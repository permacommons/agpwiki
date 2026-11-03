import { FORUM_REPLY_CREATED_NOTIFICATION, processForumReplyCreatedNotification } from './forum-notification-service.js';
import { PAGE_COMMENT_NOTIFICATION, processPageCommentNotification } from './page-comment-notification-service.js';
import { PAGE_REVERTED_NOTIFICATION } from './page-revert-service.js';
import { processPageRevertedNotification } from './revert-notification-service.js';

export const notificationJobHandlers = {
  [FORUM_REPLY_CREATED_NOTIFICATION]: processForumReplyCreatedNotification,
  [PAGE_REVERTED_NOTIFICATION]: processPageRevertedNotification,
  [PAGE_COMMENT_NOTIFICATION]: processPageCommentNotification,
} as const;
