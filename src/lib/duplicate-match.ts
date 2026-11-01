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
  normalizeTitleForMatch(slug).split(' ').filter(Boolean).map(foldPlural).join('');

/**
 * The words that carry a title's topic, for spotting related articles.
 */
export const mainTitleWords = (title: string) =>
  new Set(
    normalizeTitleForMatch(title)
      .split(' ')
      .filter(word => word.length >= 3 && !MINOR_WORDS.has(word))
      .map(foldPlural)
  );

export const countSharedWords = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
};

/**
 * Related when the other title holds all of the new title's main words, or
 * at least two of them when there are more.
 */
export const sharesMainWords = (newWords: Set<string>, otherWords: Set<string>) =>
  newWords.size > 0 && countSharedWords(newWords, otherWords) >= Math.min(2, newWords.size);

// Pages outside articles (policies, proposals, tools) are never checked.
export const isArticleSlug = (slug: string) => !slug.startsWith('meta/') && !slug.startsWith('tool/');
