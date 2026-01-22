import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from 'diff';
import dal from '../../dal/index.js';
import type { DataAccessLayer } from '../../dal/lib/data-access-layer.js';
import languages from '../../locales/languages.js';
import { normalizeSlug } from '../lib/slug.js';
import BlogPost from '../models/blog-post.js';
import type { BlogPostInstance } from '../models/manifests/blog-post.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  ValidationCollector,
  ValidationError,
} from './errors.js';
import { BLOG_AUTHOR_ROLE } from './roles.js';

const { mlString } = dal;

const ensureNonEmptyString = (
  value: string | undefined | null,
  label: string,
  errors?: ValidationCollector
) => {
  if (!value || !value.trim()) {
    if (errors) {
      errors.add(label, 'is required.', 'required');
      return false;
    }
    throw new ValidationError(`${label} is required.`, [
      { field: label, message: 'is required.', code: 'required' },
    ]);
  }
  return true;
};

const normalizeSlugInput = (value: string, label: string, errors?: ValidationCollector) => {
  if (!ensureNonEmptyString(value, label, errors)) return '';
  const normalized = normalizeSlug(value);
  if (!normalized) {
    if (errors) {
      errors.add(label, 'is required.', 'required');
      return '';
    }
    throw new ValidationError(`${label} is required.`, [
      { field: label, message: 'is required.', code: 'required' },
    ]);
  }
  return normalized;
};

const normalizeOptionalSlug = (
  value: string | undefined | null,
  label: string,
  errors?: ValidationCollector
) => {
  ensureOptionalString(value, label, errors);
  if (!value) return undefined;
  const normalized = normalizeSlug(value);
  if (!normalized) {
    if (errors) {
      errors.add(label, 'is required.', 'required');
      return undefined;
    }
    throw new ValidationError(`${label} is required.`, [
      { field: label, message: 'is required.', code: 'required' },
    ]);
  }
  return normalized;
};

const ensureOptionalString = (
  value: string | undefined | null,
  label: string,
  errors?: ValidationCollector
) => {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    if (errors) {
      errors.add(label, 'must be a string.', 'type');
      return;
    }
    throw new ValidationError(`${label} must be a string.`, [
      { field: label, message: 'must be a string.', code: 'type' },
    ]);
  }
};

const ensureOptionalLanguage = (
  value: string | undefined | null,
  label: string,
  errors?: ValidationCollector
) => {
  ensureOptionalString(value, label, errors);
  if (!value) return;
  if (!languages.isValid(value)) {
    if (errors) {
      errors.add(label, 'must be a supported locale code.', 'invalid');
      return;
    }
    throw new ValidationError(`${label} must be a supported locale code.`, [
      { field: label, message: 'must be a supported locale code.', code: 'invalid' },
    ]);
  }
};

const ensureNonEmptySlug = (slug: string) => normalizeSlugInput(slug, 'slug');

const validateTitle = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  try {
    mlString.validate(value, { maxLength: 200, allowHTML: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid title value.';
    if (errors) {
      errors.add('title', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'title', message, code: 'invalid' }]);
  }
};

const validateBody = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  try {
    mlString.validate(value, { maxLength: 20000, allowHTML: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid body value.';
    if (errors) {
      errors.add('body', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'body', message, code: 'invalid' }]);
  }
};

const validateSummary = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  try {
    mlString.validate(value, { maxLength: 500, allowHTML: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid summary value.';
    if (errors) {
      errors.add('summary', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'summary', message, code: 'invalid' }]);
  }
};

const validateRevSummary = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined || value === null) return;
  try {
    mlString.validate(value, { maxLength: 300, allowHTML: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid revSummary value.';
    if (errors) {
      errors.add('revSummary', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'revSummary', message, code: 'invalid' }]);
  }
  for (const [lang, summary] of Object.entries(value)) {
    if (summary.length > 300) {
      if (errors) {
        errors.add(`revSummary.${lang}`, 'must be 300 characters or less.', 'max_length');
        continue;
      }
      throw new ValidationError(`revSummary for ${lang} must be 300 characters or less.`, [
        {
          field: `revSummary.${lang}`,
          message: 'must be 300 characters or less.',
          code: 'max_length',
        },
      ]);
    }
  }
};

const requireRevSummary = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) {
    if (errors) {
      errors.addMissing('revSummary');
      return;
    }
    throw new ValidationError('revSummary is required for updates.', [
      { field: 'revSummary', message: 'is required.', code: 'required' },
    ]);
  }
  validateRevSummary(value, errors);
  const entries = Object.entries(value);
  if (entries.length === 0) {
    if (errors) {
      errors.add('revSummary', 'must include at least one language entry.', 'invalid');
      return;
    }
    throw new ValidationError('revSummary must include at least one language entry.', [
      { field: 'revSummary', message: 'must include at least one language entry.', code: 'invalid' },
    ]);
  }
  for (const [lang, summary] of entries) {
    if (!lang || !summary || summary.trim().length === 0) {
      if (errors) {
        errors.add(`revSummary.${lang || 'unknown'}`, 'must be a non-empty string.', 'invalid');
        continue;
      }
      throw new ValidationError('revSummary entries must be non-empty strings.', [
        {
          field: `revSummary.${lang || 'unknown'}`,
          message: 'must be a non-empty string.',
          code: 'invalid',
        },
      ]);
    }
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
  title?: Record<string, string> | null;
  body?: Record<string, string> | null;
  summary?: Record<string, string> | null;
  originalLanguage?: string | null;
  tags?: string[];
  revSummary?: Record<string, string> | null;
}

export interface BlogPostUpdateInput extends BlogPostWriteInput {
  newSlug?: string;
  revSummary: Record<string, string>;
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
  revSummary: Record<string, string> | null | undefined;
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
  fields: {
    title: BlogPostFieldDiff;
    body: BlogPostFieldDiff;
    summary: BlogPostFieldDiff;
  };
}

export interface BlogPostFieldDiff {
  unifiedDiff: string;
  wordDiff: Array<{ type: 'added' | 'removed' | 'unchanged'; value: string }>;
  stats: {
    addedLines: number;
    removedLines: number;
  };
}

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

const buildFieldDiff = (label: string, fromValue: string, toValue: string): BlogPostFieldDiff => {
  const fromLines = fromValue.split('\n');
  const toLines = toValue.split('\n');
  const lineDiffs = diffLines(fromValue, toValue);
  let addedLines = 0;
  let removedLines = 0;
  for (const diff of lineDiffs) {
    if (diff.added) addedLines += diff.count ?? 0;
    if (diff.removed) removedLines += diff.count ?? 0;
  }
  const unifiedDiff = createTwoFilesPatch(
    label,
    label,
    fromLines.join('\n'),
    toLines.join('\n'),
    '',
    '',
    { context: 2 }
  );
  const wordDiff = diffWordsWithSpace(fromValue, toValue).map(change => {
    const type: 'added' | 'removed' | 'unchanged' = change.added
      ? 'added'
      : change.removed
        ? 'removed'
        : 'unchanged';
    return { type, value: change.value };
  });
  return {
    unifiedDiff,
    wordDiff,
    stats: {
      addedLines,
      removedLines,
    },
  };
};

const requireBlogAuthor = async (dalInstance: DataAccessLayer, userId: string) => {
  const result = await dalInstance.query(
    'SELECT 1 FROM user_roles WHERE user_id = $1 AND role = $2 LIMIT 1',
    [userId, BLOG_AUTHOR_ROLE]
  );
  if (result.rowCount === 0) {
    throw new ForbiddenError(`User does not have ${BLOG_AUTHOR_ROLE} role.`);
  }
};

export async function listBlogPostResources(
  _dalInstance: DataAccessLayer
): Promise<{ resources: Array<{ uri: string; name: string; mimeType?: string }> }> {
  const posts = await BlogPost.filterWhere({
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>)
    .orderBy('slug')
    .run();
  const resources = posts.map(post => ({
    uri: `agpwiki://blog?slug=${post.slug}`,
    name: post.slug,
    mimeType: 'application/json',
  }));
  return { resources };
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

export async function readBlogPostResource(
  _dalInstance: DataAccessLayer,
  uri: string
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  const parsed = new URL(uri);
  if (parsed.hostname !== 'blog') {
    throw new InvalidRequestError(`Unknown MCP resource: ${uri}`);
  }
  const slug = parsed.searchParams.get('slug') ?? '';
  if (!slug) {
    throw new InvalidRequestError(`Invalid MCP resource: ${uri}`);
  }
  const normalizedSlug = ensureNonEmptySlug(slug);
  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  const payload = {
    ...toBlogPostResult(post),
  };
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
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
  if (title !== undefined) post.title = title;
  if (body !== undefined) post.body = body;
  if (summary !== undefined) post.summary = summary;
  if (originalLanguage !== undefined) post.originalLanguage = originalLanguage;
  if (revSummary !== undefined) post._revSummary = revSummary;
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
  if (title !== undefined) post.title = title;
  if (body !== undefined) post.body = body;
  if (summary !== undefined) post.summary = summary;
  if (originalLanguage !== undefined) post.originalLanguage = originalLanguage;
  if (revSummary !== undefined) post._revSummary = revSummary;
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
  const fromTitle = mlString.resolve(lang, fromRev.title ?? null)?.str ?? '';
  const toTitle = mlString.resolve(lang, toRev.title ?? null)?.str ?? '';
  const fromBody = mlString.resolve(lang, fromRev.body ?? null)?.str ?? '';
  const toBody = mlString.resolve(lang, toRev.body ?? null)?.str ?? '';
  const fromSummary = mlString.resolve(lang, fromRev.summary ?? null)?.str ?? '';
  const toSummary = mlString.resolve(lang, toRev.summary ?? null)?.str ?? '';
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
    fields: {
      title: buildFieldDiff('title', fromTitle, toTitle),
      body: buildFieldDiff('body', fromBody, toBody),
      summary: buildFieldDiff('summary', fromSummary, toSummary),
    },
  };
}

export async function deleteBlogPost(
  _dalInstance: DataAccessLayer,
  { slug, revSummary }: BlogPostDeleteInput,
  userId: string
): Promise<BlogPostDeleteResult> {
  const errors = new ValidationCollector('Invalid blog post delete input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const post = await findCurrentPostBySlug(normalizedSlug);
  if (!post) {
    throw new NotFoundError(`Blog post not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  await post.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });

  return {
    id: post.id,
    slug: post.slug,
    deleted: true,
  };
}
