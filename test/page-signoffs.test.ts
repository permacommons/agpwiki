import assert from 'node:assert/strict';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';
import { renderPageSignoffs } from '../src/routes/lib/page-signoffs.js';
import type { PageSignoffResult } from '../src/services/page-signoff-service.js';

const position: PageSignoffResult = {
  id: 'position', pageId: 'page', revId: 'revision', userId: 'user', stance: 'support',
  comment: 'نص <script>alert(1)</script>', commentLanguage: 'ar', signedAt: new Date(),
};

const render = (signoff: PageSignoffResult) => renderPageSignoffs({
  slug: 'meta/proposals/test', currentRevId: 'revision', signoffs: [signoff],
  userMap: new Map([['user', 'Test user']]), viewerId: 'user', canSignOff: true,
  t: i18next.t.bind(i18next), language: 'en',
  languageOptions: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'العربية' }],
});

test('Position rationale records its language, supports RTL, and directs conversation to the forum', () => {
  const html = render(position);
  assert.match(html, /<blockquote[^>]*dir="auto"[^>]*lang="ar"/);
  assert.ok(html.includes('<p class="page-signoff-language">العربية</p>'));
  assert.match(html, /name="commentLanguage"\s+id="page-signoff-language-ar"\s+value="ar" checked/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('/tool/forum/policy/page/meta%2Fproposals%2Ftest'));
  assert.ok(html.includes('Brief rationale (optional)'));
});

test('Legacy rationales retain unknown language and new rationales default to the UI language', () => {
  const html = render({ ...position, commentLanguage: null });
  assert.match(html, /<blockquote class="page-signoff-comment" dir="auto">/);
  assert.ok(!html.includes('<p class="page-signoff-language">'));
  assert.match(html, /name="commentLanguage"\s+id="page-signoff-language-en"\s+value="en" checked/);
});
