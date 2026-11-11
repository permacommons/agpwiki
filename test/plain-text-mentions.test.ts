import assert from 'node:assert/strict';
import test from 'node:test';
import { findMentionNames } from '../src/lib/mentions.js';
import { renderPlainTextWithLinks } from '../src/routes/lib/page-signoffs.js';

const cases: Array<[string, string, string[]]> = [
  ['query', 'https://example.org/?name=@Alice', []],
  ['fragment', 'https://example.org/#@Alice', []],
  ['userinfo', 'https://@Alice:password@example.org/', []],
  ['multiple URLs', 'https://example.org/?q=@Alice http://example.org/#@Bob', []],
  ['multiple query values', 'https://example.org/?q=@Alice&other=@Bob', []],
  ['visible mentions', '@Alice https://example.org/?q=@Bob @Bob', ['alice', 'bob']],
  ['same user outside URL', 'https://example.org/?q=@Alice Thanks @Alice.', ['alice']],
  ['trailing punctuation', '(https://example.org/?q=@Alice). @Bob', ['bob']],
  ['trailing quote', '"https://example.org/?q=@Alice" @Bob', ['bob']],
  ['HTML delimiters', '<https://example.org/?q=@Alice> @Bob', ['bob']],
  ['newline', 'https://example.org/?q=@Alice\n@Bob', ['bob']],
  ['literal markup', '`@Alice` and ![photo @Bob](photo.jpg)', ['alice', 'bob']],
];

for (const [name, source, expected] of cases) {
  test(`Plain-text mentions: ${name}`, () => {
    assert.deepEqual(findMentionNames(source), expected);
    const mentions = new Map(['alice', 'bob'].map(username => [username, username]));
    const html = renderPlainTextWithLinks(source, mentions);
    const rendered = [...html.matchAll(/class="mention" href="\/user\/([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual([...new Set(rendered)], expected);
  });
}
