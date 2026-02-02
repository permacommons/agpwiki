import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutAssets } from '../src/asset-urls.js';

test('layoutAssets include deterministic version query strings', () => {
  assert.match(layoutAssets.siteCss, /^\/static\/styles\/site\.css\?v=[\da-f]{8}$/);
  assert.match(layoutAssets.searchJs, /^\/static\/scripts\/search\.js\?v=[\da-f]{8}$/);
  assert.match(layoutAssets.metaTooltipsJs, /^\/static\/scripts\/meta-tooltips\.js\?v=[\da-f]{8}$/);
  assert.match(layoutAssets.tocJs, /^\/static\/scripts\/toc\.js\?v=[\da-f]{8}$/);
});
