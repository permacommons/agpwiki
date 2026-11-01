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

test('Replies to a position show as forum posts, with editing for their author only', () => {
  const reply = (id: string, authorId: string, bodyHtml: string, edited: boolean) => ({
    id, threadId: 'thread-1', authorId, body: 'Markdown source', bodyLanguage: 'en', createdAt: new Date(), edited, bodyHtml,
  });
  const replies = new Map([
    ['position', { threadId: 'thread-1', replies: [reply('c1', 'other', '<p>From the other user.</p>', false), reply('c2', 'user', '<p>Thanks!</p>', true)] }],
  ]);
  const base = {
    slug: 'meta/proposals/test', currentRevId: 'revision', signoffs: [{ ...position, comment: 'A question?' }],
    userMap: new Map([['user', 'Test user'], ['other', 'Other user']]), canSignOff: true,
    t: i18next.t.bind(i18next), language: 'en',
    languageOptions: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'العربية' }], replies,
  };
  const html = renderPageSignoffs({ ...base, viewerId: 'user' });
  assert.ok(html.includes('<p>From the other user.</p>'));
  assert.ok(html.includes('id="reply-c1"'));
  assert.ok(html.includes('href="/tool/forum/thread/thread-1"'));
  assert.ok(html.includes('Open these replies in the forum'));
  assert.ok(html.includes('action="/meta/proposals/test/position-reply"'));
  assert.ok(html.includes('name="signoffId" value="position"'));
  // Only the viewer's own reply can be edited, through the forum.
  assert.equal((html.match(/action="\/tool\/forum\/comment\/[^"]+\/edit"/g) ?? []).length, 1);
  assert.ok(html.includes('action="/tool/forum/comment/c2/edit"'));
  assert.ok(html.includes('href="/tool/forum/comment/c2/edit?return=%2Fmeta%2Fproposals%2Ftest%23reply-c2" data-comment-edit-link'));
  assert.ok(html.includes('data-comment-editor hidden'));
  assert.ok(html.includes('data-comment-content'));
  assert.ok(html.includes('data-comment-edit-cancel>Cancel</a>'));
  assert.ok(!html.includes('page-signoff-reply-edit'));
  assert.ok(html.includes('name="return" value="/meta/proposals/test#reply-c2"'));
  // An edited reply links to its history.
  assert.ok(html.includes('href="/tool/forum/comment/c2/history">edited</a>'));
  assert.ok(!html.includes('/tool/forum/comment/c1/history'));

  const signedOut = renderPageSignoffs({ ...base, viewerId: null, canSignOff: false });
  assert.ok(!signedOut.includes('name="signoffId"'));
  assert.ok(!signedOut.includes('/edit"'));
  assert.ok(signedOut.includes('<p>Thanks!</p>'));

  const unconfirmed = renderPageSignoffs({ ...base, viewerId: 'user', canReply: false });
  assert.ok(!unconfirmed.includes('name="signoffId"'));
  assert.ok(unconfirmed.includes('Confirm your email address'));

  const noComment = renderPageSignoffs({ ...base, viewerId: 'user', signoffs: [{ ...position, comment: null }] });
  assert.ok(!noComment.includes('page-signoff-thread'));
  assert.ok(!html.includes('maxlength="2000"'));
});
