import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from 'diff';
import dal from '../../dal/index.js';
import type { DataAccessLayer } from '../../dal/lib/data-access-layer.js';
import Citation from '../models/citation.js';
import type { CitationInstance } from '../models/manifests/citation.js';
import type { WikiPageInstance } from '../models/manifests/wiki-page.js';
import WikiPage from '../models/wiki-page.js';
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

const findCurrentPageBySlug = async (slug: string) =>
  WikiPage.filterWhere({
    slug,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

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

const ensureNonEmptyString = (value: string, label: string) => {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
};

const ensureOptionalString = (value: string | null | undefined, label: string) => {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
};

const validateTitle = (value: Record<string, string> | null | undefined) => {
  if (value === undefined) return;
  mlString.validate(value, { maxLength: 200, allowHTML: false });
};

const validateBody = (value: Record<string, string> | null | undefined) => {
  if (value === undefined) return;
  mlString.validate(value, { maxLength: 20000, allowHTML: true });
};

const validateRevSummary = (value: Record<string, string> | null | undefined) => {
  if (value === undefined) return;
  mlString.validate(value, { maxLength: 300, allowHTML: false });
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
  for (const [lang, text] of entries) {
    if (!lang || !text || text.trim().length === 0) {
      throw new Error('revSummary entries must be non-empty strings.');
    }
  }
};

const ensureObject = (
  value: Record<string, unknown> | null | undefined,
  label: string,
  { allowNull = false }: { allowNull?: boolean } = {}
) => {
  if (value === undefined) return;
  if (value === null) {
    if (allowNull) return;
    throw new Error(`${label} must be an object.`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
};

const ensureKeyLength = (value: string, label: string, maxLength: number) => {
  if (value.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
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
    throw new Error(`Unknown MCP resource: ${uri}`);
  }

  const slug = parsed.searchParams.get('slug') ?? '';
  if (!slug) {
    throw new Error(`Invalid MCP resource: ${uri}`);
  }

  const page = await findCurrentPageBySlug(slug);

  if (!page) {
    throw new Error(`Wiki page not found: ${slug}`);
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

export async function createWikiPage(
  _dalInstance: DataAccessLayer,
  { slug, title, body, originalLanguage, tags = [], revSummary }: WikiPageWriteInput,
  userId: string
): Promise<WikiPageResult> {
  ensureNonEmptyString(slug, 'slug');
  ensureNonEmptyString(userId, 'userId');
  ensureOptionalString(originalLanguage, 'originalLanguage');
  validateTitle(title);
  validateBody(body);
  validateRevSummary(revSummary);

  const existing = await findCurrentPageBySlug(slug);
  if (existing) {
    throw new Error(`Wiki page already exists: ${slug}`);
  }

  const createdAt = new Date();
  const page = await WikiPage.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );

  page.slug = slug;
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
  ensureNonEmptyString(slug, 'slug');
  ensureNonEmptyString(userId, 'userId');
  ensureOptionalString(newSlug, 'newSlug');
  ensureOptionalString(originalLanguage, 'originalLanguage');
  validateTitle(title);
  validateBody(body);
  requireRevSummary(revSummary);

  const page = await findCurrentPageBySlug(slug);
  if (!page) {
    throw new Error(`Wiki page not found: ${slug}`);
  }

  if (newSlug && newSlug !== slug) {
    const slugMatch = await findCurrentPageBySlug(newSlug);
    if (slugMatch) {
      throw new Error(`Wiki page already exists: ${newSlug}`);
    }
  }

  await page.newRevision({ id: userId }, { tags: ['update', ...tags] });

  if (newSlug !== undefined) page.slug = newSlug;
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
  ensureNonEmptyString(slug, 'slug');
  ensureNonEmptyString(patch, 'patch');
  ensureNonEmptyString(format, 'format');
  if (format !== 'unified' && format !== 'codex') {
    throw new Error(`Invalid patch format: ${format}`);
  }
  ensureOptionalString(lang, 'lang');
  ensureOptionalString(baseRevId, 'baseRevId');
  requireRevSummary(revSummary);

  const page = await findCurrentPageBySlug(slug);
  if (!page) {
    throw new Error(`Wiki page not found: ${slug}`);
  }

  if (baseRevId && baseRevId !== page._revID) {
    throw new Error(
      `Revision mismatch: current is ${page._revID ?? 'unknown'}, base was ${baseRevId}.`
    );
  }

  const currentBody = page.body ?? {};
  const currentText = mlString.resolve(lang, currentBody)?.str ?? '';
  const patched = applyUnifiedPatch(currentText, patch, format, { expectedFile: slug });

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

export async function listWikiPageRevisions(
  dalInstance: DataAccessLayer,
  slug: string
): Promise<WikiPageRevisionListResult> {
  const page = await findCurrentPageBySlug(slug);
  if (!page) {
    throw new Error(`Wiki page not found: ${slug}`);
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
  const page = await findCurrentPageBySlug(slug);
  if (!page) {
    throw new Error(`Wiki page not found: ${slug}`);
  }

  const revision = await fetchPageRevisionByRevId(dalInstance, page.id, revId);
  if (!revision) {
    throw new Error(`Revision not found: ${revId}`);
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
  const page = await findCurrentPageBySlug(slug);
  if (!page) {
    throw new Error(`Wiki page not found: ${slug}`);
  }

  const fromRev = await fetchPageRevisionByRevId(dalInstance, page.id, fromRevId);
  if (!fromRev) {
    throw new Error(`Revision not found: ${fromRevId}`);
  }

  const toRevisionId = toRevId ?? page._revID;
  const toRev = await fetchPageRevisionByRevId(dalInstance, page.id, toRevisionId);
  if (!toRev) {
    throw new Error(`Revision not found: ${toRevisionId}`);
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
    throw new Error(`Unknown MCP resource: ${uri}`);
  }

  const key = parsed.pathname.replace(/^\//, '');
  if (!key) {
    throw new Error(`Invalid MCP resource: ${uri}`);
  }

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new Error(`Citation not found: ${key}`);
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

export async function createCitation(
  _dalInstance: DataAccessLayer,
  { key, data, tags = [], revSummary }: CitationWriteInput,
  userId: string
): Promise<CitationResult> {
  ensureNonEmptyString(key, 'key');
  ensureKeyLength(key, 'key', 200);
  ensureNonEmptyString(userId, 'userId');
  ensureObject(data, 'data');
  validateRevSummary(revSummary);

  const existing = await findCurrentCitationByKey(key);
  if (existing) {
    throw new Error(`Citation already exists: ${key}`);
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
  ensureNonEmptyString(key, 'key');
  ensureKeyLength(key, 'key', 200);
  ensureOptionalString(newKey, 'newKey');
  if (newKey) ensureKeyLength(newKey, 'newKey', 200);
  ensureNonEmptyString(userId, 'userId');
  ensureObject(data, 'data');
  requireRevSummary(revSummary);

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new Error(`Citation not found: ${key}`);
  }

  if (newKey && newKey !== key) {
    const keyMatch = await findCurrentCitationByKey(newKey);
    if (keyMatch) {
      throw new Error(`Citation already exists: ${newKey}`);
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
    throw new Error(`Citation not found: ${key}`);
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
    throw new Error(`Citation not found: ${key}`);
  }

  const revision = await fetchCitationRevisionByRevId(dalInstance, citation.id, revId);
  if (!revision) {
    throw new Error(`Revision not found: ${revId}`);
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
    throw new Error(`Citation not found: ${key}`);
  }

  const fromRev = await fetchCitationRevisionByRevId(dalInstance, citation.id, fromRevId);
  if (!fromRev) {
    throw new Error(`Revision not found: ${fromRevId}`);
  }

  const toRevisionId = toRevId ?? citation._revID;
  const toRev = await fetchCitationRevisionByRevId(dalInstance, citation.id, toRevisionId);
  if (!toRev) {
    throw new Error(`Revision not found: ${toRevisionId}`);
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
