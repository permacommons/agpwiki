import { NotFoundError } from './errors.js';

export const ALL_LANGUAGES = '*';

type LocalizedMap = Record<string, string | null | undefined> | null | undefined;

const presentLanguages = (map: LocalizedMap) =>
  map
    ? Object.entries(map)
        .filter(([, value]) => typeof value === 'string')
        .map(([lang]) => lang)
    : [];

/**
 * Languages a page has text in, in a stable order. Body languages count;
 * title languages are used only when the page has no body at all.
 */
export const listAvailableLanguages = (title: LocalizedMap, body: LocalizedMap): string[] => {
  const fromBody = presentLanguages(body);
  return [...new Set(fromBody.length ? fromBody : presentLanguages(title))].sort();
};

/**
 * Pick the language a read returns. An explicit request must exist (no
 * silent fallback); otherwise the canonical language when it has a body,
 * then English, then the first available language.
 */
export const selectContentLanguage = ({
  requested,
  canonicalLanguage,
  availableLanguages,
  slug,
}: {
  requested?: string | null;
  canonicalLanguage?: string | null;
  availableLanguages: string[];
  slug?: string;
}): string | null => {
  if (requested === ALL_LANGUAGES) return ALL_LANGUAGES;
  if (requested) {
    if (!availableLanguages.includes(requested)) {
      throw new NotFoundError(
        `Language not available: ${requested}. Available languages: ${
          availableLanguages.join(', ') || 'none'
        }.`,
        { slug, requestedLanguage: requested, availableLanguages }
      );
    }
    return requested;
  }
  if (canonicalLanguage && availableLanguages.includes(canonicalLanguage)) return canonicalLanguage;
  if (availableLanguages.includes('en')) return 'en';
  return availableLanguages[0] ?? null;
};

export const filterLocalizedMap = <T extends LocalizedMap>(map: T, language: string | null): T => {
  if (!map || language === ALL_LANGUAGES) return map;
  if (language === null) return {} as T;
  return (language in map ? { [language]: map[language] } : {}) as T;
};

interface LocalizedContent {
  title?: LocalizedMap;
  body?: LocalizedMap;
  canonicalLanguage?: string | null;
}

/**
 * Narrow a page or revision payload to one language, keeping the shape of
 * its title and body maps and reporting what was selected.
 */
export const selectPayloadLanguage = <T extends LocalizedContent>(
  payload: T,
  requested?: string | null,
  slug?: string
): T & { selectedLanguage: string | null; availableLanguages: string[] } => {
  const availableLanguages = listAvailableLanguages(payload.title, payload.body);
  const selectedLanguage = selectContentLanguage({
    requested,
    canonicalLanguage: payload.canonicalLanguage,
    availableLanguages,
    slug,
  });
  return {
    ...payload,
    title: filterLocalizedMap(payload.title, selectedLanguage),
    body: filterLocalizedMap(payload.body, selectedLanguage),
    selectedLanguage,
    availableLanguages,
  };
};
