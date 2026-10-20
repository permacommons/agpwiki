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

test('Replies show under a position comment with links, and only the author or an admin can act on them', () => {
  const replies = new Map([
    [
      'position',
      [
        {
          id: 'reply-1', signoffId: 'position', pageId: 'page', userId: 'other', body: 'See https://example.org/x. <b>bold</b>',
          bodyLanguage: 'en', createdAt: new Date(), updatedAt: null,
        },
        {
          id: 'reply-2', signoffId: 'position', pageId: 'page', userId: 'user', body: 'Thanks!',
          bodyLanguage: 'en', createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    ],
  ]);
  const base = {
    slug: 'meta/proposals/test', currentRevId: 'revision', signoffs: [{ ...position, comment: 'A question?' }],
    userMap: new Map([['user', 'Test user'], ['other', 'Other user']]), canSignOff: true,
    t: i18next.t.bind(i18next), language: 'en',
    languageOptions: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'العربية' }], replies,
  };
  const html = renderPageSignoffs({ ...base, viewerId: 'user' });
  assert.ok(html.includes('<a href="https://example.org/x" rel="nofollow ugc noopener">https://example.org/x</a>.'));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(html.includes('id="reply-reply-1"'));
  assert.ok(html.includes('action="/meta%2Fproposals%2Ftest/position-reply"'));
  assert.ok(html.includes('name="signoffId" value="position"'));
  // The viewer can edit and delete their own reply, but not the other one.
  assert.equal((html.match(/name="intent" value="update"/g) ?? []).length, 1);
  assert.equal((html.match(/name="intent" value="remove"/g) ?? []).length, 1);
  assert.ok(html.includes('edited'));

  const admin = renderPageSignoffs({ ...base, viewerId: 'admin', isAdmin: true });
  assert.equal((admin.match(/name="intent" value="remove"/g) ?? []).length, 2);
  assert.ok(admin.includes('>Hide<'));

  const signedOut = renderPageSignoffs({ ...base, viewerId: null, canSignOff: false });
  assert.ok(!signedOut.includes('name="intent" value="create"'));
  assert.ok(signedOut.includes('Thanks!'));

  const noComment = renderPageSignoffs({ ...base, viewerId: 'user', signoffs: [{ ...position, comment: null }] });
  assert.ok(!noComment.includes('page-signoff-thread'));
  assert.ok(!html.includes('maxlength="2000"'));
});
