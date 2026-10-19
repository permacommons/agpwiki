import type { FieldDiff, LocalizedDiff, ScalarDiff, StructuredDiff, TextDiff } from './diff-engine.js';
import { ALL_LANGUAGES } from './language-selection.js';

type CompactTextDiff = Omit<TextDiff, 'from' | 'to'> & Partial<Pick<TextDiff, 'from' | 'to'>>;

type CompactLanguageEntry = { lang: string; characters: number; value?: string };

export type CompactLocalizedDiff = {
  kind: 'localized';
  added: CompactLanguageEntry[];
  removed: CompactLanguageEntry[];
  modified: Record<string, CompactTextDiff>;
};

export type CompactFieldDiff =
  | ScalarDiff
  | StructuredDiff
  | { kind: 'text'; diff: CompactTextDiff }
  | CompactLocalizedDiff;

const keepLanguage = (lang: string, language: string | null) =>
  language === ALL_LANGUAGES || lang === language;

const compactLocalized = (
  diff: LocalizedDiff,
  language: string | null,
  includeFullText: boolean
): CompactLocalizedDiff | null => {
  const entry = ({ lang, value }: { lang: string; value: string }): CompactLanguageEntry =>
    includeFullText ? { lang, characters: value.length, value } : { lang, characters: value.length };
  const added = diff.added.filter(item => keepLanguage(item.lang, language)).map(entry);
  const removed = diff.removed.filter(item => keepLanguage(item.lang, language)).map(entry);
  const modified: Record<string, CompactTextDiff> = {};
  for (const [lang, textDiff] of Object.entries(diff.modified)) {
    if (!keepLanguage(lang, language)) continue;
    modified[lang] = includeFullText
      ? textDiff
      : { unifiedDiff: textDiff.unifiedDiff, stats: textDiff.stats };
  }
  if (!added.length && !removed.length && Object.keys(modified).length === 0) return null;
  return { kind: 'localized', added, removed, modified };
};

/**
 * Narrow a revision diff to one language (or all, with "*") and, unless
 * full text is requested, drop the complete before/after texts so only the
 * unified diff and its statistics remain.
 */
export const compactFieldDiffs = (
  fields: Record<string, FieldDiff>,
  language: string | null,
  includeFullText = false
): Record<string, CompactFieldDiff> => {
  const result: Record<string, CompactFieldDiff> = {};
  for (const [name, diff] of Object.entries(fields)) {
    if (diff.kind === 'localized') {
      const compact = compactLocalized(diff, language, includeFullText);
      if (compact) result[name] = compact;
      continue;
    }
    if (diff.kind === 'text' && !includeFullText) {
      result[name] = {
        kind: 'text',
        diff: { unifiedDiff: diff.diff.unifiedDiff, stats: diff.diff.stats },
      };
      continue;
    }
    result[name] = diff;
  }
  return result;
};
