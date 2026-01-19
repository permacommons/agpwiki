import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import type { LocaleCode } from './languages.js';

const optionsPath = path.resolve(process.cwd(), 'locales/language-options.json5');

const precomputedData = JSON5.parse(fs.readFileSync(optionsPath, 'utf-8'));

export interface LanguageOption {
  code: LocaleCode;
  label: string;
}

const languageOptionsCache = precomputedData as unknown as Record<LocaleCode, LanguageOption[]>;

export function getLanguageOptions(uiLocale: LocaleCode): LanguageOption[] {
  return languageOptionsCache[uiLocale] || [];
}