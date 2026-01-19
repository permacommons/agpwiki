declare module 'cldr' {
  export function extractLanguageDisplayNames(locale: string): Record<string, string>;
}
