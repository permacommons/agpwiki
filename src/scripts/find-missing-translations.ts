import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const localesDir = path.resolve(process.cwd(), 'locales/ui');
const identicalAllowlistBlockRegex =
  /\/\*\s*i18n-identical-allowlist\s*:\s*([\s\S]*?)\*\//g;

export type LocaleIssueType = 'missing' | 'identical_to_en' | 'extra_in_locale';

export type LocaleIssue = {
  locale: string;
  key: string;
  issue: LocaleIssueType;
};

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const subKeys = flattenKeys(value as Record<string, unknown>, newKey);
      for (const subKey of subKeys) {
        keys.add(subKey);
      }
    } else {
      keys.add(newKey);
    }
  }
  return keys;
}

function flattenValues(
  obj: Record<string, unknown>,
  prefix = '',
  values = new Map<string, unknown>()
): Map<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenValues(value as Record<string, unknown>, newKey, values);
      continue;
    }
    values.set(newKey, value);
  }

  return values;
}

function parseIdenticalAllowlist(enContent: string): Map<string, Set<string>> {
  const allowlist = new Map<string, Set<string>>();

  const matches = enContent.matchAll(identicalAllowlistBlockRegex);
  for (const match of matches) {
    const rawObject = match[1]?.trim();
    if (!rawObject) {
      continue;
    }

    const parsed = JSON5.parse(rawObject);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'Invalid i18n-identical-allowlist block in locales/ui/en.json5. Expected an object.'
      );
    }

    for (const [locale, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) {
        throw new Error(
          `Invalid i18n-identical-allowlist entry for "${locale}" in locales/ui/en.json5. Expected an array of key strings.`
        );
      }

      const localeAllowlist = allowlist.get(locale) ?? new Set<string>();
      for (const key of keys) {
        localeAllowlist.add(key);
      }
      allowlist.set(locale, localeAllowlist);
    }
  }

  return allowlist;
}

function valuesMatch(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  return JSON5.stringify(left) === JSON5.stringify(right);
}

function isAllowlisted(
  allowlist: Map<string, Set<string>>,
  locale: string,
  key: string
): boolean {
  return allowlist.get(locale)?.has(key) ?? false;
}

export function findLocaleIssues(localesDirectory: string): LocaleIssue[] {
  const enPath = path.join(localesDirectory, 'en.json5');
  if (!fs.existsSync(enPath)) {
    console.error('Error: locales/ui/en.json5 not found.');
    process.exit(1);
  }

  const enContent = fs.readFileSync(enPath, 'utf-8');
  const enObj = JSON5.parse(enContent);
  const allowlist = parseIdenticalAllowlist(enContent);
  const canonicalKeys = flattenKeys(enObj);
  const canonicalValues = flattenValues(enObj);

  const issues: LocaleIssue[] = [];
  const files = fs
    .readdirSync(localesDirectory)
    .filter(file => file.endsWith('.json5') && file !== 'en.json5');

  for (const file of files) {
    const langCode = path.basename(file, '.json5');
    const filePath = path.join(localesDirectory, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    try {
      const obj = JSON5.parse(content);
      const existingKeys = flattenKeys(obj);
      const existingValues = flattenValues(obj);

      for (const key of canonicalKeys) {
        if (!existingKeys.has(key)) {
          issues.push({ locale: langCode, key, issue: 'missing' });
          continue;
        }

        const enValue = canonicalValues.get(key);
        const localeValue = existingValues.get(key);
        if (
          valuesMatch(localeValue, enValue) &&
          !isAllowlisted(allowlist, langCode, key)
        ) {
          issues.push({ locale: langCode, key, issue: 'identical_to_en' });
        }
      }

      for (const key of existingKeys) {
        if (!canonicalKeys.has(key)) {
          issues.push({ locale: langCode, key, issue: 'extra_in_locale' });
        }
      }
    } catch (error) {
      console.error(`Error parsing ${file}:`, error);
    }
  }

  return issues.sort((a, b) => {
    if (a.locale !== b.locale) {
      return a.locale.localeCompare(b.locale);
    }
    if (a.key !== b.key) {
      return a.key.localeCompare(b.key);
    }
    return a.issue.localeCompare(b.issue);
  });
}

function main() {
  const issues = findLocaleIssues(localesDir);
  for (const issue of issues) {
    console.log(`${issue.locale},${issue.key},${issue.issue}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
