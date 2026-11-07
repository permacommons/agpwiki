import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import {
  type DuplicateAlias,
  type DuplicateCandidate,
  type DuplicateCheckResult,
  matchPossibleDuplicates,
  type PossibleDuplicate,
  type RelatedPage,
} from '../lib/duplicate-match.js';

import { InvalidRequestError, PossibleDuplicateError, ValidationCollector } from '../lib/errors.js';
import type { LocalizedMapInput } from '../lib/localized.js';
import { DEFAULT_PAGE_NAMESPACE, duplicateScope, pageNamespaceSql, resolvePageAddress } from '../lib/page-address.js';
import { isBlockedSlug, toAddressForm } from '../lib/slug.js';
import { normalizeSlugInput } from './validation.js';

export type { DuplicateCheckResult, DuplicateMatch, PossibleDuplicate, RelatedPage } from '../lib/duplicate-match.js';

export const NOT_DUPLICATE_TAG_PREFIX = 'not-duplicate-of:';

export interface DuplicateCheckInput {
  titles: string[];
  slug?: string | null;
  wikidata?: string | null;
  // A page that is not its own duplicate, such as a draft being published.
  excludeSlug?: string | null;
}

export interface NewPageCheckInput {
  slug: string;
  title?: LocalizedMapInput;
  canonicalLanguage?: string | null;
  wikidata?: string | null;
  notDuplicateOf?: string[];
  excludeSlug?: string | null;
}

export interface NewPageCheckResult {
  related: RelatedPage[];
  // Revision tags recording the pages the creator checked and set aside.
  tags: string[];
}

const CURRENT_PAGE = '_old_rev_of IS NULL AND _rev_deleted = false';

const titleValues = (title: Record<string, string> | null) =>
  Object.values(title ?? {}).filter((value): value is string => typeof value === 'string');

// Matching runs in code so accent folding needs no PostgreSQL extension.
export async function findPossibleDuplicates(
  dalInstance: DataAccessLayer,
  { titles, slug, wikidata, excludeSlug }: DuplicateCheckInput
): Promise<DuplicateCheckResult> {
  const normalizedSlug = slug == null ? null : toAddressForm(normalizeSlugInput(slug, 'slug'));
  if (normalizedSlug && isBlockedSlug(normalizedSlug)) {
    throw new InvalidRequestError(`Wiki page slug is reserved: ${normalizedSlug}`, { slug: normalizedSlug });
  }
  const address = resolvePageAddress(normalizedSlug ?? '');
  const namespaces = duplicateScope(address?.namespace ?? DEFAULT_PAGE_NAMESPACE.name);
  const excluded = excludeSlug ?? '';
  const [pageResult, aliasResult] = await Promise.all([
    dalInstance.query(
      `SELECT slug, title, properties->>'wikidata' AS wikidata
         FROM pages WHERE ${CURRENT_PAGE}
          AND slug <> $2
          AND ${pageNamespaceSql()} IS NOT NULL
          AND (${pageNamespaceSql()} = ANY($1::text[]) OR id IN (
            SELECT page_id FROM page_aliases WHERE ${pageNamespaceSql()} = ANY($1::text[])
          ))`,
      [namespaces, excluded]
    ),
    dalInstance.query(
      `SELECT a.slug, p.slug AS "pageSlug"
         FROM page_aliases a JOIN pages p ON p.id = a.page_id
        WHERE p._old_rev_of IS NULL AND p._rev_deleted = false
          AND p.slug <> $2
          AND ${pageNamespaceSql('p.slug')} IS NOT NULL
          AND ${pageNamespaceSql('a.slug')} = ANY($1::text[])`,
      [namespaces, excluded]
    ),
  ]);
  return matchPossibleDuplicates({ titles, address, wikidata },
    pageResult.rows as DuplicateCandidate[], aliasResult.rows as DuplicateAlias[]);
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
  { slug, title, canonicalLanguage, wikidata, notDuplicateOf = [], excludeSlug }: NewPageCheckInput
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
    excludeSlug,
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
