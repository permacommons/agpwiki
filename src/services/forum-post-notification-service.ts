import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import debug from '../../util/debug.js';
import { enqueueForumReplyNotification } from './forum-notification-service.js';
import { notifyMentions } from './mention-service.js';
import { enqueueNotificationJob } from './notification-queue.js';
import { notifyPageFollowersOfForumPost } from './page-comment-notification-service.js';

export const notifyForumPost = async (
  dal: DataAccessLayer,
  { threadId, commentId, actorUserId, text, event }: {
    threadId: string;
    commentId: string;
    actorUserId: string;
    text: string;
    event: 'thread' | 'comment';
  }
) => {
  const mentionRecipientUserIds = await notifyMentions(
    dal,
    { type: 'comment', threadId, commentId },
    { text, actorUserId }
  );
  if (event === 'comment') {
    try {
      await enqueueForumReplyNotification(threadId, commentId, actorUserId, enqueueNotificationJob, mentionRecipientUserIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Failed to enqueue forum reply notification for comment ${commentId}: ${message}`);
    }
  }
  try {
    await notifyPageFollowersOfForumPost(
      dal,
      { threadId, commentId, actorUserId, event, mentionRecipientUserIds },
      enqueueNotificationJob
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`Failed to notify page followers of comment ${commentId}: ${message}`);
  }
};
