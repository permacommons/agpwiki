import { resolvePageAddress } from './page-address.js';

export const FORUM_BASE_PATH = '/tool/forum';

export const forumIndexPath = () => FORUM_BASE_PATH;

export const forumCategoryPath = (category: string) =>
  `${FORUM_BASE_PATH}/${encodeURIComponent(category)}`;

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

export const forumCommentEditPath = (commentId: string) =>
  `${FORUM_BASE_PATH}/comment/${encodeURIComponent(commentId)}/edit`;

export const forumCommentHistoryPath = (commentId: string) =>
  `${FORUM_BASE_PATH}/comment/${encodeURIComponent(commentId)}/history`;

export type PageForumCategory = 'articles' | 'policy' | 'users';

/** Forum sections whose threads are each about one wiki page or profile. */
export const PAGE_FORUM_CATEGORIES: readonly PageForumCategory[] = ['articles', 'policy', 'users'];

export const forumPageCategory = (slug: string): PageForumCategory | null => {
  const address = resolvePageAddress(slug);
  if (!address) return null;
  return address.namespace === 'meta' ? 'policy' : address.namespace === 'user' ? 'users' : 'articles';
};
