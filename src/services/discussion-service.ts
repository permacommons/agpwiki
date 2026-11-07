import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';

/** Threads shown per page of a discussion; more load as the reader scrolls. */
export const DISCUSSION_PAGE_SIZE = 20;

/**
 * Which threads make up a discussion: those about one page (under its
 * current address or an older one it was renamed from), or those in a forum
 * section that are not about a page.
 */
export type DiscussionScope = { pageSlugs: string[] } | { category: string };

export interface DiscussionComment {
  id: string;
  threadId: string;
  parentId: string | null;
  body: Record<string, string> | null;
  canonicalLanguage: string | null;
  authorId: string | null;
  createdAt: Date | null;
  edited: boolean;
  replies: DiscussionComment[];
}

export interface DiscussionThread {
  id: string;
  category: string;
  pageSlug: string | null;
  title: Record<string, string> | null;
  canonicalLanguage: string | null;
  pinned: boolean;
  createdAt: Date | null;
  commentCount: number;
  latestActivityAt: Date | null;
  // Top-level comments, oldest first, each with its replies.
  comments: DiscussionComment[];
}

export interface DiscussionPage {
  threads: DiscussionThread[];
  threadIds: string[];
  threadCount: number;
  commentCount: number;
  page: number;
  pageCount: number;
}

interface ThreadRow {
  id: string;
  category: string;
  page_slug: string | null;
  title: Record<string, string> | null;
  canonical_language: string | null;
  pinned: number | null;
  created_at: Date | null;
  comment_count: number;
  latest_activity_at: Date | null;
}

const scopeFilter = (scope: DiscussionScope, params: unknown[]) => {
  if ('pageSlugs' in scope) {
    params.push(scope.pageSlugs);
    return `t.page_slug = ANY($${params.length}) AND t.category IN ('articles', 'policy')`;
  }
  params.push(scope.category);
  return `t.category = $${params.length}
    AND (t.page_slug IS NULL OR t.category NOT IN ('articles', 'policy'))`;
};

// Threads attached to something else (replies to a position) are shown with
// what they belong to, not as threads of their own.
const listThreadRows = async (dalInstance: DataAccessLayer, scope: DiscussionScope) => {
  const params: unknown[] = [];
  const filter = scopeFilter(scope, params);
  const result = await dalInstance.query(
    `SELECT t.id, t.category, t.page_slug, t.title, t.canonical_language, t.pinned, t.created_at,
            COUNT(c.id)::int AS comment_count,
            GREATEST(t.created_at, COALESCE(MAX(c.created_at), t.created_at)) AS latest_activity_at
       FROM ${ForumThread.tableName} t
       LEFT JOIN ${ForumComment.tableName} c
         ON c.thread_id = t.id AND c._old_rev_of IS NULL AND c._rev_deleted = false
      WHERE t._old_rev_of IS NULL AND t._rev_deleted = false
        AND t.attached_type IS NULL
        AND ${filter}
      GROUP BY t.id
      ORDER BY t.pinned DESC, latest_activity_at DESC, t.id`,
    params
  );
  return result.rows as unknown as ThreadRow[];
};

/**
 * The current comments of the given threads, oldest first, with the person
 * who wrote each one (the author of its first version).
 */
export const listThreadComments = async (
  dalInstance: DataAccessLayer,
  threadIds: string[]
): Promise<DiscussionComment[]> => {
  if (!threadIds.length) return [];
  const result = await dalInstance.query(
    `SELECT c.id, c.thread_id, c.parent_id, c.body, c.canonical_language, c.created_at, c.updated_at,
            (SELECT f._rev_user FROM ${ForumComment.tableName} f
              WHERE f.id = c.id OR f._old_rev_of = c.id
              ORDER BY f._rev_date ASC LIMIT 1) AS author_id
       FROM ${ForumComment.tableName} c
      WHERE c.thread_id = ANY($1) AND c._old_rev_of IS NULL AND c._rev_deleted = false
      ORDER BY c.created_at ASC, c._rev_date ASC`,
    [threadIds]
  );
  return (result.rows as Array<Record<string, unknown>>).map(row => {
    const createdAt = (row.created_at as Date | null) ?? null;
    const updatedAt = (row.updated_at as Date | null) ?? null;
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      parentId: (row.parent_id as string | null) ?? null,
      body: (row.body as Record<string, string> | null) ?? null,
      canonicalLanguage: (row.canonical_language as string | null) ?? null,
      authorId: (row.author_id as string | null) ?? null,
      createdAt,
      edited: Boolean(createdAt && updatedAt && updatedAt.getTime() - createdAt.getTime() > 1000),
      replies: [],
    };
  });
};

/**
 * Put replies under the comment they answer. A reply whose comment was
 * deleted stays visible, at the top level.
 */
export const nestReplies = (comments: DiscussionComment[]) => {
  const topLevel = new Map<string, DiscussionComment>();
  for (const comment of comments) {
    if (!comment.parentId) topLevel.set(comment.id, { ...comment, replies: [] });
  }
  const result: DiscussionComment[] = [];
  for (const comment of comments) {
    const parent = comment.parentId ? topLevel.get(comment.parentId) : undefined;
    if (parent) parent.replies.push(comment);
    else result.push(topLevel.get(comment.id) ?? comment);
  }
  return result;
};

const toThread = (row: ThreadRow, comments: DiscussionComment[]): DiscussionThread => ({
  id: row.id,
  category: row.category,
  pageSlug: row.page_slug ?? null,
  title: row.title ?? null,
  canonicalLanguage: row.canonical_language ?? null,
  pinned: Boolean(row.pinned),
  createdAt: row.created_at ?? null,
  commentCount: Number(row.comment_count) || 0,
  latestActivityAt: row.latest_activity_at ?? null,
  comments: nestReplies(comments),
});

/**
 * One page of a discussion: its threads with the most recent activity first
 * (pinned ones before the rest), each with all its comments. Asking for a
 * thread returns the page that holds it.
 */
export const readDiscussion = async (
  dalInstance: DataAccessLayer,
  scope: DiscussionScope,
  {
    page = 1,
    threadId,
    threadIds,
    pageSize = DISCUSSION_PAGE_SIZE,
  }: { page?: number; threadId?: string; threadIds?: string[]; pageSize?: number } = {}
): Promise<DiscussionPage> => {
  const rows = await listThreadRows(dalInstance, scope);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const threadIndex = threadId ? rows.findIndex(row => row.id === threadId) : -1;
  const requested = threadIndex >= 0 ? Math.floor(threadIndex / pageSize) + 1 : page;
  const current = Math.min(Math.max(1, Math.floor(requested) || 1), pageCount);
  const byId = new Map(rows.map(row => [row.id, row]));
  // Explicit batches preserve browsing order while replies change the live ranking.
  const selected = threadIds
    ? [...new Set(threadIds)].slice(0, pageSize).flatMap(id => {
        const row = byId.get(id);
        return row ? [row] : [];
      })
    : rows.slice((current - 1) * pageSize, current * pageSize);
  const comments = await listThreadComments(
    dalInstance,
    selected.map(row => row.id)
  );
  const byThread = new Map<string, DiscussionComment[]>();
  for (const comment of comments) {
    const list = byThread.get(comment.threadId) ?? [];
    list.push(comment);
    byThread.set(comment.threadId, list);
  }
  return {
    threads: selected.map(row => toThread(row, byThread.get(row.id) ?? [])),
    threadIds: rows.map(row => row.id),
    threadCount: rows.length,
    commentCount: rows.reduce((sum, row) => sum + (Number(row.comment_count) || 0), 0),
    page: current,
    pageCount,
  };
};

/**
 * Every address a page's discussion threads may be stored under: its current
 * slug and the older ones it keeps as aliases after a rename.
 */
export const listPageDiscussionSlugs = async (
  dalInstance: DataAccessLayer,
  page: { id: string; slug: string }
): Promise<string[]> => {
  const result = await dalInstance.query('SELECT slug FROM page_aliases WHERE page_id = $1', [page.id]);
  return [page.slug, ...(result.rows as Array<{ slug: string }>).map(row => row.slug)];
};

/**
 * Comments in a page's discussion, for the count on its Discuss tab. Replies
 * to positions on a proposal count too: they are part of its discussion.
 */
export const countPageDiscussionComments = async (
  dalInstance: DataAccessLayer,
  pageSlugs: string[]
): Promise<number> => {
  const result = await dalInstance.query(
    `SELECT COUNT(c.id)::int AS comment_count
       FROM ${ForumThread.tableName} t
       JOIN ${ForumComment.tableName} c
         ON c.thread_id = t.id AND c._old_rev_of IS NULL AND c._rev_deleted = false
      WHERE t._old_rev_of IS NULL AND t._rev_deleted = false
        AND t.page_slug = ANY($1) AND t.category IN ('articles', 'policy')`,
    [pageSlugs]
  );
  return Number(result.rows[0]?.comment_count) || 0;
};

export const findOrphanedDiscussion = async (dalInstance: DataAccessLayer, slug: string) => {
  const result = await dalInstance.query(
    `SELECT p.id, p.slug FROM pages p
      WHERE p._old_rev_of IS NULL AND p._rev_deleted = true
        AND (p.slug = $1 OR p.id IN (SELECT page_id FROM page_aliases WHERE slug = $1))
      ORDER BY (p.slug = $1) DESC LIMIT 1`,
    [slug]
  );
  const page = result.rows[0] as { id: string; slug: string } | undefined;
  const slugs = page ? await listPageDiscussionSlugs(dalInstance, page) : [slug];
  const discussion = await readDiscussion(dalInstance, { pageSlugs: slugs }, { pageSize: 1 });
  return discussion.threadCount ? { slug: page?.slug ?? slug, slugs } : null;
};
