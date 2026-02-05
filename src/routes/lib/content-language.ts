import languages from '../../../locales/languages.js';
import { escapeHtml, type LanguageOption } from '../../render.js';

type QueryParams = Record<string, string>;

type ContentLanguageArgs = {
  uiLocale: string;
  override?: string;
  availableLangs: string[];
};

export const extractQueryParams = (query: Record<string, unknown>): QueryParams => {
  const params: QueryParams = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.length > 0) {
      params[key] = value;
    }
  }
  return params;
};

export const getAvailableLanguages = (
  ...values: Array<Record<string, string> | null | undefined>
): string[] => {
  const available = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const [lang, text] of Object.entries(value)) {
      if (!languages.isValid(lang)) continue;
      if (typeof text === 'string' && text.trim().length > 0) {
        available.add(lang);
      }
    }
  }
  return languages.getValidLanguages().filter(lang => available.has(lang));
};

export const normalizeOverrideLang = (override?: string): string | undefined => {
  if (typeof override !== 'string') return undefined;
  return languages.isValid(override) ? override : undefined;
};

export const resolveContentLanguage = ({
  uiLocale,
  override,
  availableLangs,
}: ContentLanguageArgs): string => {
  const has = (lang: string) => availableLangs.includes(lang);
  const normalizedOverride = normalizeOverrideLang(override);

  if (normalizedOverride && has(normalizedOverride)) {
    return normalizedOverride;
  }

  if (!normalizedOverride) {
    if (uiLocale !== 'en' && has(uiLocale)) {
      return uiLocale;
    }
    if (uiLocale === 'en' && !has('en') && availableLangs.length > 0) {
      return availableLangs[0];
    }
  }

  if (has('en')) return 'en';
  if (availableLangs.length > 0) return availableLangs[0];
  return 'en';
};

const buildContentLangHref = (
  path: string,
  queryParams: QueryParams,
  lang: string
): string => {
  const params = new URLSearchParams(queryParams);
  params.set('lang', lang);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};

export const renderContentLanguageRow = ({
  label,
  currentLang,
  availableLangs,
  languageOptions,
  path,
  queryParams,
}: {
  label: string;
  currentLang: string;
  availableLangs: string[];
  languageOptions: LanguageOption[];
  path: string;
  queryParams: QueryParams;
}): string => {
  if (!availableLangs.length) return '';

  const labels = new Map(languageOptions.map(option => [option.code, option.label]));
  const params = { ...queryParams };
  delete params.lang;

  const chips = availableLangs
    .map(lang => {
      const chipLabel = labels.get(lang) ?? lang;
      const href = buildContentLangHref(path, params, lang);
      const isActive = lang === currentLang;
      const className = `content-language-chip${isActive ? ' content-language-chip--active' : ''}`;
      return `<a class="${className}" href="${escapeHtml(href)}" title="${escapeHtml(
        chipLabel
      )}" aria-current="${isActive ? 'true' : 'false'}">${escapeHtml(chipLabel)}</a>`;
    })
    .join('\n');

  return `<div class="content-language-row">
  <span class="content-language-label">${escapeHtml(label)}</span>
  <div class="content-language-chips">${chips}</div>
</div>`;
};
