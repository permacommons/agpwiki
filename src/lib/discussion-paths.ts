import { FORUM_BASE_PATH } from './forum-paths.js';
import { encodeSlugPath } from './slug.js';

/**
 * Where a discussion lives: every wiki page and blog post has one, at its
 * address plus /discussion, and each forum section has one for threads that
 * are not about a single page.
 */
export type DiscussionTarget =
  | { kind: 'page'; slug: string }
  | { kind: 'post'; slug: string }
  | { kind: 'section'; category: string };

export const DISCUSSION_SUFFIX = 'discussion';

export const discussionPath = (target: DiscussionTarget) =>
  target.kind === 'page'
    ? `/${encodeSlugPath(target.slug)}/${DISCUSSION_SUFFIX}`
    : target.kind === 'post'
      ? `/blog/${encodeURIComponent(target.slug)}/${DISCUSSION_SUFFIX}`
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
  !pageSlug
    ? { kind: 'section', category }
    : category === 'blog'
      ? { kind: 'post', slug: pageSlug }
      : { kind: 'page', slug: pageSlug };

interface LinkedThread extends ThreadPlacement {
  id: string;
  attachedType?: string | null;
  attachedId?: string | null;
}

// Replies to a position on a proposal are shown under that position, at the
// top of the proposal's discussion; the thread holding them has no section.
const positionTarget = (thread: LinkedThread) => {
  const target = discussionTargetOfThread(thread);
  return thread.attachedType === 'position' && target.kind === 'page' ? target : null;
};

/** Where a thread can be read: its section in its discussion. */
export const threadLinkPath = (thread: LinkedThread) => {
  const position = positionTarget(thread);
  if (position) {
    return thread.attachedId
      ? `${discussionPath(position)}#${positionAnchor(thread.attachedId)}`
      : discussionPath(position);
  }
  return threadPermalink(discussionTargetOfThread(thread), thread.id);
};

/** Where a comment can be read, inside its thread's section. */
export const commentLinkPath = (thread: LinkedThread, commentId: string) => {
  const position = positionTarget(thread);
  return position
    ? `${discussionPath(position)}#${commentAnchor(commentId)}`
    : commentPermalink(discussionTargetOfThread(thread), thread.id, commentId);
};

/**
 * Where an old thread address leads. There is no fragment, so the browser
 * keeps the one of the old link (such as #comment-…); the page scrolls to the
 * thread or position otherwise.
 */
export const movedThreadPath = (thread: LinkedThread) => {
  const position = positionTarget(thread);
  if (position) {
    return thread.attachedId
      ? `${discussionPath(position)}?position=${encodeURIComponent(thread.attachedId)}`
      : discussionPath(position);
  }
  return threadLocationPath(discussionTargetOfThread(thread), thread.id);
};
