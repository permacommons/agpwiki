import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

import { fetchCommonsMetadata, normalizeCommonsTitle } from '../lib/commons.js';
import {
  diffLocalizedField,
  diffScalarField,
  diffStructuredField,
  type FieldDiff,
} from '../lib/diff-engine.js';
import {
  ConflictError,
  NotFoundError,
  UnsupportedError,
  ValidationCollector,
} from '../lib/errors.js';
import {
  type LocalizedMap,
  type LocalizedMapInput,
  mergeLocalizedMap,
  sanitizeLocalizedMapInput,
} from '../lib/localized.js';
import {
  MEDIA_ALT_TEXT_MAX_LENGTH,
  MEDIA_CAPTION_MAX_LENGTH,
  MEDIA_COMMONS_TITLE_MAX_LENGTH,
  MEDIA_SLUG_MAX_LENGTH,
  MEDIA_TITLE_MAX_LENGTH,
  type MediaData,
  type MediaType,
} from '../lib/media.js';
import type { MediaStorage } from '../lib/media-storage.js';
import { validateMediaSlugFormat } from '../lib/media-validation.js';
import type { MediaInstance } from '../models/manifests/media.js';
import Media from '../models/media.js';
import { assertCanDeleteMedia } from './authorization.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import {
  ensureKeyLength,
  ensureNoControlCharacters,
  ensureNonEmptyString,
  ensureOptionalString,
  requireRevSummary,
  toRevisionMeta,
  validateRevSummary,
} from './validation.js';

export type CommonsFetcher = typeof fetchCommonsMetadata;

export interface MediaWriteInput {
  slug: string;
  commonsTitle: string;
  title?: LocalizedMapInput;
  caption?: LocalizedMapInput;
  altText?: LocalizedMapInput;
  tags?: string[];
  revSummary?: LocalizedMapInput;
}

export interface MediaUpdateInput {
  slug: string;
  newSlug?: string;
  title?: LocalizedMapInput;
  caption?: LocalizedMapInput;
  altText?: LocalizedMapInput;
  tags?: string[];
  revSummary: Record<string, string | null>;
}

export interface MediaRefreshInput {
  slug: string;
  tags?: string[];
  revSummary: Record<string, string | null>;
}

export interface MediaQueryInput {
  slugPrefix?: string;
  commonsTitle?: string;
  mediaType?: MediaType;
  license?: string;
  author?: string;
  limit?: number;
  offset?: number;
}

export interface MediaDeleteInput {
  slug: string;
  revSummary: Record<string, string | null>;
}

export interface MediaResult {
  id: string;
  slug: string;
  title: LocalizedMap | null;
  commonsTitle: string;
  mediaType: MediaType;
  data: MediaData | Record<string, unknown> | null;
  caption: LocalizedMap | null;
  altText: LocalizedMap | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface MediaRevisionResult extends MediaResult {
  revId: string;
  revDate: Date;
  revUser: string | null;
  revTags: string[] | null;
  revSummary: LocalizedMap | null;
  revDeleted: boolean;
  oldRevOf: string | null;
}

export interface MediaRevisionListResult {
  mediaId: string;
  revisions: MediaRevisionResult[];
}

export interface MediaRevisionReadResult {
  mediaId: string;
  revision: MediaRevisionResult;
}

export interface MediaDiffInput {
  slug: string;
  fromRevId: string;
  toRevId?: string;
}

export interface MediaDiffResult {
  mediaId: string;
  fromRevId: string;
  toRevId: string;
  from: ReturnType<typeof toRevisionMeta>;
  to: ReturnType<typeof toRevisionMeta>;
  fields: Record<string, FieldDiff>;
}

export interface MediaQueryResult {
  media: MediaResult[];
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface MediaDeleteResult {
  id: string;
  slug: string;
  deleted: boolean;
}

export interface MediaServiceOptions {
  commonsFetcher?: CommonsFetcher;
  storage?: MediaStorage;
}

const toMediaResult = (media: MediaInstance): MediaResult => ({
  id: media.id,
  slug: media.slug,
  title: (media.title ?? null) as LocalizedMap | null,
  commonsTitle: media.commonsTitle,
  mediaType: media.mediaType as MediaType,
  data: (media.data ?? null) as MediaData | Record<string, unknown> | null,
  caption: (media.caption ?? null) as LocalizedMap | null,
  altText: (media.altText ?? null) as LocalizedMap | null,
  createdAt: media.createdAt ?? null,
  updatedAt: media.updatedAt ?? null,
});

const toMediaRevisionResult = (media: MediaInstance): MediaRevisionResult => ({
  ...toMediaResult(media),
  revId: media._revID,
  revDate: media._revDate,
  revUser: media._revUser ?? null,
  revTags: media._revTags ?? null,
  revSummary: (media._revSummary ?? null) as LocalizedMap | null,
  revDeleted: media._revDeleted ?? false,
  oldRevOf: media._oldRevOf ?? null,
});

export const findCurrentMediaBySlug = async (slug: string) =>
  Media.filterWhere({
    slug,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

export const findCurrentMediaByCommonsTitle = async (commonsTitle: string) =>
  Media.filterWhere({
    commonsTitle,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const fetchMediaRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  mediaId: string,
  revId: string
): Promise<MediaInstance | null> =>
  Media.filterWhere({}).getRevisionByRevId(revId, mediaId).first();

const validateLocalizedField = (
  value: LocalizedMapInput,
  label: string,
  maxLength: number,
  errors: ValidationCollector
) => {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.add(label, 'must be an object.', 'type');
    return;
  }
  for (const [lang, text] of Object.entries(value)) {
    if (text === null) continue;
    if (typeof text !== 'string') {
      errors.add(`${label}.${lang}`, 'must be a string or null.', 'type');
      continue;
    }
    if (text.length > maxLength) {
      errors.add(
        `${label}.${lang}`,
        `must be at most ${maxLength} characters.`,
        'max_length'
      );
    }
  }
  ensureNoControlCharacters(value, label, errors);
};

const ensureImageMediaType = (mediaType: MediaType) => {
  if (mediaType !== 'image') {
    throw new UnsupportedError(
      `Media type ${mediaType} is not yet supported. Only images can be added at this time.`,
      { mediaType }
    );
  }
};

export async function readMedia(
  _dalInstance: DataAccessLayer,
  slug: string
): Promise<MediaResult> {
  ensureNonEmptyString(slug, 'slug');
  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }
  return toMediaResult(media);
}

export async function createMedia(
  _dalInstance: DataAccessLayer,
  { slug, commonsTitle, title, caption, altText, tags = [], revSummary }: MediaWriteInput,
  userId: string,
  options: MediaServiceOptions = {}
): Promise<MediaResult> {
  const errors = new ValidationCollector('Invalid media input.');
  const normalizedSlug = validateMediaSlugFormat(slug ?? '', 'slug', errors);
  if (normalizedSlug) {
    ensureKeyLength(normalizedSlug, 'slug', MEDIA_SLUG_MAX_LENGTH, errors);
  }
  ensureNonEmptyString(commonsTitle, 'commonsTitle', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  validateLocalizedField(title, 'title', MEDIA_TITLE_MAX_LENGTH, errors);
  validateLocalizedField(caption, 'caption', MEDIA_CAPTION_MAX_LENGTH, errors);
  validateLocalizedField(altText, 'altText', MEDIA_ALT_TEXT_MAX_LENGTH, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();

  const normalizedTitle = normalizeCommonsTitle(commonsTitle);
  if (normalizedTitle.length > MEDIA_COMMONS_TITLE_MAX_LENGTH) {
    errors.add(
      'commonsTitle',
      `must be at most ${MEDIA_COMMONS_TITLE_MAX_LENGTH} characters.`,
      'max_length'
    );
    errors.throwIfAny();
  }

  const finalSlug = normalizedSlug as string;
  const existingBySlug = await findCurrentMediaBySlug(finalSlug);
  if (existingBySlug) {
    throw new ConflictError(`Media already exists: ${finalSlug}`, { slug: finalSlug });
  }
  const existingByTitle = await findCurrentMediaByCommonsTitle(normalizedTitle);
  if (existingByTitle) {
    throw new ConflictError(
      `Commons file is already imported as media: ${existingByTitle.slug}`,
      { commonsTitle: normalizedTitle, slug: existingByTitle.slug }
    );
  }

  const fetcher = options.commonsFetcher ?? fetchCommonsMetadata;
  const fetched = await fetcher(normalizedTitle);
  ensureImageMediaType(fetched.mediaType);

  const createdAt = new Date();
  const media = await Media.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );

  media.slug = finalSlug;
  media.commonsTitle = normalizedTitle;
  media.mediaType = fetched.mediaType;
  media.data = fetched.data as unknown as Record<string, unknown>;
  const normalizedTitleField = sanitizeLocalizedMapInput(title);
  if (normalizedTitleField !== undefined) media.title = normalizedTitleField;
  const normalizedCaption = sanitizeLocalizedMapInput(caption);
  if (normalizedCaption !== undefined) media.caption = normalizedCaption;
  const normalizedAlt = sanitizeLocalizedMapInput(altText);
  if (normalizedAlt !== undefined) media.altText = normalizedAlt;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) media._revSummary = normalizedRevSummary;
  media.createdAt = createdAt;
  media.updatedAt = createdAt;

  await media.save();

  return toMediaResult(media);
}

export async function updateMedia(
  _dalInstance: DataAccessLayer,
  { slug, newSlug, title, caption, altText, tags = [], revSummary }: MediaUpdateInput,
  userId: string,
  options: MediaServiceOptions = {}
): Promise<MediaResult> {
  const errors = new ValidationCollector('Invalid media update input.');
  ensureNonEmptyString(slug, 'slug', errors);
  if (slug) ensureKeyLength(slug, 'slug', MEDIA_SLUG_MAX_LENGTH, errors);
  let normalizedNewSlug: string | null = null;
  if (newSlug !== undefined && newSlug !== null) {
    normalizedNewSlug = validateMediaSlugFormat(newSlug, 'newSlug', errors);
    if (normalizedNewSlug) {
      ensureKeyLength(normalizedNewSlug, 'newSlug', MEDIA_SLUG_MAX_LENGTH, errors);
    }
  }
  ensureNonEmptyString(userId, 'userId', errors);
  validateLocalizedField(title, 'title', MEDIA_TITLE_MAX_LENGTH, errors);
  validateLocalizedField(caption, 'caption', MEDIA_CAPTION_MAX_LENGTH, errors);
  validateLocalizedField(altText, 'altText', MEDIA_ALT_TEXT_MAX_LENGTH, errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }

  const targetSlug = normalizedNewSlug ?? null;
  if (targetSlug && targetSlug !== slug) {
    const conflict = await findCurrentMediaBySlug(targetSlug);
    if (conflict) {
      throw new ConflictError(`Media already exists: ${targetSlug}`, { slug: targetSlug });
    }
  }

  await media.newRevision({ id: userId }, { tags: ['update', ...tags] });

  if (targetSlug !== null) media.slug = targetSlug;
  const mergedTitle = mergeLocalizedMap(
    (media.title ?? null) as LocalizedMap | null,
    title
  );
  if (mergedTitle !== undefined) media.title = mergedTitle;
  const mergedCaption = mergeLocalizedMap(
    (media.caption ?? null) as LocalizedMap | null,
    caption
  );
  if (mergedCaption !== undefined) media.caption = mergedCaption;
  const mergedAlt = mergeLocalizedMap(
    (media.altText ?? null) as LocalizedMap | null,
    altText
  );
  if (mergedAlt !== undefined) media.altText = mergedAlt;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) media._revSummary = normalizedRevSummary;
  media.updatedAt = new Date();

  await media.save();

  // Move stored thumbnails to the new slug directory if the slug
  // changed. Storage is best-effort: a missing source dir is fine
  // (no thumbnails were ever cached); but a real I/O error is a
  // correctness problem the caller should see.
  if (options.storage && targetSlug !== null && targetSlug !== slug) {
    await options.storage.renameSlug(slug, targetSlug);
  }

  return toMediaResult(media);
}

export async function refreshMedia(
  _dalInstance: DataAccessLayer,
  { slug, tags = [], revSummary }: MediaRefreshInput,
  userId: string,
  options: MediaServiceOptions = {}
): Promise<MediaResult> {
  const errors = new ValidationCollector('Invalid media refresh input.');
  ensureNonEmptyString(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }

  const fetcher = options.commonsFetcher ?? fetchCommonsMetadata;
  const fetched = await fetcher(media.commonsTitle);
  ensureImageMediaType(fetched.mediaType);

  await media.newRevision({ id: userId }, { tags: ['refresh', ...tags] });

  media.mediaType = fetched.mediaType;
  media.data = fetched.data as unknown as Record<string, unknown>;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) media._revSummary = normalizedRevSummary;
  media.updatedAt = new Date();

  await media.save();

  // Cached thumbnails reflect the previous Commons state. Wipe them
  // so the next render-time miss re-fetches against the current URL.
  if (options.storage) {
    await options.storage.deleteAllForSlug(slug);
  }

  return toMediaResult(media);
}

export async function listMediaRevisions(
  _dalInstance: DataAccessLayer,
  slug: string
): Promise<MediaRevisionListResult> {
  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }

  const revisionRows = await Media.filterWhere({})
    .getAllRevisions(media.id)
    .orderBy('_revDate', 'DESC')
    .run();

  return {
    mediaId: media.id,
    revisions: revisionRows.map(row => toMediaRevisionResult(row)),
  };
}

export async function readMediaRevision(
  dalInstance: DataAccessLayer,
  slug: string,
  revId: string
): Promise<MediaRevisionReadResult> {
  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }
  const revision = await fetchMediaRevisionByRevId(dalInstance, media.id, revId);
  if (!revision) {
    throw new NotFoundError(`Revision not found: ${revId}`, { revId });
  }
  return {
    mediaId: media.id,
    revision: toMediaRevisionResult(revision),
  };
}

export async function diffMediaRevisions(
  dalInstance: DataAccessLayer,
  { slug, fromRevId, toRevId }: MediaDiffInput
): Promise<MediaDiffResult> {
  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }
  const fromRev = await fetchMediaRevisionByRevId(dalInstance, media.id, fromRevId);
  if (!fromRev) {
    throw new NotFoundError(`Revision not found: ${fromRevId}`, { revId: fromRevId });
  }
  const toRevisionId = toRevId ?? media._revID;
  const toRev = await fetchMediaRevisionByRevId(dalInstance, media.id, toRevisionId);
  if (!toRev) {
    throw new NotFoundError(`Revision not found: ${toRevisionId}`, { revId: toRevisionId });
  }

  const fields: Record<string, FieldDiff> = {};
  const slugDiff = diffScalarField('slug', fromRev.slug ?? null, toRev.slug ?? null);
  if (slugDiff) fields.slug = slugDiff;
  const titleDiff = diffLocalizedField(
    'title',
    (fromRev.title ?? null) as LocalizedMap | null,
    (toRev.title ?? null) as LocalizedMap | null
  );
  if (titleDiff) fields.title = titleDiff;
  const ctDiff = diffScalarField(
    'commonsTitle',
    fromRev.commonsTitle ?? null,
    toRev.commonsTitle ?? null
  );
  if (ctDiff) fields.commonsTitle = ctDiff;
  const typeDiff = diffScalarField(
    'mediaType',
    fromRev.mediaType ?? null,
    toRev.mediaType ?? null
  );
  if (typeDiff) fields.mediaType = typeDiff;
  const dataDiff = diffStructuredField('data', fromRev.data ?? null, toRev.data ?? null);
  if (dataDiff) fields.data = dataDiff;
  const captionDiff = diffLocalizedField(
    'caption',
    (fromRev.caption ?? null) as LocalizedMap | null,
    (toRev.caption ?? null) as LocalizedMap | null
  );
  if (captionDiff) fields.caption = captionDiff;
  const altDiff = diffLocalizedField(
    'altText',
    (fromRev.altText ?? null) as LocalizedMap | null,
    (toRev.altText ?? null) as LocalizedMap | null
  );
  if (altDiff) fields.altText = altDiff;

  return {
    mediaId: media.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields,
  };
}

export async function queryMedia(
  dalInstance: DataAccessLayer,
  {
    slugPrefix,
    commonsTitle,
    mediaType,
    license,
    author,
    limit,
    offset,
  }: MediaQueryInput
): Promise<MediaQueryResult> {
  const errors = new ValidationCollector('Invalid media query input.');
  if (slugPrefix !== undefined) ensureOptionalString(slugPrefix, 'slugPrefix', errors);
  if (commonsTitle !== undefined) ensureOptionalString(commonsTitle, 'commonsTitle', errors);
  if (mediaType !== undefined && mediaType !== 'image') {
    errors.add('mediaType', 'must be "image".', 'invalid');
  }
  if (license !== undefined) ensureOptionalString(license, 'license', errors);
  if (author !== undefined) ensureOptionalString(author, 'author', errors);
  errors.throwIfAny();

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

  if (slugPrefix) addCondition(`slug ILIKE $${idx}`, `${slugPrefix}%`);
  if (commonsTitle) addCondition(`commons_title ILIKE $${idx}`, `%${commonsTitle}%`);
  if (mediaType) addCondition(`media_type = $${idx}`, mediaType);
  if (license) addCondition(`data->>'license' ILIKE $${idx}`, `%${license}%`);
  if (author) addCondition(`data->>'author' ILIKE $${idx}`, `%${author}%`);

  const sql = `SELECT * FROM ${Media.tableName} WHERE ${conditions.join(
    ' AND '
  )} ORDER BY updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  values.push(normalizedLimit + 1, normalizedOffset);

  const result = await dalInstance.query(sql, values);
  const rows = result.rows.map(row => Media.createFromRow(row));
  const hasMore = rows.length > normalizedLimit;
  const media = rows.slice(0, normalizedLimit).map(toMediaResult);

  return {
    media,
    limit: normalizedLimit,
    offset: normalizedOffset,
    hasMore,
    nextOffset: hasMore ? normalizedOffset + normalizedLimit : null,
  };
}

export async function deleteMedia(
  dalInstance: DataAccessLayer,
  { slug, revSummary }: MediaDeleteInput,
  userId: string,
  options: MediaServiceOptions = {}
): Promise<MediaDeleteResult> {
  const errors = new ValidationCollector('Invalid media delete input.');
  ensureNonEmptyString(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  await assertCanDeleteMedia(dalInstance, userId);

  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }

  const deletionRevision = await media.deleteAllRevisions(
    { id: userId },
    { tags: ['admin-delete'] }
  );
  await applyDeletionRevisionSummary(deletionRevision, revSummary);

  // Reclaim disk after the row is soft-deleted. Best-effort — if
  // storage cleanup throws, the deletion still succeeded as far as
  // the DB is concerned, and a future refresh would re-overwrite
  // anyway.
  if (options.storage) {
    try {
      await options.storage.deleteAllForSlug(slug);
    } catch {
      // intentionally swallowed; DB delete is authoritative.
    }
  }

  return {
    id: media.id,
    slug: media.slug,
    deleted: true,
  };
}
