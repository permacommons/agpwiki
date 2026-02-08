import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { validateCitationClaimRefs } from '../lib/citation-claim-validation.js';
import { validateLocalizedMarkdownContent } from '../lib/content-validation.js';
import type { FieldDiff } from '../lib/diff-engine.js';
import { diffLocalizedField, diffScalarField } from '../lib/diff-engine.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationCollector,
  ValidationError,
} from '../lib/errors.js';
import { type LocalizedMapInput, mergeLocalizedMap, sanitizeLocalizedMapInput } from '../lib/localized.js';
import BlogPost from '../models/blog-post.js';
import type { BlogPostInstance } from '../models/manifests/blog-post.js';
import { assertCanDeleteBlogPost } from './authorization.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import { BLOG_AUTHOR_ROLE, userHasRole } from './roles.js';
import {
  ensureNonEmptyString,
  ensureOptionalLanguage,
  normalizeOptionalSlug,
  normalizeSlugInput,
  requireRevSummary,
  validateBody,
  validateRevSummary,
  validateTitle,
} from './validation.js';

const { mlString } = dal;

const ensureNonEmptySlug = (slug: string) => normalizeSlugInput(slug, 'slug');

const validateSummary = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 500, allowHTML: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid summary value.';
    if (errors) {
      errors.add('summary', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'summary', message, code: 'invalid' }]);
  }
};

const findCurrentPostBySlug = async (slug: string) =>
  BlogPost.filterWhere({ slug, _oldRevOf: null, _revDeleted: false } as Record<string, unknown>).first();

const toBlogPostResult = (post: BlogPostInstance) => ({
  id: post.id,
  slug: post.slug,
  title: post.title ?? null,
  body: post.body ?? null,
  summary: post.summary ?? null,
  originalLanguage: post.originalLanguage ?? null,
  createdAt: post.createdAt ?? null,
  updatedAt: post.updatedAt ?? null,
});

export interface BlogPostWriteInput {
  slug: string;
  title?: LocalizedMapInput;
  body?: LocalizedMapInput;
  summary?: LocalizedMapInput;
  originalLanguage?: string | null;
  tags?: string[];
  revSummary?: LocalizedMapInput;
}

export interface BlogPostUpdateInput extends BlogPostWriteInput {
  newSlug?: string;
  revSummary: Record<string, string | null>;
}

export interface BlogPostResult {
  id: string;
  slug: string;
  title: Record<string, string> | null | undefined;
  body: Record<string, string> | null | undefined;
  summary: Record<string, string> | null | undefined;
  originalLanguage: string | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
}

export interface BlogPostRevisionResult extends BlogPostResult {
  revId: string;
  revDate: Date;
  revUser: string | null | undefined;
  revTags: string[] | null | undefined;
  revSummary: Record<string, string> | null | undefined;
  revDeleted: boolean;
  oldRevOf: string | null | undefined;
}

export interface BlogPostRevisionListResult {
  postId: string;
  revisions: BlogPostRevisionResult[];
}

export interface BlogPostRevisionReadResult {
  postId: string;
  revision: BlogPostRevisionResult;
}

export interface BlogPostDeleteInput {
  slug: string;
  revSummary: LocalizedMapInput;
}

export interface BlogPostDeleteResult {
  id: string;
  slug: string;
  deleted: boolean;
}

export interface BlogPostDiffInput {
  slug: string;
  fromRevId: string;
  toRevId?: string;
  lang?: string;
}

export interface BlogPostDiffResult {
  postId: string;
  fromRevId: string;
  toRevId: string;
  language: string;
  from: {
    revId: string;
    revDate: Date;
    revUser: string | null | undefined;
    revTags: string[] | null | undefined;
  };
  to: {
    revId: string;
    revDate: Date;
    revUser: string | null | undefined;
    revTags: string[] | null | undefined;
  };
  fields: Record<string, FieldDiff>;
}

export type BlogPostFieldDiff = FieldDiff;

const toBlogPostRevisionResult = (post: BlogPostInstance): BlogPostRevisionResult => ({
  ...toBlogPostResult(post),
  revId: post._revID,
  revDate: post._revDate,
  revUser: post._revUser ?? null,
  revTags: post._revTags ?? null,
  revSummary: post._revSummary ?? null,
  revDeleted: post._revDeleted ?? false,
  oldRevOf: post._oldRevOf ?? null,
});

const requireBlogAuthor = async (dalInstance: DataAccessLayer, userId: string) => {
  const hasAuthorRole = await userHasRole(dalInstance, userId, BLOG_AUTHOR_ROLE);
  if (!hasAuthorRole) {
    throw new ForbiddenError(`User does not have ${BLOG_AUTHOR_ROLE} role.`);
  }
};

export interface BlogPostListResult {
  hint: string;
  posts: Array<{ slug: string; name: string }>;
}

export interface BlogPostListQueryInput {
  limit?: number;
  offset?: number;
}

export async function listBlogPostResources(
  _dalInstance: DataAccessLayer
): Promise<BlogPostListResult> {
  const posts = await BlogPost.filterWhere({
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>)
    .orderBy('slug')
    .run();

  return {
    hint: 'Use blog_readPost tool with slug to read a post.',
    posts: posts.map(post => ({
      slug: post.slug,
      name: post.slug,
    })),
  };
}

export async function listBlogPosts(
  dalInstance: DataAccessLayer,
  { limit, offset }: BlogPostListQueryInput = {}
): Promise<BlogPostResult[]> {
  const normalizedLimit = Math.min(Math.max(limit ?? 100, 1), 500);
  const normalizedOffset = Math.max(offset ?? 0, 0);
  // Route list pages and APIs can share this read model without touching ORM directly.
  const result = await dalInstance.query(
    `SELECT * FROM ${BlogPost.tableName}
     WHERE _old_rev_of IS NULL AND _rev_deleted = false
     ORDER BY created_at DESC, _rev_date DESC
     LIMIT $1 OFFSET $2`,
    [normalizedLimit, normalizedOffset]
  );
  return result.rows.map(row => toBlogPostResult(BlogPost.createFromRow(row)));
}

export async function readBlogPost(
  _dalInstance: DataAccessLayer,
  slug: string
): Promise<BlogPostResult> {
  const normalizedSlug = ensureNonEmptySlug(slug);
  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  return toBlogPostResult(post);
}

export async function createBlogPost(
  dalInstance: DataAccessLayer,
  { slug, title, body, summary, originalLanguage, tags = [], revSummary }: BlogPostWriteInput,
  userId: string
): Promise<BlogPostResult> {
  const errors = new ValidationCollector('Invalid blog post input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalLanguage(originalLanguage, 'originalLanguage', errors);
  validateTitle(title, errors);
  validateBody(body, errors);
  validateSummary(summary, errors);
  validateRevSummary(revSummary, errors);
  await validateLocalizedMarkdownContent(body, 'body', errors, [validateCitationClaimRefs]);
  await validateLocalizedMarkdownContent(summary, 'summary', errors, [validateCitationClaimRefs]);
  errors.throwIfAny();
  await requireBlogAuthor(dalInstance, userId);

  const existing = await findCurrentPostBySlug(normalizedSlug);
  if (existing) {
    throw new ConflictError(`Blog post already exists: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const createdAt = new Date();
  const post = await BlogPost.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );
  post.slug = normalizedSlug;
  const normalizedTitle = sanitizeLocalizedMapInput(title);
  const normalizedBody = sanitizeLocalizedMapInput(body);
  const normalizedSummary = sanitizeLocalizedMapInput(summary);
  if (normalizedTitle !== undefined) post.title = normalizedTitle;
  if (normalizedBody !== undefined) post.body = normalizedBody;
  if (normalizedSummary !== undefined) post.summary = normalizedSummary;
  if (originalLanguage !== undefined) post.originalLanguage = originalLanguage;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) post._revSummary = normalizedRevSummary;
  post.createdAt = createdAt;
  post.updatedAt = createdAt;
  await post.save();

  return toBlogPostResult(post);
}

export async function updateBlogPost(
  dalInstance: DataAccessLayer,
  { slug, newSlug, title, body, summary, originalLanguage, tags = [], revSummary }: BlogPostUpdateInput,
  userId: string
): Promise<BlogPostResult> {
  const errors = new ValidationCollector('Invalid blog post update input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  const normalizedNewSlug = normalizeOptionalSlug(newSlug, 'newSlug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalLanguage(originalLanguage, 'originalLanguage', errors);
  validateTitle(title, errors);
  validateBody(body, errors);
  validateSummary(summary, errors);
  requireRevSummary(revSummary, errors);
  await validateLocalizedMarkdownContent(body, 'body', errors, [validateCitationClaimRefs]);
  await validateLocalizedMarkdownContent(summary, 'summary', errors, [validateCitationClaimRefs]);
  errors.throwIfAny();
  await requireBlogAuthor(dalInstance, userId);

  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  if (normalizedNewSlug && normalizedNewSlug !== normalizedSlug) {
    const slugMatch = await findCurrentPostBySlug(normalizedNewSlug);
    if (slugMatch) {
      throw new ConflictError(`Blog post already exists: ${normalizedNewSlug}`, {
        slug: normalizedNewSlug,
      });
    }
  }

  await post.newRevision({ id: userId }, { tags: ['update', ...tags] });
  if (normalizedNewSlug !== undefined) post.slug = normalizedNewSlug;
  const mergedTitle = mergeLocalizedMap(post.title ?? null, title);
  const mergedBody = mergeLocalizedMap(post.body ?? null, body);
  const mergedSummary = mergeLocalizedMap(post.summary ?? null, summary);
  if (mergedTitle !== undefined) post.title = mergedTitle;
  if (mergedBody !== undefined) post.body = mergedBody;
  if (mergedSummary !== undefined) post.summary = mergedSummary;
  if (originalLanguage !== undefined) post.originalLanguage = originalLanguage;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) post._revSummary = normalizedRevSummary;
  post.updatedAt = new Date();
  await post.save();

  return toBlogPostResult(post);
}

export async function listBlogPostRevisions(
  dalInstance: DataAccessLayer,
  slug: string
): Promise<BlogPostRevisionListResult> {
  const normalizedSlug = ensureNonEmptySlug(slug);
  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  const tableName = BlogPost.tableName;
  const result = await dalInstance.query(
    `SELECT * FROM ${tableName} WHERE id = $1 OR _old_rev_of = $1 ORDER BY _rev_date DESC`,
    [post.id]
  );
  const revisions = result.rows.map(row => toBlogPostRevisionResult(BlogPost.createFromRow(row)));
  return {
    postId: post.id,
    revisions,
  };
}

export async function readBlogPostRevision(
  dalInstance: DataAccessLayer,
  slug: string,
  revId: string
): Promise<BlogPostRevisionReadResult> {
  const normalizedSlug = ensureNonEmptySlug(slug);
  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  const result = await dalInstance.query(
    `SELECT * FROM ${BlogPost.tableName} WHERE _rev_id = $1 AND (id = $2 OR _old_rev_of = $2) LIMIT 1`,
    [revId, post.id]
  );
  const [row] = result.rows;
  if (!row) {
    throw new NotFoundError(`Revision not found: ${revId}`, {
      revId,
    });
  }
  const revision = BlogPost.createFromRow(row);
  return {
    postId: post.id,
    revision: toBlogPostRevisionResult(revision),
  };
}

export async function diffBlogPostRevisions(
  dalInstance: DataAccessLayer,
  { slug, fromRevId, toRevId, lang = 'en' }: BlogPostDiffInput
): Promise<BlogPostDiffResult> {
  ensureOptionalLanguage(lang, 'lang');
  const normalizedSlug = ensureNonEmptySlug(slug);
  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  const fetchRevisionByRevId = async (revId: string) => {
    const result = await dalInstance.query(
      `SELECT * FROM ${BlogPost.tableName} WHERE _rev_id = $1 AND (id = $2 OR _old_rev_of = $2) LIMIT 1`,
      [revId, post.id]
    );
    const [row] = result.rows;
    return row ? BlogPost.createFromRow(row) : null;
  };
  const fromRev = await fetchRevisionByRevId(fromRevId);
  if (!fromRev) {
    throw new NotFoundError(`Revision not found: ${fromRevId}`, {
      revId: fromRevId,
    });
  }
  const toRevisionId = toRevId ?? post._revID;
  const toRev = await fetchRevisionByRevId(toRevisionId);
  if (!toRev) {
    throw new NotFoundError(`Revision not found: ${toRevisionId}`, {
      revId: toRevisionId,
    });
  }
  const fields: Record<string, FieldDiff> = {};
  const titleDiff = diffLocalizedField('title', fromRev.title ?? null, toRev.title ?? null);
  if (titleDiff) fields.title = titleDiff;
  const bodyDiff = diffLocalizedField('body', fromRev.body ?? null, toRev.body ?? null);
  if (bodyDiff) fields.body = bodyDiff;
  const summaryDiff = diffLocalizedField(
    'summary',
    fromRev.summary ?? null,
    toRev.summary ?? null
  );
  if (summaryDiff) fields.summary = summaryDiff;
  const slugDiff = diffScalarField('slug', fromRev.slug ?? null, toRev.slug ?? null);
  if (slugDiff) fields.slug = slugDiff;
  const originalLangDiff = diffScalarField(
    'originalLanguage',
    fromRev.originalLanguage ?? null,
    toRev.originalLanguage ?? null
  );
  if (originalLangDiff) fields.originalLanguage = originalLangDiff;
  return {
    postId: post.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    language: lang,
    from: {
      revId: fromRev._revID,
      revDate: fromRev._revDate,
      revUser: fromRev._revUser ?? null,
      revTags: fromRev._revTags ?? null,
    },
    to: {
      revId: toRev._revID,
      revDate: toRev._revDate,
      revUser: toRev._revUser ?? null,
      revTags: toRev._revTags ?? null,
    },
    fields,
  };
}

export async function deleteBlogPost(
  dalInstance: DataAccessLayer,
  { slug, revSummary }: BlogPostDeleteInput,
  userId: string
): Promise<BlogPostDeleteResult> {
  const errors = new ValidationCollector('Invalid blog post delete input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();
  await assertCanDeleteBlogPost(dalInstance, userId);

  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const deletionRevision = await post.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });
  await applyDeletionRevisionSummary(deletionRevision, revSummary);

  return {
    id: post.id,
    slug: post.slug,
    deleted: true,
  };
}
