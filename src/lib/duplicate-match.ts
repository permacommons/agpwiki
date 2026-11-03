import { DEFAULT_PAGE_NAMESPACE, type PageAddress, resolvePageAddress } from './page-address.js';

// Short words that say nothing about a topic. Words under three letters
// ("in", "of", "de", "la") are dropped by length, so only longer ones are here.
const MINOR_WORDS = new Set([
  'and',
  'the',
  'for',
  'from',
  'with',
  'les',
  'des',
  'une',
  'dans',
  'pour',
  'avec',
  'der',
  'die',
  'das',
  'und',
  'von',
  'del',
  'los',
  'las',
  'por',
  'para',
  'con',
  'della',
  'delle',
  'degli',
  'dos',
]);

/**
 * Lowercase, without accents, with every run of punctuation or spaces
 * turned into a single space: "Gutenberg-Bibel" and "gutenberg bibel" match.
 */
export const normalizeTitleForMatch = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// A simple plural fold: "wars" and "war" compare equal, "glass" stays.
const foldPlural = (word: string) =>
  word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

/**
 * An address with hyphens and plurals set aside: "world-wars" and
 * "worldwar" give the same key.
 */
export const normalizeAddressForMatch = (slug: string) =>
  slug.split('/').map(segment =>
    normalizeTitleForMatch(segment).split(' ').filter(Boolean).map(foldPlural).join('')
  ).join('/');

/**
 * The words that carry a title's topic, for spotting related articles.
 */
const mainWordsFromKey = (titleKey: string) =>
  new Set(
    titleKey.split(' ')
      .filter(word => word.length >= 3 && !MINOR_WORDS.has(word))
      .map(foldPlural)
  );

export const mainTitleWords = (title: string) => mainWordsFromKey(normalizeTitleForMatch(title));

export const countSharedWords = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
};

/**
 * Related when the other title holds all of the new title's main words, or
 * at least two of them when there are more.
 */
const relatedTitleScore = (newWords: Set<string>, otherWords: Set<string>) => {
  const shared = countSharedWords(newWords, otherWords);
  return newWords.size > 0 && shared >= Math.min(2, newWords.size) ? shared : 0;
};

export const sharesMainWords = (newWords: Set<string>, otherWords: Set<string>) =>
  relatedTitleScore(newWords, otherWords) > 0;

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

export interface DuplicateCheckResult {
  duplicates: PossibleDuplicate[];
  related: RelatedPage[];
}

export type DuplicateCandidate = {
  slug: string;
  title: Record<string, string> | null;
  wikidata: string | null;
};

export type DuplicateAlias = {
  slug: string;
  pageSlug: string;
};

interface ProposedPage {
  titles: readonly string[];
  address: PageAddress | null;
  wikidata?: string | null;
}

const RELATED_LIMIT = 10;

export const matchPossibleDuplicates = (
  { titles, address, wikidata }: ProposedPage,
  pages: readonly DuplicateCandidate[],
  aliases: readonly DuplicateAlias[]
): DuplicateCheckResult => {
  const namespace = address?.namespace ?? DEFAULT_PAGE_NAMESPACE.name;
  const titleKeys = new Set(titles.map(normalizeTitleForMatch).filter(Boolean));
  const proposedTitleWords = [...titleKeys].map(mainWordsFromKey);
  const addressKey = address ? normalizeAddressForMatch(address.localName) : '';
  const candidates = pages.flatMap(page => {
    const pageAddress = resolvePageAddress(page.slug);
    if (!pageAddress) return [];
    const entries = Object.entries(page.title ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const keys = entries.map(([, value]) => normalizeTitleForMatch(value));
    return [{
      page,
      address: pageAddress,
      addressKey: normalizeAddressForMatch(pageAddress.localName),
      titleKeys: keys,
      titleWords: keys.map(mainWordsFromKey),
      languages: entries.filter(([, value]) => value.trim()).map(([language]) => language),
    }];
  });
  const matches = new Map<string, Set<DuplicateMatch>>();
  const addMatch = (slug: string, reason: DuplicateMatch) => {
    const reasons = matches.get(slug) ?? new Set<DuplicateMatch>();
    reasons.add(reason);
    matches.set(slug, reasons);
  };
  for (const candidate of candidates) {
    if (candidate.address.namespace !== namespace) continue;
    if (wikidata && candidate.page.wikidata === wikidata) addMatch(candidate.page.slug, 'wikidata');
    if (candidate.titleKeys.some(key => titleKeys.has(key))) addMatch(candidate.page.slug, 'title');
    if (addressKey && candidate.addressKey === addressKey) addMatch(candidate.page.slug, 'address');
  }
  for (const alias of aliases) {
    const aliasAddress = resolvePageAddress(alias.slug);
    if (aliasAddress?.namespace !== namespace) continue;
    if (titleKeys.has(normalizeTitleForMatch(aliasAddress.localName))) addMatch(alias.pageSlug, 'alias');
    if (addressKey && normalizeAddressForMatch(aliasAddress.localName) === addressKey) {
      addMatch(alias.pageSlug, 'address');
    }
  }
  const duplicates = candidates.filter(({ page }) => matches.has(page.slug))
    .map(({ page, languages }) => ({
      slug: page.slug,
      title: page.title,
      wikidata: page.wikidata,
      languages,
      matchedBy: [...(matches.get(page.slug) ?? [])],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const related = candidates.filter(candidate => candidate.address.namespace === namespace
    && !matches.has(candidate.page.slug) && candidate.page.slug !== address?.slug)
    .map(candidate => {
      let score = 0;
      for (const words of candidate.titleWords) {
        for (const newWords of proposedTitleWords) {
          score = Math.max(score, relatedTitleScore(newWords, words));
        }
      }
      return { candidate, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.page.slug.localeCompare(b.candidate.page.slug))
    .slice(0, RELATED_LIMIT)
    .map(({ candidate: { page, languages } }) => ({ slug: page.slug, title: page.title, languages }));
  return { duplicates, related };
};
