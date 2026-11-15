import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import type { TFunction } from 'i18next';
import { initializePostgreSQL } from '../src/db.js';
import { findMentionNames, linkMentionsInEscapedText, MAX_MENTIONS_PER_EDIT } from '../src/lib/mentions.js';
import User from '../src/models/user.js';
import { findMarkdownMentionNames, renderMarkdown } from '../src/render.js';
import { renderNotificationText } from '../src/routes/lib/notifications.js';
import { renderPlainTextWithLinks } from '../src/routes/lib/page-signoffs.js';
import { processForumReplyCreatedNotification } from '../src/services/forum-notification-service.js';
import { createForumComment, createForumThread, updateForumComment } from '../src/services/forum-service.js';
import { subscribeUserToForumThread } from '../src/services/forum-subscription-service.js';
import {
  listMentionRecipientUserIds,
  MENTION_NOTIFICATION,
  type MentionPayload,
  processMentionNotification,
  suggestMentionUsernames,
} from '../src/services/mention-service.js';
import { enqueueNotificationJob } from '../src/services/notification-queue.js';
import { processPageCommentNotification } from '../src/services/page-comment-notification-service.js';
import { followPage } from '../src/services/page-subscription-service.js';
import { signOffPage, withdrawPageSignoff } from '../src/services/page-signoff-service.js';
import { replyToPosition } from '../src/services/position-reply-service.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

let sharedDal: Dal | null = null;
const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};
test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

// Usernames are stored normalized: lowercase, without spaces, - or _.
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const createTestUser = async (name: string) =>
  User.create({
    username: `mention${name}${run}`,
    displayName: `Mention ${name}`,
    email: `mention-${name}-${run}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
  });

const findJobs = async (dal: Dal, field: 'commentId' | 'signoffId', id: string) =>
  (
    await dal.query(`SELECT id, payload FROM notification_jobs WHERE type = $1 AND payload->>'${field}' = $2 ORDER BY created_at`, [
      MENTION_NOTIFICATION,
      id,
    ])
  ).rows as Array<{ id: string; payload: MentionPayload }>;

const cleanup = async (dal: Dal, prefix: string, userIds: string[]) => {
  const pages = await dal.query('SELECT id FROM pages WHERE slug LIKE $1', [`%${prefix}%`]);
  const pageIds = (pages.rows as Array<{ id: string }>).map(row => row.id);
  const threads = await dal.query("SELECT id FROM forum_threads WHERE title->>'en' LIKE $1", [`%${prefix}%`]);
  const threadIds = (threads.rows as Array<{ id: string }>).map(row => row.id);
  const jobFilter = `payload->>'pageId' = ANY($1) OR payload->>'threadId' = ANY($2) OR payload->>'actorUserId' = ANY($3)`;
  const params = [pageIds, threadIds, userIds];
  await dal.query(`DELETE FROM notifications WHERE job_id IN (SELECT id FROM notification_jobs WHERE ${jobFilter})`, params);
  await dal.query(
    `DELETE FROM notification_deliveries WHERE job_id IN (SELECT id FROM notification_jobs WHERE ${jobFilter})`,
    params
  );
  await dal.query(`DELETE FROM notification_jobs WHERE ${jobFilter}`, params);
  await dal.query('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM forum_thread_subscriptions WHERE thread_id = ANY($1)', [threadIds]);
  await dal.query('DELETE FROM forum_comments WHERE thread_id = ANY($1)', [threadIds]);
  await dal.query('DELETE FROM forum_threads WHERE id = ANY($1) OR _old_rev_of = ANY($1)', [threadIds]);
  await dal.query('DELETE FROM page_signoffs WHERE page_id = ANY($1)', [pageIds]);
  await dal.query('DELETE FROM admin_events WHERE target_id = ANY($1)', [pageIds]);
  await dal.query('DELETE FROM page_subscriptions WHERE page_id = ANY($1) OR user_id = ANY($2)', [pageIds, userIds]);
  await dal.query('DELETE FROM pages WHERE id = ANY($1) OR _old_rev_of = ANY($1)', [pageIds]);
  await dal.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
};

test('Mentions are @ and a username, not e-mail addresses or citations', () => {
  assert.deepEqual(
    findMentionNames('Hi @Eloquence, and @Another_Editor. Mail me@example.org, see [@smith2020], @eloquence again.'),
    ['eloquence', 'anothereditor']
  );
  assert.deepEqual(findMentionNames('@ alone, @-, trailing @Name.'), ['name']);
  assert.deepEqual(
    findMarkdownMentionNames('Ask @Alice. Not `@code`, not [@key], not [a link](https://example.org/@bob).\n\n    @indented\n'),
    ['alice']
  );
});

test('Mentions of real usernames link to profiles; other text after @ stays plain', async () => {
  const mentions = new Map([['eloquence', 'eloquence']]);
  const { html } = await renderMarkdown('Thanks @Eloquence and @nobody, mail a@eloquence.org.', [], { mentions });
  assert.match(html, /<a href="\/user\/eloquence" class="mention"[^>]*>@Eloquence<\/a> and @nobody, mail <a href="mailto:a@eloquence\.org">/);
  const plain = await renderMarkdown('Thanks @Eloquence.', []);
  assert.ok(!plain.html.includes('class="mention"'), 'Articles do not link mentions');

  const position = renderPlainTextWithLinks('Agree with @Eloquence, see https://example.org/@eloquence <ok>', mentions);
  assert.ok(position.includes('<a class="mention" href="/user/eloquence">@Eloquence</a>,'));
  assert.ok(position.includes('<a href="https://example.org/@eloquence" rel="nofollow ugc noopener">'));
  assert.ok(position.includes('&lt;ok&gt;'));
  assert.equal(linkMentionsInEscapedText('@Eloquence', undefined), '@Eloquence');
});

test('Comments notify the people they mention, once, with the operator as the author', async () => {
  const dal = await getDal();
  const prefix = `mention-forum-${run}`;
  const userIds: string[] = [];
  try {
    const author = await createTestUser('author');
    const reader = await createTestUser('reader');
    const later = await createTestUser('later');
    userIds.push(author.id, reader.id, later.id);

    const thread = await createForumThread(
      { category: 'general', title: `${prefix} thread`, body: 'Opening post.', language: 'en' },
      author.id
    );
    await subscribeUserToForumThread(thread.id, reader.id);
    const comment = await createForumComment(
      {
        threadId: thread.id,
        body: `Hey @Mention_Reader${run}, @${author.username} and @nobody${run}. Not \`@${later.username}\`.`,
        language: 'en',
      },
      author.id
    );
    const jobs = await findJobs(dal, 'commentId', comment.id);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload.recipientUserIds, [reader.id]);
    assert.equal(jobs[0].payload.actorUserId, author.id);

    const sent: string[] = [];
    const result = await processMentionNotification(dal, { id: jobs[0].id, payload: jobs[0].payload } as never, async message => {
      sent.push(String(message.subject));
      return { delivered: true, skipped: false } as never;
    });
    assert.equal(result.siteCount, 1);
    assert.deepEqual(sent, [`Mention author mentioned you in: ${prefix} thread`]);
    const rows = await dal.query('SELECT kind, url, subject, actor_user_id FROM notifications WHERE user_id = $1', [reader.id]);
    assert.deepEqual(rows.rows, [
      {
        kind: 'mention',
        url: `/tool/forum/general?thread=${thread.id}#comment-${comment.id}`,
        subject: `${prefix} thread`,
        actor_user_id: author.id,
      },
    ]);

    // The reader follows the thread too, but hears about this reply only
    // through the mention.
    const reply = await dal.query(
      `SELECT id, payload FROM notification_jobs WHERE type = 'forum.reply.created' AND payload->>'commentId' = $1`,
      [comment.id]
    );
    const replyJob = reply.rows[0] as { id: string; payload: never };
    const replyResult = await processForumReplyCreatedNotification(dal, replyJob as never, async () => {
      throw new Error('no e-mail expected');
    });
    assert.equal(replyResult.siteCount, 0);

    // An edit notifies only people it newly mentions.
    await updateForumComment(
      dal,
      { commentId: comment.id, body: `Hey @${reader.username} and @${later.username}.`, language: 'en' },
      author.id
    );
    const afterEdit = await findJobs(dal, 'commentId', comment.id);
    assert.equal(afterEdit.length, 2);
    assert.deepEqual(afterEdit[1].payload.recipientUserIds, [later.id]);
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

for (const channel of ['forum', 'page'] as const) {
  test(`Removing a mention before delivery does not duplicate the ${channel} notification`, async () => {
    const dal = await getDal();
    const prefix = `mention-snapshot-${channel}-${run}`;
    const userIds: string[] = [];
    try {
      const author = await createTestUser(`snapshot${channel}author`);
      const reader = await createTestUser(`snapshot${channel}reader`);
      userIds.push(author.id, reader.id);
      if (channel === 'page') {
        const page = await createWikiPage(
          dal,
          { slug: prefix, title: { en: prefix }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
          author.id
        );
        await followPage(dal, page.id, reader.id);
      }
      const thread = await createForumThread(
        { category: channel === 'page' ? 'articles' : 'general', pageSlug: channel === 'page' ? prefix : undefined,
          title: prefix, body: 'Opening post.', language: 'en' },
        author.id
      );
      if (channel === 'forum') await subscribeUserToForumThread(thread.id, reader.id);
      const comment = await createForumComment(
        { threadId: thread.id, body: `Hello @${reader.username}.`, language: 'en' }, author.id
      );
      const mentionJobs = await findJobs(dal, 'commentId', comment.id);
      assert.equal(mentionJobs.length, 1);
      const type = channel === 'forum' ? 'forum.reply.created' : 'page.comment.created';
      const queued = await dal.query(
        "SELECT id, payload FROM notification_jobs WHERE type = $1 AND payload->>'commentId' = $2",
        [type, comment.id]
      );
      assert.equal(queued.rows.length, 1);
      assert.deepEqual(
        (queued.rows[0] as { payload: { mentionRecipientUserIds: string[] } }).payload.mentionRecipientUserIds,
        mentionJobs[0].payload.recipientUserIds
      );
      await updateForumComment(dal, { commentId: comment.id, body: 'Hello everyone.', language: 'en' }, author.id);
      const sent: string[] = [];
      const sendMail = async (message: { subject: string }) => {
        sent.push(message.subject);
        return { delivered: true, skipped: false } as never;
      };
      const processSubscriber = channel === 'forum' ? processForumReplyCreatedNotification : processPageCommentNotification;
      await processSubscriber(dal, queued.rows[0] as never, sendMail);
      await processMentionNotification(dal, mentionJobs[0] as never, sendMail);
      const notifications = await dal.query('SELECT kind FROM notifications WHERE user_id = $1', [reader.id]);
      assert.deepEqual(notifications.rows, [{ kind: 'mention' }]);
      assert.equal(sent.length, 1);
    } finally {
      await cleanup(dal, prefix, userIds);
    }
  });
}

test('Each edit notifies up to ten people absent from the preceding text', async () => {
  const dal = await getDal();
  const userIds: string[] = [];
  try {
    const author = await createTestUser('capauthor');
    userIds.push(author.id);
    const mentioned = [];
    for (let index = 0; index < MAX_MENTIONS_PER_EDIT + 2; index += 1) {
      const user = await createTestUser(`cap${index}x`);
      userIds.push(user.id);
      mentioned.push(user);
    }
    const text = mentioned.map(user => `@${user.username}`).join(' ');
    const first = await listMentionRecipientUserIds(dal, { text, format: 'plain', actorUserId: author.id });
    assert.deepEqual(first, mentioned.slice(0, MAX_MENTIONS_PER_EDIT).map(user => user.id));
    const hiddenMentions = mentioned
      .map(user => `[hello @${user.username}](https://example.org) ![photo @${user.username}](photo.jpg)`)
      .join(' ');
    const visibleOnly = await listMentionRecipientUserIds(dal, {
      text: `${hiddenMentions} @${mentioned.at(-1)!.username}`,
      format: 'markdown',
      actorUserId: author.id,
    });
    assert.deepEqual(visibleOnly, [mentioned.at(-1)!.id], 'Link labels and alt text must not consume the recipient limit');
    const edited = await listMentionRecipientUserIds(dal, {
      text: `${text} @${author.username}`,
      previousText: mentioned
        .slice(0, 9)
        .map(user => `@${user.username}`)
        .join(' '),
      format: 'plain',
      actorUserId: author.id,
    });
    assert.deepEqual(edited, mentioned.slice(9).map(user => user.id));
    const restored = await listMentionRecipientUserIds(dal, {
      text,
      previousText: '',
      format: 'plain',
      actorUserId: author.id,
    });
    assert.deepEqual(restored, first);
    const retained = await listMentionRecipientUserIds(dal, {
      text,
      previousText: text,
      format: 'plain',
      actorUserId: author.id,
    });
    assert.deepEqual(retained, []);
  } finally {
    await cleanup(dal, `mention-cap-${run}`, userIds);
  }
});

test('Position comments notify the people they newly mention', async () => {
  const dal = await getDal();
  const prefix = `mention-position-${run}`;
  const slug = `meta/proposals/${prefix}`;
  const userIds: string[] = [];
  try {
    const proposer = await createTestUser('proposer');
    const voter = await createTestUser('voter');
    const other = await createTestUser('other');
    userIds.push(proposer.id, voter.id, other.id);
    await createWikiPage(
      dal,
      { slug, title: { en: 'Mention proposal' }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
      proposer.id
    );
    const jobs: Array<{ type: string; payload: MentionPayload }> = [];
    const enqueueJob = (async (type: string, payload: MentionPayload) => {
      jobs.push({ type, payload });
    }) as never;
    const first = await signOffPage(
      dal,
      { slug, stance: 'support', comment: `As @${proposer.username} says.`, commentLanguage: 'en' },
      voter.id,
      { enqueueJob }
    );
    const mentions = jobs.filter(job => job.type === MENTION_NOTIFICATION);
    assert.equal(mentions.length, 1);
    assert.deepEqual(mentions[0].payload, {
      type: 'position',
      signoffId: first.id,
      actorUserId: voter.id,
      recipientUserIds: [proposer.id],
    });

    jobs.length = 0;
    await signOffPage(
      dal,
      { slug, stance: 'neutral', comment: `As @${proposer.username} and @${other.username} say.`, commentLanguage: 'en' },
      voter.id,
      { enqueueJob }
    );
    const again = jobs.filter(job => job.type === MENTION_NOTIFICATION);
    assert.deepEqual(again[0].payload.recipientUserIds, [other.id]);

    const job = await enqueueNotificationJob(MENTION_NOTIFICATION, again[0].payload);
    const result = await processMentionNotification(dal, { id: job.id, payload: again[0].payload } as never, async () => ({
      delivered: true,
      skipped: false,
    }) as never);
    assert.equal(result.siteCount, 1);
    const rows = await dal.query('SELECT kind, url, subject FROM notifications WHERE user_id = $1', [other.id]);
    const row = rows.rows[0] as { kind: string; url: string; subject: string };
    assert.equal(row.kind, 'mention');
    assert.match(row.url, new RegExp(`^/meta/proposals/${prefix}#position-`));
    assert.equal(row.subject, 'Mention proposal');
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('A first position reply mentions its owner without duplicate subscriber delivery', async () => {
  const dal = await getDal();
  const prefix = `mention-first-position-reply-${run}`;
  const slug = `meta/proposals/${prefix}`;
  const userIds: string[] = [];
  try {
    const owner = await createTestUser('firstreplyowner');
    const author = await createTestUser('firstreplyauthor');
    userIds.push(owner.id, author.id);
    await createWikiPage(
      dal,
      { slug, title: { en: prefix }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
      owner.id
    );
    const position = await signOffPage(
      dal, { slug, stance: 'support', comment: prefix, commentLanguage: 'en' }, owner.id
    );
    const reply = await replyToPosition(
      dal, { slug, signoffId: position.id, body: `Thanks @${owner.username}.`, language: 'en' }, author.id
    );
    assert.equal(reply.createdThread, true);
    const mentions = await findJobs(dal, 'commentId', reply.commentId);
    assert.equal(mentions.length, 1);
    assert.deepEqual(mentions[0].payload.recipientUserIds, [owner.id]);
    const queued = await dal.query(
      "SELECT id, payload FROM notification_jobs WHERE type = 'forum.reply.created' AND payload->>'commentId' = $1",
      [reply.commentId]
    );
    assert.equal(queued.rows.length, 1);
    const job = queued.rows[0] as { id: string; payload: { recipientUserIds: string[]; mentionRecipientUserIds: string[] } };
    assert.deepEqual(job.payload.recipientUserIds, [owner.id]);
    assert.deepEqual(job.payload.mentionRecipientUserIds, [owner.id]);
    const sendMail = async () => ({ delivered: true, skipped: false }) as never;
    await processForumReplyCreatedNotification(dal, job as never, sendMail);
    await processMentionNotification(dal, mentions[0] as never, sendMail);
    const notifications = await dal.query('SELECT kind FROM notifications WHERE user_id = $1', [owner.id]);
    assert.deepEqual(notifications.rows, [{ kind: 'mention' }]);
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('Position URL contents do not notify users or suppress a later visible mention', async () => {
  const dal = await getDal();
  const prefix = `mention-position-url-${run}`;
  const slug = `meta/proposals/${prefix}`;
  const userIds: string[] = [];
  try {
    const proposer = await createTestUser('urlproposer');
    const voter = await createTestUser('urlvoter');
    userIds.push(proposer.id, voter.id);
    await createWikiPage(
      dal,
      { slug, title: { en: prefix }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
      proposer.id
    );
    const body = `See https://example.org/?name=@${proposer.username}`;
    await signOffPage(dal, { slug, stance: 'support', comment: body, commentLanguage: 'en' }, voter.id);
    const queued = await dal.query(
      "SELECT id FROM notification_jobs WHERE type = $1 AND payload->>'actorUserId' = $2",
      [MENTION_NOTIFICATION, voter.id]
    );
    assert.deepEqual(queued.rows, [], 'A username inside a URL must not queue a mention');
    const edited = await signOffPage(
      dal,
      { slug, stance: 'support', comment: `${body} Thanks @${proposer.username}.`, commentLanguage: 'en' },
      voter.id
    );
    const jobs = await findJobs(dal, 'signoffId', edited.id);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload.recipientUserIds, [proposer.id]);
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('A retained position mention is delivered after the position is replaced', async () => {
  const dal = await getDal();
  const prefix = `mention-pending-position-${run}`;
  const slug = `meta/proposals/${prefix}`;
  const userIds: string[] = [];
  try {
    const proposer = await createTestUser('pendingproposer');
    const voter = await createTestUser('pendingvoter');
    userIds.push(proposer.id, voter.id);
    await createWikiPage(
      dal,
      { slug, title: { en: 'Pending mention proposal' }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
      proposer.id
    );
    const first = await signOffPage(
      dal,
      { slug, stance: 'support', comment: `Agree with @${proposer.username}.`, commentLanguage: 'en' },
      voter.id
    );
    const jobs = await findJobs(dal, 'signoffId', first.id);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload.recipientUserIds, [proposer.id]);

    const replacement = await signOffPage(
      dal,
      { slug, stance: 'neutral', comment: `Still considering @${proposer.username}'s point.`, commentLanguage: 'en' },
      voter.id
    );
    assert.notEqual(replacement.id, first.id);
    assert.deepEqual(await findJobs(dal, 'signoffId', replacement.id), []);

    const result = await processMentionNotification(dal, jobs[0] as never, async () => ({
      delivered: true,
      skipped: false,
    }) as never);
    assert.equal(result.siteCount, 1, 'The queued mention must survive replacement of its position');
    const rows = await dal.query('SELECT url FROM notifications WHERE user_id = $1 AND job_id = $2', [
      proposer.id,
      jobs[0].id,
    ]);
    assert.equal(rows.rows.length, 1);
    assert.equal((rows.rows[0] as { url: string }).url, `/${slug}#position-${replacement.id}`);

    await withdrawPageSignoff(dal, { slug }, voter.id);
    const withdrawnResult = await processMentionNotification(dal, jobs[0] as never, async () => {
      assert.fail('A withdrawn position must not send mail');
    });
    assert.equal(withdrawnResult.siteCount, 0);
    assert.equal('skipped' in withdrawnResult && withdrawnResult.skipped, 'post_not_found');
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('Username suggestions match verified, unblocked accounts', async () => {
  const dal = await getDal();
  const userIds: string[] = [];
  try {
    const shown = await createTestUser('suggestshown');
    const blocked = await User.create({
      username: `${shown.username}blocked`,
      displayName: 'Blocked',
      emailVerifiedAt: new Date(),
      email: `mention-blocked-${run}@example.com`,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
    });
    const unverified = await User.create({
      username: `${shown.username}unverified`,
      displayName: 'Unverified',
      email: `mention-unverified-${run}@example.com`,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
    });
    userIds.push(shown.id, blocked.id, unverified.id);
    await dal.query('UPDATE users SET blocked_at = NOW() WHERE id = $1', [blocked.id]);
    const users = await suggestMentionUsernames(dal, `Mention_SuggestShown${run}`);
    assert.deepEqual(users, [{ username: shown.username, name: shown.displayName }]);
    await dal.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [unverified.id]);
    assert.deepEqual(await suggestMentionUsernames(dal, unverified.username), [
      { username: unverified.username, name: unverified.displayName },
    ]);
    assert.deepEqual(await suggestMentionUsernames(dal, '%'), []);
    assert.deepEqual(await suggestMentionUsernames(dal, ''), []);
  } finally {
    await cleanup(dal, `mention-suggest-${run}`, userIds);
  }
});

test('A mention notification names who mentioned you and where', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    options ? `${key}${JSON.stringify(options)}` : key) as unknown as TFunction;
  const text = renderNotificationText(
    { id: 'n1', kind: 'mention', actorName: 'Erik <b>', subject: 'Values', createdAt: new Date() } as never,
    t
  );
  assert.ok(text.startsWith('notifications.kind.mention'));
  assert.ok(text.includes('Erik &lt;b&gt;'));
});
