export const FORUM_BASE_PATH = '/tool/forum';

export const forumIndexPath = () => FORUM_BASE_PATH;

export const forumCategoryPath = (category: string) =>
  `${FORUM_BASE_PATH}/${encodeURIComponent(category)}`;

export const forumCategoryPagePath = (category: string, slug: string) =>
  `${forumCategoryPath(category)}/page/${encodeURIComponent(slug)}`;

export const forumDismissPreamblePath = () => `${FORUM_BASE_PATH}/dismiss-preamble`;

export const forumThreadPath = (threadId: string) =>
  `${FORUM_BASE_PATH}/thread/${encodeURIComponent(threadId)}`;

export const forumThreadCommentPath = (threadId: string) =>
  `${forumThreadPath(threadId)}/comment`;

export const forumThreadPinPath = (threadId: string) =>
  `${forumThreadPath(threadId)}/pin`;

export const forumThreadDeletePath = (threadId: string) =>
  `${forumThreadPath(threadId)}/delete`;

export const forumCommentDeletePath = (commentId: string) =>
  `${FORUM_BASE_PATH}/comment/${encodeURIComponent(commentId)}/delete`;

export const forumCommentAnchor = (commentId: string) =>
  `comment-${encodeURIComponent(commentId)}`;
