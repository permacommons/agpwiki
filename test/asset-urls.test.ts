import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutAssets } from '../src/asset-urls.js';

test('layoutAssets include deterministic version query strings', () => {
  for (const [name, url] of Object.entries(layoutAssets)) {
    assert.match(url, /^\/static\/(scripts|styles|images)\/[\w.-]+\.(js|css|svg)\?v=[\da-f]{8}$/, name);
  }
});
