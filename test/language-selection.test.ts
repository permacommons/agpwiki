import assert from 'node:assert/strict';
import test from 'node:test';

import { compactFieldDiffs } from '../src/lib/diff-compact.js';
import { diffLocalizedField } from '../src/lib/diff-engine.js';
import { NotFoundError } from '../src/lib/errors.js';
import {
  listAvailableLanguages,
  selectContentLanguage,
  selectPayloadLanguage,
} from '../src/lib/language-selection.js';

test('listAvailableLanguages uses body languages in a stable order, else title languages', () => {
  assert.deepEqual(listAvailableLanguages({ en: 'T' }, { fr: 'b', de: 'a', en: 'c' }), ['de', 'en', 'fr']);
  assert.deepEqual(listAvailableLanguages({ fr: 'T', en: 'T' }, null), ['en', 'fr']);
  assert.deepEqual(listAvailableLanguages(null, null), []);
});

test('selectContentLanguage prefers the original language, then English, then the first one', () => {
  const availableLanguages = ['de', 'en', 'fr'];
  assert.equal(selectContentLanguage({ originalLanguage: 'fr', availableLanguages }), 'fr');
  assert.equal(selectContentLanguage({ originalLanguage: 'it', availableLanguages }), 'en');
  assert.equal(selectContentLanguage({ availableLanguages: ['fr', 'de'].sort() }), 'de');
  assert.equal(selectContentLanguage({ availableLanguages: [] }), null);
  assert.equal(selectContentLanguage({ requested: '*', availableLanguages }), '*');
  assert.equal(selectContentLanguage({ requested: 'de', originalLanguage: 'fr', availableLanguages }), 'de');
});

test('selectContentLanguage rejects a missing language and lists the available ones', () => {
  assert.throws(
    () => selectContentLanguage({ requested: 'ja', availableLanguages: ['de', 'en'] }),
    (error: unknown) =>
      error instanceof NotFoundError &&
      /Available languages: de, en/.test(error.message)
  );
});

test('selectPayloadLanguage keeps the map shape and reports the selection', () => {
  const page = {
    title: { en: 'Title', fr: 'Titre' },
    body: { en: 'Body', fr: 'Corps' },
    originalLanguage: 'fr',
    contentHash: 'abc',
  };
  const selected = selectPayloadLanguage(page);
  assert.deepEqual(selected.title, { fr: 'Titre' });
  assert.deepEqual(selected.body, { fr: 'Corps' });
  assert.equal(selected.selectedLanguage, 'fr');
  assert.deepEqual(selected.availableLanguages, ['en', 'fr']);
  assert.equal(selected.contentHash, 'abc');

  const all = selectPayloadLanguage(page, '*');
  assert.deepEqual(all.body, page.body);
  assert.equal(all.selectedLanguage, '*');
});

test('compactFieldDiffs keeps one language and drops full texts unless asked', () => {
  const fields = {
    body: diffLocalizedField(
      'body',
      { en: 'Old line.\n', de: 'Alte Zeile.\n' },
      { en: 'New line.\n', de: 'Neue Zeile.\n', fr: 'Nouvelle ligne.\n' }
    ),
  };
  assert.ok(fields.body);
  const compact = compactFieldDiffs({ body: fields.body }, 'en');
  const body = compact.body;
  assert.equal(body?.kind, 'localized');
  if (body?.kind !== 'localized') return;
  assert.deepEqual(Object.keys(body.modified), ['en']);
  assert.match(body.modified.en.unifiedDiff, /\+New line\./);
  assert.equal(body.modified.en.from, undefined);
  assert.equal(body.added.length, 0);

  const all = compactFieldDiffs({ body: fields.body }, '*', true);
  const allBody = all.body;
  if (allBody?.kind !== 'localized') throw new Error('expected a localized diff');
  assert.deepEqual(Object.keys(allBody.modified).sort(), ['de', 'en']);
  assert.equal(allBody.modified.en.from, 'Old line.\n');
  assert.deepEqual(allBody.added, [{ lang: 'fr', characters: 16, value: 'Nouvelle ligne.\n' }]);

  assert.deepEqual(compactFieldDiffs({ body: fields.body }, 'ja'), {});
});
