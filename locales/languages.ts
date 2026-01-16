const SUPPORTED_LOCALES = [
  'en',
  'ar',
  'bn',
  'de',
  'eo',
  'es',
  'fi',
  'fr',
  'hi',
  'hu',
  'it',
  'ja',
  'lt',
  'mk',
  'nl',
  'pt',
  'pt-PT',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'zh',
  'zh-Hant',
] as const satisfies ReadonlyArray<AgpWiki.LocaleCode>;

type LocaleCode = AgpWiki.LocaleCode;

type LocaleCodeWithUndetermined = AgpWiki.LocaleCodeWithUndetermined;

const DEFAULT_FALLBACKS = ['en', 'und', ...SUPPORTED_LOCALES].filter(
  (value, index, self) => self.indexOf(value) === index
) as LocaleCodeWithUndetermined[];

const buildFallbackMap = ({
  minimalFallback = false,
}: {
  minimalFallback?: boolean;
} = {}): Record<string, LocaleCodeWithUndetermined[]> => {
  const scriptByLang: Partial<Record<string, string | null>> = {};
  const baseByLang: Partial<Record<string, string>> = {};

  const getBase = (code: string): string => {
    const cachedBase = baseByLang[code];
    if (cachedBase !== undefined) return cachedBase;
    try {
      baseByLang[code] = new Intl.Locale(code).language || code.toLowerCase();
    } catch {
      baseByLang[code] = code.toLowerCase();
    }
    return baseByLang[code] ?? code.toLowerCase();
  };

  const getScript = (code: string): string | null => {
    if (Object.hasOwn(scriptByLang, code)) {
      return scriptByLang[code] ?? null;
    }
    try {
      scriptByLang[code] = new Intl.Locale(code).maximize().script || null;
    } catch {
      scriptByLang[code] = null;
    }
    return scriptByLang[code] ?? null;
  };

  const supported = [...SUPPORTED_LOCALES];

  const result: Record<string, LocaleCodeWithUndetermined[]> = {};

  for (const lang of supported) {
    const fallbacks: LocaleCodeWithUndetermined[] = [];
    const seen = new Set<string>();
    const append = (code?: string | null) => {
      if (!code) return;
      if (seen.has(code)) return;
      seen.add(code);
      fallbacks.push(code as LocaleCodeWithUndetermined);
    };

    append(lang);
    append('und');

    const base = getBase(lang);
    for (const candidate of supported) {
      if (candidate === lang) continue;
      if (getBase(candidate) === base) append(candidate);
    }

    append('en');

    if (!minimalFallback) {
      const script = getScript(lang);
      if (script) {
        for (const candidate of supported) {
          if (seen.has(candidate)) continue;
          if (getScript(candidate) === script) append(candidate);
        }
      }

      for (const candidate of supported) append(candidate);
    }

    result[lang] = fallbacks;
  }

  return result;
};

const FALLBACKS_BY_LANG = buildFallbackMap();
const SEARCH_FALLBACKS_BY_LANG = buildFallbackMap({ minimalFallback: true });

const languages = {
  getValidLanguages(): LocaleCode[] {
    return [...SUPPORTED_LOCALES];
  },

  getValidLanguagesAndUndetermined(): LocaleCodeWithUndetermined[] {
    return ['und', ...SUPPORTED_LOCALES];
  },

  isValid(langKey: string): langKey is LocaleCode {
    return SUPPORTED_LOCALES.includes(langKey as LocaleCode) && langKey !== 'und';
  },

  getFallbacks(langKey: string): LocaleCodeWithUndetermined[] {
    const cached = FALLBACKS_BY_LANG[langKey];
    if (cached) return [...cached];
    return [...DEFAULT_FALLBACKS];
  },

  getSearchFallbacks(langKey: string): LocaleCodeWithUndetermined[] {
    const cached = SEARCH_FALLBACKS_BY_LANG[langKey];
    if (cached) return [...cached];
    return [...DEFAULT_FALLBACKS];
  },
};

export { SUPPORTED_LOCALES };
export type { LocaleCode, LocaleCodeWithUndetermined };
export default languages;
