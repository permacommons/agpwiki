import { FORUM_BASE_PATH, forumThreadPath } from './forum-paths.js';
import { encodeSlugPath } from './slug.js';

/**
 * Where a discussion lives: every wiki page has one, at its address plus
 * /discussion, and each forum section has one for threads that are not
 * about a single page.
 */
export type DiscussionTarget =
  | { kind: 'page'; slug: string }
  | { kind: 'section'; category: string };

export const DISCUSSION_SUFFIX = 'discussion';

export const discussionPath = (target: DiscussionTarget) =>
  target.kind === 'page'
    ? `/${encodeSlugPath(target.slug)}/${DISCUSSION_SUFFIX}`
    : `${FORUM_BASE_PATH}/${encodeURIComponent(target.category)}`;

export const discussionPagePath = (target: DiscussionTarget, page: number) =>
  page > 1 ? `${discussionPath(target)}?page=${page}` : discussionPath(target);

export const threadAnchor = (threadId: string) => `thread-${encodeURIComponent(threadId)}`;

export const commentAnchor = (commentId: string) => `comment-${encodeURIComponent(commentId)}`;

export const positionAnchor = (signoffId: string) => `position-${encodeURIComponent(signoffId)}`;

// The thread goes in the query, not only the fragment, because the server
// has to know which page of the discussion holds it.
export const threadLocationPath = (target: DiscussionTarget, threadId: string) =>
  `${discussionPath(target)}?thread=${encodeURIComponent(threadId)}`;

/** The permanent link of a thread: its section in the page's discussion. */
export const threadPermalink = (target: DiscussionTarget, threadId: string) =>
  `${threadLocationPath(target, threadId)}#${threadAnchor(threadId)}`;

/** The permanent link of a comment, inside its thread's section. */
export const commentPermalink = (target: DiscussionTarget, threadId: string, commentId: string) =>
  `${threadLocationPath(target, threadId)}#${commentAnchor(commentId)}`;

interface ThreadPlacement {
  category: string;
  pageSlug?: string | null;
}

/** The discussion a thread is part of. */
export const discussionTargetOfThread = ({ category, pageSlug }: ThreadPlacement): DiscussionTarget =>
  pageSlug && (category === 'articles' || category === 'policy')
    ? { kind: 'page', slug: pageSlug }
    : { kind: 'section', category };

interface LinkedThread extends ThreadPlacement {
  id: string;
  attachedType?: string | null;
}

/**
 * Where to send a reader for a thread. Threads about a page are sections of
 * its discussion; the others still have a page of their own.
 */
export const threadLinkPath = (thread: LinkedThread) => {
  const target = discussionTargetOfThread(thread);
  return target.kind === 'page' && !thread.attachedType
    ? threadPermalink(target, thread.id)
    : forumThreadPath(thread.id);
};

/** Where to send a reader for a comment, as {@link threadLinkPath}. */
export const commentLinkPath = (thread: LinkedThread, commentId: string) => {
  const target = discussionTargetOfThread(thread);
  return target.kind === 'page' && !thread.attachedType
    ? commentPermalink(target, thread.id, commentId)
    : `${forumThreadPath(thread.id)}#${commentAnchor(commentId)}`;
};
