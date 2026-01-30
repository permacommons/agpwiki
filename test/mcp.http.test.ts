import assert from 'node:assert/strict';
import test from 'node:test';

import { isJsonParseError } from '../src/mcp/http-errors.js';

test('isJsonParseError identifies body-parser parse errors', () => {
  const error = new SyntaxError('Unexpected token');
  (error as { type?: string }).type = 'entity.parse.failed';
  assert.equal(isJsonParseError(error), true);
});

test('isJsonParseError ignores non-parse errors', () => {
  assert.equal(isJsonParseError(new Error('nope')), false);
});
