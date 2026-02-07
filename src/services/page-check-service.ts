import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { validateCitationClaimRefs } from '../lib/citation-claim-validation.js';
import { validateLocalizedMarkdownContent } from '../lib/content-validation.js';
import type { FieldDiff } from '../lib/diff-engine.js';
import { diffLocalizedField, diffScalarField, diffStructuredField } from '../lib/diff-engine.js';
import {
  NotFoundError,
  ValidationCollector,
  ValidationError,
} from '../lib/errors.js';
import { type LocalizedMapInput, mergeLocalizedMap, sanitizeLocalizedMapInput } from '../lib/localized.js';
import {
  getPageCheckMetricsErrors,
  PAGE_CHECK_NOTES_MAX_LENGTH,
  PAGE_CHECK_RESULTS_MAX_LENGTH,
  PAGE_CHECK_STATUSES,
  PAGE_CHECK_TYPES,
  type PageCheckMetrics,
} from '../lib/page-checks.js';
import type { PageCheckInstance } from '../models/manifests/page-check.js';
import PageCheck from '../models/page-check.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import {
  ensureNoControlCharacters,
  ensureNonEmptyString,
  ensureOptionalLanguage,
  normalizeSlugInput,
  parseOptionalDate,
  requireRevSummary,
  toRevisionMeta,
  validateRevSummary,
} from './validation.js';
import { fetchPageRevisionByRevId, findCurrentPageBySlugOrAlias } from './wiki-page-service.js';

const { mlString } = dal;

export interface PageCheckWriteInput {
  slug: string;
  type: string;
  status: string;
  checkResults: Record<string, string | null>;
  notes?: Record<string, string | null> | null;
  metrics: PageCheckMetrics;
  targetRevId: string;
  completedAt?: string | null;
  tags?: string[];
  revSummary?: Record<string, string | null> | null;
}

export interface PageCheckUpdateInput {
  checkId: string;
  type?: string;
  status?: string;
  checkResults?: Record<string, string | null> | null;
  notes?: Record<string, string | null> | null;
  metrics?: PageCheckMetrics;
  targetRevId?: string;
  completedAt?: string | null;
  tags?: string[];
  revSummary: Record<string, string | null>;
}

export interface PageCheckResult {
  id: string;
  pageId: string;
  type: string;
  status: string;
  checkResults: Record<string, string> | null | undefined;
  notes: Record<string, string> | null | undefined;
  metrics: PageCheckMetrics | null | undefined;
  createdAt: Date | null | undefined;
  completedAt: Date | null | undefined;
  targetRevId: string;
}

export interface PageCheckRevisionResult extends PageCheckResult {
  revId: string;
  revDate: Date;
  revUser: string | null | undefined;
  revTags: string[] | null | undefined;
  revSummary: Record<string, string> | null | undefined;
  revDeleted: boolean;
  oldRevOf: string | null | undefined;
}

export interface PageCheckListResult {
  pageId: string;
  checks: PageCheckResult[];
}

export interface PageCheckRevisionListResult {
  checkId: string;
  revisions: PageCheckRevisionResult[];
}

export interface PageCheckRevisionReadResult {
  checkId: string;
  revision: PageCheckRevisionResult;
}

export interface PageCheckDiffInput {
  checkId: string;
  fromRevId: string;
  toRevId?: string;
  lang?: string;
}

export interface PageCheckDiffResult {
  checkId: string;
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

export interface PageCheckDeleteInput {
  checkId: string;
  revSummary: Record<string, string | null>;
}

export interface PageCheckDeleteResult {
  id: string;
  deleted: boolean;
}

const toPageCheckResult = (check: PageCheckInstance): PageCheckResult => ({
  id: check.id,
  pageId: check.pageId,
  type: check.type,
  status: check.status,
  checkResults: check.checkResults ?? null,
  notes: check.notes ?? null,
  metrics: (check.metrics ?? null) as PageCheckMetrics | null,
  createdAt: check.createdAt ?? null,
  completedAt: check.completedAt ?? null,
  targetRevId: check.targetRevId,
});

const toPageCheckRevisionResult = (check: PageCheckInstance): PageCheckRevisionResult => ({
  ...toPageCheckResult(check),
  revId: check._revID,
  revDate: check._revDate,
  revUser: check._revUser ?? null,
  revTags: check._revTags ?? null,
  revSummary: check._revSummary ?? null,
  revDeleted: check._revDeleted ?? false,
  oldRevOf: check._oldRevOf ?? null,
});

const findCurrentPageCheckById = async (id: string) =>
  PageCheck.filterWhere({
    id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const fetchPageCheckRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  checkId: string,
  revId: string
): Promise<PageCheckInstance | null> => {
  return PageCheck.filterWhere({}).getRevisionByRevId(revId, checkId).first();
};

const validateCheckResults = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: PAGE_CHECK_RESULTS_MAX_LENGTH, allowHTML: true });
    ensureNoControlCharacters(normalized, 'checkResults', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid checkResults value.';
    if (errors) {
      errors.add('checkResults', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [
      { field: 'checkResults', message, code: 'invalid' },
    ]);
  }
};

const requireCheckResults = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  const normalized = sanitizeLocalizedMapInput(value);
  if (!normalized) {
    if (errors) {
      errors.addMissing('checkResults');
      return;
    }
    throw new ValidationError('checkResults is required.', [
      { field: 'checkResults', message: 'is required.', code: 'required' },
    ]);
  }
  validateCheckResults(value, errors);
  const entries = Object.entries(normalized);
  if (entries.length === 0) {
    if (errors) {
      errors.add('checkResults', 'must include at least one language entry.', 'invalid');
      return;
    }
    throw new ValidationError('checkResults must include at least one language entry.', [
      { field: 'checkResults', message: 'must include at least one language entry.', code: 'invalid' },
    ]);
  }
  for (const [lang, text] of entries) {
    if (!lang || !text || text.trim().length === 0) {
      if (errors) {
        errors.add(`checkResults.${lang || 'unknown'}`, 'must be a non-empty string.', 'invalid');
        continue;
      }
      throw new ValidationError('checkResults entries must be non-empty strings.', [
        {
          field: `checkResults.${lang || 'unknown'}`,
          message: 'must be a non-empty string.',
          code: 'invalid',
        },
      ]);
    }
  }
};

const validateNotes = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: PAGE_CHECK_NOTES_MAX_LENGTH, allowHTML: true });
    ensureNoControlCharacters(normalized, 'notes', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid notes value.';
    if (errors) {
      errors.add('notes', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'notes', message, code: 'invalid' }]);
  }
};

const validateMetrics = (
  value: PageCheckMetrics | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  const metricErrors = getPageCheckMetricsErrors(value);
  if (!metricErrors.length) return;
  if (errors) {
    for (const metricError of metricErrors) {
      errors.add(metricError.field, metricError.message, metricError.code);
    }
    return;
  }
  const first = metricErrors[0];
  throw new ValidationError('Invalid metrics.', [
    { field: first.field, message: first.message, code: first.code },
  ]);
};

const requireMetrics = (
  value: PageCheckMetrics | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) {
    if (errors) {
      errors.addMissing('metrics');
      return;
    }
    throw new ValidationError('metrics is required.', [
      { field: 'metrics', message: 'is required.', code: 'required' },
    ]);
  }
  validateMetrics(value, errors);
};

const validatePageCheckType = (value: string | null | undefined, errors?: ValidationCollector) => {
  if (value === undefined) return;
  if (!PAGE_CHECK_TYPES.includes(value as (typeof PAGE_CHECK_TYPES)[number])) {
    const message = `type must be one of: ${PAGE_CHECK_TYPES.join(', ')}`;
    if (errors) {
      errors.add('type', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'type', message, code: 'invalid' }]);
  }
};

const validatePageCheckStatus = (
  value: string | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  if (!PAGE_CHECK_STATUSES.includes(value as (typeof PAGE_CHECK_STATUSES)[number])) {
    const message = `status must be one of: ${PAGE_CHECK_STATUSES.join(', ')}`;
    if (errors) {
      errors.add('status', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'status', message, code: 'invalid' }]);
  }
};

export async function createPageCheck(
  dalInstance: DataAccessLayer,
  {
    slug,
    type,
    status,
    checkResults,
    notes,
    metrics,
    targetRevId,
    completedAt,
    tags = [],
    revSummary,
  }: PageCheckWriteInput,
  userId: string
): Promise<PageCheckResult> {
  const errors = new ValidationCollector('Invalid page check input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  validatePageCheckType(type, errors);
  validatePageCheckStatus(status, errors);
  requireCheckResults(checkResults, errors);
  validateNotes(notes, errors);
  requireMetrics(metrics, errors);
  ensureNonEmptyString(targetRevId, 'targetRevId', errors);
  validateRevSummary(revSummary, errors);
  const parsedCompletedAt = parseOptionalDate(completedAt ?? undefined, 'completedAt', errors);
  await validateLocalizedMarkdownContent(
    checkResults,
    'checkResults',
    errors,
    [validateCitationClaimRefs]
  );
  await validateLocalizedMarkdownContent(notes, 'notes', errors, [validateCitationClaimRefs]);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const targetRevision = await fetchPageRevisionByRevId(dalInstance, page.id, targetRevId);
  if (!targetRevision) {
    throw new ValidationError('targetRevId does not match a revision for this page.', [
      {
        field: 'targetRevId',
        message: 'does not match a revision for this page.',
        code: 'invalid',
      },
    ]);
  }

  const createdAt = new Date();
  const check = await PageCheck.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );

  check.pageId = page.id;
  check.type = type;
  check.status = status;
  const normalizedCheckResults = sanitizeLocalizedMapInput(checkResults);
  const normalizedNotes = sanitizeLocalizedMapInput(notes ?? undefined);
  check.checkResults = normalizedCheckResults ?? null;
  if (normalizedNotes !== undefined) check.notes = normalizedNotes;
  check.metrics = metrics;
  check.createdAt = createdAt;
  if (parsedCompletedAt !== undefined) check.completedAt = parsedCompletedAt;
  check.targetRevId = targetRevId;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) check._revSummary = normalizedRevSummary;

  await check.save();

  return toPageCheckResult(check);
}

export async function updatePageCheck(
  dalInstance: DataAccessLayer,
  {
    checkId,
    type,
    status,
    checkResults,
    notes,
    metrics,
    targetRevId,
    completedAt,
    tags = [],
    revSummary,
  }: PageCheckUpdateInput,
  userId: string
): Promise<PageCheckResult> {
  const errors = new ValidationCollector('Invalid page check update input.');
  ensureNonEmptyString(checkId, 'checkId', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  validatePageCheckType(type, errors);
  validatePageCheckStatus(status, errors);
  if (checkResults !== undefined) {
    if (checkResults === null) {
      errors.add('checkResults', 'cannot be null.', 'invalid');
    } else {
      validateCheckResults(checkResults, errors);
    }
  }
  validateNotes(notes, errors);
  if (metrics !== undefined) {
    if (metrics === null) {
      errors.add('metrics', 'cannot be null.', 'invalid');
    } else {
      validateMetrics(metrics, errors);
    }
  }
  if (targetRevId !== undefined) {
    ensureNonEmptyString(targetRevId, 'targetRevId', errors);
  }
  requireRevSummary(revSummary, errors);
  const parsedCompletedAt =
    completedAt === null ? null : parseOptionalDate(completedAt ?? undefined, 'completedAt', errors);
  await validateLocalizedMarkdownContent(
    checkResults,
    'checkResults',
    errors,
    [validateCitationClaimRefs]
  );
  await validateLocalizedMarkdownContent(notes, 'notes', errors, [validateCitationClaimRefs]);
  errors.throwIfAny();

  const check = await findCurrentPageCheckById(checkId);
  if (!check) {
    throw new NotFoundError(`Page check not found: ${checkId}`, {
      checkId,
    });
  }

  if (targetRevId) {
    const targetRevision = await fetchPageRevisionByRevId(dalInstance, check.pageId, targetRevId);
    if (!targetRevision) {
      throw new ValidationError('targetRevId does not match a revision for this page.', [
        {
          field: 'targetRevId',
          message: 'does not match a revision for this page.',
          code: 'invalid',
        },
      ]);
    }
  }

  await check.newRevision({ id: userId }, { tags: ['update', ...tags] });

  if (type !== undefined) check.type = type;
  if (status !== undefined) check.status = status;
  if (checkResults !== undefined && checkResults !== null) {
    const mergedCheckResults = mergeLocalizedMap(check.checkResults ?? null, checkResults);
    if (!mergedCheckResults) {
      throw new ValidationError('checkResults cannot be null.', [
        { field: 'checkResults', message: 'cannot be null.', code: 'invalid' },
      ]);
    }
    check.checkResults = mergedCheckResults;
  }
  if (notes !== undefined) {
    const mergedNotes = mergeLocalizedMap(check.notes ?? null, notes);
    if (mergedNotes !== undefined) check.notes = mergedNotes;
  }
  if (metrics !== undefined && metrics !== null) check.metrics = metrics;
  if (targetRevId !== undefined) check.targetRevId = targetRevId;
  if (completedAt === null) {
    check.completedAt = null;
  } else if (parsedCompletedAt !== undefined) {
    check.completedAt = parsedCompletedAt;
  }
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) check._revSummary = normalizedRevSummary;

  await check.save();

  return toPageCheckResult(check);
}

export async function listPageChecks(
  _dalInstance: DataAccessLayer,
  slug: string
): Promise<PageCheckListResult> {
  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const checks = await PageCheck.filterWhere({
    pageId: page.id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>)
    .orderBy('_revDate', 'DESC')
    .run();

  return {
    pageId: page.id,
    checks: checks.map(check => toPageCheckResult(check)),
  };
}

export async function listPageCheckRevisions(
  _dalInstance: DataAccessLayer,
  checkId: string
): Promise<PageCheckRevisionListResult> {
  const check = await findCurrentPageCheckById(checkId);
  if (!check) {
    throw new NotFoundError(`Page check not found: ${checkId}`, {
      checkId,
    });
  }

  const revisionRows = await PageCheck.filterWhere({})
    .getAllRevisions(check.id)
    .orderBy('_revDate', 'DESC')
    .run();

  return {
    checkId: check.id,
    revisions: revisionRows.map(row => toPageCheckRevisionResult(row)),
  };
}

export async function readPageCheckRevision(
  dalInstance: DataAccessLayer,
  checkId: string,
  revId: string
): Promise<PageCheckRevisionReadResult> {
  const check = await findCurrentPageCheckById(checkId);
  if (!check) {
    throw new NotFoundError(`Page check not found: ${checkId}`, {
      checkId,
    });
  }

  const revision = await fetchPageCheckRevisionByRevId(dalInstance, check.id, revId);
  if (!revision) {
    throw new NotFoundError(`Revision not found: ${revId}`, {
      revId,
    });
  }

  return {
    checkId: check.id,
    revision: toPageCheckRevisionResult(revision),
  };
}

export async function diffPageCheckRevisions(
  dalInstance: DataAccessLayer,
  { checkId, fromRevId, toRevId, lang = 'en' }: PageCheckDiffInput
): Promise<PageCheckDiffResult> {
  ensureOptionalLanguage(lang, 'lang');
  const check = await findCurrentPageCheckById(checkId);
  if (!check) {
    throw new NotFoundError(`Page check not found: ${checkId}`, {
      checkId,
    });
  }

  const fromRev = await fetchPageCheckRevisionByRevId(dalInstance, check.id, fromRevId);
  if (!fromRev) {
    throw new NotFoundError(`Revision not found: ${fromRevId}`, {
      revId: fromRevId,
    });
  }

  const toRevisionId = toRevId ?? check._revID;
  const toRev = await fetchPageCheckRevisionByRevId(dalInstance, check.id, toRevisionId);
  if (!toRev) {
    throw new NotFoundError(`Revision not found: ${toRevisionId}`, {
      revId: toRevisionId,
    });
  }

  const fields: Record<string, FieldDiff> = {};
  const typeDiff = diffScalarField('type', fromRev.type ?? null, toRev.type ?? null);
  if (typeDiff) fields.type = typeDiff;
  const statusDiff = diffScalarField('status', fromRev.status ?? null, toRev.status ?? null);
  if (statusDiff) fields.status = statusDiff;
  const checkResultsDiff = diffLocalizedField(
    'checkResults',
    fromRev.checkResults ?? null,
    toRev.checkResults ?? null
  );
  if (checkResultsDiff) fields.checkResults = checkResultsDiff;
  const notesDiff = diffLocalizedField('notes', fromRev.notes ?? null, toRev.notes ?? null);
  if (notesDiff) fields.notes = notesDiff;
  const metricsDiff = diffStructuredField(
    'metrics',
    fromRev.metrics ?? null,
    toRev.metrics ?? null
  );
  if (metricsDiff) fields.metrics = metricsDiff;
  const targetDiff = diffScalarField(
    'targetRevId',
    fromRev.targetRevId ?? null,
    toRev.targetRevId ?? null
  );
  if (targetDiff) fields.targetRevId = targetDiff;
  const completedDiff = diffScalarField(
    'completedAt',
    fromRev.completedAt ?? null,
    toRev.completedAt ?? null
  );
  if (completedDiff) fields.completedAt = completedDiff;

  return {
    checkId: check.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    language: lang,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields,
  };
}

export async function deletePageCheck(
  _dalInstance: DataAccessLayer,
  { checkId, revSummary }: PageCheckDeleteInput,
  userId: string
): Promise<PageCheckDeleteResult> {
  const errors = new ValidationCollector('Invalid page check delete input.');
  ensureNonEmptyString(checkId, 'checkId', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const check = await findCurrentPageCheckById(checkId);
  if (!check) {
    throw new NotFoundError(`Page check not found: ${checkId}`, {
      checkId,
    });
  }

  const deletionRevision = await check.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });
  await applyDeletionRevisionSummary(deletionRevision, revSummary);

  return {
    id: check.id,
    deleted: true,
  };
}
