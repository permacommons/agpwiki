import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { createSession } from '../src/auth/session.js';
import { hashToken } from '../src/auth/tokens.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createBlogPost } from '../src/services/blog-post-service.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import {
  FORUM_MODERATOR_ROLE,
  WIKI_ADMIN_ROLE,
  grantRoleUpsert,
} from '../src/services/roles.js';
import { findExistingWikiLinkSlugs } from '../src/services/wiki-link-preview-service.js';
import {
  createCitation,
  deleteCitation,
  readCitation,
  updateCitation,
} from '../src/services/citation-service.js';
import {
  createCitationClaim,
  readCitationClaim,
  updateCitationClaim,
} from '../src/services/citation-claim-service.js';
import {
  blockUserAccount,
  getAccountLifecycleState,
  unblockUserAccount,
} from '../src/services/account-lifecycle.js';
import {
  createPasswordResetToken,
  requestPasswordReset,
  resetPasswordWithToken,
} from '../src/services/password-reset.js';
import {
  processForumReplyCreatedNotification,
  FORUM_REPLY_CREATED_NOTIFICATION,
} from '../src/services/forum-notification-service.js';
import {
  claimPendingNotificationJobs,
  resetProcessingNotificationJobs,
  markNotificationJobProcessed,
} from '../src/services/notification-queue.js';
import {
  isUserSubscribedToForumThread,
  subscribeUserToForumThread,
} from '../src/services/forum-subscription-service.js';
import { createPageCheck } from '../src/services/page-check-service.js';
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
import {
  addWikiPageAlias,
  applyWikiPagePatch,
  createWikiPage,
  deleteWikiPage,
  listWikiPageRevisions,
  readWikiPage,
  replaceWikiPageExactText,
  rewriteWikiPageSection,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';
import AuthSession from '../src/models/auth-session.js';
import NotificationDelivery from '../src/models/notification-delivery.js';
import NotificationJob from '../src/models/notification-job.js';
import PasswordResetToken from '../src/models/password-reset-token.js';
import User from '../src/models/user.js';
import { renderMarkdown } from '../src/render.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

const getDal = async () => {
  if (sharedDal) return sharedDal;
  sharedDal = await initializePostgreSQL();
  return sharedDal;
};

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

test('Service unblockUserAccount clears blocked account state', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

    await blockUserAccount(dal, user.id, user.id, 'Test block');
    const blockedState = await getAccountLifecycleState(user.id);
    assert.equal(blockedState?.isBlocked, true);

    await unblockUserAccount(user.id);
    const unblockedState = await getAccountLifecycleState(user.id);

    assert.equal(unblockedState?.isBlocked, false);
    assert.equal(unblockedState?.user.blockedAt, null);
    assert.equal(unblockedState?.user.blockedBy, null);
    assert.equal(unblockedState?.user.blockReason, null);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service resetPasswordWithToken updates password and revokes sessions', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    user.passwordHash = await hashPassword('old-password');
    await user.save();

    const session = await createSession(user.id);
    const { token } = await createPasswordResetToken(user);
    const { token: otherToken } = await createPasswordResetToken(user);
    const records = await PasswordResetToken.filterWhere({ userId: user.id }).run();

    assert.equal(records.length, 2);
    assert.notEqual(records[0]?.tokenHash, token);
    assert.equal(records.every(record => record.usedAt === null), true);

    const resetUser = await resetPasswordWithToken(dal, token, 'new-password');
    assert.equal(resetUser?.id, user.id);

    const reloadedUser = await User.filterWhere({ id: user.id }).first();
    assert.ok(reloadedUser);
    assert.equal(await verifyPassword('new-password', reloadedUser.passwordHash), true);
    assert.equal(await verifyPassword('old-password', reloadedUser.passwordHash), false);

    const usedRecords = await PasswordResetToken.filterWhere({ userId: user.id }).run();
    assert.equal(usedRecords.every(record => Boolean(record.usedAt)), true);

    const activeSession = await AuthSession.findActiveByHash(hashToken(session.token));
    assert.equal(activeSession, null);

    const secondUse = await resetPasswordWithToken(dal, token, 'another-password');
    assert.equal(secondUse, null);

    const otherUse = await resetPasswordWithToken(dal, otherToken, 'another-password');
    assert.equal(otherUse, null);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service requestPasswordReset skips blocked accounts', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    await blockUserAccount(dal, user.id, user.id, 'Test block');

    const result = await requestPasswordReset(user.email);
    const records = await PasswordResetToken.filterWhere({ userId: user.id }).run();

    assert.equal(result.requested, false);
    assert.equal(records.length, 0);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum replies auto-subscribe participants and enqueue a notification job', async () => {
  const dal = await getDal();
  const baseTitle = `forum-notify-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let creatorIdForCleanup: string | null = null;
  let replierIdForCleanup: string | null = null;

  try {
    const creator = await createTestUser();
    const replier = await createTestUser();
    creatorIdForCleanup = creator.id;
    replierIdForCleanup = replier.id;

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
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        creatorIdForCleanup,
        replierIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum notification processing emails subscribed verified users with notifications enabled', async () => {
  const dal = await getDal();
  const baseTitle = `forum-delivery-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let recipientIdForCleanup: string | null = null;
  let mutedIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const recipient = await createVerifiedTestUser();
    const muted = await createVerifiedTestUser();
    actorIdForCleanup = actor.id;
    recipientIdForCleanup = recipient.id;
    mutedIdForCleanup = muted.id;

    muted.emailNotificationsEnabled = false;
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

    const job = await claimQueuedForumReplyJobByThreadId(dal, thread.id);
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

    const deliveries = await NotificationDelivery.filterWhere({ jobId: job.id }).run();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.userId, recipient.id);
    assert.equal(deliveries[0]?.status, 'sent');
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        recipientIdForCleanup,
        mutedIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum notification processing includes reply excerpt and comment link', async () => {
  const dal = await getDal();
  const baseTitle = `forum-delivery-content-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let recipientIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const recipient = await createVerifiedTestUser();
    actorIdForCleanup = actor.id;
    recipientIdForCleanup = recipient.id;

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

    const job = await claimQueuedForumReplyJobByThreadId(dal, thread.id);
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
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        recipientIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum notification processing records disabled email delivery as skipped', async () => {
  const dal = await getDal();
  const baseTitle = `forum-skipped-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let recipientIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const recipient = await createVerifiedTestUser();
    actorIdForCleanup = actor.id;
    recipientIdForCleanup = recipient.id;

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

    const job = await claimQueuedForumReplyJobByThreadId(dal, thread.id);
    assert.ok(job);

    const result = await processForumReplyCreatedNotification(dal, job, async () => ({
      delivered: false as const,
      skipped: true as const,
    }));
    assert.equal(result.sentCount, 0);

    const deliveries = await NotificationDelivery.filterWhere({ jobId: job.id }).run();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.userId, recipient.id);
    assert.equal(deliveries[0]?.status, 'skipped');
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        recipientIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum notification excerpt decodes escaped markdown HTML entities', async () => {
  const dal = await getDal();
  const baseTitle = `forum-entities-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let recipientIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const recipient = await createVerifiedTestUser();
    actorIdForCleanup = actor.id;
    recipientIdForCleanup = recipient.id;

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
        body: '<b>boo</b> boo',
        language: 'en',
      },
      actor.id
    );

    const job = await claimQueuedForumReplyJobByThreadId(dal, thread.id);
    assert.ok(job);

    const sent: Array<{ text: string; html?: string }> = [];
    await processForumReplyCreatedNotification(dal, job, async message => {
      sent.push({
        text: message.text,
        html: message.html,
      });
      return { delivered: true as const, skipped: false as const };
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /\n\n<b>boo<\/b> boo\n\n/);
    assert.match(sent[0]?.html ?? '', /&lt;b&gt;boo&lt;\/b&gt; boo/);
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        recipientIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum notification retry skips recipients already marked sent', async () => {
  const dal = await getDal();
  const baseTitle = `forum-retry-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let firstRecipientIdForCleanup: string | null = null;
  let secondRecipientIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const firstRecipient = await createVerifiedTestUser();
    const secondRecipient = await createVerifiedTestUser();
    actorIdForCleanup = actor.id;
    firstRecipientIdForCleanup = firstRecipient.id;
    secondRecipientIdForCleanup = secondRecipient.id;

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

    const job = await claimQueuedForumReplyJobByThreadId(dal, thread.id);
    assert.ok(job);

    const firstPassSent: string[] = [];
    let firstFailure = false;
    await assert.rejects(async () => {
      await processForumReplyCreatedNotification(dal, job, async message => {
        firstPassSent.push(message.to);
        if (message.to === secondRecipient.email && !firstFailure) {
          firstFailure = true;
          throw new Error('Simulated provider failure');
        }
        return { delivered: true as const, skipped: false as const };
      });
    });

    assert.deepEqual(firstPassSent, [firstRecipient.email, secondRecipient.email]);

    const secondPassSent: string[] = [];
    await processForumReplyCreatedNotification(dal, job, async message => {
      secondPassSent.push(message.to);
      return { delivered: true as const, skipped: false as const };
    });

    assert.deepEqual(secondPassSent, [secondRecipient.email]);
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        firstRecipientIdForCleanup,
        secondRecipientIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum reply notifications use recipients captured at enqueue time', async () => {
  const dal = await getDal();
  const baseTitle = `forum-snapshot-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let earlyRecipientIdForCleanup: string | null = null;
  let lateRecipientIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const earlyRecipient = await createVerifiedTestUser();
    const lateRecipient = await createVerifiedTestUser();
    actorIdForCleanup = actor.id;
    earlyRecipientIdForCleanup = earlyRecipient.id;
    lateRecipientIdForCleanup = lateRecipient.id;

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

    const job = await claimQueuedForumReplyJobByThreadId(dal, thread.id);
    assert.ok(job);
    assert.deepEqual(job.payload.recipientUserIds, [earlyRecipient.id]);

    const sent: string[] = [];
    await processForumReplyCreatedNotification(dal, job, async message => {
      sent.push(message.to);
      return { delivered: true as const, skipped: false as const };
    });

    assert.deepEqual(sent, [earlyRecipient.email]);
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        earlyRecipientIdForCleanup,
        lateRecipientIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum notification processing skips deleted comments without retrying', async () => {
  const dal = await getDal();
  const baseTitle = `forum-deleted-notification-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let actorIdForCleanup: string | null = null;
  let recipientIdForCleanup: string | null = null;
  let moderatorIdForCleanup: string | null = null;

  try {
    const actor = await createVerifiedTestUser();
    const recipient = await createVerifiedTestUser();
    const moderator = await createTestUser();
    actorIdForCleanup = actor.id;
    recipientIdForCleanup = recipient.id;
    moderatorIdForCleanup = moderator.id;
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

    const job = await claimQueuedForumReplyJobByCommentId(dal, reply.id);
    assert.ok(job);

    let sendAttempts = 0;
    const result = await processForumReplyCreatedNotification(dal, job, async () => {
      sendAttempts += 1;
      return { delivered: true as const, skipped: false as const };
    });

    assert.equal(sendAttempts, 0);
    assert.equal(result.sentCount, 0);
    assert.equal(result.skipped, 'comment_not_found');

    const deliveries = await NotificationDelivery.filterWhere({ jobId: job.id }).run();
    assert.equal(deliveries.length, 0);
  } finally {
    try {
      await cleanupNotificationScenario(dal, forumThreadPrefix, [
        actorIdForCleanup,
        recipientIdForCleanup,
        moderatorIdForCleanup,
      ]);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Notification worker startup reset returns processing jobs to pending', async () => {
  const dal = await getDal();

  try {
    await NotificationJob.create({
      type: FORUM_REPLY_CREATED_NOTIFICATION,
      payload: {
        threadId: '00000000-0000-4000-8000-000000000001',
        commentId: '00000000-0000-4000-8000-000000000002',
        actorUserId: '00000000-0000-4000-8000-000000000003',
      },
      status: 'processing',
      availableAt: new Date(),
      lockedAt: new Date(),
      lockToken: '00000000-0000-4000-8000-000000000004',
      attemptCount: 0,
      createdAt: new Date(),
    });

    const resetCount = await resetProcessingNotificationJobs(dal);
    assert.equal(resetCount, 1);

    const jobs = await NotificationJob.filterWhere({
      type: FORUM_REPLY_CREATED_NOTIFICATION,
    }).run();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, 'pending');
    assert.equal(jobs[0]?.lockedAt ?? null, null);
    assert.equal(jobs[0]?.lockToken ?? null, null);
  } finally {
    await dal.query('DELETE FROM notification_deliveries');
    await dal.query('DELETE FROM notification_jobs');
  }
});

const createTestUser = async () => {
  const email = `service-test-${Date.now()}@example.com`;
  const user = await User.create({
    username: `servicetest${Date.now()}`,
    displayName: 'Service Test',
    email,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });

  return user;
};

const createVerifiedTestUser = async () => {
  const user = await createTestUser();
  user.emailVerifiedAt = new Date();
  await user.save();
  return user;
};

const findQueuedForumReplyJobByThreadId = async (threadId: string) => {
  const jobs = await NotificationJob.filterWhere({
    type: FORUM_REPLY_CREATED_NOTIFICATION,
    status: 'pending',
  }).run();
  return jobs.find(job => job.payload?.threadId === threadId);
};

const claimQueuedForumReplyJobByThreadId = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  threadId: string
) => {
  const claimed = await claimPendingNotificationJobs(dal, 10);
  return claimed.jobs.find(entry => entry.payload.threadId === threadId);
};

const claimQueuedForumReplyJobByCommentId = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  commentId: string
) => {
  const claimed = await claimPendingNotificationJobs(dal, 10);
  return claimed.jobs.find(entry => entry.payload.commentId === commentId);
};

const cleanupNotificationScenario = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  forumThreadPrefix: string,
  userIds: Array<string | null>
) => {
  await dal.query('DELETE FROM notification_deliveries');
  await dal.query('DELETE FROM notification_jobs');
  let shouldDeleteThreads = true;
  for (const userId of userIds) {
    await cleanupTestArtifacts(dal, {
      forumThreadPrefix: shouldDeleteThreads ? forumThreadPrefix : undefined,
      userId: userId ?? undefined,
    });
    shouldDeleteThreads = false;
  }
};

const cleanupTestArtifacts = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  {
    slugPrefix,
    citationPrefix,
    claimPrefix,
    forumThreadPrefix,
    userId,
  }: {
    slugPrefix?: string;
    citationPrefix?: string;
    claimPrefix?: string;
    forumThreadPrefix?: string;
    userId?: string;
  }
) => {
  if (slugPrefix) {
    await dal.query('DELETE FROM page_aliases WHERE slug LIKE $1', [slugPrefix]);
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (citationPrefix) {
    await dal.query(
      'DELETE FROM citation_claims WHERE citation_id IN (SELECT id FROM citations WHERE key LIKE $1)',
      [citationPrefix]
    );
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [citationPrefix]);
  }
  if (claimPrefix) {
    await dal.query('DELETE FROM citation_claims WHERE claim_id LIKE $1', [claimPrefix]);
  }
  if (forumThreadPrefix) {
    await dal.query(
      "DELETE FROM forum_thread_subscriptions WHERE thread_id IN (SELECT id FROM forum_threads WHERE title->>'en' LIKE $1)",
      [forumThreadPrefix]
    );
    await dal.query(
      "DELETE FROM forum_comments WHERE thread_id IN (SELECT id FROM forum_threads WHERE title->>'en' LIKE $1)",
      [forumThreadPrefix]
    );
    await dal.query("DELETE FROM forum_threads WHERE title->>'en' LIKE $1", [forumThreadPrefix]);
  }
  if (userId) {
    await dal.query('DELETE FROM notification_deliveries WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM forum_thread_subscriptions WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM api_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM oauth_access_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM oauth_refresh_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM oauth_authorization_codes WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM agent_access_requests WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM user_notice_dismissals WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

test('Service auth + wiki create/update writes revisions', async () => {
  const dal = await getDal();
  const slug = `test-mcp-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'MCP Test' },
        body: { en: 'Initial content.' },
        originalLanguage: 'en',
      },
      userId,
    );

    await updateWikiPage(
      dal,
      {
        slug,
        body: { en: 'Updated content.' },
        revSummary: { en: 'Update content.' },
      },
      userId,
    );

    const revisions = await listWikiPageRevisions(dal, slug);
    assert.equal(revisions.pageId.length > 0, true);
    assert.ok(revisions.revisions.length >= 2);
    assert.ok(revisions.revisions.every(rev => rev.revUser === userId));
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service readWikiPage returns a stable content hash that changes on update', async () => {
  const dal = await getDal();
  const slug = `test-mcp-content-hash-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Hash Test' },
        body: { en: 'Initial content.' },
        originalLanguage: 'en',
      },
      userId
    );

    const firstRead = await readWikiPage(dal, slug);
    const secondRead = await readWikiPage(dal, slug);
    assert.match(firstRead.currentRevId, /^[0-9a-f-]{36}$/);
    assert.equal(firstRead.contentHash.length, 64);
    assert.equal(firstRead.contentHash, secondRead.contentHash);
    assert.equal(firstRead.currentRevId, secondRead.currentRevId);

    await updateWikiPage(
      dal,
      {
        slug,
        body: { en: 'Updated content.' },
        revSummary: { en: 'Update hash source.' },
      },
      userId
    );

    const updatedRead = await readWikiPage(dal, slug);
    assert.notEqual(updatedRead.contentHash, firstRead.contentHash);
    assert.notEqual(updatedRead.currentRevId, firstRead.currentRevId);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service updateWikiPage preserves other localized entries', async () => {
  const dal = await getDal();
  const slug = `test-page-localized-update-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Original English title', fr: 'Titre francais original' },
        body: { en: 'English body.', fr: 'Corps francais original.' },
        originalLanguage: 'en',
      },
      userId
    );

    await updateWikiPage(
      dal,
      {
        slug,
        title: { fr: 'Titre francais mis a jour' },
        body: { fr: 'Corps francais mis a jour.' },
        revSummary: { fr: 'Mettre a jour la version francaise.' },
      },
      userId
    );

    const page = await readWikiPage(dal, slug);
    assert.equal(page.title?.en, 'Original English title');
    assert.equal(page.title?.fr, 'Titre francais mis a jour');
    assert.equal(page.body?.en, 'English body.');
    assert.equal(page.body?.fr, 'Corps francais mis a jour.');
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service apply patch updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Patch Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = [
      '--- before',
      '+++ after',
      '@@ -1 +1 @@',
      '-Hello old world',
      '+Hello new world',
    ].join('\n');

    const result = await applyWikiPagePatch(
      dal,
      {
        slug,
        patch,
        format: 'unified',
        lang: 'en',
        revSummary: { en: 'Patch update.' },
      },
      userId
    );

    assert.equal(result.body?.en, 'Hello new world');
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects malformed unified patch hunks', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-invalid-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Patch Invalid Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = ['--- before', '+++ after', '@@', '-Hello old world', '+Hello new world'].join(
      '\n'
    );

    await assert.rejects(
      () =>
        applyWikiPagePatch(
          dal,
          {
            slug,
            patch,
            format: 'unified',
            lang: 'en',
            revSummary: { en: 'Invalid patch update.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Invalid @@ hunk header'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Forum services create threads/comments and list categories', async () => {
  const dal = await getDal();
  const baseTitle = `forum-test-${Date.now()}`;
  const titlePrefix = `${baseTitle}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

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
    assert.equal(detail.thread.originalLanguage, 'en');
    assert.equal(detail.comments.length, 2);
    assert.equal(threadList.some(item => item.id === thread.id), true);
  } finally {
    await cleanupTestArtifacts(dal, {
      forumThreadPrefix: titlePrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Forum moderator can pin and delete thread and comments', async () => {
  const dal = await getDal();
  const baseTitle = `forum-moderation-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let authorIdForCleanup: string | null = null;
  let moderatorIdForCleanup: string | null = null;

  try {
    const author = await createTestUser();
    const moderator = await createTestUser();
    authorIdForCleanup = author.id;
    moderatorIdForCleanup = moderator.id;
    await grantRoleUpsert(dal, moderator.id, FORUM_MODERATOR_ROLE);

    const older = await createForumThread(
      {
        category: 'technology',
        title: `${baseTitle}-older`,
        body: 'Older thread.',
        language: 'en',
      },
      author.id
    );
    const newer = await createForumThread(
      {
        category: 'technology',
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

    const threadList = await listForumThreads(dal, 'technology');
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
  } finally {
    await cleanupTestArtifacts(dal, {
      forumThreadPrefix,
      userId: authorIdForCleanup ?? undefined,
    });
    await cleanupTestArtifacts(dal, {
      userId: moderatorIdForCleanup ?? undefined,
    });
  }
});

test('Forum article threads normalize aliases and reject invalid slugs', async () => {
  const dal = await getDal();
  const slug = `forum-article-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;
  const slugPrefix = `${slug}%`;
  const threadBaseTitle = `forum-article-thread-${Date.now()}`;
  const forumThreadPrefix = `${threadBaseTitle}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Forum Article Test' },
        body: { en: 'Body.' },
        originalLanguage: 'en',
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      forumThreadPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Forum policy threads may optionally link to a wiki page', async () => {
  const dal = await getDal();
  const slug = `forum-policy-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;
  const slugPrefix = `${slug}%`;
  const threadBaseTitle = `forum-policy-thread-${Date.now()}`;
  const forumThreadPrefix = `${threadBaseTitle}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Forum Policy Test' },
        body: { en: 'Body.' },
        originalLanguage: 'en',
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

    assert.equal(linkedThread.pageSlug, slug);
    assert.equal(genericThread.pageSlug, null);

    const linkedThreads = await listForumThreads(dal, 'policy', {
      pageSlug: slug,
    });
    assert.equal(linkedThreads.some(item => item.id === linkedThread.id), true);
    assert.equal(linkedThreads.some(item => item.id === genericThread.id), false);
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      forumThreadPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Forum moderation actions require forum moderator role', async () => {
  const dal = await getDal();
  const baseTitle = `forum-auth-${Date.now()}`;
  const forumThreadPrefix = `${baseTitle}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      forumThreadPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service rejects malformed codex patch hunks', async () => {
  const dal = await getDal();
  const slug = `test-mcp-codex-invalid-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Patch Codex Invalid Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = [
      '*** Begin Patch',
      `*** Update File: ${slug}`,
      '@@',
      '-Hello old world',
      '+Hello new world',
      '*** End Patch',
    ].join('\n');

    await assert.rejects(
      () =>
        applyWikiPagePatch(
          dal,
          {
            slug,
            patch,
            format: 'codex',
            lang: 'en',
            revSummary: { en: 'Invalid codex patch update.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Invalid @@ hunk header'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service accepts codex patch targets with a leading slash', async () => {
  const dal = await getDal();
  const slug = `test-mcp-codex-slash-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Patch Codex Slash Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = [
      '*** Begin Patch',
      `*** Update File: /${slug}`,
      '@@ -1 +1 @@',
      '-Hello old world',
      '+Hello new world',
      '*** End Patch',
    ].join('\n');

    const result = await applyWikiPagePatch(
      dal,
      {
        slug,
        patch,
        format: 'codex',
        lang: 'en',
        revSummary: { en: 'Codex patch with leading slash.' },
      },
      userId
    );

    assert.equal(result.body?.en, 'Hello new world');
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rewrite section updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const originalBody = [
      '# Title',
      '',
      '## History',
      'Old line',
      '',
      '## Details',
      'More text',
    ].join('\n');

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Rewrite Test' },
        body: { en: originalBody },
        originalLanguage: 'en',
      },
      userId
    );

    const result = await rewriteWikiPageSection(
      dal,
      {
        slug,
        heading: 'History',
        content: 'New line',
        lang: 'en',
        revSummary: { en: 'Rewrite section.' },
      },
      userId
    );

    const expectedBody = [
      '# Title',
      '',
      '## History',
      'New line',
      '',
      '## Details',
      'More text',
    ].join('\n');

    assert.equal(result.body?.en, expectedBody);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rewrite section supports lead target', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-lead-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const originalBody = ['Lead paragraph.', '', '## History', 'Old line'].join('\n');

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Rewrite Lead Test' },
        body: { en: originalBody },
        originalLanguage: 'en',
      },
      userId
    );

    const result = await rewriteWikiPageSection(
      dal,
      {
        slug,
        target: 'lead',
        content: 'Updated lead paragraph.',
        lang: 'en',
        revSummary: { en: 'Rewrite lead section.' },
      },
      userId
    );

    const expectedBody = ['Updated lead paragraph.', '', '## History', 'Old line'].join('\n');
    assert.equal(result.body?.en, expectedBody);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service replace exact text applies multiple unique replacements atomically', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Replace Exact Test' },
        body: { en: 'foo and bla' },
        originalLanguage: 'en',
      },
      userId
    );

    const result = await replaceWikiPageExactText(
      dal,
      {
        slug,
        replacements: [
          { from: 'foo', to: 'bar' },
          { from: 'bla', to: 'boo' },
        ],
        lang: 'en',
        revSummary: { en: 'Replace exact text.' },
      },
      userId
    );

    assert.equal(result.body?.en, 'bar and boo');
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service replace exact text rejects ambiguous replacements without partial edits', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-ambiguous-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Replace Exact Ambiguous Test' },
        body: { en: 'foo and bla and bla' },
        originalLanguage: 'en',
      },
      userId
    );

    await assert.rejects(
      () =>
        replaceWikiPageExactText(
          dal,
          {
            slug,
            replacements: [
              { from: 'foo', to: 'bar' },
              { from: 'bla', to: 'boo' },
            ],
            lang: 'en',
            revSummary: { en: 'Reject ambiguous replacements.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          'Exact text occurs more than once: "bla". Refusing to apply partial replacement.'
        );
        return true;
      }
    );

    const page = await readWikiPage(dal, slug);
    assert.equal(page.body?.en, 'foo and bla and bla');
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown includes bibliography entries for citations', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Agpedia Test Citation',
          URL: 'https://example.com/test-citation',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const { html } = await renderMarkdown(`Testing [@${citationKey}].`, [
      { ...(citation.data ?? {}), id: citation.key },
    ]);
    assert.match(html, /Agpedia Test Citation/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown supports adjacent bracket citations', async () => {
  const dal = await getDal();
  const citationBase = `test-cite-adj-${Date.now()}`;
  const citationPrefix = `${citationBase}%`;
  const citationKeyA = `${citationBase}-a`;
  const citationKeyB = `${citationBase}-b`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citationA = await createCitation(
      dal,
      {
        key: citationKeyA,
        data: {
          id: citationKeyA,
          type: 'webpage',
          title: 'Adjacent Citation A',
          URL: 'https://example.com/adjacent-a',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const citationB = await createCitation(
      dal,
      {
        key: citationKeyB,
        data: {
          id: citationKeyB,
          type: 'webpage',
          title: 'Adjacent Citation B',
          URL: 'https://example.com/adjacent-b',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const { html } = await renderMarkdown(
      `Testing [@${citationKeyA}][@${citationKeyB}].`,
      [
        { ...(citationA.data ?? {}), id: citationA.key },
        { ...(citationB.data ?? {}), id: citationB.key },
      ]
    );

    assert.equal((html.match(/citation-group/g) ?? []).length, 2);
    assert.doesNotMatch(html, /\[\s*<span class="citation-group">/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown links citation claims in bibliography', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-claim-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation with claim',
          URL: 'https://example.com/test-claim',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(`Testing [@${citationKey}:birthdate].`, [
      { ...(citation.data ?? {}), id: citation.key },
    ]);

    assert.match(html, new RegExp(`/cite/${citationKey}#claim-birthdate`));
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown disambiguates multiple claim refs with numeric slots', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-claim-multi-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation with multiple claim refs',
          URL: 'https://example.com/test-claim-multi',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(
      `Testing [@${citationKey}:alpha][@${citationKey}:beta].`,
      [{ ...(citation.data ?? {}), id: citation.key }]
    );

    assert.match(html, /href="#ref-1-1">1:1<\/a>/);
    assert.match(html, /href="#ref-1-2">1:2<\/a>/);
    assert.match(html, /id="ref-1-1" class="ref-claim-pair"/);
    assert.match(html, /id="ref-1-2" class="ref-claim-pair"/);
    assert.match(html, new RegExp(`/cite/${citationKey}#claim-alpha`));
    assert.match(html, new RegExp(`/cite/${citationKey}#claim-beta`));
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown keeps non-claim duplicate refs unsuffixed', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-noclaim-dup-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation with duplicate non-claim refs',
          URL: 'https://example.com/test-noclaim-dup',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(
      `Testing [@${citationKey}][@${citationKey}].`,
      [{ ...(citation.data ?? {}), id: citation.key }]
    );

    assert.equal((html.match(/href="#ref-1">1<\/a>/g) ?? []).length, 2);
    assert.doesNotMatch(html, /href="#ref-1a">1a<\/a>/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown groups repeated same-claim refs under one claim slot', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-claim-repeat-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation with repeated claim refs',
          URL: 'https://example.com/test-claim-repeat',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(
      `Testing [@${citationKey}:alpha] and later [@${citationKey}:alpha].`,
      [{ ...(citation.data ?? {}), id: citation.key }]
    );

    assert.equal((html.match(/href="#ref-1-1">1:1<\/a>/g) ?? []).length, 2);
    assert.equal((html.match(/id="ref-1-1" class="ref-claim-pair"/g) ?? []).length, 1);
    assert.match(html, /id="ref-1-1" class="ref-claim-pair">[\s\S]*\^a[\s\S]*\^b/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('renderMarkdown ignores bare @key tokens', async () => {
  const { html } = await renderMarkdown('Contact @no-such-citation:bad-claim.', []);
  assert.doesNotMatch(html, /citation-group/);
  assert.doesNotMatch(html, /citation-ref/);
});

test('renderMarkdown punctuation handles author-only citations without year', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-noyear-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Sandbox citation with no year',
          author: [{ family: 'Tester', given: 'Alex' }],
          URL: 'https://example.com/sandbox-citation',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(`Testing [@${citationKey}].`, [
      { ...(citation.data ?? {}), id: citation.key },
    ]);
    assert.match(html, /Tester, Alex\. Sandbox citation with no year\./);
    assert.doesNotMatch(html, /AlexSandbox/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects citation create when ISBN is an array', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-invalid-isbn-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await assert.rejects(
      () =>
        createCitation(
          dal,
          {
            key: citationKey,
            data: {
              type: 'book',
              title: 'Invalid ISBN Citation',
              ISBN: ['9780444525123', '9780080931395'],
            },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'data.ISBN'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects citation update when CSL shape fails citeproc', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-invalid-author-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Valid Citation',
          URL: 'https://example.com/valid-citation',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        updateCitation(
          dal,
          {
            key: citationKey,
            data: {
              type: 'webpage',
              title: 'Invalid Author Shape',
              author: 'Alice Example',
              URL: 'https://example.com/invalid-author',
            },
            revSummary: { en: 'Introduce invalid author shape.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'data'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service createCitation ignores submitted data.id and returns warning', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-ignore-id-create-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const created = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: 'client-provided-id',
          type: 'webpage',
          title: 'Citation with ignored id',
          URL: 'https://example.com/citation-ignore-id-create',
        },
      },
      userId
    );

    assert.ok(
      created.warnings?.includes('Ignored data.id; citation key is authoritative.')
    );
    assert.equal(Object.hasOwn(created.data ?? {}, 'id'), false);

    const saved = await readCitation(dal, citationKey);
    assert.equal(Object.hasOwn(saved.data ?? {}, 'id'), false);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service updateCitation ignores submitted data.id and returns warning', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-ignore-id-update-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Base citation',
          URL: 'https://example.com/citation-ignore-id-update',
        },
      },
      userId
    );

    const updated = await updateCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: 'client-update-id',
          type: 'webpage',
          title: 'Updated citation',
          URL: 'https://example.com/citation-ignore-id-update-v2',
        },
        revSummary: { en: 'Update citation while submitting data.id.' },
      },
      userId
    );

    assert.ok(
      updated.warnings?.includes('Ignored data.id; citation key is authoritative.')
    );
    assert.equal(Object.hasOwn(updated.data ?? {}, 'id'), false);

    const saved = await readCitation(dal, citationKey);
    assert.equal(Object.hasOwn(saved.data ?? {}, 'id'), false);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service createCitationClaim requires quoteLanguage when quote provided', async () => {
  const dal = await getDal();
  const citationKey = `test-claim-quote-lang-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  const claimId = 'birthdate';
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Claim test citation',
          URL: 'https://example.com/claim-test',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        createCitationClaim(
          dal,
          {
            key: citationKey,
            claimId,
            assertion: { en: 'A test claim.' },
            quote: { en: 'A test quote.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'quoteLanguage'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service createCitationClaim and updateCitationClaim write revisions', async () => {
  const dal = await getDal();
  const citationKey = `test-claim-revisions-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  const claimId = `claim-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Claim test citation',
          URL: 'https://example.com/claim-test-revisions',
        },
      },
      userId
    );

    const created = await createCitationClaim(
      dal,
      {
        key: citationKey,
        claimId,
        assertion: { en: 'Initial claim assertion.' },
        quote: { en: 'Initial quoted text.' },
        quoteLanguage: 'en',
        locatorType: 'page',
        locatorValue: { und: '42' },
      },
      userId
    );

    assert.equal(created.claimId, claimId);
    assert.equal(created.locatorValue?.und, '42');

    const updatedClaimId = `${claimId}-updated`;
    const updated = await updateCitationClaim(
      dal,
      {
        key: citationKey,
        claimId,
        newClaimId: updatedClaimId,
        assertion: { en: 'Updated claim assertion.' },
        revSummary: { en: 'Update claim assertion.' },
      },
      userId
    );

    assert.equal(updated.claimId, updatedClaimId);
    assert.equal(updated.assertion?.en, 'Updated claim assertion.');

    const readBack = await readCitationClaim(dal, citationKey, updatedClaimId);
    assert.equal(readBack.claimId, updatedClaimId);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects invalid language codes', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await assert.rejects(
      () =>
        createWikiPage(
          dal,
          {
            slug: `test-lang-${Date.now()}`,
            title: { en: 'Invalid lang' },
            body: { en: 'Body' },
            originalLanguage: 'xx',
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'originalLanguage'));
        return true;
      }
    );

    await assert.rejects(
      () =>
        applyWikiPagePatch(
          dal,
          {
            slug: 'nonexistent-slug',
            patch: ['--- before', '+++ after', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
            format: 'unified',
            lang: 'xx',
            revSummary: { en: 'Invalid lang patch.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'lang'));
        return true;
      }
    );

    await assert.rejects(
      () =>
        createBlogPost(
          dal,
          {
            slug: `test-blog-lang-${Date.now()}`,
            title: { en: 'Invalid blog lang' },
            body: { en: 'Body' },
            originalLanguage: 'xx',
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'originalLanguage'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects control characters in wiki content', async () => {
  const dal = await getDal();
  const slug = `test-control-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Control char test' },
        body: { en: 'Safe body.' },
        originalLanguage: 'en',
      },
      userId
    );

    await assert.rejects(
      () =>
        updateWikiPage(
          dal,
          {
            slug,
            body: { en: `Contains control char \u001c here.` },
            revSummary: { en: 'Try control char.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'body.en'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service aggregates validation errors for wiki patch inputs', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await assert.rejects(
      () =>
        applyWikiPagePatch(
          dal,
          {
            slug: '',
            patch: '',
            format: 'bad' as unknown as 'unified',
            lang: 'xx',
            revSummary: null as unknown as Record<string, string>,
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors);
        assert.ok(error.fieldErrors.length >= 4);
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects unknown citation claim references', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-claim-ref-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Claim validation test',
          URL: 'https://example.com/claim-validation',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        createWikiPage(
          dal,
          {
            slug,
            title: { en: 'Claim validation' },
            body: { en: `See [@${citationKey}:missing-claim].` },
            revSummary: { en: 'Add claim reference.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'body.en'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects unknown citation keys', async () => {
  const dal = await getDal();
  const slug = `test-cite-key-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-cite-key-valid-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation key validation test',
          URL: 'https://example.com/citation-key-validation',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        createWikiPage(
          dal,
          {
            slug,
            title: { en: 'Citation key validation' },
            body: { en: `See [@${citationKey}; @no-such-citation].` },
            revSummary: { en: 'Add citation references.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'body.en'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects unknown citation keys in blog summary', async () => {
  const dal = await getDal();
  const slug = `test-blog-cite-key-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-blog-cite-valid-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Blog citation key validation test',
          URL: 'https://example.com/blog-citation-key-validation',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        createBlogPost(
          dal,
          {
            slug,
            title: { en: 'Blog citation key validation' },
            body: { en: 'Body is fine.' },
            summary: { en: `See [@${citationKey}; @no-such-citation].` },
            revSummary: { en: 'Add citation references in summary.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'summary.en'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service rejects unknown citation keys in page check markdown', async () => {
  const dal = await getDal();
  const slug = `test-check-cite-key-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-check-cite-valid-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Page check citation key validation test',
          URL: 'https://example.com/check-citation-key-validation',
        },
      },
      userId
    );

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Page check citation key validation' },
        body: { en: 'Base article text.' },
        revSummary: { en: 'Create page for check test.' },
      },
      userId
    );
    const revisions = await listWikiPageRevisions(dal, slug);
    const targetRevId = revisions.revisions[0]?.revId;
    assert.ok(targetRevId);

    await assert.rejects(
      () =>
        createPageCheck(
          dal,
          {
            slug,
            type: 'fact_check',
            status: 'issues_found',
            checkResults: { en: `Result cites [@${citationKey}; @no-such-citation].` },
            notes: { en: `Note cites [@${citationKey}; @missing-note-cite].` },
            metrics: {
              issues_found: { high: 1, medium: 0, low: 0 },
              issues_fixed: { high: 0, medium: 0, low: 0 },
            },
            targetRevId,
            revSummary: { en: 'Create check with citation references.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'checkResults.en'));
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'notes.en'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service allows citation-like text in inline code spans', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-code-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-claim-ref-code-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Claim validation inline code test',
          URL: 'https://example.com/claim-validation-code',
        },
      },
      userId
    );

    const created = await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Claim validation inline code' },
        body: { en: `Literal \`[@${citationKey}:bad-claim]\` should not validate.` },
        revSummary: { en: 'Add inline code example.' },
      },
      userId
    );
    assert.equal(created.slug, slug);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service allows non-citation @key:claim text', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-plain-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-claim-ref-plain-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Claim validation plain text test',
          URL: 'https://example.com/claim-validation-plain',
        },
      },
      userId
    );

    const created = await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Claim validation plain text' },
        body: { en: `Reach out to @${citationKey}:bad-claim for details.` },
        revSummary: { en: 'Add plain text example.' },
      },
      userId
    );
    assert.equal(created.slug, slug);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service deleteWikiPage soft-deletes a page', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Page to Delete' },
        body: { en: 'Content to delete.' },
        originalLanguage: 'en',
      },
      userId
    );

    const readBefore = await readWikiPage(dal, slug);
    assert.equal(readBefore.slug, slug);
    await grantRoleUpsert(dal, userId, WIKI_ADMIN_ROLE);

    const deleteResult = await deleteWikiPage(
      dal,
      { slug, revSummary: { en: 'Admin deletion.' } },
      userId
    );

    assert.equal(deleteResult.deleted, true);
    assert.equal(deleteResult.slug, slug);
    const pageDeleteRow = await dal.query(
      'SELECT _rev_summary FROM pages WHERE slug = $1 AND _old_rev_of IS NULL AND _rev_deleted = true',
      [slug]
    );
    assert.equal(pageDeleteRow.rowCount, 1);
    assert.deepEqual(
      (pageDeleteRow.rows[0] as { _rev_summary: Record<string, string> | null })._rev_summary,
      { en: 'Admin deletion.' }
    );

    await assert.rejects(
      () => readWikiPage(dal, slug),
      error => {
        assert.ok(error instanceof NotFoundError);
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('findExistingWikiLinkSlugs ignores aliases of deleted pages', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-alias-page-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Page with Alias' },
        body: { en: 'Content to delete.' },
        originalLanguage: 'en',
      },
      userId
    );

    await addWikiPageAlias(
      dal,
      {
        pageSlug: slug,
        slug: aliasSlug,
      },
      userId
    );

    const existingBeforeDelete = await findExistingWikiLinkSlugs(dal, [aliasSlug]);
    assert.deepEqual([...existingBeforeDelete], [aliasSlug]);

    await grantRoleUpsert(dal, userId, WIKI_ADMIN_ROLE);
    await deleteWikiPage(
      dal,
      { slug, revSummary: { en: 'Admin deletion.' } },
      userId
    );

    const existingAfterDelete = await findExistingWikiLinkSlugs(dal, [aliasSlug]);
    assert.deepEqual([...existingAfterDelete], []);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service deleteCitation soft-deletes a citation', async () => {
  const dal = await getDal();
  const citationKey = `test-delete-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation to Delete',
          URL: 'https://example.com/delete-test',
        },
      },
      userId
    );

    const readBefore = await readCitation(dal, citationKey);
    assert.equal(readBefore.key, citationKey);
    await grantRoleUpsert(dal, userId, WIKI_ADMIN_ROLE);

    const deleteResult = await deleteCitation(
      dal,
      { key: citationKey, revSummary: { en: 'Admin deletion.' } },
      userId
    );

    assert.equal(deleteResult.deleted, true);
    assert.equal(deleteResult.key, citationKey);
    const citationDeleteRow = await dal.query(
      'SELECT _rev_summary FROM citations WHERE key = $1 AND _old_rev_of IS NULL AND _rev_deleted = true',
      [citationKey]
    );
    assert.equal(citationDeleteRow.rowCount, 1);
    assert.deepEqual(
      (citationDeleteRow.rows[0] as { _rev_summary: Record<string, string> | null })._rev_summary,
      { en: 'Admin deletion.' }
    );

    await assert.rejects(
      () => readCitation(dal, citationKey),
      error => {
        assert.ok(error instanceof NotFoundError);
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('Service deleteWikiPage requires wiki_admin role', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-forbidden-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Page to Delete (Forbidden)' },
        body: { en: 'Content to delete.' },
        originalLanguage: 'en',
      },
      userId
    );

    await assert.rejects(
      () => deleteWikiPage(dal, { slug, revSummary: { en: 'Admin deletion.' } }, userId),
      error => {
        assert.ok(error instanceof ForbiddenError);
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});
