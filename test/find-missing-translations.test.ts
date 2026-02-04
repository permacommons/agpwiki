import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findLocaleIssues } from '../src/scripts/find-missing-translations.js';

function writeLocale(baseDir: string, filename: string, content: string) {
  fs.writeFileSync(path.join(baseDir, filename), content, 'utf-8');
}

test('findLocaleIssues reports missing and non-allowlisted identical values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agpwiki-locale-test-'));
  try {
    writeLocale(
      dir,
      'en.json5',
      `{
  /*
   i18n-identical-allowlist:
   {
     "fr": ["site.name"]
   }
  */
  "site": { "name": "Agpedia" },
  "nav": { "home": "Home", "blog": "Blog" }
}
`
    );

    writeLocale(
      dir,
      'fr.json5',
      `{
  "site": { "name": "Agpedia" },
  "nav": { "home": "Accueil" }
}
`
    );

    const issues = findLocaleIssues(dir);
    assert.deepEqual(issues, [{ locale: 'fr', key: 'nav.blog', issue: 'missing' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLocaleIssues merges multiple allowlist blocks in en.json5 comments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agpwiki-locale-test-'));
  try {
    writeLocale(
      dir,
      'en.json5',
      `{
  /*
   i18n-identical-allowlist:
   {
     "mk": ["site.name"]
   }
  */
  /*
   i18n-identical-allowlist:
   {
     "mk": ["nav.home"]
   }
  */
  "site": { "name": "Agpedia" },
  "nav": { "home": "Home" }
}
`
    );

    writeLocale(
      dir,
      'mk.json5',
      `{
  "site": { "name": "Agpedia" },
  "nav": { "home": "Home" }
}
`
    );

    const issues = findLocaleIssues(dir);
    assert.deepEqual(issues, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLocaleIssues reports extra locale keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agpwiki-locale-test-'));
  try {
    writeLocale(
      dir,
      'en.json5',
      `{
  "site": { "name": "Agpedia" },
  "nav": { "home": "Home" }
}
`
    );

    writeLocale(
      dir,
      'es.json5',
      `{
  "site": { "name": "Agpedia" },
  "nav": { "home": "Inicio", "extra": "Extra" }
}
`
    );

    const issues = findLocaleIssues(dir);
    assert.deepEqual(issues, [
      { locale: 'es', key: 'nav.extra', issue: 'extra_in_locale' },
      { locale: 'es', key: 'site.name', issue: 'identical_to_en' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
