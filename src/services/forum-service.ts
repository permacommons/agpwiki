import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import debug from '../../util/debug.js';
import { validateLocalizedMarkdownContent } from '../lib/content-validation.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationCollector,
} from '../lib/errors.js';
import { sanitizeLocalizedMapInput } from '../lib/localized.js';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';
import type { ForumCommentInstance } from '../models/manifests/forum-comment.js';
import type { ForumThreadInstance } from '../models/manifests/forum-thread.js';
import { escapeHtml } from '../render.js';
import { assertCanModerateForum } from './authorization.js';
import {
  enqueueForumReplyNotification,
  subscribeActorToForumThread,
} from './forum-notification-service.js';
import { enqueueNotificationJob } from './notification-queue.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import {
  ensureNonEmptyString,
  ensureOptionalLanguage,
  ensureString,
  normalizeSlugInput,
  requireRevSummary,
  validateRevSummary,
} from './validation.js';
import { findCurrentPageBySlugOrAlias } from './wiki-page-service.js';

export const FORUM_CATEGORY_KEYS = {
  general: 'forum.category.general',
  articles: 'forum.category.articles',
  technology: 'forum.category.technology',
  policy: 'forum.category.policy',
} as const;

export type ForumCategorySlug = keyof typeof FORUM_CATEGORY_KEYS;

export const FORUM_CATEGORIES = Object.keys(FORUM_CATEGORY_KEYS) as ForumCategorySlug[];

export interface ForumThreadResult {
  id: string;
  category: ForumCategorySlug;
  pageSlug: string | null | undefined;
  title: Record<string, string> | null | undefined;
  originalLanguage: string | null | undefined;
  pinned: boolean;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
  commentCount?: number;
}

export interface ForumCommentResult {
  id: string;
  threadId: string;
  body: Record<string, string> | null | undefined;
  originalLanguage: string | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
  revDeleted?: boolean;
  revUser?: string | null | undefined;
}

export interface ForumCategoryListItem {
  slug: ForumCategorySlug;
  labelKey: string;
  threadCount: number;
  latestPost:
    | {
        threadId: string;
        commentId: string;
        title: Record<string, string> | null | undefined;
        originalLanguage: string | null | undefined;
        createdAt: Date | null;
      }
    | null;
}

export interface ForumThreadListItem extends ForumThreadResult {
  latestCommentAt: Date | null;
}

export interface ForumThreadDetailResult {
  thread: ForumThreadResult;
  comments: ForumCommentResult[];
}

export interface CreateForumThreadInput {
  category: string;
  pageSlug?: string;
  title: string;
  body: string;
  language: string;
}

export interface CreateForumCommentInput {
  threadId: string;
  body: string;
  language: string;
}

export interface UpdateForumThreadPinInput {
  threadId: string;
  pinned: boolean;
  revSummary: Record<string, string | null>;
}

export interface DeleteForumThreadInput {
  threadId: string;
  revSummary: Record<string, string | null>;
}

export interface DeleteForumCommentInput {
  commentId: string;
  revSummary: Record<string, string | null>;
}

const isForumCategory = (value: string): value is ForumCategorySlug =>
  FORUM_CATEGORIES.includes(value as ForumCategorySlug);

export const ensureForumCategory = (
  value: string,
  field = 'category',
  errors?: ValidationCollector
) => {
  if (!isForumCategory(value)) {
    if (errors) {
      errors.add(field, `must be one of: ${FORUM_CATEGORIES.join(', ')}.`, 'invalid');
      return null;
    }
    throw new NotFoundError(`Forum category not found: ${value}`, { category: value });
  }
  return value;
};

const toForumThreadResult = (thread: ForumThreadInstance): ForumThreadResult => ({
  id: thread.id,
  category: ensureForumCategory(thread.category) ?? 'general',
  pageSlug: thread.pageSlug ?? null,
  title: thread.title ?? null,
  originalLanguage: thread.originalLanguage ?? null,
  pinned: Boolean(thread.pinned),
  createdAt: thread.createdAt ?? null,
  updatedAt: thread.updatedAt ?? null,
});

const toForumCommentResult = (comment: ForumCommentInstance): ForumCommentResult => ({
  id: comment.id,
  threadId: comment.threadId,
  body: comment.body ?? null,
  originalLanguage: comment.originalLanguage ?? null,
  createdAt: comment.createdAt ?? null,
  updatedAt: comment.updatedAt ?? null,
  revDeleted: comment._revDeleted ?? false,
  revUser: comment._revUser ?? null,
});

const findCurrentThreadById = async (threadId: string) =>
  ForumThread.filterWhere({
    id: threadId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentCommentById = async (commentId: string) =>
  ForumComment.filterWhere({
    id: commentId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const requireThread = async (threadId: string) => {
  const thread = await findCurrentThreadById(threadId);
  if (!thread) {
    throw new NotFoundError(`Forum thread not found: ${threadId}`, { threadId });
  }
  return thread;
};

const requireComment = async (commentId: string) => {
  const comment = await findCurrentCommentById(commentId);
  if (!comment) {
    throw new NotFoundError(`Forum comment not found: ${commentId}`, { commentId });
  }
  return comment;
};

const deleteAllEntityRevisions = async (
  entity: { deleteAllRevisions?: unknown },
  userId: string
) => {
  const deleteAllRevisions = entity.deleteAllRevisions as
    | ((actor: { id: string }, options: { tags: string[] }) => Promise<{
        _revSummary?: Record<string, string> | null;
        save: () => Promise<unknown>;
      }>)
    | undefined;
  if (typeof deleteAllRevisions !== 'function') {
    throw new Error('Entity does not support deleteAllRevisions.');
  }
  return deleteAllRevisions.call(entity, { id: userId }, { tags: ['admin-delete'] });
};

const validateTitle = (title: string, errors: ValidationCollector) => {
  ensureString(title, 'title', errors);
  if (typeof title !== 'string') return;
  const normalized = title.trim();
  if (normalized.length === 0) {
    errors.add('title', 'must not be empty.', 'required');
  } else if (normalized.length > 200) {
    errors.add('title', 'must be at most 200 characters.', 'invalid');
  }
};

const validateMarkdownBody = async (
  body: string,
  language: string,
  field: string,
  errors: ValidationCollector
) => {
  ensureString(body, field, errors);
  if (typeof body !== 'string') return;
  if (body.trim().length === 0) {
    errors.add(field, 'must not be empty.', 'required');
    return;
  }
  // Forum comments intentionally skip the article-content validators
  // (citation refs, media refs, standard-image rejection) that
  // wiki-page-service and blog-post-service apply. Forum is operator
  // discussion, not encyclopedia content; informal `[@key]` mentions
  // and screenshot-style image links are allowed here.
  await validateLocalizedMarkdownContent({ [language]: body }, field, errors, []);
};

const normalizeQuotedMarkdown = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');

export const buildForumQuote = (value: string) => `${normalizeQuotedMarkdown(value)}\n\n`;

export interface ForumPageTarget {
  canonicalSlug: string;
  title: Record<string, string> | null | undefined;
  originalLanguage: string | null | undefined;
}

export const resolveForumPageTarget = async (
  slug: string
): Promise<ForumPageTarget | null> => {
  const normalizedSlug = normalizeSlugInput(slug, 'pageSlug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) return null;

  return {
    canonicalSlug: page.slug,
    title: page.title ?? null,
    originalLanguage: page.originalLanguage ?? null,
  };
};

export const listForumCategories = async (
  dalInstance: DataAccessLayer
): Promise<ForumCategoryListItem[]> => {
  const threadRows = await dalInstance.query(
    `SELECT category, COUNT(*)::int AS thread_count
     FROM ${ForumThread.tableName}
     WHERE _old_rev_of IS NULL AND _rev_deleted = false
     GROUP BY category`,
    []
  );

  const latestRows = await dalInstance.query(
    `SELECT DISTINCT ON (t.category)
       t.category,
       t.id AS thread_id,
       t.title,
       t.original_language,
       c.id AS comment_id,
       c.created_at
     FROM ${ForumThread.tableName} t
     INNER JOIN ${ForumComment.tableName} c
       ON c.thread_id = t.id
      AND c._old_rev_of IS NULL
      AND c._rev_deleted = false
     WHERE t._old_rev_of IS NULL
       AND t._rev_deleted = false
     ORDER BY t.category, c.created_at DESC, c._rev_date DESC`,
    []
  );

  const counts = new Map<string, number>(
    threadRows.rows.map(row => [row.category as string, Number(row.thread_count) || 0])
  );
  const latestByCategory = new Map(
    latestRows.rows.map(row => [
      row.category as string,
      {
        threadId: row.thread_id as string,
        commentId: row.comment_id as string,
        title: (row.title as Record<string, string> | null) ?? null,
        originalLanguage: (row.original_language as string | null) ?? null,
        createdAt: (row.created_at as Date | null) ?? null,
      },
    ])
  );

  return FORUM_CATEGORIES.map(slug => ({
    slug,
    labelKey: FORUM_CATEGORY_KEYS[slug],
    threadCount: counts.get(slug) ?? 0,
    latestPost: latestByCategory.get(slug) ?? null,
  }));
};

export const listForumThreads = async (
  dalInstance: DataAccessLayer,
  category: string,
  options: { pageSlug?: string } = {}
): Promise<ForumThreadListItem[]> => {
  const normalizedCategory = ensureForumCategory(category);
  const params: string[] = [normalizedCategory];
  let pageFilterSql = '';
  if (options.pageSlug) {
    params.push(normalizeSlugInput(options.pageSlug, 'pageSlug'));
    pageFilterSql = ` AND t.page_slug = $${params.length}`;
  }
  const result = await dalInstance.query(
    `SELECT
       t.*,
       COUNT(c.id)::int AS comment_count,
       MAX(c.created_at) AS latest_comment_at
     FROM ${ForumThread.tableName} t
     LEFT JOIN ${ForumComment.tableName} c
       ON c.thread_id = t.id
      AND c._old_rev_of IS NULL
      AND c._rev_deleted = false
     WHERE t._old_rev_of IS NULL
       AND t._rev_deleted = false
       AND t.category = $1
       ${pageFilterSql}
     GROUP BY t.id
     ORDER BY t.pinned DESC, t.created_at DESC, t._rev_date DESC`,
    params
  );

  return result.rows.map(row => ({
    ...toForumThreadResult(ForumThread.createFromRow(row)),
    commentCount: Number(row.comment_count) || 0,
    latestCommentAt: (row.latest_comment_at as Date | null) ?? null,
  }));
};

export const readForumThread = async (
  dalInstance: DataAccessLayer,
  threadId: string
): Promise<ForumThreadDetailResult> => {
  const thread = await requireThread(threadId);
  const result = await dalInstance.query(
    `SELECT *
     FROM ${ForumComment.tableName}
     WHERE thread_id = $1
       AND _old_rev_of IS NULL
       AND _rev_deleted = false
     ORDER BY created_at ASC, _rev_date ASC`,
    [thread.id]
  );

  const comments = result.rows.map(row =>
    toForumCommentResult(ForumComment.createFromRow(row))
  );

  return {
    thread: {
      ...toForumThreadResult(thread),
      commentCount: comments.length,
    },
    comments,
  };
};

export const readForumComment = async (
  commentId: string
): Promise<ForumCommentResult> => toForumCommentResult(await requireComment(commentId));

export const createForumThread = async (
  { category, pageSlug, title, body, language }: CreateForumThreadInput,
  userId: string
): Promise<ForumThreadResult> => {
  const errors = new ValidationCollector('Invalid forum thread input.');
  const normalizedCategory = ensureForumCategory(category, 'category', errors);
  let normalizedPageSlug: string | null = null;
  ensureNonEmptyString(userId, 'userId', errors);
  ensureNonEmptyString(language, 'language', errors);
  ensureOptionalLanguage(language, 'language', errors);
  validateTitle(title, errors);
  await validateMarkdownBody(body, language, 'body', errors);
  const rawPageSlug =
    typeof pageSlug === 'string' && pageSlug.trim().length > 0
      ? normalizeSlugInput(pageSlug, 'pageSlug', errors)
      : '';
  if (normalizedCategory === 'articles') {
    if (!rawPageSlug) {
      errors.add('pageSlug', 'must not be empty.', 'required');
    } else {
      const target = await resolveForumPageTarget(rawPageSlug);
      if (!target) {
        errors.add('pageSlug', 'must refer to an existing wiki page.', 'not_found');
      } else {
        normalizedPageSlug = target.canonicalSlug;
      }
    }
  } else if (normalizedCategory === 'policy') {
    if (rawPageSlug) {
      const target = await resolveForumPageTarget(rawPageSlug);
      if (!target) {
        errors.add('pageSlug', 'must refer to an existing wiki page.', 'not_found');
      } else {
        normalizedPageSlug = target.canonicalSlug;
      }
    }
  } else if (rawPageSlug) {
    errors.add('pageSlug', 'is only allowed for page discussion threads.', 'invalid');
  }
  errors.throwIfAny();

  const createdAt = new Date();
  const thread = await ForumThread.createFirstRevision(
    { id: userId },
    { tags: ['create'], date: createdAt }
  );
  thread.category = normalizedCategory ?? 'general';
  thread.pageSlug = normalizedPageSlug;
  thread.title = sanitizeLocalizedMapInput({ [language]: escapeHtml(title.trim()) });
  thread.originalLanguage = language;
  thread.pinned = 0;
  thread.createdAt = createdAt;
  thread.updatedAt = createdAt;
  await thread.save();

  const comment = await ForumComment.createFirstRevision(
    { id: userId },
    { tags: ['create'], date: createdAt }
  );
  comment.threadId = thread.id;
  comment.body = sanitizeLocalizedMapInput({ [language]: body });
  comment.originalLanguage = language;
  comment.createdAt = createdAt;
  comment.updatedAt = createdAt;
  await comment.save();

  try {
    await subscribeActorToForumThread(thread.id, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`Failed to auto-subscribe thread creator for thread ${thread.id}: ${message}`);
  }

  return {
    ...toForumThreadResult(thread),
    commentCount: 1,
  };
};

export const createForumComment = async (
  { threadId, body, language }: CreateForumCommentInput,
  userId: string
): Promise<ForumCommentResult> => {
  const errors = new ValidationCollector('Invalid forum comment input.');
  ensureNonEmptyString(userId, 'userId', errors);
  ensureNonEmptyString(threadId, 'threadId', errors);
  ensureNonEmptyString(language, 'language', errors);
  ensureOptionalLanguage(language, 'language', errors);
  await validateMarkdownBody(body, language, 'body', errors);
  errors.throwIfAny();

  const thread = await requireThread(threadId);
  const createdAt = new Date();
  const comment = await ForumComment.createFirstRevision(
    { id: userId },
    { tags: ['create'], date: createdAt }
  );
  comment.threadId = thread.id;
  comment.body = sanitizeLocalizedMapInput({ [language]: body });
  comment.originalLanguage = language;
  comment.createdAt = createdAt;
  comment.updatedAt = createdAt;
  await comment.save();

  const threadRevision = await thread.newRevision(
    { id: userId },
    { tags: ['activity', 'comment'], date: createdAt }
  );
  threadRevision.updatedAt = createdAt;
  await threadRevision.save();

  try {
    await subscribeActorToForumThread(thread.id, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`Failed to auto-subscribe replier for thread ${thread.id}: ${message}`);
  }
  try {
    await enqueueForumReplyNotification(
      thread.id,
      comment.id,
      userId,
      enqueueNotificationJob
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`Failed to enqueue forum reply notification for comment ${comment.id}: ${message}`);
  }

  return toForumCommentResult(comment);
};

export const setForumThreadPinned = async (
  dalInstance: DataAccessLayer,
  { threadId, pinned, revSummary }: UpdateForumThreadPinInput,
  userId: string
): Promise<ForumThreadResult> => {
  const errors = new ValidationCollector('Invalid forum thread pin input.');
  ensureNonEmptyString(threadId, 'threadId', errors);
  requireRevSummary(revSummary, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();
  await assertCanModerateForum(dalInstance, userId);

  const thread = await requireThread(threadId);
  const updatedAt = new Date();
  const revision = await thread.newRevision(
    { id: userId },
    { tags: [pinned ? 'pin' : 'unpin'], date: updatedAt }
  );
  revision.pinned = pinned ? 1 : 0;
  revision.updatedAt = updatedAt;
  revision._revSummary = sanitizeLocalizedMapInput(revSummary);
  await revision.save();

  return toForumThreadResult(revision);
};

export const deleteForumThread = async (
  dalInstance: DataAccessLayer,
  { threadId, revSummary }: DeleteForumThreadInput,
  userId: string
): Promise<{ id: string; deleted: boolean }> => {
  const errors = new ValidationCollector('Invalid forum thread delete input.');
  ensureNonEmptyString(threadId, 'threadId', errors);
  requireRevSummary(revSummary, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();
  await assertCanModerateForum(dalInstance, userId);

  const thread = await requireThread(threadId);
  const deletionRevision = await deleteAllEntityRevisions(thread, userId);
  await applyDeletionRevisionSummary(deletionRevision, revSummary);
  await deletionRevision.save();

  return { id: thread.id, deleted: true };
};

export const deleteForumComment = async (
  dalInstance: DataAccessLayer,
  { commentId, revSummary }: DeleteForumCommentInput,
  userId: string
): Promise<{ id: string; deleted: boolean }> => {
  const errors = new ValidationCollector('Invalid forum comment delete input.');
  ensureNonEmptyString(commentId, 'commentId', errors);
  requireRevSummary(revSummary, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();
  await assertCanModerateForum(dalInstance, userId);

  const comment = await requireComment(commentId);
  const deletionRevision = await deleteAllEntityRevisions(comment, userId);
  await applyDeletionRevisionSummary(deletionRevision, revSummary);
  await deletionRevision.save();

  return { id: comment.id, deleted: true };
};

export const requireSignedInUserId = (userId: string | null | undefined) => {
  if (!userId) {
    throw new ForbiddenError('User must be signed in.');
  }
  return userId;
};
