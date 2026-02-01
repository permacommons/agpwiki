import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from 'diff';
import MarkdownIt from 'markdown-it';
import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
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
  value: Record<string, string> | null | undefined,
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

const validateTitle = (
  value: Record<string, string> | null | undefined,
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  try {
    mlString.validate(value, { maxLength: 200, allowHTML: false });
    ensureNoControlCharacters(value, 'title', errors);
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
    ensureNoControlCharacters(value, 'body', errors);
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
    ensureNoControlCharacters(value, 'revSummary', errors);
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
  ensureNoControlCharacters({ [lang]: patched }, 'body');

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

  await page.newRevision({ id: userId }, { tags: ['update', 'rewrite-section', ...tags] });

  page.body = {
    ...currentBody,
    [lang]: updatedText,
  };
  if (revSummary !== undefined) page._revSummary = revSummary;
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

  await page.newRevision({ id: userId }, { tags: ['update', 'replace-exact', ...tags] });

  page.body = {
    ...currentBody,
    [lang]: updatedText,
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
