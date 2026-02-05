import type { ValidationCollector } from '../mcp/errors.js';
import Citation from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';

const citationKeyRegex = /@([\w][\w:.#$%&\-+?<>~/]*)/g;

const splitClaimRef = (value: string) => {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) return null;
  const key = value.slice(0, separatorIndex);
  const claimId = value.slice(separatorIndex + 1);
  return { key, claimId };
};

const extractClaimRefs = (text: string) => {
  const refs = new Map<string, Set<string>>();
  for (const match of text.matchAll(citationKeyRegex)) {
    const ref = splitClaimRef(match[1]);
    if (!ref) continue;
    const claimId = ref.claimId.trim();
    if (!refs.has(ref.key)) {
      refs.set(ref.key, new Set());
    }
    refs.get(ref.key)?.add(claimId);
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

const toNonEmptyArray = <T>(values: T[]) => {
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  return [first, ...rest] as [T, ...T[]];
};

export const validateCitationClaimRefs = async (
  body: Record<string, string> | string | null | undefined,
  fieldLabel: string,
  errors: ValidationCollector
) => {
  if (!body) return;

  const refsByKey = new Map<string, Set<string>>();

  const mergeRefs = (refs: Map<string, Set<string>>) => {
    for (const [key, claimIds] of refs.entries()) {
      if (!refsByKey.has(key)) {
        refsByKey.set(key, new Set());
      }
      const target = refsByKey.get(key);
      for (const claimId of claimIds) {
        target?.add(claimId);
      }
    }
  };

  if (typeof body === 'string') {
    mergeRefs(extractClaimRefs(body));
  } else {
    for (const [_lang, text] of Object.entries(body)) {
      if (!text) continue;
      const refs = extractClaimRefs(text);
      if (refs.size > 0) {
        mergeRefs(refs);
      }
    }
  }

  if (refsByKey.size === 0) return;

  const { in: inOp } = Citation.ops;
  const citationKeys = Array.from(refsByKey.keys());
  const citationKeyList = toNonEmptyArray(citationKeys);
  if (!citationKeyList) return;
  const citations = await Citation.filterWhere({ key: inOp(citationKeyList) }).run();
  const citationMap = new Map(citations.map(citation => [citation.key, citation]));
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
