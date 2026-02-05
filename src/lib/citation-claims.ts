export const CITATION_CLAIM_ASSERTION_MAX_LENGTH = 2000;
export const CITATION_CLAIM_QUOTE_MAX_LENGTH = 4000;
export const CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH = 200;
export const CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH = 200;

export const CITATION_CLAIM_LOCATOR_TYPES = [
  'page',
  'section',
  'chapter',
  'paragraph',
  'timestamp',
  'figure',
  'table',
  'line',
  'characterOffset',
  'other',
] as const;

export type CitationClaimLocatorType = (typeof CITATION_CLAIM_LOCATOR_TYPES)[number];
