import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import {
  countSharedWords,
  mainTitleWords,
  normalizeAddressForMatch,
  normalizeTitleForMatch,
  sharesMainWords,
} from '../lib/duplicate-match.js';
import { InvalidRequestError, PossibleDuplicateError, ValidationCollector } from '../lib/errors.js';
import type { LocalizedMapInput } from '../lib/localized.js';
import { pageNamespaceSql, resolvePageAddress } from '../lib/page-address.js';
import { isBlockedSlug, toAddressForm } from '../lib/slug.js';
import { normalizeSlugInput } from './validation.js';

export const NOT_DUPLICATE_TAG_PREFIX = 'not-duplicate-of:';

const RELATED_LIMIT = 10;

export type DuplicateMatch = 'wikidata' | 'title' | 'alias' | 'address';

export interface PossibleDuplicate {
  slug: string;
  title: Record<string, string> | null;
  languages: string[];
  wikidata: string | null;
  matchedBy: DuplicateMatch[];
}

export interface RelatedPage {
  slug: string;
  title: Record<string, string> | null;
  languages: string[];
}

export interface DuplicateCheckInput {
  titles: string[];
  slug?: string | null;
  wikidata?: string | null;
}

export interface DuplicateCheckResult {
  duplicates: PossibleDuplicate[];
  related: RelatedPage[];
}

export interface NewPageCheckInput {
  slug: string;
  title?: LocalizedMapInput;
  canonicalLanguage?: string | null;
  wikidata?: string | null;
  notDuplicateOf?: string[];
}

export interface NewPageCheckResult {
  related: RelatedPage[];
  // Revision tags recording the pages the creator checked and set aside.
  tags: string[];
}

type PageRow = {
  slug: string;
  title: Record<string, string> | null;
  canonical_language: string | null;
  wikidata: string | null;
};

type AliasRow = { slug: string; page_slug: string };

const CURRENT_PAGE = '_old_rev_of IS NULL AND _rev_deleted = false';

const titleValues = (title: Record<string, string> | null) =>
  Object.values(title ?? {}).filter((value): value is string => typeof value === 'string');

const titleLanguages = (title: Record<string, string> | null) =>
  Object.entries(title ?? {})
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([lang]) => lang);

/**
 * Existing pages that may be the same topic as a new one, and pages
 * that overlap with it. Titles and addresses are compared in code because
 * PostgreSQL cannot set accents aside without an extra extension.
 */
export async function findPossibleDuplicates(
  dalInstance: DataAccessLayer,
  { titles, slug, wikidata }: DuplicateCheckInput
): Promise<DuplicateCheckResult> {
  const normalizedSlug = slug == null ? null : toAddressForm(normalizeSlugInput(slug, 'slug'));
  if (normalizedSlug && isBlockedSlug(normalizedSlug)) {
    throw new InvalidRequestError(`Wiki page slug is reserved: ${normalizedSlug}`, { slug: normalizedSlug });
  }
  const address = resolvePageAddress(normalizedSlug ?? '');
  const namespace = address?.namespace ?? 'article';
  const newSlug = address?.slug ?? null;

  const titleKeys = new Set(titles.map(normalizeTitleForMatch).filter(Boolean));
  const addressKey = newSlug ? normalizeAddressForMatch(address?.localName ?? newSlug) : '';

  const [pageResult, aliasResult] = await Promise.all([
    dalInstance.query(
      `SELECT slug, title, canonical_language, properties->>'wikidata' AS wikidata
         FROM pages WHERE ${CURRENT_PAGE}
          AND ${pageNamespaceSql()} IS NOT NULL
          AND (${pageNamespaceSql()} = $1 OR id IN (
            SELECT page_id FROM page_aliases WHERE ${pageNamespaceSql()} = $1
          ))`,
      [namespace]
    ),
    dalInstance.query(
      `SELECT a.slug, p.slug AS page_slug
         FROM page_aliases a JOIN pages p ON p.id = a.page_id
        WHERE p._old_rev_of IS NULL AND p._rev_deleted = false
          AND ${pageNamespaceSql('p.slug')} IS NOT NULL
          AND ${pageNamespaceSql('a.slug')} = $1`,
      [namespace]
    ),
  ]);
  const pages = pageResult.rows as PageRow[];
  const aliases = aliasResult.rows as AliasRow[];

  const matches = new Map<string, Set<DuplicateMatch>>();
  const addMatch = (pageSlug: string, match: DuplicateMatch) => {
    const set = matches.get(pageSlug) ?? new Set<DuplicateMatch>();
    set.add(match);
    matches.set(pageSlug, set);
  };

  for (const page of pages) {
    const otherAddress = resolvePageAddress(page.slug);
    if (otherAddress?.namespace !== namespace) continue;
    if (wikidata && page.wikidata === wikidata) addMatch(page.slug, 'wikidata');
    if (titleValues(page.title).some(value => titleKeys.has(normalizeTitleForMatch(value)))) {
      addMatch(page.slug, 'title');
    }
    if (addressKey && normalizeAddressForMatch(otherAddress.localName) === addressKey) {
      addMatch(page.slug, 'address');
    }
  }
  for (const alias of aliases) {
    const aliasName = resolvePageAddress(alias.slug)?.localName ?? alias.slug;
    if (titleKeys.has(normalizeTitleForMatch(aliasName))) addMatch(alias.page_slug, 'alias');
    if (addressKey && normalizeAddressForMatch(aliasName) === addressKey) {
      addMatch(alias.page_slug, 'address');
    }
  }

  const duplicates: PossibleDuplicate[] = pages
    .filter(page => matches.has(page.slug))
    .map(page => ({
      slug: page.slug,
      title: page.title,
      languages: titleLanguages(page.title),
      wikidata: page.wikidata,
      matchedBy: [...(matches.get(page.slug) ?? [])],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const proposedTitleWords = titles.map(mainTitleWords);
  const related = pages
    .filter(page => resolvePageAddress(page.slug)?.namespace === namespace
      && !matches.has(page.slug) && page.slug !== newSlug)
    .map(page => {
      let score = 0;
      for (const value of titleValues(page.title)) {
        const words = mainTitleWords(value);
        for (const newWords of proposedTitleWords) {
          if (sharesMainWords(newWords, words)) score = Math.max(score, countSharedWords(newWords, words));
        }
      }
      return { page, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug))
    .slice(0, RELATED_LIMIT)
    .map(({ page }) => ({
      slug: page.slug,
      title: page.title,
      languages: titleLanguages(page.title),
    }));

  return { duplicates, related };
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const languageName = (code: string) => {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
};

const displayTitle = (title: Record<string, string> | null, preferred: string | null, fallback: string) =>
  (preferred && title?.[preferred]) || title?.en || titleValues(title)[0] || fallback;

const describeMatch = (duplicate: PossibleDuplicate) =>
  duplicate.matchedBy.map(match => {
    switch (match) {
      case 'wikidata':
        return `same Wikidata item ${duplicate.wikidata}`;
      case 'title':
        return 'same title';
      case 'alias':
        return 'title matches one of its addresses';
      default:
        return 'similar address';
    }
  });

const describeDuplicates = (
  newTitle: string,
  newLanguage: string | null,
  duplicates: PossibleDuplicate[]
) => {
  const list = duplicates
    .map(duplicate => {
      const parts = [
        `/${duplicate.slug}`,
        duplicate.languages.map(languageName).join(', ') || null,
        ...describeMatch(duplicate),
      ].filter(Boolean);
      return `${displayTitle(duplicate.title, newLanguage, duplicate.slug)} (${parts.join(', ')})`;
    })
    .join('; ');
  const target = duplicates.length === 1 ? 'that page' : 'one of those pages';
  const missingLanguage =
    newLanguage && duplicates.every(duplicate => !duplicate.languages.includes(newLanguage));
  const advice = missingLanguage
    ? `Add a translation in ${languageName(newLanguage)} to ${target}`
    : `Improve ${target}`;
  const slugs = JSON.stringify(duplicates.map(duplicate => duplicate.slug));
  return `Not created: "${newTitle}" may already exist as ${list}. ${advice}, or create this one again with notDuplicateOf: ${slugs} if it is a different topic.`;
};

/**
 * Refuses a new page that may already exist, unless every possible
 * duplicate in its namespace is named in notDuplicateOf.
 */
export async function checkNewPage(
  dalInstance: DataAccessLayer,
  { slug, title, canonicalLanguage, wikidata, notDuplicateOf = [] }: NewPageCheckInput
): Promise<NewPageCheckResult> {
  const errors = new ValidationCollector('Invalid wiki page input.');
  const checked = notDuplicateOf.map((value, index) =>
    toAddressForm(normalizeSlugInput(value, `notDuplicateOf.${index}`, errors))
  );
  errors.throwIfAny();

  const titleMap = Object.fromEntries(
    Object.entries(title ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''
    )
  );
  const { duplicates, related } = await findPossibleDuplicates(dalInstance, {
    titles: Object.values(titleMap),
    slug,
    wikidata: wikidata ?? null,
  });

  const checkedSet = new Set(checked);
  const blocking = duplicates.filter(duplicate => !checkedSet.has(toAddressForm(duplicate.slug)));
  if (blocking.length) {
    const newLanguage = canonicalLanguage ?? Object.keys(titleMap)[0] ?? null;
    const newTitle = displayTitle(titleMap, newLanguage, toAddressForm(slug));
    throw new PossibleDuplicateError(describeDuplicates(newTitle, newLanguage, blocking), {
      duplicates: blocking,
      related,
    });
  }

  return {
    related,
    tags: [...checkedSet].map(checkedSlug => `${NOT_DUPLICATE_TAG_PREFIX}${checkedSlug}`),
  };
}
