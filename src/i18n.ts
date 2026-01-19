import path from 'node:path';
import HandlebarsI18n from 'handlebars-i18n';
import hbs from 'hbs';
import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import * as i18nextMiddleware from 'i18next-http-middleware';
import JSON5 from 'json5';
import { getLanguageOptions } from '../locales/cldr.js';
import { SUPPORTED_LOCALES } from '../locales/languages.js';

export async function initializeI18n(): Promise<void> {
  await i18next
    .use(Backend)
    .use(i18nextMiddleware.LanguageDetector)
    .init({
      fallbackLng: 'en',
      supportedLngs: [...SUPPORTED_LOCALES],
      preload: [...SUPPORTED_LOCALES],
      backend: {
        loadPath: path.resolve(process.cwd(), 'locales/ui/{{lng}}.json5'),
        parse: JSON5.parse,
      },
      detection: {
        order: ['cookie', 'header'],
        lookupCookie: 'locale',
        caches: ['cookie'],
        cookieExpirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
      interpolation: {
        escapeValue: false,
      },
    });

  HandlebarsI18n.init(hbs.handlebars, i18next);

  // Override the __ helper to read locale from template context
  hbs.handlebars.registerHelper('__', function (this: { locale?: string }, key: string) {
    const locale = this.locale ?? 'en';
    return i18next.t(key, { lng: locale });
  });
}

const middleware = i18nextMiddleware;
export { i18next, middleware, getLanguageOptions };
