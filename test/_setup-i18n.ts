// Sync i18next bootstrap for unit tests. Loads the English resource
// file from disk so test code that goes through the markdown renderer
// (or any other i18next.t caller) gets real translations instead of
// raw keys.
//
// Idempotent: safe to import from multiple test files.
import fs from 'node:fs';
import path from 'node:path';

import i18next from 'i18next';
import JSON5 from 'json5';

if (!i18next.isInitialized) {
  const enPath = path.resolve(process.cwd(), 'locales/ui/en.json5');
  const enResources = JSON5.parse(fs.readFileSync(enPath, 'utf8')) as Record<string, unknown>;
  i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: enResources } },
    interpolation: { escapeValue: false },
  });
}
