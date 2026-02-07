import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import {
  CITATION_CLAIM_ASSERTION_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_TYPES,
  CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH,
  CITATION_CLAIM_QUOTE_MAX_LENGTH,
} from '../lib/citation-claims.js';
import type { FieldDiff } from '../lib/diff-engine.js';
import { diffLocalizedField, diffScalarField } from '../lib/diff-engine.js';
import {
  ConflictError,
  NotFoundError,
  ValidationCollector,
  ValidationError,
} from '../lib/errors.js';
import { type LocalizedMapInput, mergeLocalizedMap, sanitizeLocalizedMapInput } from '../lib/localized.js';
import CitationClaim from '../models/citation-claim.js';
import type { CitationClaimInstance } from '../models/manifests/citation-claim.js';
import { findCurrentCitationByKey } from './citation-service.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import {
  ensureKeyLength,
  ensureNoControlCharacters,
  ensureNonEmptyString,
  ensureOptionalLanguage,
  ensureOptionalString,
  requireRevSummary,
  toRevisionMeta,
  validateRevSummary,
} from './validation.js';

const { mlString } = dal;

export interface CitationClaimWriteInput {
  key: string;
  claimId: string;
  assertion: Record<string, string | null>;
  quote?: Record<string, string | null> | null;
  quoteLanguage?: string | null;
  locatorType?: string | null;
  locatorValue?: Record<string, string | null> | null;
  locatorLabel?: Record<string, string | null> | null;
  tags?: string[];
  revSummary?: Record<string, string | null> | null;
}

export interface CitationClaimUpdateInput extends CitationClaimWriteInput {
  revSummary: Record<string, string | null>;
  newClaimId?: string;
}

export interface CitationClaimResult {
  id: string;
  citationId: string;
  claimId: string;
  assertion: Record<string, string> | null | undefined;
  quote: Record<string, string> | null | undefined;
  quoteLanguage: string | null | undefined;
  locatorType: string | null | undefined;
  locatorValue: Record<string, string> | null | undefined;
  locatorLabel: Record<string, string> | null | undefined;
  createdAt: Date | null | undefined;
  updatedAt: Date | null | undefined;
}

export interface CitationClaimRevisionResult extends CitationClaimResult {
  revId: string;
  revDate: Date;
  revUser: string | null | undefined;
  revTags: string[] | null | undefined;
  revSummary: Record<string, string> | null | undefined;
  revDeleted: boolean;
  oldRevOf: string | null | undefined;
}

export interface CitationClaimRevisionListResult {
  citationId: string;
  claimId: string;
  revisions: CitationClaimRevisionResult[];
}

export interface CitationClaimRevisionReadResult {
  citationId: string;
  claimId: string;
  revision: CitationClaimRevisionResult;
}

export interface CitationClaimDiffInput {
  key: string;
  claimId: string;
  fromRevId: string;
  toRevId?: string;
  lang?: string;
}

export interface CitationClaimDiffResult {
  citationId: string;
  claimId: string;
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

export interface CitationClaimDeleteInput {
  key: string;
  claimId: string;
  revSummary: Record<string, string | null>;
}

export interface CitationClaimDeleteResult {
  id: string;
  key: string;
  claimId: string;
  deleted: boolean;
}

const toCitationClaimResult = (claim: CitationClaimInstance): CitationClaimResult => ({
  id: claim.id,
  citationId: claim.citationId,
  claimId: claim.claimId,
  assertion: claim.assertion ?? null,
  quote: claim.quote ?? null,
  quoteLanguage: claim.quoteLanguage ?? null,
  locatorType: claim.locatorType ?? null,
  locatorValue: claim.locatorValue ?? null,
  locatorLabel: claim.locatorLabel ?? null,
  createdAt: claim.createdAt ?? null,
  updatedAt: claim.updatedAt ?? null,
});

const toCitationClaimRevisionResult = (
  claim: CitationClaimInstance
): CitationClaimRevisionResult => ({
  ...toCitationClaimResult(claim),
  revId: claim._revID,
  revDate: claim._revDate,
  revUser: claim._revUser ?? null,
  revTags: claim._revTags ?? null,
  revSummary: claim._revSummary ?? null,
  revDeleted: claim._revDeleted ?? false,
  oldRevOf: claim._oldRevOf ?? null,
});

const findCurrentCitationClaim = async (citationId: string, claimId: string) =>
  CitationClaim.filterWhere({
    citationId,
    claimId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const fetchCitationClaimRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  claimId: string,
  revId: string
): Promise<CitationClaimInstance | null> => {
  return CitationClaim.filterWhere({}).getRevisionByRevId(revId, claimId).first();
};

const citationClaimIdRegex = /^[\w][\w:.#$%&+?<>~/-]*$/;

const ensureClaimIdFormat = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (!ensureNonEmptyString(value, label, errors)) return;
  if (!citationClaimIdRegex.test(value)) {
    if (errors) {
      errors.add(label, 'must use a valid claim id format.', 'invalid');
      return;
    }
    throw new ValidationError(`${label} must use a valid claim id format.`, [
      { field: label, message: 'must use a valid claim id format.', code: 'invalid' },
    ]);
  }
};

const requireMlString = (
  value: LocalizedMapInput,
  label: string,
  errors?: ValidationCollector
) => {
  const normalized = sanitizeLocalizedMapInput(value);
  if (!normalized) {
    if (errors) {
      errors.addMissing(label);
      return false;
    }
    throw new ValidationError(`${label} is required.`, [
      { field: label, message: 'is required.', code: 'required' },
    ]);
  }
  return true;
};

const validateAssertion = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, {
      maxLength: CITATION_CLAIM_ASSERTION_MAX_LENGTH,
      allowHTML: false,
    });
    ensureNoControlCharacters(normalized, 'assertion', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid assertion value.';
    if (errors) {
      errors.add('assertion', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'assertion', message, code: 'invalid' }]);
  }
};

const validateQuote = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined || value === null) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, {
      maxLength: CITATION_CLAIM_QUOTE_MAX_LENGTH,
      allowHTML: false,
    });
    ensureNoControlCharacters(normalized, 'quote', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid quote value.';
    if (errors) {
      errors.add('quote', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'quote', message, code: 'invalid' }]);
  }
};

const validateLocatorValue = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined || value === null) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, {
      maxLength: CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH,
      allowHTML: false,
    });
    ensureNoControlCharacters(normalized, 'locatorValue', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid locator value.';
    if (errors) {
      errors.add('locatorValue', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [
      { field: 'locatorValue', message, code: 'invalid' },
    ]);
  }
};

const validateLocatorLabel = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined || value === null) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, {
      maxLength: CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH,
      allowHTML: false,
    });
    ensureNoControlCharacters(normalized, 'locatorLabel', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid locator label.';
    if (errors) {
      errors.add('locatorLabel', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [
      { field: 'locatorLabel', message, code: 'invalid' },
    ]);
  }
};

const ensureLocatorType = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  ensureOptionalString(value, label, errors);
  if (!value) return;
  if (!CITATION_CLAIM_LOCATOR_TYPES.includes(value as (typeof CITATION_CLAIM_LOCATOR_TYPES)[number])) {
    if (errors) {
      errors.add(label, `must be one of: ${CITATION_CLAIM_LOCATOR_TYPES.join(', ')}`, 'invalid');
      return;
    }
    throw new ValidationError(`${label} must be one of: ${CITATION_CLAIM_LOCATOR_TYPES.join(', ')}`, [
      { field: label, message: `must be one of: ${CITATION_CLAIM_LOCATOR_TYPES.join(', ')}`, code: 'invalid' },
    ]);
  }
};

const validateQuoteLanguage = (
  quote: LocalizedMapInput,
  quoteLanguage: string | null | undefined,
  errors?: ValidationCollector
) => {
  const normalizedQuote = sanitizeLocalizedMapInput(quote);
  if (!normalizedQuote) {
    if (quoteLanguage) {
      if (errors) {
        errors.add('quoteLanguage', 'requires quote to be provided.', 'invalid');
        return;
      }
      throw new ValidationError('quoteLanguage requires quote to be provided.', [
        { field: 'quoteLanguage', message: 'requires quote to be provided.', code: 'invalid' },
      ]);
    }
    return;
  }

  if (!quoteLanguage) {
    if (errors) {
      errors.add('quoteLanguage', 'is required when quote is provided.', 'required');
      return;
    }
    throw new ValidationError('quoteLanguage is required when quote is provided.', [
      { field: 'quoteLanguage', message: 'is required when quote is provided.', code: 'required' },
    ]);
  }

  ensureOptionalLanguage(quoteLanguage, 'quoteLanguage', errors);
  if (!quoteLanguage) return;
  const sourceQuote = normalizedQuote[quoteLanguage];
  if (!sourceQuote || typeof sourceQuote !== 'string' || sourceQuote.trim().length === 0) {
    if (errors) {
      errors.add(`quote.${quoteLanguage}`, 'is required for the source language.', 'required');
      return;
    }
    throw new ValidationError('quote must include a value for quoteLanguage.', [
      {
        field: `quote.${quoteLanguage}`,
        message: 'is required for the source language.',
        code: 'required',
      },
    ]);
  }
};

export async function readCitationClaim(
  _dalInstance: DataAccessLayer,
  key: string,
  claimId: string
): Promise<CitationClaimResult> {
  ensureNonEmptyString(key, 'key');
  ensureClaimIdFormat(claimId, 'claimId');
  ensureKeyLength(claimId, 'claimId', 200);
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }
  const claim = await findCurrentCitationClaim(citation.id, claimId);
  if (!claim) {
    throw new NotFoundError(`Citation claim not found: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }
  return toCitationClaimResult(claim);
}

export async function createCitationClaim(
  _dalInstance: DataAccessLayer,
  {
    key,
    claimId,
    assertion,
    quote,
    quoteLanguage,
    locatorType,
    locatorValue,
    locatorLabel,
    tags = [],
    revSummary,
  }: CitationClaimWriteInput,
  userId: string
): Promise<CitationClaimResult> {
  const errors = new ValidationCollector('Invalid citation claim input.');
  ensureNonEmptyString(key, 'key', errors);
  ensureClaimIdFormat(claimId, 'claimId', errors);
  if (claimId) ensureKeyLength(claimId, 'claimId', 200, errors);
  ensureNonEmptyString(userId, 'userId', errors);
  if (requireMlString(assertion, 'assertion', errors)) {
    validateAssertion(assertion, errors);
  }
  validateQuote(quote ?? undefined, errors);
  validateQuoteLanguage(quote ?? undefined, quoteLanguage ?? undefined, errors);
  ensureLocatorType(locatorType ?? undefined, 'locatorType', errors);
  validateLocatorValue(locatorValue ?? undefined, errors);
  validateLocatorLabel(locatorLabel ?? undefined, errors);
  validateRevSummary(revSummary, errors);
  errors.throwIfAny();

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const existing = await findCurrentCitationClaim(citation.id, claimId);
  if (existing) {
    throw new ConflictError(`Citation claim already exists: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }

  const createdAt = new Date();
  const claim = await CitationClaim.createFirstRevision(
    { id: userId },
    { tags: ['create', ...tags], date: createdAt }
  );

  claim.citationId = citation.id;
  claim.claimId = claimId;
  const normalizedAssertion = sanitizeLocalizedMapInput(assertion);
  const normalizedQuote = sanitizeLocalizedMapInput(quote ?? undefined);
  const normalizedLocatorValue = sanitizeLocalizedMapInput(locatorValue ?? undefined);
  const normalizedLocatorLabel = sanitizeLocalizedMapInput(locatorLabel ?? undefined);
  claim.assertion = normalizedAssertion ?? null;
  claim.quote = normalizedQuote ?? null;
  claim.quoteLanguage = quoteLanguage ?? null;
  claim.locatorType = locatorType ?? null;
  claim.locatorValue = normalizedLocatorValue ?? null;
  claim.locatorLabel = normalizedLocatorLabel ?? null;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) claim._revSummary = normalizedRevSummary;
  claim.createdAt = createdAt;
  claim.updatedAt = createdAt;

  await claim.save();

  return toCitationClaimResult(claim);
}

export async function updateCitationClaim(
  _dalInstance: DataAccessLayer,
  {
    key,
    claimId,
    newClaimId,
    assertion,
    quote,
    quoteLanguage,
    locatorType,
    locatorValue,
    locatorLabel,
    tags = [],
    revSummary,
  }: CitationClaimUpdateInput,
  userId: string
): Promise<CitationClaimResult> {
  const errors = new ValidationCollector('Invalid citation claim update input.');
  ensureNonEmptyString(key, 'key', errors);
  ensureClaimIdFormat(claimId, 'claimId', errors);
  if (claimId) ensureKeyLength(claimId, 'claimId', 200, errors);
  ensureOptionalString(newClaimId, 'newClaimId', errors);
  if (newClaimId) {
    ensureClaimIdFormat(newClaimId, 'newClaimId', errors);
    ensureKeyLength(newClaimId, 'newClaimId', 200, errors);
  }
  ensureNonEmptyString(userId, 'userId', errors);
  if (assertion !== undefined) {
    if (requireMlString(assertion, 'assertion', errors)) {
      validateAssertion(assertion, errors);
    }
  }
  if (quote !== undefined) {
    if (quote !== null) {
      validateQuote(quote, errors);
    }
    validateQuoteLanguage(quote ?? undefined, quoteLanguage ?? undefined, errors);
  } else if (quoteLanguage !== undefined) {
    validateQuoteLanguage(undefined, quoteLanguage ?? undefined, errors);
  }
  ensureLocatorType(locatorType ?? undefined, 'locatorType', errors);
  validateLocatorValue(locatorValue ?? undefined, errors);
  validateLocatorLabel(locatorLabel ?? undefined, errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const claim = await findCurrentCitationClaim(citation.id, claimId);
  if (!claim) {
    throw new NotFoundError(`Citation claim not found: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }

  if (newClaimId && newClaimId !== claimId) {
    const claimMatch = await findCurrentCitationClaim(citation.id, newClaimId);
    if (claimMatch) {
      throw new ConflictError(`Citation claim already exists: ${key}:${newClaimId}`, {
        key,
        claimId: newClaimId,
      });
    }
  }

  await claim.newRevision({ id: userId }, { tags: ['update', ...tags] });

  if (newClaimId !== undefined) claim.claimId = newClaimId;
  const mergedAssertion = mergeLocalizedMap(claim.assertion ?? null, assertion);
  const mergedQuote = mergeLocalizedMap(claim.quote ?? null, quote);
  const mergedLocatorValue = mergeLocalizedMap(claim.locatorValue ?? null, locatorValue);
  const mergedLocatorLabel = mergeLocalizedMap(claim.locatorLabel ?? null, locatorLabel);
  if (mergedAssertion !== undefined) {
    if (!mergedAssertion) {
      throw new ValidationError('assertion cannot be null.', [
        { field: 'assertion', message: 'cannot be null.', code: 'invalid' },
      ]);
    }
    claim.assertion = mergedAssertion;
  }
  if (mergedQuote !== undefined) claim.quote = mergedQuote;
  if (quoteLanguage !== undefined) claim.quoteLanguage = quoteLanguage;
  if (locatorType !== undefined) claim.locatorType = locatorType;
  if (mergedLocatorValue !== undefined) claim.locatorValue = mergedLocatorValue;
  if (mergedLocatorLabel !== undefined) claim.locatorLabel = mergedLocatorLabel;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) claim._revSummary = normalizedRevSummary;
  claim.updatedAt = new Date();

  await claim.save();

  return toCitationClaimResult(claim);
}

export async function listCitationClaimRevisions(
  _dalInstance: DataAccessLayer,
  key: string,
  claimId: string
): Promise<CitationClaimRevisionListResult> {
  ensureNonEmptyString(key, 'key');
  ensureClaimIdFormat(claimId, 'claimId');
  ensureKeyLength(claimId, 'claimId', 200);
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }
  const claim = await findCurrentCitationClaim(citation.id, claimId);
  if (!claim) {
    throw new NotFoundError(`Citation claim not found: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }

  const revisionRows = await CitationClaim.filterWhere({})
    .getAllRevisions(claim.id)
    .orderBy('_revDate', 'DESC')
    .run();

  return {
    citationId: citation.id,
    claimId: claim.claimId,
    revisions: revisionRows.map(row => toCitationClaimRevisionResult(row)),
  };
}

export async function readCitationClaimRevision(
  dalInstance: DataAccessLayer,
  key: string,
  claimId: string,
  revId: string
): Promise<CitationClaimRevisionReadResult> {
  ensureNonEmptyString(key, 'key');
  ensureClaimIdFormat(claimId, 'claimId');
  ensureKeyLength(claimId, 'claimId', 200);
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }
  const claim = await findCurrentCitationClaim(citation.id, claimId);
  if (!claim) {
    throw new NotFoundError(`Citation claim not found: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }

  const revision = await fetchCitationClaimRevisionByRevId(dalInstance, claim.id, revId);
  if (!revision) {
    throw new NotFoundError(`Revision not found: ${revId}`, {
      revId,
    });
  }

  return {
    citationId: citation.id,
    claimId: claim.claimId,
    revision: toCitationClaimRevisionResult(revision),
  };
}

export async function diffCitationClaimRevisions(
  dalInstance: DataAccessLayer,
  { key, claimId, fromRevId, toRevId, lang = 'en' }: CitationClaimDiffInput
): Promise<CitationClaimDiffResult> {
  ensureOptionalLanguage(lang, 'lang');
  ensureClaimIdFormat(claimId, 'claimId');
  ensureKeyLength(claimId, 'claimId', 200);
  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }
  const claim = await findCurrentCitationClaim(citation.id, claimId);
  if (!claim) {
    throw new NotFoundError(`Citation claim not found: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }

  const fromRev = await fetchCitationClaimRevisionByRevId(dalInstance, claim.id, fromRevId);
  if (!fromRev) {
    throw new NotFoundError(`Revision not found: ${fromRevId}`, {
      revId: fromRevId,
    });
  }

  const toRevisionId = toRevId ?? claim._revID;
  const toRev = await fetchCitationClaimRevisionByRevId(dalInstance, claim.id, toRevisionId);
  if (!toRev) {
    throw new NotFoundError(`Revision not found: ${toRevisionId}`, {
      revId: toRevisionId,
    });
  }

  const fields: Record<string, FieldDiff> = {};
  const claimIdDiff = diffScalarField('claimId', fromRev.claimId ?? null, toRev.claimId ?? null);
  if (claimIdDiff) fields.claimId = claimIdDiff;
  const assertionDiff = diffLocalizedField(
    'assertion',
    fromRev.assertion ?? null,
    toRev.assertion ?? null
  );
  if (assertionDiff) fields.assertion = assertionDiff;
  const quoteDiff = diffLocalizedField('quote', fromRev.quote ?? null, toRev.quote ?? null);
  if (quoteDiff) fields.quote = quoteDiff;
  const quoteLangDiff = diffScalarField(
    'quoteLanguage',
    fromRev.quoteLanguage ?? null,
    toRev.quoteLanguage ?? null
  );
  if (quoteLangDiff) fields.quoteLanguage = quoteLangDiff;
  const locatorTypeDiff = diffScalarField(
    'locatorType',
    fromRev.locatorType ?? null,
    toRev.locatorType ?? null
  );
  if (locatorTypeDiff) fields.locatorType = locatorTypeDiff;
  const locatorValueDiff = diffLocalizedField(
    'locatorValue',
    fromRev.locatorValue ?? null,
    toRev.locatorValue ?? null
  );
  if (locatorValueDiff) fields.locatorValue = locatorValueDiff;
  const locatorLabelDiff = diffLocalizedField(
    'locatorLabel',
    fromRev.locatorLabel ?? null,
    toRev.locatorLabel ?? null
  );
  if (locatorLabelDiff) fields.locatorLabel = locatorLabelDiff;

  return {
    citationId: citation.id,
    claimId: claim.claimId,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    language: lang,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields,
  };
}

export async function deleteCitationClaim(
  _dalInstance: DataAccessLayer,
  { key, claimId, revSummary }: CitationClaimDeleteInput,
  userId: string
): Promise<CitationClaimDeleteResult> {
  const errors = new ValidationCollector('Invalid citation claim delete input.');
  ensureNonEmptyString(key, 'key', errors);
  ensureClaimIdFormat(claimId, 'claimId', errors);
  if (claimId) ensureKeyLength(claimId, 'claimId', 200, errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const citation = await findCurrentCitationByKey(key);
  if (!citation) {
    throw new NotFoundError(`Citation not found: ${key}`, {
      key,
    });
  }

  const claim = await findCurrentCitationClaim(citation.id, claimId);
  if (!claim) {
    throw new NotFoundError(`Citation claim not found: ${key}:${claimId}`, {
      key,
      claimId,
    });
  }

  const deletionRevision = await claim.deleteAllRevisions(
    { id: userId },
    { tags: ['admin-delete'] }
  );
  await applyDeletionRevisionSummary(deletionRevision, revSummary);

  return {
    id: claim.id,
    key,
    claimId: claim.claimId,
    deleted: true,
  };
}
