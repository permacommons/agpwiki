import { type SafeText, toSafeText } from '../render.js';

type ResolveFn = (
  lang: string | string[],
  value: Record<string, string> | null | undefined
) => { str: string } | undefined;

/**
 * Resolve a multilingual safe-text field into SafeText with a fallback.
 * SafeText allows HTML entities or special characters, but no tags.
 */
export const resolveSafeText = (
  resolve: ResolveFn,
  lang: string | string[],
  value: Record<string, string> | null | undefined,
  fallback: string = ''
): SafeText | string => {
  const resolved = resolve(lang, value ?? null);
  return resolved?.str ? toSafeText(resolved.str) : fallback;
};

/**
 * Resolve a multilingual safe-text field into SafeText, always returning SafeText.
 */
export const resolveSafeTextRequired = (
  resolve: ResolveFn,
  lang: string | string[],
  value: Record<string, string> | null | undefined,
  fallback: string = ''
): SafeText => {
  const resolved = resolve(lang, value ?? null);
  return resolved?.str ? toSafeText(resolved.str) : toSafeText(fallback);
};

/**
 * Resolve a multilingual safe-text field into SafeText if present.
 */
export const resolveOptionalSafeText = (
  resolve: ResolveFn,
  lang: string | string[],
  value: Record<string, string> | null | undefined
): SafeText | undefined => {
  const resolved = resolve(lang, value ?? null);
  return resolved?.str ? toSafeText(resolved.str) : undefined;
};

/**
 * Resolve multilingual safe-text preferring a locale with a fallback chain.
 */
export const resolveSafeTextWithFallback = (
  resolve: ResolveFn,
  preferredLang: string,
  value: Record<string, string> | null | undefined,
  fallback: string = ''
): SafeText | string => resolveSafeText(resolve, [preferredLang, 'en'], value, fallback);
