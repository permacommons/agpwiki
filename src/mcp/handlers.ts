import fs from 'node:fs';
import path from 'node:path';
import { Driver } from '@citeproc-rs/wasm';
import { createTwoFilesPatch, diffLines } from 'diff';
import MarkdownIt from 'markdown-it';
import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import languages from '../../locales/languages.js';
import { validateCitationClaimRefs } from '../lib/citation-claim-validation.js';
import {
  CITATION_CLAIM_ASSERTION_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_TYPES,
  CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH,
  CITATION_CLAIM_QUOTE_MAX_LENGTH,
} from '../lib/citation-claims.js';
import { validateMarkdownContent } from '../lib/content-validation.js';
import {
  getPageCheckMetricsErrors,
  PAGE_CHECK_NOTES_MAX_LENGTH,
  PAGE_CHECK_RESULTS_MAX_LENGTH,
  PAGE_CHECK_STATUSES,
  PAGE_CHECK_TYPES,
  type PageCheckMetrics,
} from '../lib/page-checks.js';
import { isBlockedSlug, normalizeSlug } from '../lib/slug.js';
import Citation from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';
import type { CitationInstance } from '../models/manifests/citation.js';
import type { CitationClaimInstance } from '../models/manifests/citation-claim.js';
import type { PageAliasInstance } from '../models/manifests/page-alias.js';
import type { PageCheckInstance } from '../models/manifests/page-check.js';
import type { WikiPageInstance } from '../models/manifests/wiki-page.js';
import PageAlias from '../models/page-alias.js';
import PageCheck from '../models/page-check.js';
import WikiPage from '../models/wiki-page.js';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PreconditionFailedError,
  ValidationCollector,
  ValidationError,
} from './errors.js';
import { type LocalizedMapInput, mergeLocalizedMap, sanitizeLocalizedMapInput } from './localized.js';
import { applyUnifiedPatch, type PatchFormat } from './patch.js';

const { mlString } = dal;
const citationStylePath = path.resolve(process.cwd(), 'vendor/csl/agpwiki-author-date.csl');
const citationStyle = fs.readFileSync(citationStylePath, 'utf8');

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
  title?: LocalizedMapInput;
  body?: LocalizedMapInput;
  originalLanguage?: string | null;
  tags?: string[];
  revSummary?: LocalizedMapInput;
}

export interface WikiPageUpdateInput extends WikiPageWriteInput {
  newSlug?: string;
  revSummary: Record<string, string | null>;
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

export interface WikiPageRewriteSectionInput {
  slug: string;
  target?: 'heading' | 'lead';
  heading?: string;
  headingLevel?: number;
  occurrence?: number;
  mode?: 'replace' | 'prepend' | 'append';
  content: string;
  lang?: string;
  expectedRevId?: string;
  tags?: string[];
  revSummary: Record<string, string>;
}

export interface WikiPageExactReplacement {
  from: string;
  to: string;
}

export interface WikiPageReplaceExactTextInput {
  slug: string;
  replacements: WikiPageExactReplacement[];
  lang?: string;
  expectedRevId?: string;
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
  revSummary: Record<string, string | null>;
}

export interface WikiPageDeleteResult {
  id: string;
  slug: string;
  deleted: boolean;
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

export interface PageCheckDeleteInput {
  checkId: string;
  revSummary: Record<string, string | null>;
}

export interface PageCheckDeleteResult {
  id: string;
  deleted: boolean;
}

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
  stats: {
    addedLines: number;
    removedLines: number;
  };
}

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
  fields: {
    key: WikiPageFieldDiff;
    data: WikiPageFieldDiff;
  };
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
  fields: Record<string, WikiPageFieldDiff>;
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
  fields: Record<string, WikiPageFieldDiff>;
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

const findCurrentCitationClaim = async (citationId: string, claimId: string) =>
  CitationClaim.filterWhere({
    citationId,
    claimId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentPageCheckById = async (id: string) =>
  PageCheck.filterWhere({
    id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const fetchPageRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  pageId: string,
  revId: string
): Promise<WikiPageInstance | null> => {
  return WikiPage.filterWhere({}).getRevisionByRevId(revId, pageId).first();
};

const fetchCitationRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  citationId: string,
  revId: string
): Promise<CitationInstance | null> => {
  return Citation.filterWhere({}).getRevisionByRevId(revId, citationId).first();
};

const fetchCitationClaimRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  claimId: string,
  revId: string
): Promise<CitationClaimInstance | null> => {
  return CitationClaim.filterWhere({}).getRevisionByRevId(revId, claimId).first();
};

const fetchPageCheckRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  checkId: string,
  revId: string
): Promise<PageCheckInstance | null> => {
  return PageCheck.filterWhere({}).getRevisionByRevId(revId, checkId).first();
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
    stats: { addedLines, removedLines },
  };
};

const toRevisionMeta = (rev: {
  _revID?: string | null;
  _revDate?: Date | null;
  _revUser?: string | null;
  _revTags?: string[] | null;
}) => ({
  revId: rev._revID ?? '',
  revDate: rev._revDate ?? new Date(0),
  revUser: rev._revUser ?? null,
  revTags: rev._revTags ?? null,
});

const buildDiffFields = <T extends string>(
  fields: Array<{ key: T; from: string; to: string }>
): Record<T, WikiPageFieldDiff> =>
  Object.fromEntries(
    fields.map(field => [field.key, buildFieldDiff(field.key, field.from, field.to)])
  ) as Record<T, WikiPageFieldDiff>;

const stringifyJsonValue = (value: unknown) => JSON.stringify(value ?? null, null, 2);

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


const parseOptionalDate = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    if (errors) {
      errors.add(label, 'must be an ISO date string.', 'type');
      return undefined;
    }
    throw new ValidationError(`${label} must be an ISO date string.`, [
      { field: label, message: 'must be an ISO date string.', code: 'type' },
    ]);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    if (errors) {
      errors.add(label, 'must be a valid ISO date string.', 'invalid');
      return undefined;
    }
    throw new ValidationError(`${label} must be a valid ISO date string.`, [
      { field: label, message: 'must be a valid ISO date string.', code: 'invalid' },
    ]);
  }
  return parsed;
};

const ensureString = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) {
    if (errors) {
      errors.addMissing(label);
      return false;
    }
    throw new ValidationError(`${label} is required.`, [
      { field: label, message: 'is required.', code: 'required' },
    ]);
  }
  if (typeof value !== 'string') {
    if (errors) {
      errors.add(label, 'must be a string.', 'type');
      return false;
    }
    throw new ValidationError(`${label} must be a string.`, [
      { field: label, message: 'must be a string.', code: 'type' },
    ]);
  }
  return true;
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

type HeadingSection = {
  level: number;
  text: string;
  line: number;
  contentStartLine: number;
  contentEndLine: number;
};

const sectionParser = new MarkdownIt({ html: false, linkify: true });

const listHeadingSections = (text: string): HeadingSection[] => {
  const tokens = sectionParser.parse(text, {});
  const headings: Array<Omit<HeadingSection, 'contentEndLine'>> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const map = token.map;
    if (!map || map.length < 2) continue;
    const inlineToken = tokens[i + 1];
    const textValue = inlineToken && inlineToken.type === 'inline' ? inlineToken.content : '';
    const level = Number.parseInt(token.tag.slice(1), 10);
    headings.push({
      level,
      text: textValue,
      line: map[0],
      contentStartLine: map[1] ?? map[0] + 1,
    });
  }

  const totalLines = text.split('\n').length;
  return headings.map((heading, index) => {
    let contentEndLine = totalLines;
    for (let i = index + 1; i < headings.length; i += 1) {
      const next = headings[i];
      if (next.line > heading.line && next.level <= heading.level) {
        contentEndLine = next.line;
        break;
      }
    }
    return { ...heading, contentEndLine };
  });
};

const buildHeadingDetails = (sections: HeadingSection[], limit = 25) => {
  const counts = new Map<string, number>();
  return sections.slice(0, limit).map(section => {
    const key = `${section.text}::${section.level}`;
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    return {
      text: section.text,
      level: section.level,
      occurrence,
      line: section.line + 1,
    };
  });
};

const rewriteSectionBody = (
  text: string,
  section: HeadingSection,
  mode: 'replace' | 'prepend' | 'append',
  content: string
) => {
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  const contentLines = content === '' ? [] : content.split('\n');
  const before = lines.slice(0, section.contentStartLine);
  const currentSection = lines.slice(section.contentStartLine, section.contentEndLine);
  const after = lines.slice(section.contentEndLine);

  const nextLines = [...before];
  if (mode === 'replace') {
    const nextContent = [...contentLines];
    if (currentSection.length > 0 && currentSection[currentSection.length - 1] === '') {
      if (nextContent.length === 0 || nextContent[nextContent.length - 1] !== '') {
        nextContent.push('');
      }
    }
    nextLines.push(...nextContent);
  } else if (mode === 'prepend') {
    nextLines.push(...contentLines, ...currentSection);
  } else {
    nextLines.push(...currentSection, ...contentLines);
  }
  nextLines.push(...after);

  let nextText = nextLines.join('\n');
  if (endsWithNewline && !nextText.endsWith('\n')) {
    nextText += '\n';
  }
  return nextText;
};

const countOccurrences = (text: string, needle: string) => {
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
};

const applyExactReplacements = (
  text: string,
  replacements: WikiPageExactReplacement[]
) => {
  type LocatedReplacement = {
    from: string;
    to: string;
    start: number;
    end: number;
  };

  const located: LocatedReplacement[] = replacements.map(replacement => {
    const count = countOccurrences(text, replacement.from);
    if (count === 0) {
      throw new NotFoundError(`Exact text not found: "${replacement.from}".`, {
        text: replacement.from,
      });
    }
    if (count > 1) {
      throw new ConflictError(
        `Exact text occurs more than once: "${replacement.from}". Refusing to apply partial replacement.`,
        { text: replacement.from, occurrences: count }
      );
    }
    const start = text.indexOf(replacement.from);
    return {
      ...replacement,
      start,
      end: start + replacement.from.length,
    };
  });

  located.sort((a, b) => a.start - b.start);
  for (let i = 1; i < located.length; i += 1) {
    const previous = located[i - 1];
    const current = located[i];
    if (current.start < previous.end) {
      throw new InvalidRequestError(
        `Exact replacement ranges overlap: "${previous.from}" and "${current.from}".`,
        {
          first: previous.from,
          second: current.from,
        }
      );
    }
  }

  let cursor = 0;
  let nextText = '';
  for (const replacement of located) {
    nextText += text.slice(cursor, replacement.start);
    nextText += replacement.to;
    cursor = replacement.end;
  }
  nextText += text.slice(cursor);
  return nextText;
};

const hasDisallowedControlCharacters = (value: string) => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
    if (code >= 0x80 && code <= 0x9f) {
      return true;
    }
    if (code >= 0x2400 && code <= 0x241f) {
      return true;
    }
  }
  return false;
};

const ensureNoControlCharacters = (
  value: Record<string, string | null> | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === undefined || value === null) return;
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    if (!hasDisallowedControlCharacters(text)) continue;
    const message = `${label} contains disallowed control characters.`;
    const field = `${label}.${lang || 'unknown'}`;
    if (errors) {
      errors.add(field, message, 'invalid');
      continue;
    }
    throw new ValidationError(message, [{ field, message, code: 'invalid' }]);
  }
};

const validateTitle = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 200, allowHTML: false });
    ensureNoControlCharacters(normalized, 'title', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid title value.';
    if (errors) {
      errors.add('title', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'title', message, code: 'invalid' }]);
  }
};

const validateBody = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 20000, allowHTML: true });
    ensureNoControlCharacters(normalized, 'body', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid body value.';
    if (errors) {
      errors.add('body', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'body', message, code: 'invalid' }]);
  }
};

const validateRevSummary = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 300, allowHTML: false });
    ensureNoControlCharacters(normalized, 'revSummary', errors);
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

const validateCheckResults = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: PAGE_CHECK_RESULTS_MAX_LENGTH, allowHTML: false });
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
    mlString.validate(normalized, { maxLength: PAGE_CHECK_NOTES_MAX_LENGTH, allowHTML: false });
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

const requireRevSummary = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  const normalized = sanitizeLocalizedMapInput(value);
  if (!normalized) {
    if (errors) {
      errors.addMissing('revSummary');
      return;
    }
    throw new ValidationError('revSummary is required for updates.', [
      { field: 'revSummary', message: 'is required.', code: 'required' },
    ]);
  }
  validateRevSummary(value, errors);
  const entries = Object.entries(normalized);
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

  // Common scalar fields that must stay strings in CSL JSON.
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

const stringifyCitationData = (value: Record<string, unknown> | null | undefined): string =>
  value ? JSON.stringify(value, null, 2) : '';

export interface WikiPageListResult {
  hint: string;
  pages: Array<{ slug: string; name: string }>;
}

export async function listWikiPageResources(
  _dalInstance: DataAccessLayer
): Promise<WikiPageListResult> {
  const pages = await WikiPage.filterWhere({
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>)
    .orderBy('slug')
    .run();

  return {
    hint: 'Use wiki_readPage tool with slug to read a page.',
    pages: pages.map(page => {
      const resolved = mlString.resolve('en', page.title ?? null);
      return {
        slug: page.slug,
        name: resolved?.str || page.slug || 'Untitled page',
      };
    }),
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
  if (body) {
    for (const [lang, text] of Object.entries(body)) {
      if (!text) continue;
      await validateMarkdownContent(text, `body.${lang}`, errors, [validateCitationClaimRefs]);
    }
  }
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
  const normalizedTitle = sanitizeLocalizedMapInput(title);
  const normalizedBody = sanitizeLocalizedMapInput(body);
  if (normalizedTitle !== undefined) page.title = normalizedTitle;
  if (normalizedBody !== undefined) page.body = normalizedBody;
  if (originalLanguage !== undefined) page.originalLanguage = originalLanguage;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) page._revSummary = normalizedRevSummary;
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
  if (body) {
    for (const [lang, text] of Object.entries(body)) {
      if (!text) continue;
      await validateMarkdownContent(text, `body.${lang}`, errors, [validateCitationClaimRefs]);
    }
  }
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
  const mergedTitle = mergeLocalizedMap(page.title ?? null, title);
  const mergedBody = mergeLocalizedMap(page.body ?? null, body);
  if (mergedTitle !== undefined) page.title = mergedTitle;
  if (mergedBody !== undefined) page.body = mergedBody;
  if (originalLanguage !== undefined) page.originalLanguage = originalLanguage;
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) page._revSummary = normalizedRevSummary;
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
  ensureNoControlCharacters({ [lang]: patched }, 'body');
  await validateMarkdownContent(patched, `body.${lang}`, errors, [validateCitationClaimRefs]);
  errors.throwIfAny();

  await page.newRevision({ id: userId }, { tags: ['update', 'patch', ...tags] });

  page.body = {
    ...currentBody,
    [lang]: patched,
  };
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) page._revSummary = normalizedRevSummary;
  page.updatedAt = new Date();

  await page.save();

  return toWikiPageResult(page);
}

export async function rewriteWikiPageSection(
  _dalInstance: DataAccessLayer,
  {
    slug,
    target = 'heading',
    heading,
    headingLevel,
    occurrence,
    mode = 'replace',
    content,
    lang = 'en',
    expectedRevId,
    tags = [],
    revSummary,
  }: WikiPageRewriteSectionInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid wiki section rewrite input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  if (target !== 'heading' && target !== 'lead') {
    errors.add('target', 'must be "heading" or "lead".', 'invalid');
  }
  if (target === 'heading') {
    ensureNonEmptyString(heading, 'heading', errors);
  } else {
    ensureOptionalString(heading, 'heading', errors);
    if (heading !== undefined) {
      errors.add('heading', 'must be omitted when target is "lead".', 'invalid');
    }
    if (headingLevel !== undefined) {
      errors.add('headingLevel', 'must be omitted when target is "lead".', 'invalid');
    }
    if (occurrence !== undefined) {
      errors.add('occurrence', 'must be omitted when target is "lead".', 'invalid');
    }
  }
  ensureString(content, 'content', errors);
  ensureOptionalLanguage(lang, 'lang', errors);
  ensureOptionalString(expectedRevId, 'expectedRevId', errors);
  if (headingLevel !== undefined) {
    if (!Number.isInteger(headingLevel) || headingLevel < 1 || headingLevel > 6) {
      errors.add('headingLevel', 'must be an integer between 1 and 6.', 'invalid');
    }
  }
  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      errors.add('occurrence', 'must be an integer greater than or equal to 1.', 'invalid');
    }
  }
  if (mode !== 'replace' && mode !== 'prepend' && mode !== 'append') {
    errors.add('mode', 'must be "replace", "prepend", or "append".', 'invalid');
  }
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  if (expectedRevId && expectedRevId !== page._revID) {
    throw new PreconditionFailedError(
      `Revision mismatch: current is ${page._revID ?? 'unknown'}, expected was ${expectedRevId}.`,
      { currentRevId: page._revID ?? null, expectedRevId }
    );
  }

  const currentBody = page.body ?? {};
  const currentText = mlString.resolve(lang, currentBody)?.str ?? '';
  const sections = listHeadingSections(currentText);
  let selected: HeadingSection;
  if (target === 'lead') {
    const totalLines = currentText.split('\n').length;
    const firstHeadingLine = sections[0]?.line ?? totalLines;
    selected = {
      level: 0,
      text: '',
      line: 0,
      contentStartLine: 0,
      contentEndLine: firstHeadingLine,
    };
  } else {
    const allHeadingDetails = buildHeadingDetails(sections);
    let matches = sections.filter(section => section.text === heading);

    if (headingLevel !== undefined) {
      matches = matches.filter(section => section.level === headingLevel);
    }

    if (matches.length === 0) {
      throw new NotFoundError(`Section heading not found: ${heading}`, {
        slug: normalizedSlug,
        heading,
        availableHeadings: allHeadingDetails,
      });
    }

    if (matches.length > 1 && occurrence === undefined) {
      throw new ConflictError(`Section heading is not unique: ${heading}`, {
        slug: normalizedSlug,
        heading,
        matches: buildHeadingDetails(matches),
      });
    }

    selected = matches[0];
    if (occurrence !== undefined) {
      const index = occurrence - 1;
      if (!matches[index]) {
        throw new NotFoundError(`Section heading occurrence not found: ${heading}`, {
          slug: normalizedSlug,
          heading,
          occurrence,
          matches: buildHeadingDetails(matches),
        });
      }
      selected = matches[index];
    }
  }

  const updatedText = rewriteSectionBody(currentText, selected, mode, content);
  if (updatedText === currentText) {
    throw new PreconditionFailedError('Rewrite did not change content.', {
      slug: normalizedSlug,
      heading,
    });
  }
  ensureNoControlCharacters({ [lang]: updatedText }, 'body');
  await validateMarkdownContent(updatedText, `body.${lang}`, errors, [validateCitationClaimRefs]);
  errors.throwIfAny();

  await page.newRevision({ id: userId }, { tags: ['update', 'rewrite-section', ...tags] });

  page.body = {
    ...currentBody,
    [lang]: updatedText,
  };
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) page._revSummary = normalizedRevSummary;
  page.updatedAt = new Date();

  await page.save();

  return toWikiPageResult(page);
}

export async function replaceWikiPageExactText(
  _dalInstance: DataAccessLayer,
  {
    slug,
    replacements,
    lang = 'en',
    expectedRevId,
    tags = [],
    revSummary,
  }: WikiPageReplaceExactTextInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid wiki exact replacement input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  if (!Array.isArray(replacements) || replacements.length === 0) {
    errors.add('replacements', 'must be a non-empty array.', 'invalid');
  } else {
    replacements.forEach((replacement, index) => {
      if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
        errors.add(`replacements.${index}`, 'must be an object with from and to strings.', 'type');
        return;
      }
      const { from, to } = replacement;
      ensureNonEmptyString(from, `replacements.${index}.from`, errors);
      ensureString(to, `replacements.${index}.to`, errors);
    });
  }
  ensureOptionalLanguage(lang, 'lang', errors);
  ensureOptionalString(expectedRevId, 'expectedRevId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  if (expectedRevId && expectedRevId !== page._revID) {
    throw new PreconditionFailedError(
      `Revision mismatch: current is ${page._revID ?? 'unknown'}, expected was ${expectedRevId}.`,
      { currentRevId: page._revID ?? null, expectedRevId }
    );
  }

  const currentBody = page.body ?? {};
  const currentText = mlString.resolve(lang, currentBody)?.str ?? '';
  const updatedText = applyExactReplacements(currentText, replacements);

  if (updatedText === currentText) {
    throw new PreconditionFailedError('Replace exact text did not change content.', {
      slug: normalizedSlug,
    });
  }
  ensureNoControlCharacters({ [lang]: updatedText }, 'body');
  await validateMarkdownContent(updatedText, `body.${lang}`, errors, [validateCitationClaimRefs]);
  errors.throwIfAny();

  await page.newRevision({ id: userId }, { tags: ['update', 'replace-exact', ...tags] });

  page.body = {
    ...currentBody,
    [lang]: updatedText,
  };
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary !== undefined) page._revSummary = normalizedRevSummary;
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
  _dalInstance: DataAccessLayer,
  slug: string
): Promise<WikiPageRevisionListResult> {
  const normalizedSlug = normalizeSlugInput(slug, 'slug');
  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const revisionRows = await WikiPage.filterWhere({})
    .getAllRevisions(page.id)
    .orderBy('_revDate', 'DESC')
    .run();

  const revisions = revisionRows.map(row => toWikiPageRevisionResult(row));

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
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields: buildDiffFields([
      { key: 'title', from: fromTitle, to: toTitle },
      { key: 'body', from: fromBody, to: toBody },
    ]),
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

  const fromResults = mlString.resolve(lang, fromRev.checkResults ?? null)?.str ?? '';
  const toResults = mlString.resolve(lang, toRev.checkResults ?? null)?.str ?? '';
  const fromNotes = mlString.resolve(lang, fromRev.notes ?? null)?.str ?? '';
  const toNotes = mlString.resolve(lang, toRev.notes ?? null)?.str ?? '';

  return {
    checkId: check.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    language: lang,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields: buildDiffFields([
      { key: 'type', from: fromRev.type ?? '', to: toRev.type ?? '' },
      { key: 'status', from: fromRev.status ?? '', to: toRev.status ?? '' },
      { key: 'checkResults', from: fromResults, to: toResults },
      { key: 'notes', from: fromNotes, to: toNotes },
      {
        key: 'metrics',
        from: stringifyJsonValue(fromRev.metrics ?? null),
        to: stringifyJsonValue(toRev.metrics ?? null),
      },
      { key: 'targetRevId', from: fromRev.targetRevId ?? '', to: toRev.targetRevId ?? '' },
      {
        key: 'completedAt',
        from: fromRev.completedAt?.toISOString() ?? '',
        to: toRev.completedAt?.toISOString() ?? '',
      },
    ]),
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
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields: buildDiffFields([
      { key: 'key', from: fromKey, to: toKey },
      { key: 'data', from: fromData, to: toData },
    ]),
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

  const fromAssertion = mlString.resolve(lang, fromRev.assertion ?? null)?.str ?? '';
  const toAssertion = mlString.resolve(lang, toRev.assertion ?? null)?.str ?? '';
  const fromQuote = mlString.resolve(lang, fromRev.quote ?? null)?.str ?? '';
  const toQuote = mlString.resolve(lang, toRev.quote ?? null)?.str ?? '';
  const fromLocatorValue = mlString.resolve(lang, fromRev.locatorValue ?? null)?.str ?? '';
  const toLocatorValue = mlString.resolve(lang, toRev.locatorValue ?? null)?.str ?? '';
  const fromLocatorLabel = mlString.resolve(lang, fromRev.locatorLabel ?? null)?.str ?? '';
  const toLocatorLabel = mlString.resolve(lang, toRev.locatorLabel ?? null)?.str ?? '';

  return {
    citationId: citation.id,
    claimId: claim.claimId,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    language: lang,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields: buildDiffFields([
      { key: 'claimId', from: fromRev.claimId ?? '', to: toRev.claimId ?? '' },
      { key: 'assertion', from: fromAssertion, to: toAssertion },
      { key: 'quote', from: fromQuote, to: toQuote },
      { key: 'quoteLanguage', from: fromRev.quoteLanguage ?? '', to: toRev.quoteLanguage ?? '' },
      { key: 'locatorType', from: fromRev.locatorType ?? '', to: toRev.locatorType ?? '' },
      { key: 'locatorValue', from: fromLocatorValue, to: toLocatorValue },
      { key: 'locatorLabel', from: fromLocatorLabel, to: toLocatorLabel },
    ]),
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

  await claim.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });

  return {
    id: claim.id,
    key,
    claimId: claim.claimId,
    deleted: true,
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

  await check.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });

  return {
    id: check.id,
    deleted: true,
  };
}
