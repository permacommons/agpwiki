import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCitationAuthors,
  formatCitationIssued,
  formatCitationPageTitle,
} from '../src/lib/citation.js';

test('formatCitationPageTitle uses title + container-title', () => {
  const title = formatCitationPageTitle('key', {
    title: 'Example Title',
    'container-title': 'Example Journal',
  });
  assert.equal(title, 'Example Title — Example Journal');
});

test('formatCitationPageTitle falls back to title + publisher', () => {
  const title = formatCitationPageTitle('key', {
    title: 'Example Title',
    publisher: 'Example Press',
  });
  assert.equal(title, 'Example Title — Example Press');
});

test('formatCitationPageTitle falls back to title then key', () => {
  assert.equal(formatCitationPageTitle('key', { title: 'Example Title' }), 'Example Title');
  assert.equal(formatCitationPageTitle('key', {}), 'key');
});

test('formatCitationAuthors renders literal and given/family', () => {
  const authors = formatCitationAuthors({
    author: [
      { literal: 'Example Org' },
      { given: 'Alex', family: 'Tester' },
    ],
  });
  assert.equal(authors, 'Example Org; Tester, Alex');
});

test('formatCitationIssued formats date-parts when present', () => {
  const issued = formatCitationIssued({ issued: { 'date-parts': [[2024, 5, 3]] } });
  assert.equal(issued, '2024-5-3');
  assert.equal(formatCitationIssued({}), '');
});
