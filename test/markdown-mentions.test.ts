import assert from 'node:assert/strict';
import test from 'node:test';
import { findMarkdownMentionNames, renderMarkdown } from '../src/render.js';

const cases: Array<[string, string, string[]]> = [
  ['plain text', 'Hello @Alice and @Bob.', ['alice', 'bob']],
  ['formatting', '*@Alice* **@Bob** ~~@Carol~~', ['alice', 'bob', 'carol']],
  ['blocks', '# @Alice\n\n> @Bob\n\n- @Carol', ['alice', 'bob', 'carol']],
  ['inline link', '[hello @Alice](https://example.org)', []],
  ['formatted link', '[hello **@Alice**](https://example.org)', []],
  ['reference link', '[hello @Alice][ref]\n\n[ref]: https://example.org', []],
  ['collapsed link', '[hello @Alice][]\n\n[hello @Alice]: https://example.org', []],
  ['shortcut link', '[hello @Alice]\n\n[hello @Alice]: https://example.org', []],
  ['image', '![photo of @Alice](photo.jpg)', []],
  ['formatted image', '![photo of **@Alice**](photo.jpg)', []],
  ['reference image', '![photo of @Alice][ref]\n\n[ref]: photo.jpg', []],
  ['collapsed image', '![photo of @Alice][]\n\n[photo of @Alice]: photo.jpg', []],
  ['shortcut image', '![photo of @Alice]\n\n[photo of @Alice]: photo.jpg', []],
  ['image title', '![photo](photo.jpg "@Alice")', []],
  ['linked image', '[![photo of @Alice](photo.jpg)](https://example.org)', []],
  ['link destination and title', '[hello](https://example.org/@Alice "@Bob")', []],
  ['autolinks', '<https://example.org/@Alice> <alice@example.org>', []],
  ['bare URL', 'https://example.org/@Alice', []],
  ['URL query', 'https://example.org/?name=@Alice', []],
  ['link with code', '[`@Alice` and @Bob](https://example.org)', []],
  ['table', '| Name |\n| --- |\n| @Alice |', ['alice']],
  ['inline code', '`@Alice` and ``@Bob``', []],
  ['fenced code', '```\n@Alice\n```', []],
  ['indented code', '    @Alice\n', []],
  ['escaped mention', '\\@Alice', []],
  ['entity', '&#64;Alice', []],
  ['citation', '[@Alice]', []],
  ['invalid link', '[hello @Alice](unfinished', ['alice']],
  ['invalid image', '![photo of @Alice](unfinished', ['alice']],
  ['after excluded contexts', '[hello @Alice](https://example.org) ![photo @Bob](photo.jpg) @Carol', ['carol']],
  ['deduplication and order', '@Bob [hello @Carol](https://example.org) @Alice @Bob', ['bob', 'alice']],
];

for (const [name, source, expected] of cases) {
  test(`Markdown mentions: ${name}`, async () => {
    assert.deepEqual(findMarkdownMentionNames(source), expected);
    const mentions = new Map(['alice', 'bob', 'carol'].map(username => [username, username]));
    const { html } = await renderMarkdown(source, [], { mentions });
    const rendered = [...html.matchAll(/href="\/user\/([^"]+)" class="mention"/g)].map(match => match[1]);
    assert.deepEqual([...new Set(rendered)], expected);
  });
}
