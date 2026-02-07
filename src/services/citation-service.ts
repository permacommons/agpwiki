import fs from 'node:fs';
import path from 'node:path';
import { Driver } from '@citeproc-rs/wasm';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import type { FieldDiff } from '../lib/diff-engine.js';
import { diffScalarField, diffStructuredField } from '../lib/diff-engine.js';
import {
  ConflictError,
  NotFoundError,
  ValidationCollector,
} from '../lib/errors.js';
import { sanitizeLocalizedMapInput } from '../lib/localized.js';
import Citation from '../models/citation.js';
import type { CitationInstance } from '../models/manifests/citation.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import {
  ensureKeyLength,
  ensureNonEmptyString,
  ensureObject,
  ensureOptionalString,
  requireRevSummary,
  toRevisionMeta,
  validateRevSummary,
} from './validation.js';

const citationStylePath = path.resolve(process.cwd(), 'vendor/csl/agpwiki-author-date.csl');
const citationStyle = fs.readFileSync(citationStylePath, 'utf8');

export interface CitationWriteInput {
  key: string;
  data: Record<string, unknown>;
  tags?: string[];
  revSummary?: Record<string, string | null> | null;
}

export interface CitationUpdateInput {
  key: string;
  newKey?: string;
  data?: Record<string, unknown> | null;
  tags?: string[];
  revSummary: Record<string, string | null>;
}

export interface CitationResult {
  id: string;
  key: string;
  data: Record<string, unknown> | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
  warnings?: string[];
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
  fields: Record<string, FieldDiff>;
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

export interface CitationDeleteInput {
  key: string;
  revSummary: Record<string, string | null>;
}

export interface CitationDeleteResult {
  id: string;
  key: string;
  deleted: boolean;
}

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

export const findCurrentCitationByKey = async (key: string) =>
  Citation.filterWhere({
    key,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const fetchCitationRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  citationId: string,
  revId: string
): Promise<CitationInstance | null> => {
  return Citation.filterWhere({}).getRevisionByRevId(revId, citationId).first();
};

const ensureCitationStringField = (
  data: Record<string, unknown>,
  field: string,
  errors: ValidationCollector
) => {
  const value = data[field];
  if (value === undefined) return true;
  if (typeof value === 'string') return true;
  errors.add(`data.${field}`, 'must be a string.', 'type');
  return false;
};

const ensureCitationDatePartsField = (
  data: Record<string, unknown>,
  field: string,
  errors: ValidationCollector
) => {
  const value = data[field];
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.add(`data.${field}`, 'must be an object.', 'type');
    return false;
  }
  const dateParts = (value as Record<string, unknown>)['date-parts'];
  if (dateParts === undefined) return true;
  if (!Array.isArray(dateParts)) {
    errors.add(`data.${field}.date-parts`, 'must be an array of arrays.', 'type');
    return false;
  }
  let valid = true;
  for (let i = 0; i < dateParts.length; i += 1) {
    const part = dateParts[i];
    if (!Array.isArray(part)) {
      errors.add(`data.${field}.date-parts.${i}`, 'must be an array.', 'type');
      valid = false;
      continue;
    }
    for (let j = 0; j < part.length; j += 1) {
      if (typeof part[j] !== 'number') {
        errors.add(`data.${field}.date-parts.${i}.${j}`, 'must be a number.', 'type');
        valid = false;
      }
    }
  }
  return valid;
};

const validateCitationWithCiteproc = (
  key: string,
  data: Record<string, unknown>,
  errors: ValidationCollector
) => {
  const driver = new Driver({
    style: citationStyle,
    format: 'html',
    bibliographyNoSort: true,
  });

  try {
    const normalized = { ...data, id: key };
    driver.insertReferences([normalized]);
    driver.insertCluster({
      id: 'cluster-1',
      cites: [{ id: key }],
    });
    driver.setClusterOrder([{ id: 'cluster-1', note: 1 }]);
    driver.fullRender();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.add('data', `is not valid CSL JSON for rendering: ${message}`, 'invalid');
  } finally {
    driver.free();
  }
};

const validateCitationData = (
  key: string,
  data: Record<string, unknown> | null | undefined,
  errors: ValidationCollector
) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  let hasStructuralErrors = false;

  for (const field of [
    'type',
    'title',
    'container-title',
    'publisher',
    'publisher-place',
    'DOI',
    'URL',
    'ISBN',
    'ISSN',
    'page',
    'volume',
    'issue',
    'language',
  ]) {
    if (!ensureCitationStringField(data, field, errors)) {
      hasStructuralErrors = true;
    }
  }
  if (!ensureCitationDatePartsField(data, 'issued', errors)) {
    hasStructuralErrors = true;
  }
  if (!ensureCitationDatePartsField(data, 'accessed', errors)) {
    hasStructuralErrors = true;
  }

  if (!hasStructuralErrors) {
    validateCitationWithCiteproc(key, data, errors);
  }
};

const sanitizeCitationData = (data: Record<string, unknown>) => {
  if (!Object.hasOwn(data, 'id')) {
    return { sanitized: data, warnings: [] as string[] };
  }
  const { id: _ignored, ...rest } = data;
  return {
    sanitized: rest,
    warnings: ['Ignored data.id; citation key is authoritative.'],
  };
};

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
  const { sanitized: sanitizedData, warnings } = sanitizeCitationData(data);
  validateCitationData(key, sanitizedData, errors);
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
  citation.data = sanitizedData;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) citation._revSummary = normalizedRevSummary;
  citation.createdAt = createdAt;
  citation.updatedAt = createdAt;

  await citation.save();

  return {
    ...toCitationResult(citation),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
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
  const { sanitized: sanitizedData, warnings } =
    data && typeof data === 'object' && !Array.isArray(data)
      ? sanitizeCitationData(data)
      : { sanitized: data, warnings: [] as string[] };
  validateCitationData(newKey ?? key, sanitizedData, errors);
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
  if (sanitizedData !== undefined) citation.data = sanitizedData;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) citation._revSummary = normalizedRevSummary;
  citation.updatedAt = new Date();

  await citation.save();

  return {
    ...toCitationResult(citation),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function listCitationRevisions(
  _dalInstance: DataAccessLayer,
  key: string
): Promise<CitationRevisionListResult> {
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const revisionRows = await Citation.filterWhere({})
    .getAllRevisions(citation.id)
    .orderBy('_revDate', 'DESC')
    .run();

  const revisions = revisionRows.map(row => toCitationRevisionResult(row));

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

  const fields: Record<string, FieldDiff> = {};
  const keyDiff = diffScalarField('key', fromRev.key ?? null, toRev.key ?? null);
  if (keyDiff) fields.key = keyDiff;
  const dataDiff = diffStructuredField('data', fromRev.data ?? null, toRev.data ?? null);
  if (dataDiff) fields.data = dataDiff;

  return {
    citationId: citation.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields,
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

  const deletionRevision = await citation.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });
  await applyDeletionRevisionSummary(deletionRevision, revSummary);

  return {
    id: citation.id,
    key: citation.key,
    deleted: true,
  };
}
