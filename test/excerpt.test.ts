import assert from 'node:assert/strict';
import test from 'node:test';
import { firstSentence } from '../src/lib/excerpt.js';

test('firstSentence takes the first sentence of the lead as plain text', () => {
  assert.equal(
    firstSentence('A **belt buckle** is a [fastener](/fastener) for a belt.[@smith-2020] It can also be decorative.'),
    'A belt buckle is a fastener for a belt.'
  );
  // Abbreviations followed by a number are not the end of a sentence.
  assert.equal(
    firstSentence('The Piano Trio No. 2 in C major, Op. 87 is a chamber work. It has four movements.'),
    'The Piano Trio No. 2 in C major, Op. 87 is a chamber work.'
  );
  // Images and citations are left out, and the lead stops at the first heading.
  assert.equal(
    firstSentence('![A buckle](/media/buckle){size=250 caption="A buckle"}\nOnly one sentence here\n\n## History\n\nMore. Text.'),
    'Only one sentence here'
  );
  assert.equal(firstSentence('茶是一种饮料。它很受欢迎。'), '茶是一种饮料。');
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence(null), '');
  assert.equal(firstSentence('## Only a heading'), '');
  const long = `${'word '.repeat(100)}end.`;
  assert.ok(firstSentence(long).endsWith('…'));
  assert.ok(firstSentence(long).length <= 280);
});

