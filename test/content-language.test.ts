import assert from 'node:assert/strict';
import test from 'node:test';

import { getAvailableLanguages, resolveContentLanguage } from '../src/routes/lib/content-language.js';

test('getAvailableLanguages filters empty values and orders by supported locales', () => {
  const available = getAvailableLanguages(
    { en: 'Hello', de: 'Hallo', fr: '' },
    { de: 'Guten Tag', es: 'Hola' }
  );

  assert.deepEqual(available, ['en', 'de', 'es']);
});

test('resolveContentLanguage respects explicit overrides', () => {
  const contentLang = resolveContentLanguage({
    uiLocale: 'en',
    override: 'de',
    availableLangs: ['en', 'de'],
  });

  assert.equal(contentLang, 'de');
});

test('resolveContentLanguage uses UI locale when available', () => {
  const contentLang = resolveContentLanguage({
    uiLocale: 'fr',
    override: undefined,
    availableLangs: ['en', 'fr'],
  });

  assert.equal(contentLang, 'fr');
});

test('resolveContentLanguage falls back to any available language for English UI', () => {
  const contentLang = resolveContentLanguage({
    uiLocale: 'en',
    override: undefined,
    availableLangs: ['de', 'es'],
  });

  assert.equal(contentLang, 'de');
});

test('resolveContentLanguage falls back to English when available', () => {
  const contentLang = resolveContentLanguage({
    uiLocale: 'pt',
    override: undefined,
    availableLangs: ['en', 'es'],
  });

  assert.equal(contentLang, 'en');
});
