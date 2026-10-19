import assert from 'node:assert/strict';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';
import {
  renderProposalHeader,
  renderProposalLinks,
  renderProposalLinksForm,
  renderProposalParts,
  renderProposalStatusForm,
} from '../src/routes/lib/proposal-status.js';
import { renderMarkdown } from '../src/render.js';

const t = i18next.t.bind(i18next);
const slug = 'meta/proposals/test';
const info = {
  status: 'adopted' as const,
  changedAt: '2026-10-19T00:00:00Z', changedBy: 'author',
  decidedAt: '2026-10-19T00:00:00Z', decidedBy: 'admin',
  decisionNote: { en: 'Decision rationale <script>unsafe</script>' },
};
const renderHeader = (statusFormHtml = '', linksFormHtml = '') => renderProposalHeader({
  info, userMap: new Map([['admin', 'Reviewer']]), locale: 'en', contentLang: 'en',
  linksHtml: '', statusFormHtml, linksFormHtml, t,
});

test('Proposal management has one disclosure and the published decision stays visible outside it', () => {
  const status = renderProposalStatusForm({ slug, info, isAdmin: true, contentLang: 'en', t });
  const links = renderProposalLinksForm({ slug, parent: null, pullRequests: [], contentLang: 'en', t });
  const html = renderHeader(status, links);
  assert.equal((html.match(/<details\b/g) ?? []).length, 1);
  assert.equal((html.match(/<form\b/g) ?? []).length, 2);
  assert.ok(html.indexOf('Decision rationale') < html.indexOf('<details'));
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(html.includes('Reviewer'));
  assert.ok(html.includes('Manage proposal'));
  assert.ok(html.includes('/meta%2Fproposals%2Ftest/proposal-status'));
  assert.ok(html.includes('/meta%2Fproposals%2Ftest/proposal-links'));
  assert.doesNotMatch(renderHeader(), /<details|<form/);
  assert.equal((renderHeader('', links).match(/<form\b/g) ?? []).length, 1);
});

test('Author form excludes admin decisions; admin fields declare relevant statuses and remain usable without JS', () => {
  const author = renderProposalStatusForm({ slug, info: null, isAdmin: false, contentLang: 'en', t });
  assert.ok(author.includes('value="open"'));
  assert.doesNotMatch(author, /value="adopted"|name="decisionNote"|name="appliedTo"|name="supersededBy"/);
  const admin = renderProposalStatusForm({ slug, info, isAdmin: true, contentLang: 'en', t });
  assert.ok(admin.includes('data-proposal-statuses="applied"'));
  assert.ok(admin.includes('data-proposal-statuses="superseded"'));
  assert.doesNotMatch(admin, / disabled|<label[^>]* hidden/);
});

test('Related links keep PR state labels and escape titles; parts render separately', () => {
  const html = renderProposalLinks({
    parent: { slug: 'meta/proposals/parent', title: 'Parent <unsafe>' },
    pullRequests: [{ url: 'https://github.com/permacommons/agpwiki/pull/86', number: 86, state: 'merged', title: 'Fix "citations"' }],
    t,
  });
  assert.ok(html.includes('Parent &lt;unsafe&gt;'));
  assert.ok(html.includes('Fix &quot;citations&quot;'));
  assert.ok(html.includes('Merged'));
  assert.doesNotMatch(html, /<form|<details/);
  assert.equal(renderProposalLinks({ parent: null, pullRequests: [], t }), '');
  assert.equal(renderProposalParts({ parts: [], t }), '');
  const parts = renderProposalParts({ parts: [{ slug, title: 'Part <unsafe>', status: 'open' }], t });
  assert.ok(parts.includes('Part &lt;unsafe&gt;'));
  assert.ok(parts.includes('Open for discussion'));
});

test('Parts go after the complete introduction, outside nested blocks, without changing the TOC or permitting raw HTML', async () => {
  const source = 'Introduction.\n\n> ## Nested heading\n> Quoted text.\n\n## First section\n\nSection body.\n\n<script>unsafe</script>';
  const insertion = '<section class="proposal-parts">Parts</section>';
  const original = await renderMarkdown(source, []);
  const rendered = await renderMarkdown(source, [], { afterLeadHtml: insertion });
  assert.deepEqual(rendered.toc, original.toc);
  assert.ok(rendered.html.indexOf('</blockquote>') < rendered.html.indexOf(insertion));
  assert.ok(rendered.html.indexOf(insertion) < rendered.html.indexOf('<h2 id="first-section"'));
  assert.ok(rendered.html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.equal(rendered.html.replace(insertion, ''), original.html);
  const noHeading = await renderMarkdown('Only an introduction.', [], { afterLeadHtml: insertion });
  assert.ok(noHeading.html.indexOf('</p>') < noHeading.html.indexOf(insertion));
});
