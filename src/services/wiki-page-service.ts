import MarkdownIt from 'markdown-it';
import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { validateCitationClaimRefs } from '../lib/citation-claim-validation.js';
import {
  validateLocalizedMarkdownContent,
  validateMarkdownContent,
} from '../lib/content-validation.js';
import type { FieldDiff } from '../lib/diff-engine.js';
import { diffLocalizedField, diffScalarField } from '../lib/diff-engine.js';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PreconditionFailedError,
  ValidationCollector,
} from '../lib/errors.js';
import { type LocalizedMapInput, mergeLocalizedMap, sanitizeLocalizedMapInput } from '../lib/localized.js';
import { applyUnifiedPatch, type PatchFormat } from '../lib/patch.js';
import { isBlockedSlug } from '../lib/slug.js';
import type { PageAliasInstance } from '../models/manifests/page-alias.js';
import type { WikiPageInstance } from '../models/manifests/wiki-page.js';
import PageAlias from '../models/page-alias.js';
import WikiPage from '../models/wiki-page.js';
import { assertCanDeleteWikiPage } from './authorization.js';
import { applyDeletionRevisionSummary } from './revision-summary.js';
import {
  ensureNoControlCharacters,
  ensureNonEmptyString,
  ensureOptionalLanguage,
  ensureOptionalString,
  ensureString,
  normalizeOptionalSlug,
  normalizeSlugInput,
  requireRevSummary,
  toRevisionMeta,
  validateBody,
  validateRevSummary,
  validateTitle,
} from './validation.js';

const { mlString } = dal;

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
  fields: Record<string, FieldDiff>;
}

export type WikiPageFieldDiff = FieldDiff;

export interface WikiPageListResult {
  hint: string;
  pages: Array<{ slug: string; name: string }>;
}

export interface WikiPageSearchInput {
  query: string;
  limit?: number;
}

export interface WikiPageSearchItem {
  slug: string;
  title: string;
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

export const findCurrentPageBySlugOrAlias = async (slug: string) => {
  const direct = await findCurrentPageBySlug(slug);
  if (direct) return direct;

  const alias = await PageAlias.filterWhere({ slug }).first();
  if (!alias) return null;

  return findCurrentPageById(alias.pageId);
};

export const fetchPageRevisionByRevId = async (
  _dalInstance: DataAccessLayer,
  pageId: string,
  revId: string
): Promise<WikiPageInstance | null> => {
  return WikiPage.filterWhere({}).getRevisionByRevId(revId, pageId).first();
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

export async function searchWikiPages(
  dalInstance: DataAccessLayer,
  { query, limit }: WikiPageSearchInput
): Promise<WikiPageSearchItem[]> {
  ensureNonEmptyString(query, 'query');
  const normalizedLimit = Math.min(Math.max(limit ?? 20, 1), 100);
  // Search is intentionally simple and locale-stable for web + API callers.
  const result = await dalInstance.query(
    `SELECT slug, title->>'en' as title
     FROM ${WikiPage.tableName}
     WHERE _old_rev_of IS NULL AND _rev_deleted = false
       AND (slug ILIKE $1 OR (title->>'en') ILIKE $1)
     ORDER BY slug
     LIMIT $2`,
    [`%${query}%`, normalizedLimit]
  );

  return result.rows.map((row: { slug: string; title: string | null }) => ({
    slug: row.slug,
    title: row.title ?? row.slug,
  }));
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
  await validateLocalizedMarkdownContent(body, 'body', errors, [validateCitationClaimRefs]);
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
  await validateLocalizedMarkdownContent(body, 'body', errors, [validateCitationClaimRefs]);
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

  const fields: Record<string, FieldDiff> = {};
  const titleDiff = diffLocalizedField('title', fromRev.title ?? null, toRev.title ?? null);
  if (titleDiff) fields.title = titleDiff;
  const bodyDiff = diffLocalizedField('body', fromRev.body ?? null, toRev.body ?? null);
  if (bodyDiff) fields.body = bodyDiff;
  const slugDiff = diffScalarField('slug', fromRev.slug ?? null, toRev.slug ?? null);
  if (slugDiff) fields.slug = slugDiff;
  const originalLangDiff = diffScalarField(
    'originalLanguage',
    fromRev.originalLanguage ?? null,
    toRev.originalLanguage ?? null
  );
  if (originalLangDiff) fields.originalLanguage = originalLangDiff;

  return {
    pageId: page.id,
    fromRevId: fromRev._revID,
    toRevId: toRev._revID,
    language: lang,
    from: toRevisionMeta(fromRev),
    to: toRevisionMeta(toRev),
    fields,
  };
}

export async function deleteWikiPage(
  dalInstance: DataAccessLayer,
  { slug, revSummary }: WikiPageDeleteInput,
  userId: string
): Promise<WikiPageDeleteResult> {
  const errors = new ValidationCollector('Invalid wiki page delete input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();
  await assertCanDeleteWikiPage(dalInstance, userId);

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, {
      slug: normalizedSlug,
    });
  }

  const deletionRevision = await page.deleteAllRevisions({ id: userId }, { tags: ['admin-delete'] });
  await applyDeletionRevisionSummary(deletionRevision, revSummary);

  return {
    id: page.id,
    slug: page.slug,
    deleted: true,
  };
}
