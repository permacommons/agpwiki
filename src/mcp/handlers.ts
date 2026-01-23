import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from 'diff';
import dal from '../../dal/index.js';
import type { DataAccessLayer } from '../../dal/lib/data-access-layer.js';
import languages from '../../locales/languages.js';
import { isBlockedSlug, normalizeSlug } from '../lib/slug.js';
import Citation from '../models/citation.js';
import type { CitationInstance } from '../models/manifests/citation.js';
import type { PageAliasInstance } from '../models/manifests/page-alias.js';
import type { WikiPageInstance } from '../models/manifests/wiki-page.js';
import PageAlias from '../models/page-alias.js';
import WikiPage from '../models/wiki-page.js';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PreconditionFailedError,
  ValidationCollector,
  ValidationError,
} from './errors.js';
import { applyUnifiedPatch, type PatchFormat } from './patch.js';

const { mlString } = dal;

export interface McpResource {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpListResourcesResult {
  resources: McpResource[];
}

export interface McpReadResourceResult {
  contents: McpResourceContents[];
}

export interface WikiPageWriteInput {
  slug: string;
  title?: Record<string, string> | null;
  body?: Record<string, string> | null;
  originalLanguage?: string | null;
  tags?: string[];
  revSummary?: Record<string, string> | null;
}

export interface WikiPageUpdateInput extends WikiPageWriteInput {
  newSlug?: string;
  revSummary: Record<string, string>;
}

export interface WikiPageResult {
  id: string;
  slug: string;
  title: Record<string, string> | null | undefined;
  body: Record<string, string> | null | undefined;
  originalLanguage: string | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
}

export interface WikiPageRevisionResult extends WikiPageResult {
  revId: string;
  revDate: Date;
  revUser: string | null | undefined;
  revTags: string[] | null | undefined;
  revSummary: Record<string, string> | null | undefined;
  revDeleted: boolean;
  oldRevOf: string | null | undefined;
}

export interface WikiPageRevisionListResult {
  pageId: string;
  revisions: WikiPageRevisionResult[];
}

export interface WikiPageRevisionReadResult {
  pageId: string;
  revision: WikiPageRevisionResult;
}

export interface WikiPageDiffInput {
  slug: string;
  fromRevId: string;
  toRevId?: string;
  lang?: string;
}

export interface WikiPagePatchInput {
  slug: string;
  patch: string;
  format: PatchFormat;
  lang?: string;
  baseRevId?: string;
  tags?: string[];
  revSummary: Record<string, string>;
}

export interface WikiPageAliasInput {
  slug: string;
  pageSlug: string;
  lang?: string;
}

export interface WikiPageAliasResult {
  id: string;
  pageId: string;
  slug: string;
  lang: string | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
  createdBy: string | null | undefined;
}

export interface WikiPageAliasDeleteResult {
  slug: string;
  removed: boolean;
}

export interface WikiPageDeleteInput {
  slug: string;
  revSummary: Record<string, string>;
}

export interface WikiPageDeleteResult {
  id: string;
  slug: string;
  deleted: boolean;
}

export interface CitationDeleteInput {
  key: string;
  revSummary: Record<string, string>;
}

export interface CitationDeleteResult {
  id: string;
  key: string;
  deleted: boolean;
}

export interface WikiPageDiffResult {
  pageId: string;
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
    title: WikiPageFieldDiff;
    body: WikiPageFieldDiff;
  };
}

export interface WikiPageFieldDiff {
  unifiedDiff: string;
  wordDiff: Array<{ type: 'added' | 'removed' | 'unchanged'; value: string }>;
  stats: {
    addedLines: number;
    removedLines: number;
  };
}

export interface CitationWriteInput {
  key: string;
  data: Record<string, unknown>;
  tags?: string[];
  revSummary?: Record<string, string> | null;
}

export interface CitationUpdateInput {
  key: string;
  newKey?: string;
  data?: Record<string, unknown> | null;
  tags?: string[];
  revSummary: Record<string, string>;
}

export interface CitationResult {
  id: string;
  key: string;
  data: Record<string, unknown> | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
}

export interface CitationRevisionResult extends CitationResult {
  revId: string;
  revDate: Date;
  revUser: string | null | undefined;
  revTags: string[] | null | undefined;
  revSummary: Record<string, string> | null | undefined;
  revDeleted: boolean;
  oldRevOf: string | null | undefined;
}

export interface CitationRevisionListResult {
  citationId: string;
  revisions: CitationRevisionResult[];
}

export interface CitationRevisionReadResult {
  citationId: string;
  revision: CitationRevisionResult;
}

export interface CitationDiffInput {
  key: string;
  fromRevId: string;
  toRevId?: string;
}

export interface CitationDiffResult {
  citationId: string;
  fromRevId: string;
  toRevId: string;
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
    key: WikiPageFieldDiff;
    data: WikiPageFieldDiff;
  };
}

export interface CitationQueryInput {
  keyPrefix?: string;
  title?: string;
  author?: string;
  year?: number;
  yearFrom?: number;
  yearTo?: number;
  doi?: string;
  url?: string;
  domain?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface CitationQueryResult {
  citations: CitationResult[];
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

const toWikiPageResult = (page: WikiPageInstance): WikiPageResult => ({
  id: page.id,
  slug: page.slug,
  title: page.title ?? null,
  body: page.body ?? null,
  originalLanguage: page.originalLanguage ?? null,
  createdAt: page.createdAt ?? null,
  updatedAt: page.updatedAt ?? null,
});

const toWikiPageRevisionResult = (page: WikiPageInstance): WikiPageRevisionResult => ({
  ...toWikiPageResult(page),
  revId: page._revID,
  revDate: page._revDate,
  revUser: page._revUser ?? null,
  revTags: page._revTags ?? null,
  revSummary: page._revSummary ?? null,
  revDeleted: page._revDeleted ?? false,
  oldRevOf: page._oldRevOf ?? null,
});

const toCitationResult = (citation: CitationInstance): CitationResult => ({
  id: citation.id,
  key: citation.key,
  data: citation.data ?? null,
  createdAt: citation.createdAt ?? null,
  updatedAt: citation.updatedAt ?? null,
});

const toCitationRevisionResult = (citation: CitationInstance): CitationRevisionResult => ({
  ...toCitationResult(citation),
  revId: citation._revID,
  revDate: citation._revDate,
  revUser: citation._revUser ?? null,
  revTags: citation._revTags ?? null,
  revSummary: citation._revSummary ?? null,
  revDeleted: citation._revDeleted ?? false,
  oldRevOf: citation._oldRevOf ?? null,
});

const toWikiPageAliasResult = (alias: PageAliasInstance): WikiPageAliasResult => ({
  id: alias.id,
  pageId: alias.pageId,
  slug: alias.slug,
  lang: alias.lang ?? null,
  createdAt: alias.createdAt ?? null,
  updatedAt: alias.updatedAt ?? null,
  createdBy: alias.createdBy ?? null,
});

const findCurrentPageBySlug = async (slug: string) =>
  WikiPage.filterWhere({
    slug,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentPageById = async (id: string) =>
  WikiPage.filterWhere({
    id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentPageBySlugOrAlias = async (slug: string) => {
  const direct = await findCurrentPageBySlug(slug);
  if (direct) return direct;

  const alias = await PageAlias.filterWhere({ slug }).first();
  if (!alias) return null;

  return findCurrentPageById(alias.pageId);
};

const findCurrentCitationByKey = async (key: string) =>
  Citation.filterWhere({
    key,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const fetchPageRevisionByRevId = async (
  dalInstance: DataAccessLayer,
  pageId: string,
  revId: string
): Promise<WikiPageInstance | null> => {
  const tableName = WikiPage.tableName;
  const result = await dalInstance.query(
    `SELECT * FROM ${tableName} WHERE _rev_id = $1 AND (id = $2 OR _old_rev_of = $2) LIMIT 1`,
    [revId, pageId]
  );

  const [row] = result.rows;
  if (!row) return null;
  return WikiPage.createFromRow(row);
};

const fetchCitationRevisionByRevId = async (
  dalInstance: DataAccessLayer,
  citationId: string,
  revId: string
): Promise<CitationInstance | null> => {
  const tableName = Citation.tableName;
  const result = await dalInstance.query(
    `SELECT * FROM ${tableName} WHERE _rev_id = $1 AND (id = $2 OR _old_rev_of = $2) LIMIT 1`,
    [revId, citationId]
  );

  const [row] = result.rows;
  if (!row) return null;
  return Citation.createFromRow(row);
};

const normalizeForDiff = (value: string): string => (value.endsWith('\n') ? value : `${value}\n`);

const buildFieldDiff = (
  fieldName: string,
  fromValue: string,
  toValue: string
): WikiPageFieldDiff => {
  const fromNormalized = normalizeForDiff(fromValue);
  const toNormalized = normalizeForDiff(toValue);
  const unifiedDiff = createTwoFilesPatch(
    fieldName,
    fieldName,
    fromNormalized,
    toNormalized,
    '',
    '',
    { context: 2 }
  );
  const wordDiff = diffWordsWithSpace(fromValue, toValue).map(part => ({
    type: (part.added ? 'added' : part.removed ? 'removed' : 'unchanged') as
      | 'added'
      | 'removed'
      | 'unchanged',
    value: part.value,
  }));
  const lineDiff = diffLines(fromNormalized, toNormalized);
  let addedLines = 0;
  let removedLines = 0;

  const countLines = (text: string) => {
    if (!text) return 0;
    const lines = text.split('\n');
    return text.endsWith('\n') ? lines.length - 1 : lines.length;
  };

  for (const chunk of lineDiff) {
    if (chunk.added) addedLines += countLines(chunk.value);
    if (chunk.removed) removedLines += countLines(chunk.value);
  }

  return {
    unifiedDiff,
    wordDiff,
    stats: { addedLines, removedLines },
  };
};

const ensureNonEmptyString = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    if (errors) {
      errors.add(label, 'must be a non-empty string.', 'required');
      return false;
    }
    throw new ValidationError(`${label} must be a non-empty string.`, [
      { field: label, message: 'must be a non-empty string.', code: 'required' },
    ]);
  }
  return true;
};

const normalizeSlugInput = (value: string, label: string, errors?: ValidationCollector) => {
  if (!ensureNonEmptyString(value, label, errors)) return '';
  const normalized = normalizeSlug(value);
  if (!normalized) {
    if (errors) {
      errors.add(label, 'must be a non-empty string.', 'required');
      return '';
    }
    throw new ValidationError(`${label} must be a non-empty string.`, [
      { field: label, message: 'must be a non-empty string.', code: 'required' },
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
      errors.add(label, 'must be a non-empty string.', 'required');
      return undefined;
    }
    throw new ValidationError(`${label} must be a non-empty string.`, [
      { field: label, message: 'must be a non-empty string.', code: 'required' },
    ]);
  }
  return normalized;
};

const ensureOptionalString = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string') {
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
  value: string | null | undefined,
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

const validateRevSummary = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  try {
    mlString.validate(value, { maxLength: 300, allowHTML: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid revSummary value.';
    if (errors) {
      errors.add('revSummary', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [
      { field: 'revSummary', message, code: 'invalid' },
    ]);
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
  for (const [lang, text] of entries) {
    if (!lang || !text || text.trim().length === 0) {
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

const ensureObject = (
  value: Record<string, unknown> | null | undefined,
  label: string,
  { allowNull = false }: { allowNull?: boolean } = {},
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  if (value === null) {
    if (allowNull) return;
    if (errors) {
      errors.add(label, 'must be an object.', 'type');
      return;
    }
    throw new ValidationError(`${label} must be an object.`, [
      { field: label, message: 'must be an object.', code: 'type' },
    ]);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (errors) {
      errors.add(label, 'must be an object.', 'type');
      return;
    }
    throw new ValidationError(`${label} must be an object.`, [
      { field: label, message: 'must be an object.', code: 'type' },
    ]);
  }
};

const ensureKeyLength = (
  value: string,
  label: string,
  maxLength: number,
  errors?: ValidationCollector
) => {
  if (value.length > maxLength) {
    if (errors) {
      errors.add(label, `must be at most ${maxLength} characters.`, 'max_length');
      return;
    }
    throw new ValidationError(`${label} must be at most ${maxLength} characters.`, [
      { field: label, message: `must be at most ${maxLength} characters.`, code: 'max_length' },
    ]);
  }
};

const stringifyCitationData = (value: Record<string, unknown> | null | undefined): string =>
  value ? JSON.stringify(value, null, 2) : '';

export async function listWikiPageResources(
  _dalInstance: DataAccessLayer
): Promise<McpListResourcesResult> {
  const pages = await WikiPage.filterWhere({
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>)
    .orderBy('slug')
    .run();

  const resources = pages.map(page => {
    const resolved = mlString.resolve('en', page.title ?? null);
    const name = resolved?.str || page.slug || 'Untitled page';
    const slugParam = encodeURIComponent(page.slug);
    return {
      uri: `agpwiki://page?slug=${slugParam}`,
      name,
      mimeType: 'application/json',
    } satisfies McpResource;
  });

  return { resources };
}

export async function readWikiPageResource(
  _dalInstance: DataAccessLayer,
  uri: string
): Promise<McpReadResourceResult> {
  const parsed = new URL(uri);
  if (parsed.hostname !== 'page') {
    throw new InvalidRequestError(`Unknown MCP resource: ${uri}`);
  }

  const slug = parsed.searchParams.get('slug') ?? '';
  if (!slug) {
    throw new InvalidRequestError(
      `Missing required 'slug' parameter. Use the format: agpwiki://page?slug=your-page-slug`
    );
  }

  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);

  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const payload = {
    ...toWikiPageResult(page),
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

export async function readWikiPage(
  _dalInstance: DataAccessLayer,
  slug: string
): Promise<WikiPageResult> {
  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  return toWikiPageResult(page);
}

export async function createWikiPage(
  _dalInstance: DataAccessLayer,
  { slug, title, body, originalLanguage, tags = [], revSummary }: WikiPageWriteInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid wiki page input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalLanguage(originalLanguage, 'originalLanguage', errors);
  validateTitle(title, errors);
  validateBody(body, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();

  const existing = await findCurrentPageBySlug(normalizedSlug);
  if (existing) {
    throw new ConflictError(`Wiki page already exists: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }
  const existingAlias = await PageAlias.filterWhere({ slug: normalizedSlug }).first();
  if (existingAlias) {
    throw new ConflictError(`Wiki page alias already exists: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const createdAt = new Date();
  const page = await WikiPage.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );

  page.slug = normalizedSlug;
  if (title !== undefined) page.title = title;
  if (body !== undefined) page.body = body;
  if (originalLanguage !== undefined) page.originalLanguage = originalLanguage;
  if (revSummary !== undefined) page._revSummary = revSummary;
  page.createdAt = createdAt;
  page.updatedAt = createdAt;

  await page.save();

  return toWikiPageResult(page);
}

export async function updateWikiPage(
  _dalInstance: DataAccessLayer,
  {
    slug,
    newSlug,
    title,
    body,
    originalLanguage,
    tags = [],
    revSummary,
  }: WikiPageUpdateInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid wiki page update input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  const normalizedNewSlug = normalizeOptionalSlug(newSlug, 'newSlug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalLanguage(originalLanguage, 'originalLanguage', errors);
  validateTitle(title, errors);
  validateBody(body, errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  if (normalizedNewSlug && normalizedNewSlug !== normalizedSlug) {
    const slugMatch = await findCurrentPageBySlug(normalizedNewSlug);
    if (slugMatch) {
      throw new ConflictError(`Wiki page already exists: ${normalizedNewSlug}`, {
        slug: normalizedNewSlug,
      });
    }
    const aliasMatch = await PageAlias.filterWhere({ slug: normalizedNewSlug }).first();
    if (aliasMatch) {
      throw new ConflictError(`Wiki page alias already exists: ${normalizedNewSlug}`, {
        slug: normalizedNewSlug,
      });
    }
  }

  await page.newRevision({ id: userId }, { tags: ['update', ...tags] });

  if (normalizedNewSlug !== undefined) page.slug = normalizedNewSlug;
  if (title !== undefined) page.title = title;
  if (body !== undefined) page.body = body;
  if (originalLanguage !== undefined) page.originalLanguage = originalLanguage;
  if (revSummary !== undefined) page._revSummary = revSummary;
  page.updatedAt = new Date();

  await page.save();

  return toWikiPageResult(page);
}

export async function applyWikiPagePatch(
  _dalInstance: DataAccessLayer,
  { slug, patch, format, lang = 'en', baseRevId, tags = [], revSummary }: WikiPagePatchInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid wiki patch input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(patch, 'patch', errors);
  ensureNonEmptyString(format, 'format', errors);
  if (format && format !== 'unified' && format !== 'codex') {
    errors.add('format', 'must be "unified" or "codex".', 'invalid');
  }
  ensureOptionalLanguage(lang, 'lang', errors);
  ensureOptionalString(baseRevId, 'baseRevId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  if (baseRevId && baseRevId !== page._revID) {
    throw new PreconditionFailedError(
      `Revision mismatch: current is ${page._revID ?? 'unknown'}, base was ${baseRevId}.`,
      { currentRevId: page._revID ?? null, baseRevId }
    );
  }

  const currentBody = page.body ?? {};
  const currentText = mlString.resolve(lang, currentBody)?.str ?? '';
  const patched = applyUnifiedPatch(currentText, patch, format, { expectedFile: normalizedSlug });

  await page.newRevision({ id: userId }, { tags: ['update', 'patch', ...tags] });

  page.body = {
    ...currentBody,
    [lang]: patched,
  };
  if (revSummary !== undefined) page._revSummary = revSummary;
  page.updatedAt = new Date();

  await page.save();

  return toWikiPageResult(page);
}

export async function addWikiPageAlias(
  _dalInstance: DataAccessLayer,
  { slug, pageSlug, lang }: WikiPageAliasInput,
  userId: string
): Promise<WikiPageAliasResult> {
  const errors = new ValidationCollector('Invalid wiki alias input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  const normalizedPageSlug = normalizeSlugInput(pageSlug, 'pageSlug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalLanguage(lang, 'lang', errors);
  errors.throwIfAny();

  if (isBlockedSlug(normalizedSlug)) {
    throw new InvalidRequestError(`Alias slug is reserved: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const page = await findCurrentPageBySlugOrAlias(normalizedPageSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedPageSlug}`, {
      slug: normalizedPageSlug,
    });
  }

  if (page.slug === normalizedSlug) {
    throw new ConflictError(`Alias slug matches the current page slug: ${normalizedSlug}`, {
      slug: normalizedSlug,
      pageSlug: page.slug,
    });
  }

  const existingPage = await findCurrentPageBySlug(normalizedSlug);
  if (existingPage) {
    throw new ConflictError(`Wiki page already exists: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const existingAlias = await PageAlias.filterWhere({ slug: normalizedSlug }).first();
  if (existingAlias) {
    throw new ConflictError(`Wiki page alias already exists: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const createdAt = new Date();
  const alias = await PageAlias.create({
    pageId: page.id,
    slug: normalizedSlug,
    lang: lang ?? null,
    createdAt,
    updatedAt: createdAt,
    createdBy: userId,
  });

  return toWikiPageAliasResult(alias);
}

export async function removeWikiPageAlias(
  _dalInstance: DataAccessLayer,
  slug: string,
  userId: string
): Promise<WikiPageAliasDeleteResult> {
  const errors = new ValidationCollector('Invalid wiki alias removal input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  errors.throwIfAny();

  const alias = await PageAlias.filterWhere({ slug: normalizedSlug }).first();
  if (!alias) {
    throw new NotFoundError(`Wiki page alias not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  await alias.delete();

  return { slug: normalizedSlug, removed: true };
}

export async function listWikiPageRevisions(
  dalInstance: DataAccessLayer,
  slug: string
): Promise<WikiPageRevisionListResult> {
  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const tableName = WikiPage.tableName;
  const result = await dalInstance.query(
    `SELECT * FROM ${tableName} WHERE id = $1 OR _old_rev_of = $1 ORDER BY _rev_date DESC`,
    [page.id]
  );

  const revisions = result.rows.map(row => toWikiPageRevisionResult(WikiPage.createFromRow(row)));

  return {
    pageId: page.id,
    revisions,
  };
}

export async function readWikiPageRevision(
  dalInstance: DataAccessLayer,
  slug: string,
  revId: string
): Promise<WikiPageRevisionReadResult> {
  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const revision = await fetchPageRevisionByRevId(dalInstance, page.id, revId);
  if (!revision) {
    throw new NotFoundError(`Revision not found: ${revId}`, {
      revId,
    });
  }

  return {
    pageId: page.id,
    revision: toWikiPageRevisionResult(revision),
  };
}

export async function diffWikiPageRevisions(
  dalInstance: DataAccessLayer,
  { slug, fromRevId, toRevId, lang = 'en' }: WikiPageDiffInput
): Promise<WikiPageDiffResult> {
  ensureOptionalLanguage(lang, 'lang');
  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const fromRev = await fetchPageRevisionByRevId(dalInstance, page.id, fromRevId);
  if (!fromRev) {
    throw new NotFoundError(`Revision not found: ${fromRevId}`, {
      revId: fromRevId,
    });
  }

  const toRevisionId = toRevId ?? page._revID;
  const toRev = await fetchPageRevisionByRevId(dalInstance, page.id, toRevisionId);
  if (!toRev) {
    throw new NotFoundError(`Revision not found: ${toRevisionId}`, {
      revId: toRevisionId,
    });
  }

  const fromTitle = mlString.resolve(lang, fromRev.title ?? null)?.str ?? '';
  const toTitle = mlString.resolve(lang, toRev.title ?? null)?.str ?? '';
  const fromBody = mlString.resolve(lang, fromRev.body ?? null)?.str ?? '';
  const toBody = mlString.resolve(lang, toRev.body ?? null)?.str ?? '';

  return {
    pageId: page.id,
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
    },
  };
}

export async function readCitationResource(
  _dalInstance: DataAccessLayer,
  uri: string
): Promise<McpReadResourceResult> {
  const parsed = new URL(uri);
  if (parsed.hostname !== 'citation') {
    throw new InvalidRequestError(`Unknown MCP resource: ${uri}`);
  }

  const key = parsed.searchParams.get('key') ?? '';
  if (!key) {
    throw new InvalidRequestError(
      `Missing required 'key' parameter. Use the format: agpwiki://citation?key=your-citation-key`
    );
  }

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const payload = {
    ...toCitationResult(citation),
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

export async function readCitation(
  _dalInstance: DataAccessLayer,
  key: string
): Promise<CitationResult> {
  ensureNonEmptyString(key, 'key');
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }
  return toCitationResult(citation);
}

export async function createCitation(
  _dalInstance: DataAccessLayer,
  { key, data, tags = [], revSummary }: CitationWriteInput,
  userId: string
): Promise<CitationResult> {
  const errors = new ValidationCollector('Invalid citation input.');
  ensureNonEmptyString(key, 'key', errors);
  if (key) {
    ensureKeyLength(key, 'key', 200, errors);
  }
  ensureNonEmptyString(userId, 'userId', errors);
  ensureObject(data, 'data', {}, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();

  const existing = await findCurrentCitationByKey(key);
  if (existing) {
    throw new ConflictError(`Citation already exists: ${key}`, {
      key,
    });
  }

  const createdAt = new Date();
  const citation = await Citation.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );

  citation.key = key;
  citation.data = data;
  if (revSummary !== undefined) citation._revSummary = revSummary;
  citation.createdAt = createdAt;
  citation.updatedAt = createdAt;

  await citation.save();

  return toCitationResult(citation);
}

export async function updateCitation(
  _dalInstance: DataAccessLayer,
  { key, newKey, data, tags = [], revSummary }: CitationUpdateInput,
  userId: string
): Promise<CitationResult> {
  const errors = new ValidationCollector('Invalid citation update input.');
  ensureNonEmptyString(key, 'key', errors);
  if (key) {
    ensureKeyLength(key, 'key', 200, errors);
  }
  ensureOptionalString(newKey, 'newKey', errors);
  if (newKey) ensureKeyLength(newKey, 'newKey', 200, errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureObject(data, 'data', {}, errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  if (newKey && newKey !== key) {
    const keyMatch = await findCurrentCitationByKey(newKey);
    if (keyMatch) {
      throw new ConflictError(`Citation already exists: ${newKey}`, {
        key: newKey,
      });
    }
  }

  await citation.newRevision({ id: userId }, { tags: ['update', ...tags] });

  if (newKey !== undefined) citation.key = newKey;
  if (data !== undefined) citation.data = data;
  if (revSummary !== undefined) citation._revSummary = revSummary;
  citation.updatedAt = new Date();

  await citation.save();

  return toCitationResult(citation);
}

export async function listCitationRevisions(
  dalInstance: DataAccessLayer,
  key: string
): Promise<CitationRevisionListResult> {
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const tableName = Citation.tableName;
  const result = await dalInstance.query(
    `SELECT * FROM ${tableName} WHERE id = $1 OR _old_rev_of = $1 ORDER BY _rev_date DESC`,
    [citation.id]
  );

  const revisions = result.rows.map(row =>
    toCitationRevisionResult(Citation.createFromRow(row))
  );

  return {
    citationId: citation.id,
    revisions,
  };
}

export async function readCitationRevision(
  dalInstance: DataAccessLayer,
  key: string,
  revId: string
): Promise<CitationRevisionReadResult> {
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const revision = await fetchCitationRevisionByRevId(dalInstance, citation.id, revId);
  if (!revision) {
    throw new NotFoundError(`Revision not found: ${revId}`, {
      revId,
    });
  }

  return {
    citationId: citation.id,
    revision: toCitationRevisionResult(revision),
  };
}

export async function diffCitationRevisions(
  dalInstance: DataAccessLayer,
  { key, fromRevId, toRevId }: CitationDiffInput
): Promise<CitationDiffResult> {
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const fromRev = await fetchCitationRevisionByRevId(dalInstance, citation.id, fromRevId);
  if (!fromRev) {
    throw new NotFoundError(`Revision not found: ${fromRevId}`, {
      revId: fromRevId,
    });
  }

  const toRevisionId = toRevId ?? citation._revID;
  const toRev = await fetchCitationRevisionByRevId(dalInstance, citation.id, toRevisionId);
  if (!toRev) {
    throw new NotFoundError(`Revision not found: ${toRevisionId}`, {
      revId: toRevisionId,
    });
  }

  const fromKey = fromRev.key ?? '';
  const toKey = toRev.key ?? '';
  const fromData = stringifyCitationData(fromRev.data ?? null);
  const toData = stringifyCitationData(toRev.data ?? null);

  return {
    citationId: citation.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
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
      key: buildFieldDiff('key', fromKey, toKey),
      data: buildFieldDiff('data', fromData, toData),
    },
  };
}

export async function queryCitations(
  dalInstance: DataAccessLayer,
  {
    keyPrefix,
    title,
    author,
    year,
    yearFrom,
    yearTo,
    doi,
    url,
    domain,
    tags,
    limit,
    offset,
  }: CitationQueryInput
): Promise<CitationQueryResult> {
  if (keyPrefix !== undefined) ensureOptionalString(keyPrefix, 'keyPrefix');
  if (title !== undefined) ensureOptionalString(title, 'title');
  if (author !== undefined) ensureOptionalString(author, 'author');
  if (doi !== undefined) ensureOptionalString(doi, 'doi');
  if (url !== undefined) ensureOptionalString(url, 'url');
  if (domain !== undefined) ensureOptionalString(domain, 'domain');

  const normalizedLimit = Math.min(Math.max(limit ?? 25, 1), 100);
  const normalizedOffset = Math.max(offset ?? 0, 0);

  const conditions: string[] = ['_old_rev_of IS NULL', '_rev_deleted = false'];
  const values: Array<string | number | string[]> = [];
  let idx = 1;

  const addCondition = (condition: string, value: string | number | string[]) => {
    conditions.push(condition);
    values.push(value);
    idx += 1;
  };

  if (keyPrefix) addCondition(`key ILIKE $${idx}`, `${keyPrefix}%`);
  if (title) addCondition(`data->>'title' ILIKE $${idx}`, `%${title}%`);
  if (author) {
    addCondition(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'author') = 'array' THEN data->'author' ELSE '[]'::jsonb END) author WHERE (author->>'family' ILIKE $${idx} OR author->>'given' ILIKE $${idx} OR author->>'literal' ILIKE $${idx}))`,
      `%${author}%`
    );
  }

  const yearExpr =
    "(CASE WHEN (data #>> '{issued,date-parts,0,0}') ~ '^[0-9]{4}$' THEN (data #>> '{issued,date-parts,0,0}')::int ELSE NULL END)";

  if (year !== undefined) addCondition(`${yearExpr} = $${idx}`, year);
  if (yearFrom !== undefined) addCondition(`${yearExpr} >= $${idx}`, yearFrom);
  if (yearTo !== undefined) addCondition(`${yearExpr} <= $${idx}`, yearTo);
  if (doi) addCondition(`data->>'DOI' ILIKE $${idx}`, doi);
  if (url) addCondition(`data->>'URL' ILIKE $${idx}`, `%${url}%`);
  if (domain) addCondition(`data->>'URL' ILIKE $${idx}`, `%${domain}%`);
  if (tags && tags.length > 0) addCondition(`data->'tags' ?| $${idx}`, tags);

  const sql = `SELECT * FROM ${Citation.tableName} WHERE ${conditions.join(
    ' AND '
  )} ORDER BY updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  values.push(normalizedLimit + 1, normalizedOffset);

  const result = await dalInstance.query(sql, values);
  const rows = result.rows.map(row => Citation.createFromRow(row));
  const hasMore = rows.length > normalizedLimit;
  const citations = rows.slice(0, normalizedLimit).map(toCitationResult);

  return {
    citations,
    limit: normalizedLimit,
    offset: normalizedOffset,
    hasMore,
    nextOffset: hasMore ? normalizedOffset + normalizedLimit : null,
  };
}

export async function deleteWikiPage(
  _dalInstance: DataAccessLayer,
  { slug, revSummary }: WikiPageDeleteInput,
  userId: string
): Promise<WikiPageDeleteResult> {
  const errors = new ValidationCollector('Invalid wiki page delete input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  await page.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });

  return {
    id: page.id,
    slug: page.slug,
    deleted: true,
  };
}

export async function deleteCitation(
  _dalInstance: DataAccessLayer,
  { key, revSummary }: CitationDeleteInput,
  userId: string
): Promise<CitationDeleteResult> {
  const errors = new ValidationCollector('Invalid citation delete input.');
  ensureNonEmptyString(key, 'key', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  await citation.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });

  return {
    id: citation.id,
    key: citation.key,
    deleted: true,
  };
}
