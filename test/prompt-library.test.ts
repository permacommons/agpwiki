import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PROMPT_LIBRARY_ROOT = path.resolve('src/mcp/prompt-library');

const mdFiles = readdirSync(PROMPT_LIBRARY_ROOT, { recursive: true })
  .map(f => String(f))
  .filter(f => f.endsWith('.md'));

test('prompt-library contains at least one template', () => {
  assert.ok(mdFiles.length > 0, 'expected .md templates in prompt-library');
});

for (const file of mdFiles) {
  test(`prompt template "${file}" is non-empty`, () => {
    const contents = readFileSync(path.join(PROMPT_LIBRARY_ROOT, file), 'utf8');
    assert.ok(contents.trim().length > 0, `${file} must not be empty`);
  });
}
