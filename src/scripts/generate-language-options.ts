import fs from 'node:fs';
import path from 'node:path';
import cldr from 'cldr';
import JSON5 from 'json5';
import { type LocaleCode, SUPPORTED_LOCALES } from '../../locales/languages.js';

const OUTPUT_PATH = path.resolve(process.cwd(), 'locales/language-options.json5');

const nativeNameCache = new Map<string, string>();

const CLDR_KEY_MAP: Record<string, string> = {
  zh: 'zh_hans',
  'zh-Hant': 'zh_hant',
  pt: 'pt_br',
  'pt-PT': 'pt_pt',
};

function getLookupKeyCandidates(code: string): string[] {
  const candidates: string[] = [];
  if (CLDR_KEY_MAP[code]) candidates.push(CLDR_KEY_MAP[code]);
  candidates.push(code.toLowerCase().replace('-', '_'));
  candidates.push(code);
  return candidates;
}

function getDisplay(names: Record<string, string>, code: string): string | undefined {
  for (const key of getLookupKeyCandidates(code)) {
    if (names[key]) return names[key];
  }
  return undefined;
}

interface LanguageOption {
  code: string;
  label: string;
}

function getNativeName(code: string): string {
  const cached = nativeNameCache.get(code);
  if (cached !== undefined) return cached;

  let names = cldr.extractLanguageDisplayNames(code);
  if (!names || Object.keys(names).length === 0) {
    names = cldr.extractLanguageDisplayNames(code.toLowerCase().replace('-', '_'));
  }

  const name = getDisplay(names, code) ?? code;
  nativeNameCache.set(code, name);
  return name;
}

function getLanguageOptions(uiLocale: LocaleCode): LanguageOption[] {
  let namesInUI = cldr.extractLanguageDisplayNames(uiLocale);
  if (!namesInUI || Object.keys(namesInUI).length === 0) {
    namesInUI = cldr.extractLanguageDisplayNames(uiLocale.toLowerCase().replace('-', '_'));
  }

  return SUPPORTED_LOCALES.map((code) => {
    const inUI = getDisplay(namesInUI, code) ?? code;
    const native = getNativeName(code);
    const label = inUI === native ? `${code} - ${inUI}` : `${code} - ${inUI} (${native})`;
    return { code, label };
  });
}

async function main() {
  console.log('Generating language options...');
  const data: Record<string, LanguageOption[]> = {};

  for (const locale of SUPPORTED_LOCALES) {
    data[locale] = getLanguageOptions(locale);
  }

  console.log(`Writing to ${OUTPUT_PATH}`);
  const header = `/**
 * THIS FILE IS GENERATED AUTOMATICALLY.
 * DO NOT EDIT MANUALLY.
 *
 * To regenerate, run: npm run generate-locales
 */
`;
  // Using JSON5.stringify gives us unquoted keys where possible and clean output
  fs.writeFileSync(OUTPUT_PATH, header + JSON5.stringify(data, null, 2));
  console.log('Done.');
}

main().catch(console.error);