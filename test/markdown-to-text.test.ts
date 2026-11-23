import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToPlainText } from '../src/lib/markdown-to-text.js';

test('markdownToPlainText parses links, emphasis, escapes and block structure', () => {
  const source = [
    '**Bold**, _italic_, ~~struck~~, `code`, [nested destination](https://example.com/a_(b)).',
    '',
    '> Quoted text',
    '',
    '- List item',
    '',
    '[reference link][help]',
    '',
    '[help]: /meta/help',
    '',
    String.raw`\*Literal asterisks\*.`,
  ].join('\n');
  assert.equal(
    markdownToPlainText(source),
    'Bold, italic, struck, code, nested destination. Quoted text List item reference link *Literal asterisks*.'
  );
});

test('markdownToPlainText decodes entities once and returns unescaped literal HTML', () => {
  assert.equal(
    markdownToPlainText('Fish &amp; chips &quot;quoted&quot; caf&eacute; &#169; &#x1F41F; &amp;amp; <strong>literal</strong>'),
    'Fish & chips "quoted" café © 🐟 &amp; <strong>literal</strong>'
  );
});

test('markdownToPlainText omits images, media attributes and citation groups', () => {
  assert.equal(
    markdownToPlainText('A ![image](https://example.com/image.png) bell ![logo](/media/logo){size=250 caption="Logo"} rings[@source; @other].'),
    'A bell rings.'
  );
});

test('markdownToPlainText preserves code content and separates blocks', () => {
  assert.equal(markdownToPlainText('Before\n\n```html\n<strong>code</strong> &amp;\n```\n\nAfter'), 'Before <strong>code</strong> &amp; After');
  assert.equal(markdownToPlainText(''), '');
});

