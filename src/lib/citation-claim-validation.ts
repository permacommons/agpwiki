import CitationModel from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';
import type { ContentValidator, MarkdownAnalysis } from './content-validation.js';
import type { ValidationCollector } from './errors.js';

const extractClaimRefs = (analysis: MarkdownAnalysis) => {
  const refs = new Map<string, Set<string>>();
  for (const citation of analysis.citations) {
    if (!citation.claimId) continue;
    const key = citation.citationId;
    const claimId = citation.claimId.trim();
    if (!refs.has(key)) {
      refs.set(key, new Set());
    }
    refs.get(key)?.add(claimId);
  }
  return refs;
};

const addMissingClaimErrors = (
  errors: ValidationCollector,
  fieldLabel: string,
  key: string,
  missing: Iterable<string>
) => {
  for (const claimId of missing) {
    const normalized = claimId.trim();
    if (!normalized) {
      errors.add(fieldLabel, 'citation claim id must not be empty.', 'invalid');
      continue;
    }
    errors.add(fieldLabel, `citation claim not found: ${key}:${normalized}`, 'invalid');
  }
};

const addMissingCitationErrors = (
  errors: ValidationCollector,
  fieldLabel: string,
  missing: Iterable<string>
) => {
  for (const key of missing) {
    const normalized = key.trim();
    if (!normalized) continue;
    errors.add(fieldLabel, `citation not found: ${normalized}`, 'invalid');
  }
};

const toNonEmptyArray = <T>(values: T[]) => {
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  return [first, ...rest] as [T, ...T[]];
};

export const validateCitationClaimRefs: ContentValidator = async ({ analysis, fieldLabel, errors }) => {
  const refsByKey = extractClaimRefs(analysis);
  const citationKeys = new Set(analysis.citations.map(citation => citation.citationId));
  if (refsByKey.size === 0 && citationKeys.size === 0) return;

  const { in: inOp } = CitationModel.ops;
  const citationKeyList = toNonEmptyArray(Array.from(citationKeys));
  if (!citationKeyList) return;
  const citations = await CitationModel.filterWhere({ key: inOp(citationKeyList) }).run();
  const citationMap = new Map(citations.map(citation => [citation.key, citation]));
  const missingCitationKeys = Array.from(citationKeys).filter(key => !citationMap.has(key));
  if (missingCitationKeys.length > 0) {
    addMissingCitationErrors(errors, fieldLabel, missingCitationKeys);
  }
  const requestedByCitationId = new Map<string, Set<string>>();
  const citationKeyById = new Map<string, string>();

  for (const [key, claimIds] of refsByKey.entries()) {
    const citation = citationMap.get(key);
    if (!citation) {
      addMissingClaimErrors(errors, fieldLabel, key, claimIds);
      continue;
    }
    const requested = Array.from(claimIds).filter(id => id.trim());
    if (requested.length === 0) {
      addMissingClaimErrors(errors, fieldLabel, key, claimIds);
      continue;
    }
    citationKeyById.set(citation.id, key);
    if (!requestedByCitationId.has(citation.id)) {
      requestedByCitationId.set(citation.id, new Set());
    }
    const target = requestedByCitationId.get(citation.id);
    for (const claimId of requested) {
      target?.add(claimId);
    }
  }

  if (requestedByCitationId.size === 0) return;

  const { in: inOpClaims } = CitationClaim.ops;
  const citationIds = Array.from(requestedByCitationId.keys());
  const requestedClaimIds = Array.from(
    new Set(
      Array.from(requestedByCitationId.values(), claimIds => Array.from(claimIds)).flat()
    )
  );
  const citationIdList = toNonEmptyArray(citationIds);
  const requestedClaimIdList = toNonEmptyArray(requestedClaimIds);
  if (!citationIdList || !requestedClaimIdList) return;

  const existing = await CitationClaim.filterWhere({
    citationId: inOpClaims(citationIdList),
    claimId: inOpClaims(requestedClaimIdList),
  }).run();

  const existingByCitationId = new Map<string, Set<string>>();
  for (const claim of existing) {
    if (!existingByCitationId.has(claim.citationId)) {
      existingByCitationId.set(claim.citationId, new Set());
    }
    existingByCitationId.get(claim.citationId)?.add(claim.claimId);
  }

  for (const [citationId, requestedClaimSet] of requestedByCitationId.entries()) {
    const existingClaimSet = existingByCitationId.get(citationId) ?? new Set();
    const missing = Array.from(requestedClaimSet).filter(
      claimId => !existingClaimSet.has(claimId)
    );
    if (missing.length === 0) continue;
    const key = citationKeyById.get(citationId) ?? citationId;
    addMissingClaimErrors(errors, fieldLabel, key, missing);
  }
};
