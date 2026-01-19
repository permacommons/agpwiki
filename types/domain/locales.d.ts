declare global {
  namespace AgpWiki {
    type LocaleCode =
      | 'en'
      | 'ar'
      | 'bn'
      | 'de'
      | 'eo'
      | 'es'
      | 'fi'
      | 'fr'
          | 'hi'
          | 'hu'
          | 'id'
          | 'it'
          | 'ja'
          | 'ko'
          | 'lt'
          | 'mk'
          | 'nl'
          | 'pl'
          | 'pt'
          | 'pt-PT'
          | 'ru'
          | 'sk'
          | 'sl'
          | 'sv'
          | 'tr'
          | 'uk'
          | 'ur'
          | 'zh'      | 'zh-Hant';

    type LocaleCodeWithUndetermined = LocaleCode | 'und';
  }
}

export type LocaleCode = AgpWiki.LocaleCode;
export type LocaleCodeWithUndetermined = AgpWiki.LocaleCodeWithUndetermined;

export declare const SUPPORTED_LOCALES: readonly LocaleCode[];
