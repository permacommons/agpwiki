import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import {
  countSharedWords,
  isArticleSlug,
  mainTitleWords,
  normalizeAddressForMatch,
  normalizeTitleForMatch,
  sharesMainWords,
} from '../lib/duplicate-match.js';
import { PossibleDuplicateError, ValidationCollector } from '../lib/errors.js';
import type { LocalizedMapInput } from '../lib/localized.js';
import { toAddressForm } from '../lib/slug.js';
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

export interface RelatedArticle {
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
  related: RelatedArticle[];
}

export interface NewArticleCheckInput {
  slug: string;
  title?: LocalizedMapInput;
  originalLanguage?: string | null;
  wikidata?: string | null;
  notDuplicateOf?: string[];
}

export interface NewArticleCheckResult {
  related: RelatedArticle[];
  // Revision tags recording the pages the creator checked and set aside.
  tags: string[];
}

type ArticleRow = {
  slug: string;
  title: Record<string, string> | null;
  original_language: string | null;
  wikidata: string | null;
};

type AliasRow = { slug: string; page_slug: string };

const CURRENT_ARTICLE = `_old_rev_of IS NULL AND _rev_deleted = false
  AND slug NOT LIKE 'meta/%' AND slug NOT LIKE 'tool/%'`;

const titleValues = (title: Record<string, string> | null) =>
  Object.values(title ?? {}).filter((value): value is string => typeof value === 'string');

const titleLanguages = (title: Record<string, string> | null) =>
  Object.entries(title ?? {})
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([lang]) => lang);

/**
 * Existing articles that may be the same topic as a new one, and articles
 * that overlap with it. Titles and addresses are compared in code because
 * PostgreSQL cannot set accents aside without an extra extension.
 */
export async function findPossibleDuplicates(
  dalInstance: DataAccessLayer,
  { titles, slug, wikidata }: DuplicateCheckInput
): Promise<DuplicateCheckResult> {
  const newSlug = slug ? toAddressForm(slug) : null;
  if (newSlug && !isArticleSlug(newSlug)) return { duplicates: [], related: [] };

  const titleKeys = new Set(titles.map(normalizeTitleForMatch).filter(Boolean));
  const addressKey = newSlug ? normalizeAddressForMatch(newSlug) : '';

  const [articleResult, aliasResult] = await Promise.all([
    dalInstance.query(
      `SELECT slug, title, original_language, properties->>'wikidata' AS wikidata
         FROM pages WHERE ${CURRENT_ARTICLE}`
    ),
    dalInstance.query(
      `SELECT a.slug, p.slug AS page_slug
         FROM page_aliases a JOIN pages p ON p.id = a.page_id
        WHERE p._old_rev_of IS NULL AND p._rev_deleted = false
          AND p.slug NOT LIKE 'meta/%' AND p.slug NOT LIKE 'tool/%'`
    ),
  ]);
  const articles = articleResult.rows as ArticleRow[];
  const aliases = aliasResult.rows as AliasRow[];

  const matches = new Map<string, Set<DuplicateMatch>>();
  const addMatch = (pageSlug: string, match: DuplicateMatch) => {
    const set = matches.get(pageSlug) ?? new Set<DuplicateMatch>();
    set.add(match);
    matches.set(pageSlug, set);
  };

  for (const article of articles) {
    if (wikidata && article.wikidata === wikidata) addMatch(article.slug, 'wikidata');
    if (titleValues(article.title).some(value => titleKeys.has(normalizeTitleForMatch(value)))) {
      addMatch(article.slug, 'title');
    }
    if (addressKey && normalizeAddressForMatch(article.slug) === addressKey) {
      addMatch(article.slug, 'address');
    }
  }
  for (const alias of aliases) {
    if (titleKeys.has(normalizeTitleForMatch(alias.slug))) addMatch(alias.page_slug, 'alias');
    if (addressKey && normalizeAddressForMatch(alias.slug) === addressKey) {
      addMatch(alias.page_slug, 'address');
    }
  }

  const duplicates: PossibleDuplicate[] = articles
    .filter(article => matches.has(article.slug))
    .map(article => ({
      slug: article.slug,
      title: article.title,
      languages: titleLanguages(article.title),
      wikidata: article.wikidata,
      matchedBy: [...(matches.get(article.slug) ?? [])],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const newWords = new Set(titles.flatMap(title => [...mainTitleWords(title)]));
  const related = articles
    .filter(article => !matches.has(article.slug) && article.slug !== newSlug)
    .map(article => {
      let score = 0;
      for (const value of titleValues(article.title)) {
        const words = mainTitleWords(value);
        if (sharesMainWords(newWords, words)) score = Math.max(score, countSharedWords(newWords, words));
      }
      return { article, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.article.slug.localeCompare(b.article.slug))
    .slice(0, RELATED_LIMIT)
    .map(({ article }) => ({
      slug: article.slug,
      title: article.title,
      languages: titleLanguages(article.title),
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
  const target = duplicates.length === 1 ? 'that article' : 'one of those articles';
  const missingLanguage =
    newLanguage && duplicates.every(duplicate => !duplicate.languages.includes(newLanguage));
  const advice = missingLanguage
    ? `Add a ${languageName(newLanguage)} translation to ${target}`
    : `Improve ${target}`;
  const slugs = JSON.stringify(duplicates.map(duplicate => duplicate.slug));
  return `Not created: "${newTitle}" may already exist as ${list}. ${advice}, or create this one again with notDuplicateOf: ${slugs} if it is a different topic.`;
};

/**
 * Refuses a new article that may already exist, unless every possible
 * duplicate is named in notDuplicateOf. Pages outside articles pass.
 */
export async function checkNewArticle(
  dalInstance: DataAccessLayer,
  { slug, title, originalLanguage, wikidata, notDuplicateOf = [] }: NewArticleCheckInput
): Promise<NewArticleCheckResult> {
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
  const blocking = duplicates.filter(duplicate => !checkedSet.has(duplicate.slug));
  if (blocking.length) {
    const newLanguage = originalLanguage ?? Object.keys(titleMap)[0] ?? null;
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
