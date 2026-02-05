import { z } from 'zod';

type LocalizedMap = Record<string, string | null>;
type LocalizedMapOptional = LocalizedMap | null | undefined;
type LanguageTag = string;
type OptionalLanguageTag = LanguageTag | undefined;
type OptionalNullableLanguageTag = LanguageTag | null | undefined;

type LocalizedMapSchemaGroup = {
  required: z.ZodType<LocalizedMap>;
  optional: z.ZodType<LocalizedMapOptional>;
};

type LanguageTagSchemaGroup = {
  required: z.ZodType<LanguageTag>;
  optional: z.ZodType<OptionalLanguageTag>;
  optionalNullable: z.ZodType<OptionalNullableLanguageTag>;
};

export const createLocalizedSchemas = () => {
  const languageTagDescription =
    'Supported locale code (see agpwiki://locales). Qualifiers only for "pt-PT" and "zh-Hant".';
  const localizedMapDescription = (label: string) =>
    `Localized ${label} map keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"..."}. Set a language key to null to remove it.`;
  const localizedMapError = (label: string) =>
    `Expected ${label} to be a language-keyed map (e.g., {"en":"..."}). See agpwiki://locales.`;

  const invalidTypeKey = '__agpwiki_invalid_type__';
  const invalidLanguageSentinel = '__agpwiki_invalid_language_tag__';

  const makeLanguageTagSchema = (): LanguageTagSchemaGroup => {
    const base = z.preprocess(
      value => {
        if (value === null || value === undefined) return value;
        if (typeof value !== 'string') {
          return `${invalidLanguageSentinel}${typeof value}`;
        }
        return value;
      },
      z.string().superRefine((value, ctx) => {
        if (value.startsWith(invalidLanguageSentinel)) {
          ctx.addIssue({ code: 'custom', message: languageTagDescription });
        }
      })
    ) as z.ZodType<LanguageTag>;

    return {
      required: base.describe(languageTagDescription),
      optional: base.optional().describe(languageTagDescription),
      optionalNullable: base.nullable().optional().describe(languageTagDescription),
    };
  };

  const makeLocalizedMapSchemas = (label: string): LocalizedMapSchemaGroup => {
    const description = localizedMapDescription(label);
    const base = z.preprocess(
      value => {
        if (value === null || value === undefined) return value;
        if (typeof value !== 'object' || Array.isArray(value)) {
          return { [invalidTypeKey]: String(value) };
        }
        return value;
      },
      z.record(z.string(), z.union([z.string(), z.null()])).superRefine((value, ctx) => {
        if (Object.hasOwn(value, invalidTypeKey)) {
          ctx.addIssue({ code: 'custom', message: localizedMapError(label) });
        }
      })
    ) as z.ZodType<LocalizedMap>;

    return {
      required: base.describe(description),
      optional: base.nullable().optional().describe(description),
    };
  };

  return {
    localizedTitleSchema: makeLocalizedMapSchemas('title'),
    localizedBodySchema: makeLocalizedMapSchemas('body'),
    localizedSummarySchema: makeLocalizedMapSchemas('summary'),
    localizedAssertionSchema: makeLocalizedMapSchemas('assertion'),
    localizedQuoteSchema: makeLocalizedMapSchemas('quote'),
    localizedLocatorValueSchema: makeLocalizedMapSchemas('locator value'),
    localizedLocatorLabelSchema: makeLocalizedMapSchemas('locator label'),
    localizedCheckResultsSchema: makeLocalizedMapSchemas('check results'),
    localizedNotesSchema: makeLocalizedMapSchemas('notes'),
    localizedRevisionSummarySchema: makeLocalizedMapSchemas('revision summary'),
    languageTagSchema: makeLanguageTagSchema(),
  };
};
