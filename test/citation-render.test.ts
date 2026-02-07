import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCitationKeysFromSources } from '../src/lib/citation-render.js';

test('extractCitationKeysFromSources parses citation and claim refs', () => {
  const keys = extractCitationKeysFromSources([
    'Text with [@alpha].',
    'Another [@beta:claim-id; @gamma].',
    'Bare token @ignored is still extracted for parity with route parsing.',
  ]);

  assert.deepEqual([...keys].sort(), ['alpha', 'beta', 'gamma', 'ignored']);
});
