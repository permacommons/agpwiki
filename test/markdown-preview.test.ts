import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdownPreviewPanel } from '../src/routes/lib/markdown-preview.js';

test('renderMarkdownPreviewPanel binds to a form and escapes preview copy', () => {
  const html = renderMarkdownPreviewPanel({
    formId: 'operator-edit-form',
    previewId: 'preview-output',
    endpoint: '/api/render-page-edit-preview',
    texts: {
      title: 'Preview <now>',
      empty: 'Nothing yet',
      error: 'Unavailable',
    },
  });

  assert.match(html, /data-markdown-preview-form="operator-edit-form"/);
  assert.match(html, /data-markdown-preview-endpoint="\/api\/render-page-edit-preview"/);
  assert.match(html, /Preview &lt;now&gt;/);
});
