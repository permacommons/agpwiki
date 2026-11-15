import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { registerNotificationRoutes } from '../src/routes/notifications.js';
import { createSession } from '../src/auth/session.js';
import { NotFoundError } from '../src/lib/errors.js';
import { FORUM_MODERATOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { processForumReplyCreatedNotification, FORUM_REPLY_CREATED_NOTIFICATION } from '../src/services/forum-notification-service.js';
import { markNotificationJobProcessed } from '../src/services/notification-queue.js';
import { isUserSubscribedToForumThread, subscribeUserToForumThread } from '../src/services/forum-subscription-service.js';
import {
  countUnreadNotifications,
  createSiteNotification,
  findLatestUnreadNotification,
  listSiteNotifications,
  markSiteNotificationsRead,
  openSiteNotification,
} from '../src/services/site-notification-service.js';
import { createForumComment, createForumThread, deleteForumComment } from '../src/services/forum-service.js';
import NotificationDelivery from '../src/models/notification-delivery.js';
import NotificationJob from '../src/models/notification-job.js';
import { createTestUser, createVerifiedTestUser, getDal } from './_service-fixtures.js';

test('Forum replies auto-subscribe participants and enqueue a notification job', async () => {
  const dal = await getDal();
  const baseTitle = `forum-notify-${Date.now()}`;

  const creator = await createTestUser();
  const replier = await createTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    creator.id
  );

  assert.equal(await isUserSubscribedToForumThread(thread.id, creator.id), true);

  const reply = await createForumComment(
    {
      threadId: thread.id,
      body: 'First reply.',
      language: 'en',
    },
    replier.id
  );

  assert.equal(await isUserSubscribedToForumThread(thread.id, replier.id), true);

  const matchingJob = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(matchingJob);
  assert.equal(matchingJob.payload?.actorUserId, replier.id);
  assert.equal(matchingJob.payload?.commentId, reply.id);
  assert.deepEqual(matchingJob.payload?.recipientUserIds, [creator.id]);
});

test('Forum notification processing emails subscribed verified users with notifications enabled', async () => {
  const dal = await getDal();
  const baseTitle = `forum-delivery-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const recipient = await createVerifiedTestUser();
  const muted = await createVerifiedTestUser();

  muted.notificationPreferences = { 'forum.reply': 'site' };
  await muted.save();

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, recipient.id);
  await subscribeUserToForumThread(thread.id, muted.id);

  await createForumComment(
    {
      threadId: thread.id,
      body: 'A **useful** reply with [a link](https://example.com).',
      language: 'en',
    },
    actor.id
  );

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);

  const sent: Array<{ to: string; subject: string; text: string }> = [];
  await processForumReplyCreatedNotification(dal, job, async message => {
    sent.push({
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { delivered: true as const, skipped: false as const };
  });
  await markNotificationJobProcessed(job.id);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, recipient.email);

  const deliveries = await NotificationDelivery.filterWhere({ jobId: job.id, channel: 'email' }).run();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.userId, recipient.id);
  assert.equal(deliveries[0]?.status, 'sent');
});

test('Forum reply notifications follow each person\'s channel choice and are not repeated', async () => {
  const dal = await getDal();
  const baseTitle = `forum-channels-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const both = await createVerifiedTestUser();
  const siteOnly = await createVerifiedTestUser();
  const emailOnly = await createVerifiedTestUser();
  const none = await createVerifiedTestUser();
  const unverified = await createTestUser();
  siteOnly.notificationPreferences = { 'forum.reply': 'site' };
  emailOnly.notificationPreferences = { 'forum.reply': 'email' };
  none.notificationPreferences = { 'forum.reply': 'none' };
  await Promise.all([siteOnly.save(), emailOnly.save(), none.save()]);

  const thread = await createForumThread(
    { category: 'general', title: baseTitle, body: 'Opening post.', language: 'en' },
    actor.id
  );
  for (const user of [both, siteOnly, emailOnly, none, unverified]) {
    await subscribeUserToForumThread(thread.id, user.id);
  }
  const reply = await createForumComment(
    { threadId: thread.id, body: 'A reply <b>with</b> markup.', language: 'en' },
    actor.id
  );

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);
  const emailed: string[] = [];
  const send = async (message: { to: string }) => {
    emailed.push(message.to);
    return { delivered: true as const, skipped: false as const };
  };
  const result = await processForumReplyCreatedNotification(dal, job, send);
  assert.equal(result.sentCount, 2);
  assert.equal(result.siteCount, 3);
  assert.deepEqual(emailed.sort(), [both.email, emailOnly.email].sort());

  const notified = await dal.query(
    'SELECT user_id, kind, url, subject, actor_user_id FROM notifications WHERE job_id = $1',
    [job.id]
  );
  const rows = notified.rows as Array<{ user_id: string; kind: string; url: string; subject: string; actor_user_id: string }>;
  // Unverified people get on-site notifications, just no email.
  assert.deepEqual(rows.map(row => row.user_id).sort(), [both.id, siteOnly.id, unverified.id].sort());
  assert.equal(rows[0].kind, 'forum.reply');
  assert.equal(rows[0].subject, baseTitle);
  assert.equal(rows[0].actor_user_id, actor.id);
  // Forum replies link to the comment inside its section's discussion.
  assert.ok(rows[0].url.startsWith('/tool/forum/general?thread='));
  assert.ok(rows[0].url.endsWith(`#comment-${reply.id}`));

  // A retried job delivers nothing twice.
  const again = await processForumReplyCreatedNotification(dal, job, send);
  assert.equal(again.sentCount, 0);
  assert.equal(again.siteCount ?? 0, 0);
  assert.equal(emailed.length, 2);
  const count = await dal.query('SELECT COUNT(*)::int AS n FROM notifications WHERE job_id = $1', [job.id]);
  assert.equal((count.rows[0] as { n: number }).n, 3);
});

test('Site notifications can be counted, listed, opened and marked as read by their owner only', async () => {
  const dal = await getDal();
  const owner = await createTestUser();
  const other = await createTestUser();

  const first = await createSiteNotification(dal, {
    userId: owner.id,
    kind: 'forum.reply',
    actorUserId: other.id,
    url: '/tool/forum/thread/a#comment-1',
    subject: 'First',
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await createSiteNotification(dal, {
    userId: owner.id,
    kind: 'forum.reply',
    actorUserId: other.id,
    url: 'https://example.com/elsewhere',
    subject: 'Second',
    excerpt: 'Excerpt.',
  });

  assert.equal(await countUnreadNotifications(dal, owner.id), 2);
  const latest = await findLatestUnreadNotification(dal, owner.id);
  assert.equal(latest?.id, second);
  assert.equal(latest?.actorName, other.displayName);
  // Links never leave the site.
  assert.equal(latest?.url, '/');

  await assert.rejects(() => openSiteNotification(dal, other.id, first), NotFoundError);
  assert.equal(await openSiteNotification(dal, owner.id, first), '/tool/forum/thread/a#comment-1');
  assert.equal(await countUnreadNotifications(dal, owner.id), 1);

  // Malformed IDs are unknown notifications: nothing opens, nothing is marked read.
  await assert.rejects(() => openSiteNotification(dal, owner.id, 'x'), NotFoundError);
  assert.equal(await markSiteNotificationsRead(dal, owner.id, 'x'), 0);
  assert.equal(await countUnreadNotifications(dal, owner.id), 1);

  assert.equal(await markSiteNotificationsRead(dal, other.id), 0);
  assert.equal(await markSiteNotificationsRead(dal, owner.id), 1);
  assert.equal(await countUnreadNotifications(dal, owner.id), 0);
  assert.equal(await findLatestUnreadNotification(dal, owner.id), null);

  const list = await listSiteNotifications(dal, owner.id);
  assert.deepEqual(list.map(item => item.subject), ['Second', 'First']);
  assert.ok(list.every(item => item.readAt instanceof Date));
});

test('Notification pages expose older entries and mark all unread entries as read', async () => {
  const dal = await getDal();
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.t = ((key: string, options?: Record<string, unknown>) => {
      if (key === 'notifications.kind.forumReply') return `${options?.name} ${options?.subject}`;
      return options ? `${key}${JSON.stringify(options)}` : key;
    }) as typeof req.t;
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ bodyHtml: options?.bodyHtml });
    }) as express.Response['render'];
    next();
  });
  registerNotificationRoutes(app);
  const server = http.createServer(app);

  try {
    const user = await createTestUser();
    const session = await createSession(user.id);
    const headers = { cookie: `agpwiki_session=${session.token}` };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/tool/notifications`;
    const getPage = async (query = '') => {
      const response = await fetch(`${url}${query}`, { headers });
      assert.equal(response.status, 200);
      return ((await response.json()) as { bodyHtml: string }).bodyHtml;
    };
    const empty = await getPage('?page=999');
    assert.ok(empty.includes('notifications.empty'));
    assert.ok(!empty.includes('notifications.markAllRead'));

    await dal.query(`INSERT INTO notifications (user_id, kind, url, subject, created_at, read_at)
      SELECT $1, 'forum.reply', '/tool/forum', 'Notification ' || n,
             NOW() - n * INTERVAL '1 second', CASE WHEN n <= 200 THEN NOW() ELSE NULL END
        FROM generate_series(1, 205) AS n`, [user.id]);
    const pages = await Promise.all([getPage(), getPage('?page=2'), getPage('?page=3')]);
    assert.deepEqual(pages.map(html => (html.match(/class="notification-item(?: notification-item--unread)?"/g) ?? []).length), [100, 100, 5]);
    const ids = pages.flatMap(html => [...html.matchAll(/href="\/tool\/notifications\/([^/]+)\/open"/g)].map(match => match[1]));
    assert.equal(new Set(ids).size, 205);
    assert.ok(!pages[0].includes('notification-item--unread'));
    assert.ok(pages[0].includes('notifications.markAllRead'));
    assert.ok(pages[2].includes('notification-item--unread'));
    assert.ok(pages[2].includes('name="return" value="/tool/notifications?page=3"'));
    for (const query of ['?page=invalid', '?page=-1', '?page=1&page=2']) {
      assert.equal(await getPage(query), pages[0]);
    }
    assert.equal(await getPage('?page=999999999999999999999'), pages[2]);

    const response = await fetch(`${url}/read`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ return: '/tool/notifications?page=3' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/tool/notifications?page=3');
    assert.equal(await countUnreadNotifications(dal, user.id), 0);
    assert.ok(!(await getPage()).includes('notifications.markAllRead'));
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  }
});

test('Forum notification processing includes reply excerpt and comment link', async () => {
  const dal = await getDal();
  const baseTitle = `forum-delivery-content-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const recipient = await createVerifiedTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, recipient.id);

  const reply = await createForumComment(
    {
      threadId: thread.id,
      body: 'A **useful** reply with [a link](https://example.com).',
      language: 'en',
    },
    actor.id
  );

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);

  const sent: Array<{ subject: string; text: string }> = [];
  await processForumReplyCreatedNotification(dal, job, async message => {
    sent.push({
      subject: message.subject,
      text: message.text,
    });
    return { delivered: true as const, skipped: false as const };
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.subject ?? '', new RegExp(baseTitle));
  assert.match(sent[0]?.text ?? '', /useful reply with a link/i);
  assert.match(sent[0]?.text ?? '', new RegExp(reply.id));
});

test('Forum notification processing records disabled email delivery as skipped', async () => {
  const dal = await getDal();
  const baseTitle = `forum-skipped-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const recipient = await createVerifiedTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, recipient.id);

  await createForumComment(
    {
      threadId: thread.id,
      body: 'Reply while email delivery is disabled.',
      language: 'en',
    },
    actor.id
  );

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);

  const result = await processForumReplyCreatedNotification(dal, job, async () => ({
    delivered: false as const,
    skipped: true as const,
  }));
  assert.equal(result.sentCount, 0);

  const deliveries = await NotificationDelivery.filterWhere({ jobId: job.id, channel: 'email' }).run();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.userId, recipient.id);
  assert.equal(deliveries[0]?.status, 'skipped');
});

test('Forum notification titles and excerpts decode HTML entities once', async () => {
  const dal = await getDal();
  const baseTitle = `forum-entities-${Date.now()}`;
  const title = `${baseTitle} Here's ": & <b>wording</b> &amp;`;

  const actor = await createVerifiedTestUser();
  const recipient = await createVerifiedTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, recipient.id);

  await createForumComment(
    {
      threadId: thread.id,
      body: '<b>boo</b> boo',
      language: 'en',
    },
    actor.id
  );

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);

  const sent: Array<{ subject: string; text: string; html?: string }> = [];
  await processForumReplyCreatedNotification(dal, job, async message => {
    sent.push({
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { delivered: true as const, skipped: false as const };
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.subject, `New reply in: ${title}`);
  assert.ok(sent[0]?.text.includes(`in "${title}"`));
  assert.ok(sent[0]?.html?.includes(`${baseTitle} Here&#39;s &quot;: &amp; &lt;b&gt;wording&lt;/b&gt; &amp;amp;`));
  const notifications = await listSiteNotifications(dal, recipient.id);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].subject, title);
  assert.match(sent[0]?.text ?? '', /\n\n<b>boo<\/b> boo\n\n/);
  assert.match(sent[0]?.html ?? '', /&lt;b&gt;boo&lt;\/b&gt; boo/);
});

test('Forum notification retry skips recipients already marked sent', async () => {
  const dal = await getDal();
  const baseTitle = `forum-retry-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const firstRecipient = await createVerifiedTestUser();
  const secondRecipient = await createVerifiedTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, firstRecipient.id);
  await subscribeUserToForumThread(thread.id, secondRecipient.id);

  await createForumComment(
    {
      threadId: thread.id,
      body: 'Reply that will partially fail.',
      language: 'en',
    },
    actor.id
  );

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);

  // Recipients come in no particular order, so the second attempt fails, whoever it is for.
  const firstPassSent: string[] = [];
  await assert.rejects(async () => {
    await processForumReplyCreatedNotification(dal, job, async message => {
      firstPassSent.push(message.to);
      if (firstPassSent.length === 2) throw new Error('Simulated provider failure');
      return { delivered: true as const, skipped: false as const };
    });
  });

  assert.deepEqual([...firstPassSent].sort(), [firstRecipient.email, secondRecipient.email].sort());

  const secondPassSent: string[] = [];
  await processForumReplyCreatedNotification(dal, job, async message => {
    secondPassSent.push(message.to);
    return { delivered: true as const, skipped: false as const };
  });

  assert.deepEqual(secondPassSent, [firstPassSent[1]]);
});

test('Forum reply notifications use recipients captured at enqueue time', async () => {
  const dal = await getDal();
  const baseTitle = `forum-snapshot-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const earlyRecipient = await createVerifiedTestUser();
  const lateRecipient = await createVerifiedTestUser();

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, earlyRecipient.id);

  await createForumComment(
    {
      threadId: thread.id,
      body: 'Reply before late recipient subscribes.',
      language: 'en',
    },
    actor.id
  );

  await subscribeUserToForumThread(thread.id, lateRecipient.id);

  const job = await findQueuedForumReplyJobByThreadId(thread.id);
  assert.ok(job);
  assert.deepEqual(job.payload.recipientUserIds, [earlyRecipient.id]);

  const sent: string[] = [];
  await processForumReplyCreatedNotification(dal, job, async message => {
    sent.push(message.to);
    return { delivered: true as const, skipped: false as const };
  });

  assert.deepEqual(sent, [earlyRecipient.email]);
});

test('Forum notification processing skips deleted comments without retrying', async () => {
  const dal = await getDal();
  const baseTitle = `forum-deleted-notification-${Date.now()}`;

  const actor = await createVerifiedTestUser();
  const recipient = await createVerifiedTestUser();
  const moderator = await createTestUser();
  await grantRoleUpsert(dal, moderator.id, FORUM_MODERATOR_ROLE);

  const thread = await createForumThread(
    {
      category: 'general',
      title: baseTitle,
      body: 'Opening post.',
      language: 'en',
    },
    actor.id
  );
  await subscribeUserToForumThread(thread.id, recipient.id);

  const reply = await createForumComment(
    {
      threadId: thread.id,
      body: 'Reply that will be deleted before notification processing.',
      language: 'en',
    },
    actor.id
  );

  await deleteForumComment(
    dal,
    {
      commentId: reply.id,
      revSummary: { en: 'Delete queued reply before notification delivery.' },
    },
    moderator.id
  );

  const job = await findQueuedForumReplyJobByCommentId(reply.id);
  assert.ok(job);

  let sendAttempts = 0;
  const result = await processForumReplyCreatedNotification(dal, job, async () => {
    sendAttempts += 1;
    return { delivered: true as const, skipped: false as const };
  });

  assert.equal(sendAttempts, 0);
  assert.equal(result.sentCount, 0);
  assert.equal(result.skipped, 'comment_not_found');

  const deliveries = await NotificationDelivery.filterWhere({ jobId: job.id, channel: 'email' }).run();
  assert.equal(deliveries.length, 0);
});

const findQueuedForumReplyJobByThreadId = async (threadId: string) => {
  const jobs = await NotificationJob.filterWhere({
    type: FORUM_REPLY_CREATED_NOTIFICATION,
    status: 'pending',
  }).run();
  return jobs.find(job => job.payload?.threadId === threadId);
};

const findQueuedForumReplyJobByCommentId = async (commentId: string) => {
  const jobs = await NotificationJob.filterWhere({ type: FORUM_REPLY_CREATED_NOTIFICATION, status: 'pending' }).run();
  return jobs.find(job => job.payload?.commentId === commentId);
};
