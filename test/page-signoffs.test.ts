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

test('Position rationale records its language without showing it, supports RTL, and links to the proposal discussion', () => {
  const html = render(position);
  assert.match(html, /<div class="discussion-comment-body page-signoff-comment" dir="auto" lang="ar">/);
  // The language stays in the markup (lang attribute) but is not shown as a line.
  assert.ok(!html.includes('العربية</p>'));
  assert.match(html, /name="commentLanguage"\s+id="page-signoff-language-ar"\s+value="ar" checked/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('href="/meta/proposals/test/discussion"'));
  assert.ok(html.includes('Brief rationale (optional)'));
});

test('Legacy rationales retain unknown language and new rationales default to the UI language', () => {
  const html = render({ ...position, commentLanguage: null });
  assert.match(html, /<div class="discussion-comment-body page-signoff-comment" dir="auto">/);
  assert.ok(!html.includes('<p class="page-signoff-language">'));
  assert.match(html, /name="commentLanguage"\s+id="page-signoff-language-en"\s+value="en" checked/);
});

test('Positions are top-level comments with their replies one level under them', () => {
  const reply = (id: string, authorId: string, bodyHtml: string, edited: boolean) => ({
    id, threadId: 'thread-1', authorId, body: 'Markdown source', bodyLanguage: 'en', createdAt: new Date(), edited, bodyHtml,
  });
  const replies = new Map([
    ['position', { threadId: 'thread-1', replies: [reply('c1', 'other', '<p>From the other user.</p>', false), reply('c2', 'user', '<p>Thanks!</p>', true)] }],
  ]);
  const base = {
    slug: 'meta/proposals/test', currentRevId: 'revision', signoffs: [{ ...position, comment: 'A question?' }],
    userMap: new Map([['user', 'Test user'], ['other', 'Other user']]),
    usernames: new Map([['user', 'testuser'], ['other', 'otheruser']]), canSignOff: true,
    t: i18next.t.bind(i18next), language: 'en',
    languageOptions: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'العربية' }], replies,
  };
  const html = renderPageSignoffs({ ...base, viewerId: 'user' });
  assert.ok(html.includes('id="position-position"'));
  assert.ok(html.includes('<p>From the other user.</p>'));
  assert.ok(html.includes('<div class="discussion-replies" data-replies="position-position"><article class="discussion-comment discussion-comment--reply page-signoff-reply" id="comment-c1"'));
  assert.ok(!html.includes('href="/tool/forum/thread/'));
  assert.ok(html.includes('action="/tool/forum/thread/thread-1/subscription"'));
  assert.ok(html.includes('href="/meta/proposals/test/discussion#comment-c1" data-permalink'));
  assert.ok(html.includes('data-reply-action="/meta/proposals/test/position-reply"'));
  assert.ok(html.includes('data-reply-fields="{&quot;signoffId&quot;:&quot;position&quot;}"'));
  // Answering a reply starts with @username.
  assert.ok(html.includes('data-reply-mention="otheruser"'));
  // Only the viewer's own reply can be edited, through the forum.
  assert.equal((html.match(/action="\/tool\/forum\/comment\/[^"]+\/edit"/g) ?? []).length, 1);
  assert.ok(html.includes('action="/tool/forum/comment/c2/edit"'));
  assert.ok(html.includes('href="/tool/forum/comment/c2/edit?return=%2Fmeta%2Fproposals%2Ftest%2Fdiscussion%23comment-c2" data-comment-edit-link'));
  assert.ok(html.includes('data-comment-editor hidden'));
  assert.ok(html.includes('name="return" value="/meta/proposals/test/discussion#comment-c2"'));
  // An edited reply links to its history.
  assert.ok(html.includes('href="/tool/forum/comment/c2/history">edited</a>'));
  assert.ok(!html.includes('/tool/forum/comment/c1/history'));

  const signedOut = renderPageSignoffs({ ...base, viewerId: null, canSignOff: false });
  assert.ok(!signedOut.includes('data-reply-to'));
  assert.ok(!signedOut.includes('/edit"'));
  assert.ok(signedOut.includes('<p>Thanks!</p>'));

  const unconfirmed = renderPageSignoffs({ ...base, viewerId: 'user', canReply: false });
  assert.ok(!unconfirmed.includes('data-reply-to'));
  assert.ok(unconfirmed.includes('Confirm your email address'));

  // Without JavaScript, the reply form opens under the position.
  const open = renderPageSignoffs({ ...base, viewerId: 'user', openReply: { signoffId: 'position' } });
  assert.ok(open.includes('id="reply-form-position"'));
  assert.ok(open.includes('name="signoffId" value="position"'));

  const noComment = renderPageSignoffs({ ...base, viewerId: 'user', signoffs: [{ ...position, comment: null }] });
  assert.ok(!noComment.includes('data-reply-to'));
  assert.ok(!html.includes('maxlength="2000"'));

  // A withdrawn position people replied to stays, with its replies and no reply form.
  const withdrawn = renderPageSignoffs({
    ...base,
    viewerId: 'user',
    signoffs: [],
    withdrawn: [{ ...position, comment: 'A question?', withdrawnAt: new Date() }],
  });
  assert.ok(withdrawn.includes('page-signoff--withdrawn'));
  assert.ok(withdrawn.includes('<p>Thanks!</p>'));
  assert.ok(!withdrawn.includes('data-reply-to'));
});
