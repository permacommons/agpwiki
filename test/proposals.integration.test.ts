import './_use-database.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import { WIKI_ADMIN_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { isUserSubscribedToForumThread } from '../src/services/forum-subscription-service.js';
import { listProposalParts, setProposalLinks } from '../src/services/proposal-links-service.js';
import { setProposalStatus } from '../src/services/proposal-status-service.js';
import { listPositionReplies, replyToPosition } from '../src/services/position-reply-service.js';
import {
  findRevisionsWithChangedText,
  listActivePageSignoffs,
  signOffPage,
  withdrawPageSignoff,
} from '../src/services/page-signoff-service.js';
import { listRecentAdminEvents } from '../src/services/admin-event-service.js';
import {
  listForumThreads,
  listForumCommentVersions,
  readForumThread,
  updateForumComment,
} from '../src/services/forum-service.js';
import {
  findCurrentPageById,
  readWikiPageRevision,
  createWikiPage,
  deleteWikiPage,
  listWikiPageRevisions,
  readWikiPage,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';
import ForumThread from '../src/models/forum-thread.js';
import { createTestUser, createVerifiedTestUser, getDal } from './_service-fixtures.js';

test('Service page positions let any signed-in user support, oppose or stay neutral on proposals', async () => {
  const dal = await getDal();
  const stamp = Date.now();
  const slug = `meta/proposals/test-signoff-${stamp}`;
  const otherSlug = `test-signoff-article-${stamp}`;

  const author = await createTestUser();
  const operator = await createTestUser();
  const blocked = await createTestUser();
  blocked.blockedAt = new Date();
  await blocked.save();

  const page = await createWikiPage(
    dal,
    { slug, title: { en: 'Test proposal' }, body: { en: 'Proposed text.' }, canonicalLanguage: 'en' },
    author.id
  );
  await createWikiPage(
    dal,
    { slug: otherSlug, title: { en: 'Article' }, body: { en: 'Text.' }, canonicalLanguage: 'en' },
    author.id
  );

  await assert.rejects(() => signOffPage(dal, { slug, stance: 'support' }, blocked.id), ForbiddenError);
  await assert.rejects(
    () => signOffPage(dal, { slug: otherSlug, stance: 'support' }, operator.id),
    ForbiddenError
  );
  await assert.rejects(() => signOffPage(dal, { slug, stance: 'maybe' }, operator.id), ValidationError);

  const signoff = await signOffPage(
    dal,
    { slug, stance: 'oppose', comment: '  Needs a clearer example.  ', commentLanguage: 'en' },
    operator.id
  );
  assert.equal(signoff.pageId, page.id);
  assert.equal(signoff.revId, page.currentRevId);
  assert.equal(signoff.stance, 'oppose');
  assert.equal(signoff.comment, 'Needs a clearer example.');
  assert.equal(signoff.commentLanguage, 'en');
  assert.ok(signoff.signedAt instanceof Date);
  const relabeled = await signOffPage(dal, {
    slug, stance: 'oppose', comment: signoff.comment, commentLanguage: 'fr',
  }, operator.id);
  assert.equal(relabeled.comment, signoff.comment);
  assert.equal(relabeled.commentLanguage, 'fr');
  assert.equal((await listActivePageSignoffs(dal, page.id))[0].commentLanguage, 'fr');

  const changed = await signOffPage(dal, { slug, stance: 'support', comment: 'Jetzt behoben.', commentLanguage: 'de' }, operator.id);
  assert.equal(changed.stance, 'support');
  assert.equal(changed.commentLanguage, 'de');
  await assert.rejects(
    () => signOffPage(dal, { slug, stance: 'oppose', comment: 'Missing language.' }, operator.id),
    ValidationError
  );
  await assert.rejects(
    () => signOffPage(dal, { slug, stance: 'oppose', comment: 'Invalid language.', commentLanguage: 'xx' }, operator.id),
    ValidationError
  );
  assert.equal((await listActivePageSignoffs(dal, page.id))[0].commentLanguage, 'de');
  const cleared = await signOffPage(dal, { slug, stance: 'support', comment: '  ', commentLanguage: 'de' }, operator.id);
  assert.equal(cleared.comment, null);
  assert.equal(cleared.commentLanguage, null);
  assert.equal((await listForumThreads(dal, 'policy', { pageSlug: slug })).length, 0);
  await signOffPage(dal, { slug, stance: 'neutral' }, author.id);

  const active = await listActivePageSignoffs(dal, page.id);
  assert.deepEqual(
    active.map(item => [item.userId, item.stance]),
    [
      [operator.id, 'support'],
      [author.id, 'neutral'],
    ]
  );

  await withdrawPageSignoff(dal, { slug }, operator.id);
  assert.deepEqual(
    (await listActivePageSignoffs(dal, page.id)).map(item => item.userId),
    [author.id]
  );
  await assert.rejects(() => withdrawPageSignoff(dal, { slug }, operator.id), NotFoundError);

  const history = await dal.query('SELECT stance FROM page_signoffs WHERE page_id = $1 AND user_id = $2', [
    page.id,
    operator.id,
  ]);
  assert.equal(history.rowCount, 4);

  const events = await listRecentAdminEvents(dal, 10);
  assert.ok(events.some(event => event.eventType === 'wiki_page_signed_off'));
  assert.ok(events.some(event => event.eventType === 'wiki_page_signoff_withdrawn'));
});

test('Service position replies are forum posts in a thread attached to the position', async () => {
  const dal = await getDal();
  const stamp = Date.now();
  const slug = `meta/proposals/test-replies-${stamp}`;

  const author = await createVerifiedTestUser();
  const replier = await createVerifiedTestUser();
  const stranger = await createVerifiedTestUser();
  const blocked = await createVerifiedTestUser();
  const unverified = await createTestUser();
  blocked.blockedAt = new Date();
  await blocked.save();

  await createWikiPage(
    dal,
    { slug, title: { en: 'Replies test' }, body: { en: 'Proposed text.' }, canonicalLanguage: 'en' },
    author.id
  );

  // Position comments have no length limit any more.
  const longComment = 'Detailed reasoning. '.repeat(200).trim();
  const position = await signOffPage(
    dal,
    { slug, stance: 'neutral', comment: longComment, commentLanguage: 'en' },
    author.id
  );
  assert.equal(position.comment?.length, longComment.length);
  const silent = await signOffPage(dal, { slug, stance: 'support' }, stranger.id);

  // The first reply starts a Policy thread attached to the position.
  const first = await replyToPosition(
    dal,
    { slug, signoffId: position.id, body: 'Good point, see https://example.org/a.', language: 'en' },
    replier.id
  );
  assert.equal(first.createdThread, true);
  const thread = await readForumThread(dal, first.threadId);
  assert.equal(thread.thread.category, 'policy');
  assert.equal(thread.thread.pageSlug, slug);
  assert.equal(thread.thread.attachedType, 'position');
  assert.equal(thread.thread.attachedId, position.id);
  assert.equal(thread.comments[0]?.id, first.commentId);
  // The position's author follows the thread and is told about the first reply.
  assert.equal(await isUserSubscribedToForumThread(first.threadId, author.id), true);
  const jobs = await dal.query("SELECT payload FROM notification_jobs WHERE payload->>'commentId' = $1", [first.commentId]);
  assert.deepEqual((jobs.rows[0] as { payload: { recipientUserIds: string[] } }).payload.recipientUserIds, [author.id]);

  // Later replies join the same thread.
  const second = await replyToPosition(
    dal,
    { slug, signoffId: position.id, body: 'Thanks, fixed.', language: 'en' },
    author.id
  );
  assert.equal(second.createdThread, false);
  assert.equal(second.threadId, first.threadId);

  await assert.rejects(
    () => replyToPosition(dal, { slug, signoffId: position.id, body: '   ', language: 'en' }, replier.id),
    ValidationError
  );
  await assert.rejects(
    () => replyToPosition(dal, { slug, signoffId: position.id, body: 'Hi', language: 'xx' }, replier.id),
    ValidationError
  );
  await assert.rejects(
    () => replyToPosition(dal, { slug, signoffId: silent.id, body: 'No comment to answer.', language: 'en' }, replier.id),
    ValidationError
  );
  await assert.rejects(
    () => replyToPosition(dal, { slug, signoffId: position.id, body: 'Blocked.', language: 'en' }, blocked.id),
    ForbiddenError
  );
  // As in the rest of the forum, posting needs a confirmed email address.
  await assert.rejects(
    () => replyToPosition(dal, { slug, signoffId: position.id, body: 'Unconfirmed.', language: 'en' }, unverified.id),
    ForbiddenError
  );

  let grouped = await listPositionReplies(dal, [position.id]);
  assert.equal(grouped.get(position.id)?.threadId, first.threadId);
  assert.deepEqual(
    grouped.get(position.id)?.replies.map(reply => [reply.id, reply.authorId, reply.edited]),
    [
      [first.commentId, replier.id, false],
      [second.commentId, author.id, false],
    ]
  );

  // Only the author edits a post, and every version is kept.
  await assert.rejects(
    () => updateForumComment(dal, { commentId: first.commentId, body: 'Not mine.', language: 'en' }, stranger.id),
    ForbiddenError
  );
  await new Promise(resolve => setTimeout(resolve, 1100));
  const edited = await updateForumComment(
    dal,
    { commentId: first.commentId, body: 'Good point, now fixed in the text.', language: 'en' },
    replier.id
  );
  assert.equal(edited.body?.en, 'Good point, now fixed in the text.');
  assert.equal(edited.edited, true);
  const versions = await listForumCommentVersions(dal, first.commentId);
  assert.deepEqual(
    versions.map(version => version.body?.en),
    ['Good point, see https://example.org/a.', 'Good point, now fixed in the text.']
  );
  assert.deepEqual(versions.map(version => version.revUser), [replier.id, replier.id]);
  grouped = await listPositionReplies(dal, [position.id]);
  assert.equal(grouped.get(position.id)?.replies[0]?.edited, true);
  assert.equal(grouped.get(position.id)?.replies[0]?.authorId, replier.id);

  // A changed position keeps its thread.
  const changed = await signOffPage(
    dal,
    { slug, stance: 'support', comment: 'Convinced now.', commentLanguage: 'en' },
    author.id
  );
  grouped = await listPositionReplies(dal, [changed.id]);
  assert.equal(grouped.get(changed.id)?.threadId, first.threadId);
  assert.equal(grouped.get(changed.id)?.replies.length, 2);

  // Withdrawn positions take no new replies.
  await withdrawPageSignoff(dal, { slug }, author.id);
  await assert.rejects(
    () => replyToPosition(dal, { slug, signoffId: changed.id, body: 'Too late.', language: 'en' }, replier.id),
    NotFoundError
  );
});

test('Concurrent first replies to a position share one forum thread', async t => {
  const dal = await getDal();
  const slug = `meta/proposals/test-concurrent-replies-${Date.now()}`;
  const author = await createVerifiedTestUser();
  const firstReplier = await createVerifiedTestUser();
  const secondReplier = await createVerifiedTestUser();
  await createWikiPage(
    dal,
    { slug, title: { en: 'Concurrent replies' }, body: { en: 'Proposal.' }, canonicalLanguage: 'en' },
    author.id
  );
  const position = await signOffPage(
    dal, { slug, stance: 'neutral', comment: 'Discuss this.', commentLanguage: 'en' }, author.id
  );

  // Both requests must finish their empty-thread lookup before either insert.
  let arrivals = 0;
  let release: () => void;
  const bothCreating = new Promise<void>(resolve => { release = resolve; });
  const timeout = setTimeout(() => release(), 5000);
  t.after(() => clearTimeout(timeout));
  const prototype = ForumThread.prototype;
  const save = prototype.save;
  t.mock.method(prototype, 'save', async function (...args) {
    if (this.attachedId === position.id && arrivals < 2) {
      arrivals++;
      if (arrivals === 2) release();
      await bothCreating;
    }
    return save.apply(this, args);
  });
  const outcomes = await Promise.allSettled([
    replyToPosition(dal, { slug, signoffId: position.id, body: 'First response.', language: 'en' }, firstReplier.id),
    replyToPosition(dal, { slug, signoffId: position.id, body: 'Second response.', language: 'en' }, secondReplier.id),
  ]);
  const replies = outcomes.map(outcome => {
    assert.equal(outcome.status, 'fulfilled', outcome.status === 'rejected' ? String(outcome.reason) : '');
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
  assert.equal(arrivals, 2);
  assert.equal(new Set(replies.map(reply => reply.threadId)).size, 1, 'both replies must use the same thread');
  assert.equal(replies.filter(reply => reply.createdThread).length, 1);
  assert.equal(new Set(replies.map(reply => reply.commentId)).size, 2);
  const threads = await dal.query(
    `SELECT id FROM forum_threads WHERE attached_type = 'position' AND attached_id = $1
       AND _old_rev_of IS NULL AND _rev_deleted = false`, [position.id]
  );
  assert.equal(threads.rowCount, 1);
  const detail = await readForumThread(dal, replies[0].threadId);
  assert.deepEqual(new Set(detail.comments.map(comment => comment.body?.en)), new Set(['First response.', 'Second response.']));
  for (const [index, reply] of replies.entries()) {
    assert.equal(detail.comments.find(comment => comment.id === reply.commentId)?.body?.en,
      index === 0 ? 'First response.' : 'Second response.');
  }

  const changed = await signOffPage(
    dal, { slug, stance: 'support', comment: 'Updated position.', commentLanguage: 'en' }, author.id
  );
  const grouped = await listPositionReplies(dal, [changed.id]);
  assert.equal(grouped.get(changed.id)?.replies.length, 2);
  assert.equal(grouped.get(changed.id)?.threadId, replies[0].threadId);
});

test('Service proposal links record pull requests and main proposals', async () => {
  const dal = await getDal();
  const stamp = Date.now();
  const prefix = `meta/proposals/test-links-${stamp}`;
  const mainSlug = `${prefix}/main`;
  const partSlug = `${prefix}/main/part`;
  const otherSlug = `${prefix}/other`;

  const author = await createTestUser();
  const editor = await createTestUser();
  const admin = await createTestUser();
  await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);

  const main = await createWikiPage(
    dal,
    { slug: mainSlug, title: { en: 'Main' }, body: { en: 'Main.' } },
    author.id
  );
  const part = await createWikiPage(
    dal,
    { slug: partSlug, title: { en: 'Part' }, body: { en: 'Part.' } },
    author.id
  );
  await createWikiPage(dal, { slug: otherSlug, title: { en: 'Other' }, body: { en: 'Other.' } }, author.id);
  assert.equal(part.proposalLinks, null);

  // Any editor may add links; URLs are normalized and de-duplicated.
  const linked = await setProposalLinks(
    dal,
    {
      slug: partSlug,
      pullRequests: [
        'https://github.com/permacommons/agpwiki/pull/86/files',
        'https://github.com/permacommons/agpwiki/pull/86',
        'https://github.com/permacommons/agpwiki/pull/87',
      ],
      parent: mainSlug,
      expectedRevId: part.currentRevId,
    },
    editor.id
  );
  assert.deepEqual(linked.proposalLinks, {
    pullRequests: [
      'https://github.com/permacommons/agpwiki/pull/86',
      'https://github.com/permacommons/agpwiki/pull/87',
    ],
    parent: { id: main.id, slug: mainSlug },
  });
  assert.equal(linked.proposal, null);
  assert.equal(linked.body?.en, 'Part.');

  await assert.rejects(
    () => setProposalLinks(dal, { slug: partSlug, pullRequests: ['https://example.com/pull/1'] }, editor.id),
    ValidationError
  );
  await assert.rejects(
    () => setProposalLinks(dal, { slug: partSlug, parent: partSlug }, editor.id),
    ValidationError
  );
  await assert.rejects(
    () => setProposalLinks(dal, { slug: partSlug, parent: 'firefox' }, editor.id),
    ValidationError
  );
  // One level only: a main proposal cannot become a part, and nothing can
  // become part of a part.
  await assert.rejects(
    () => setProposalLinks(dal, { slug: mainSlug, parent: otherSlug }, editor.id),
    ValidationError
  );
  await assert.rejects(
    () => setProposalLinks(dal, { slug: otherSlug, parent: partSlug }, editor.id),
    ValidationError
  );

  const parts = await listProposalParts(dal, main.id);
  assert.deepEqual(
    parts.map(item => [item.slug, item.status]),
    [[partSlug, null]]
  );

  const renamedSlug = `${prefix}/renamed-main`;
  const renamed = await updateWikiPage(
    dal,
    {
      slug: mainSlug,
      newSlug: renamedSlug,
      // Frees the old address for the replacement page below.
      keepAlias: false,
      title: { en: 'Renamed main' },
      revSummary: { en: 'Rename main proposal.' },
    },
    author.id
  );
  assert.equal(renamed.id, main.id);
  assert.deepEqual(await listProposalParts(dal, renamed.id), parts);
  const child = await readWikiPage(dal, partSlug);
  assert.deepEqual(child.proposalLinks?.parent, { id: main.id, slug: renamedSlug });
  const storedChild = await findCurrentPageById(child.id);
  assert.equal((storedChild?.properties as { proposal: { parentId: string } }).proposal.parentId, main.id);
  const parent = await findCurrentPageById(main.id);
  assert.equal(parent?.slug, renamedSlug);
  assert.equal(parent?.title?.en, 'Renamed main');
  const historical = await readWikiPageRevision(dal, partSlug, linked.currentRevId);
  assert.deepEqual(historical.revision.proposalLinks?.parent, { id: main.id, slug: renamedSlug });
  const history = await listWikiPageRevisions(dal, partSlug);
  assert.deepEqual(
    history.revisions.find(revision => revision.revId === linked.currentRevId)?.proposalLinks?.parent,
    { id: main.id, slug: renamedSlug }
  );
  const replacement = await createWikiPage(
    dal,
    { slug: mainSlug, title: { en: 'Replacement' }, body: { en: 'Replacement.' } },
    author.id
  );
  assert.deepEqual(await listProposalParts(dal, replacement.id), []);
  await assert.rejects(
    () => setProposalLinks(dal, { slug: renamedSlug, parent: otherSlug }, editor.id),
    ValidationError
  );

  // A status change keeps the links, and changing only one field keeps the other.
  const opened = await setProposalStatus(dal, { slug: partSlug, status: 'open' }, author.id);
  assert.equal(opened.proposal?.status, 'open');
  assert.deepEqual(opened.proposalLinks?.parent, { id: main.id, slug: renamedSlug });
  assert.ok(opened.proposal);
  assert.equal('parentId' in opened.proposal, false);
  assert.equal('pullRequests' in opened.proposal, false);
  assert.equal(opened.proposalLinks?.pullRequests.length, 2);
  assert.equal((await listProposalParts(dal, main.id))[0].status, 'open');
  const statusRevision = await readWikiPageRevision(dal, partSlug, opened.currentRevId);
  assert.deepEqual(statusRevision.revision.proposal, opened.proposal);
  assert.deepEqual(statusRevision.revision.proposalLinks, opened.proposalLinks);
  const statusHistory = await listWikiPageRevisions(dal, partSlug);
  assert.deepEqual(
    statusHistory.revisions.find(revision => revision.revId === opened.currentRevId)?.proposal,
    opened.proposal
  );
  const reread = await readWikiPage(dal, partSlug);
  assert.deepEqual(reread.proposal, opened.proposal);
  assert.deepEqual(reread.proposalLinks, opened.proposalLinks);

  const moved = await setProposalLinks(dal, { slug: partSlug, parent: otherSlug }, editor.id);
  assert.equal(moved.proposalLinks?.pullRequests.length, 2);
  assert.deepEqual(moved.proposalLinks?.parent, { id: (await readWikiPage(dal, otherSlug)).id, slug: otherSlug });
  assert.equal(moved.proposal?.status, 'open');
  assert.deepEqual(await listProposalParts(dal, main.id), []);

  const cleared = await setProposalLinks(dal, { slug: partSlug, pullRequests: [], parent: null }, editor.id);
  assert.equal(cleared.proposalLinks, null);
  assert.equal(cleared.proposal?.status, 'open');

  // Links only exist on proposals.
  await assert.rejects(
    () => setProposalLinks(dal, { slug: 'firefox', pullRequests: [] }, admin.id),
    (error: unknown) => error instanceof ValidationError || error instanceof NotFoundError
  );

  await setProposalLinks(dal, { slug: partSlug, parent: renamedSlug }, editor.id);
  await deleteWikiPage(dal, { slug: renamedSlug, revSummary: { en: 'Delete test parent.' } }, admin.id);
  const orphaned = await readWikiPage(dal, partSlug);
  assert.deepEqual(orphaned.proposalLinks, { pullRequests: [], parent: { id: main.id, slug: null } });
});

test('Service proposal status follows who may set what and keeps decisions', async () => {
  const dal = await getDal();
  const stamp = Date.now();
  const slug = `meta/proposals/test-status-${stamp}`;
  const otherSlug = `meta/proposals/test-status-next-${stamp}`;

  const author = await createTestUser();
  const stranger = await createTestUser();
  const admin = await createTestUser();
  await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);

  const created = await createWikiPage(
    dal,
    { slug, title: { en: 'Status test' }, body: { en: 'Proposal text.' } },
    author.id
  );
  await createWikiPage(dal, { slug: otherSlug, title: { en: 'Next' }, body: { en: 'Text.' } }, author.id);
  assert.equal(created.proposal, null);

  const opened = await setProposalStatus(dal, { slug, status: 'open' }, author.id);
  assert.equal(opened.proposal?.status, 'open');
  assert.equal(opened.body?.en, 'Proposal text.');

  await assert.rejects(() => setProposalStatus(dal, { slug, status: 'withdrawn' }, stranger.id), ForbiddenError);
  await assert.rejects(
    () => setProposalStatus(dal, { slug, status: 'adopted', decisionNote: { en: 'Yes.' } }, author.id),
    ForbiddenError
  );
  await assert.rejects(() => setProposalStatus(dal, { slug, status: 'adopted' }, admin.id), ValidationError);
  await assert.rejects(() => setProposalStatus(dal, { slug, status: 'maybe' }, admin.id), ValidationError);

  const adopted = await setProposalStatus(
    dal,
    { slug, status: 'adopted', decisionNote: { en: 'Adopted after review.' } },
    admin.id
  );
  assert.equal(adopted.proposal?.decidedBy, admin.id);
  assert.deepEqual(adopted.proposal?.decisionNote, { en: 'Adopted after review.' });

  await assert.rejects(() => setProposalStatus(dal, { slug, status: 'applied' }, admin.id), ValidationError);
  const applied = await setProposalStatus(
    dal,
    { slug, status: 'applied', appliedTo: ['meta/values'] },
    admin.id
  );
  assert.equal(applied.proposal?.status, 'applied');
  assert.deepEqual(applied.proposal?.appliedTo, ['meta/values']);
  assert.deepEqual(applied.proposal?.decisionNote, { en: 'Adopted after review.' });

  await assert.rejects(
    () => setProposalStatus(dal, { slug, status: 'superseded', decisionNote: { en: 'Replaced.' }, supersededBy: 'firefox' }, admin.id),
    ValidationError
  );
  const superseded = await setProposalStatus(
    dal,
    { slug, status: 'superseded', decisionNote: { en: 'Replaced.' }, supersededBy: otherSlug },
    admin.id
  );
  assert.equal(superseded.proposal?.supersededBy, otherSlug);

  await assert.rejects(
    () => setProposalStatus(dal, { slug: otherSlug.replace('meta/proposals/', 'test-not-proposal-'), status: 'open' }, admin.id),
    NotFoundError
  );

  const unchanged = await findRevisionsWithChangedText(dal, created.id, [opened.currentRevId, adopted.currentRevId]);
  assert.equal(unchanged.size, 0);
  await updateWikiPage(dal, { slug, body: { en: 'Edited proposal text.' }, revSummary: { en: 'Edit.' } }, author.id);
  const changed = await findRevisionsWithChangedText(dal, created.id, [opened.currentRevId]);
  assert.equal(changed.has(opened.currentRevId), true);
});
