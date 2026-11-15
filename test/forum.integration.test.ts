import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import { FORUM_MODERATOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { countPageDiscussionComments } from '../src/services/discussion-service.js';
import {
  createForumComment,
  createForumThread,
  deleteForumComment,
  deleteForumThread,
  listForumCategories,
  listForumThreads,
  readForumThread,
  setForumThreadPinned,
} from '../src/services/forum-service.js';
import { addWikiPageAlias, createWikiPage } from '../src/services/wiki-page-service.js';
import ForumThread from '../src/models/forum-thread.js';
import ForumComment from '../src/models/forum-comment.js';
import { createTestUser, createVerifiedTestUser, getDal } from './_service-fixtures.js';

test('Forum thread creation rolls back when its opening comment cannot be saved', async t => {
  const dal = await getDal();
  const title = `test-atomic-thread-${Date.now()}`;
  const user = await createVerifiedTestUser();
  const failure = new Error('Opening comment could not be saved.');
  const save = t.mock.method(ForumComment.prototype, 'save', async () => { throw failure; });
  await assert.rejects(
    () => createForumThread({ category: 'general', title, body: 'Opening.', language: 'en' }, user.id),
    error => error === failure
  );
  save.mock.restore();
  const threads = await dal.query("SELECT id FROM forum_threads WHERE title->>'en' = $1", [title]);
  assert.equal(threads.rowCount, 0, 'failed creation must not leave an empty thread');
});

test('Forum services create threads/comments and list categories', async () => {
  const dal = await getDal();
  const baseTitle = `forum-test-${Date.now()}`;

  const user = await createTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title: `${baseTitle} <b>thread</b>`,
      body: 'Opening post.',
      language: 'en',
    },
    user.id
  );

  await createForumComment(
    {
      threadId: thread.id,
      body: 'Second comment.',
      language: 'en',
    },
    user.id
  );

  const categoryList = await listForumCategories(dal);
  const general = categoryList.find(item => item.slug === 'general');
  const threadList = await listForumThreads(dal, 'general');
  const detail = await readForumThread(dal, thread.id);

  assert.ok(general);
  assert.ok((general?.threadCount ?? 0) >= 1);
  assert.deepEqual(detail.thread.title, { en: `${baseTitle} &lt;b&gt;thread&lt;/b&gt;` });
  assert.equal(detail.thread.canonicalLanguage, 'en');
  assert.equal(detail.comments.length, 2);
  assert.deepEqual(detail.comments.map(comment => comment.body), [{ en: 'Opening post.' }, { en: 'Second comment.' }]);
  assert.equal(threadList.some(item => item.id === thread.id), true);
});

test('Forum moderator can pin and delete thread and comments', async () => {
  const dal = await getDal();
  const baseTitle = `forum-moderation-${Date.now()}`;

  const author = await createTestUser();
  const moderator = await createTestUser();
  await grantRoleUpsert(dal, moderator.id, FORUM_MODERATOR_ROLE);

  const older = await createForumThread(
    {
      category: 'general',
      title: `${baseTitle}-older`,
      body: 'Older thread.',
      language: 'en',
    },
    author.id
  );
  const newer = await createForumThread(
    {
      category: 'general',
      title: `${baseTitle}-newer`,
      body: 'Newer thread.',
      language: 'en',
    },
    author.id
  );
  const extraComment = await createForumComment(
    {
      threadId: older.id,
      body: 'Moderation target.',
      language: 'en',
    },
    author.id
  );

  await setForumThreadPinned(
    dal,
    {
      threadId: older.id,
      pinned: true,
      revSummary: { en: 'Pin thread.' },
    },
    moderator.id
  );

  const threadList = await listForumThreads(dal, 'general');
  assert.equal(threadList[0]?.id, older.id);

  await deleteForumComment(
    dal,
    {
      commentId: extraComment.id,
      revSummary: { en: 'Delete comment.' },
    },
    moderator.id
  );
  const detailAfterCommentDelete = await readForumThread(dal, older.id);
  assert.equal(detailAfterCommentDelete.comments.length, 1);

  await deleteForumThread(
    dal,
    {
      threadId: newer.id,
      revSummary: { en: 'Delete thread.' },
    },
    moderator.id
  );

  await assert.rejects(() => readForumThread(dal, newer.id), NotFoundError);
});

const readForumThreadRevision = async (threadId: string, revId: string) => {
  const revision = await ForumThread.filterWhere({}).getRevisionByRevId(revId, threadId).first();
  assert.ok(revision, `Forum thread revision not found: ${revId}`);
  return revision;
};

test('Forum thread pin and reply revisions leave previous revisions intact', async () => {
  const dal = await getDal();
  const baseTitle = `forum-history-${Date.now()}`;

  const author = await createTestUser();
  const moderator = await createTestUser();
  await grantRoleUpsert(dal, moderator.id, FORUM_MODERATOR_ROLE);

  const thread = await createForumThread(
    { category: 'general', title: baseTitle, body: 'Opening post.', language: 'en' },
    author.id
  );
  const created = await ForumThread.getById(thread.id);
  assert.ok(created);
  const createdRevId = created._revID;
  const createdUpdatedAt = created.updatedAt?.getTime();
  const title = created.title;
  assert.deepEqual(title, { en: baseTitle });

  await setForumThreadPinned(
    dal,
    { threadId: thread.id, pinned: true, revSummary: { en: 'Pin thread.' } },
    moderator.id
  );

  const beforePin = await readForumThreadRevision(thread.id, createdRevId);
  assert.equal(beforePin.pinned, 0);
  assert.deepEqual(beforePin.title, title);

  const pinned = await ForumThread.getById(thread.id);
  assert.ok(pinned);
  assert.notEqual(pinned._revID, createdRevId);
  assert.equal(pinned.pinned, 1);
  assert.deepEqual(pinned.title, title);
  const pinnedRevId = pinned._revID;
  const pinnedUpdatedAt = pinned.updatedAt?.getTime();
  assert.ok(pinnedUpdatedAt !== undefined && createdUpdatedAt !== undefined);

  await new Promise(resolve => setTimeout(resolve, 5));
  await createForumComment(
    { threadId: thread.id, body: 'A reply.', language: 'en' },
    author.id
  );

  const beforeReply = await readForumThreadRevision(thread.id, pinnedRevId);
  assert.equal(beforeReply.updatedAt?.getTime(), pinnedUpdatedAt);
  assert.equal(beforeReply.pinned, 1);
  assert.deepEqual(beforeReply.title, title);

  const afterReply = await ForumThread.getById(thread.id);
  assert.ok(afterReply);
  assert.notEqual(afterReply._revID, pinnedRevId);
  assert.ok((afterReply.updatedAt?.getTime() ?? 0) > pinnedUpdatedAt);
  assert.equal(afterReply.pinned, 1);
  assert.deepEqual(afterReply.title, title);

  const original = await readForumThreadRevision(thread.id, createdRevId);
  assert.equal(original.pinned, 0);
  assert.equal(original.updatedAt?.getTime(), createdUpdatedAt);
});

test('Forum article threads normalize aliases and reject invalid slugs', async () => {
  const dal = await getDal();
  const slug = `forum-article-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;
  const threadBaseTitle = `forum-article-thread-${Date.now()}`;

  const user = await createTestUser();

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Forum Article Test' },
      body: { en: 'Body.' },
      canonicalLanguage: 'en',
    },
    user.id
  );
  await addWikiPageAlias(
    dal,
    {
      slug: aliasSlug,
      pageSlug: slug,
    },
    user.id
  );

  const thread = await createForumThread(
    {
      category: 'articles',
      pageSlug: aliasSlug,
      title: threadBaseTitle,
      body: 'Article discussion.',
      language: 'en',
    },
    user.id
  );

  await assert.rejects(
    () => createForumThread({ category: 'policy', pageSlug: aliasSlug, title: `${threadBaseTitle}-wrong`, body: 'Wrong category.', language: 'en' }, user.id),
    ValidationError
  );

  assert.equal(thread.pageSlug, slug);

  const articleThreads = await listForumThreads(dal, 'articles', {
    pageSlug: slug,
  });
  assert.equal(articleThreads.some(item => item.id === thread.id), true);

  await assert.rejects(
    () =>
      createForumThread(
        {
          category: 'articles',
          pageSlug: `${slug}-missing`,
          title: `forum-article-thread-${Date.now()}-bad`,
          body: 'Invalid discussion.',
          language: 'en',
        },
        user.id
      ),
    ValidationError
  );
});

test('Forum policy threads may optionally link to a wiki page', async () => {
  const dal = await getDal();
  const slug = `meta/forum-policy-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;
  const threadBaseTitle = `forum-policy-thread-${Date.now()}`;

  const user = await createTestUser();

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Forum Policy Test' },
      body: { en: 'Body.' },
      canonicalLanguage: 'en',
    },
    user.id
  );
  await addWikiPageAlias(
    dal,
    {
      slug: aliasSlug,
      pageSlug: slug,
    },
    user.id
  );

  const linkedThread = await createForumThread(
    {
      category: 'policy',
      pageSlug: aliasSlug,
      title: `${threadBaseTitle}-linked`,
      body: 'Policy page discussion.',
      language: 'en',
    },
    user.id
  );
  const genericThread = await createForumThread(
    {
      category: 'policy',
      title: `${threadBaseTitle}-general`,
      body: 'General policy discussion.',
      language: 'en',
    },
    user.id
  );

  await assert.rejects(
    () => createForumThread({ category: 'articles', pageSlug: aliasSlug, title: `${threadBaseTitle}-wrong`, body: 'Wrong category.', language: 'en' }, user.id),
    ValidationError
  );

  assert.equal(linkedThread.pageSlug, slug);
  assert.equal(genericThread.pageSlug, null);
  assert.equal(await countPageDiscussionComments(dal, [slug]), 1);

  await dal.query(
    `UPDATE forum_threads SET category = 'articles', page_slug = $1 WHERE id = $2`,
    [slug, genericThread.id]
  );
  assert.equal(await countPageDiscussionComments(dal, [slug]), 2);

  const linkedThreads = await listForumThreads(dal, 'policy', {
    pageSlug: slug,
  });
  assert.equal(linkedThreads.some(item => item.id === linkedThread.id), true);
  assert.equal(linkedThreads.some(item => item.id === genericThread.id), false);
});

test('Forum moderation actions require forum moderator role', async () => {
  const dal = await getDal();
  const baseTitle = `forum-auth-${Date.now()}`;

  const user = await createTestUser();
  const thread = await createForumThread(
    {
      category: 'policy',
      title: `${baseTitle}-thread`,
      body: 'Policy thread.',
      language: 'en',
    },
    user.id
  );

  await assert.rejects(
    () =>
      setForumThreadPinned(
        dal,
        {
          threadId: thread.id,
          pinned: true,
          revSummary: { en: 'Pin thread.' },
        },
        user.id
      ),
    ForbiddenError
  );
});
