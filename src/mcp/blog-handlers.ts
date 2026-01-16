import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from 'diff';
import dal from '../../dal/index.js';
import type { DataAccessLayer } from '../../dal/lib/data-access-layer.js';
import languages from '../../locales/languages.js';
import BlogPost from '../models/blog-post.js';
import type { BlogPostInstance } from '../models/manifests/blog-post.js';

const { mlString } = dal;

const ensureNonEmptyString = (value: string | undefined | null, label: string) => {
  if (!value || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
};

const ensureOptionalString = (value: string | undefined | null, label: string) => {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
};

const ensureOptionalLanguage = (value: string | undefined | null, label: string) => {
  ensureOptionalString(value, label);
  if (!value) return;
  if (!languages.isValid(value)) {
    throw new Error(`${label} must be a supported locale code.`);
  }
};

const ensureObject = (value: unknown, label: string) => {
  if (value && typeof value === 'object') return;
  throw new Error(`${label} must be an object.`);
};

const ensureNonEmptySlug = (slug: string) => ensureNonEmptyString(slug, 'slug');

const validateTitle = (value: Record<string, string> | null | undefined) => {
  if (value === undefined || value === null) return;
  ensureObject(value, 'title');
};

const validateBody = (value: Record<string, string> | null | undefined) => {
  if (value === undefined || value === null) return;
  ensureObject(value, 'body');
};

const validateSummary = (value: Record<string, string> | null | undefined) => {
  if (value === undefined || value === null) return;
  ensureObject(value, 'summary');
};

const validateRevSummary = (value: Record<string, string> | null | undefined) => {
  if (value === undefined || value === null) return;
  ensureObject(value, 'revSummary');
  for (const [lang, summary] of Object.entries(value)) {
    if (summary.length > 300) {
      throw new Error(`revSummary for ${lang} must be 300 characters or less.`);
    }
  }
};

const requireRevSummary = (value: Record<string, string> | null | undefined) => {
  if (value === null || value === undefined) {
    throw new Error('revSummary is required for updates.');
  }
  validateRevSummary(value);
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error('revSummary must include at least one language entry.');
  }
  for (const [lang, summary] of entries) {
    if (!lang || !summary || summary.trim().length === 0) {
      throw new Error('revSummary entries must be non-empty strings.');
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
    [userId, 'blog_author']
  );
  if (result.rowCount === 0) {
    throw new Error('User does not have blog_author role.');
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
  ensureNonEmptySlug(slug);
  const post = await findCurrentPostBySlug(slug);
  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
  }
  return toBlogPostResult(post);
}

export async function readBlogPostResource(
  _dalInstance: DataAccessLayer,
  uri: string
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  const parsed = new URL(uri);
  if (parsed.hostname !== 'blog') {
    throw new Error(`Unknown MCP resource: ${uri}`);
  }
  const slug = parsed.searchParams.get('slug') ?? '';
  if (!slug) {
    throw new Error(`Invalid MCP resource: ${uri}`);
  }
  const post = await findCurrentPostBySlug(slug);
  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
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
  ensureNonEmptySlug(slug);
  ensureNonEmptyString(userId, 'userId');
  ensureOptionalLanguage(originalLanguage, 'originalLanguage');
  validateTitle(title);
  validateBody(body);
  validateSummary(summary);
  validateRevSummary(revSummary);
  await requireBlogAuthor(dalInstance, userId);

  const existing = await findCurrentPostBySlug(slug);
  if (existing) {
    throw new Error(`Blog post already exists: ${slug}`);
  }

  const createdAt = new Date();
  const post = await BlogPost.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );
  post.slug = slug;
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
  ensureNonEmptySlug(slug);
  ensureNonEmptyString(userId, 'userId');
  ensureOptionalString(newSlug, 'newSlug');
  ensureOptionalLanguage(originalLanguage, 'originalLanguage');
  validateTitle(title);
  validateBody(body);
  validateSummary(summary);
  requireRevSummary(revSummary);
  await requireBlogAuthor(dalInstance, userId);

  const post = await findCurrentPostBySlug(slug);
  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
  }
  if (newSlug && newSlug !== slug) {
    const slugMatch = await findCurrentPostBySlug(newSlug);
    if (slugMatch) {
      throw new Error(`Blog post already exists: ${newSlug}`);
    }
  }

  await post.newRevision({ id: userId }, { tags: ['update', ...tags] });
  if (newSlug !== undefined) post.slug = newSlug;
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
  const post = await findCurrentPostBySlug(slug);
  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
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
  const post = await findCurrentPostBySlug(slug);
  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
  }
  const result = await dalInstance.query(
    `SELECT * FROM ${BlogPost.tableName} WHERE _rev_id = $1 AND (id = $2 OR _old_rev_of = $2) LIMIT 1`,
    [revId, post.id]
  );
  const [row] = result.rows;
  if (!row) {
    throw new Error(`Revision not found: ${revId}`);
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
  const post = await findCurrentPostBySlug(slug);
  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
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
    throw new Error(`Revision not found: ${fromRevId}`);
  }
  const toRevisionId = toRevId ?? post._revID;
  const toRev = await fetchRevisionByRevId(toRevisionId);
  if (!toRev) {
    throw new Error(`Revision not found: ${toRevisionId}`);
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
