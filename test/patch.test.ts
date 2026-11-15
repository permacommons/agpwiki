import assert from 'node:assert/strict';
import test from 'node:test';

import { applyUnifiedPatch } from '../src/lib/patch.js';

const unified = (...hunk: string[]) => ['--- before', '+++ after', ...hunk].join('\n');
const codex = (target: string, ...hunk: string[]) =>
  ['*** Begin Patch', `*** Update File: ${target}`, ...hunk, '*** End Patch'].join('\n');
const change = ['@@ -1 +1 @@', '-Hello old world', '+Hello new world'];

test('Unified and codex patches apply to the current text', () => {
  assert.equal(applyUnifiedPatch('Hello old world', unified(...change), 'unified'), 'Hello new world');
  assert.equal(
    applyUnifiedPatch('Hello old world', codex('page', ...change), 'codex', { expectedFile: 'page' }),
    'Hello new world'
  );
});

test('Codex patch targets may start with a slash but must name the page', () => {
  assert.equal(
    applyUnifiedPatch('Hello old world', codex('/page', ...change), 'codex', { expectedFile: 'page' }),
    'Hello new world'
  );
  assert.throws(
    () => applyUnifiedPatch('Hello old world', codex('other', ...change), 'codex', { expectedFile: 'page' }),
    /Patch target mismatch\. Expected "page", got "other"/
  );
});

test('Hunk headers without line numbers are rejected in both formats', () => {
  const bare = ['@@', '-Hello old world', '+Hello new world'];
  assert.throws(() => applyUnifiedPatch('Hello old world', unified(...bare), 'unified'), /Invalid @@ hunk header: "@@"/);
  assert.throws(() => applyUnifiedPatch('Hello old world', codex('page', ...bare), 'codex'), /Invalid @@ hunk header: "@@"/);
});

test('Malformed patches name what is wrong with them', () => {
  const cases: Array<[string, 'unified' | 'codex', RegExp]> = [
    [['--- before', '+++ after', '-Hello old world', '+Hello new world'].join('\n'), 'unified', /Missing @@ hunk header/],
    [codex('page', ...change), 'unified', /Expected unified diff format/],
    [unified(...change), 'codex', /Expected "\*\*\* Begin Patch" header/],
    [['*** Begin Patch', ...change, '*** End Patch'].join('\n'), 'codex', /Missing "\*\*\* Update File:" line/],
    [codex('page', '*** Update File: other', ...change), 'codex', /Multiple update targets/],
    [codex('page', '*** Add File: new', ...change), 'codex', /Add\/Delete file operations/],
    [codex('page', '-Hello old world', '+Hello new world'), 'codex', /Missing @@ hunk header/],
  ];
  for (const [patch, format, expected] of cases) {
    assert.throws(() => applyUnifiedPatch('Hello old world', patch, format), expected, patch);
  }
});

test('Patches that do not match or change nothing are rejected', () => {
  assert.throws(
    () => applyUnifiedPatch('Something else', unified(...change), 'unified'),
    /could not be applied to the current content/
  );
  assert.throws(
    () => applyUnifiedPatch('Hello old world', unified('@@ -1 +1 @@', '-Hello old world', '+Hello old world'), 'unified'),
    /did not change the content/
  );
});
