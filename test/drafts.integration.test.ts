import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createSession } from '../src/auth/session.js';
import { initializeI18n, i18next } from '../src/i18n.js';
import { initializePostgreSQL } from '../src/db.js';
import {
  duplicateScope,
  isArticleSlug,
  isDraftSlug,
  pageNamespaceSql,
  resolvePageAddress,
  toDraftSlug,
} from '../src/lib/page-address.js';
import { createMcpServer } from '../src/mcp/core.js';
import { articlePages } from '../src/models/page-scope.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { DRAFT_DUPLICATE_RECHECK_AFTER_MS, publishDraft } from '../src/services/draft-service.js';
import { findExistingWikiLinkSlugs } from '../src/services/wiki-link-preview-service.js';
import {
  createWikiPage,
  findCurrentPageBySlugOrAlias,
  listWikiPageRevisions,
  searchWikiPages,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};

const createTestUser = async () => {
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  return User.create({
    username: `drafttest${suffix}`,
    displayName: 'Draft Test',
    email: `draft-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

// Letters only, so titles stay unique among pages other tests create.
const randomWord = () =>
  Array.from({ length: 10 }, () => String.fromCharCode(97 + randomInt(26))).join('');

const newPrefix = (label: string) => `test-${label}-${Date.now()}-${randomWord()}`;

const cleanup = async (prefix: string, userIds: string[]) => {
  const dal = await getDal();
  const patterns = [`${prefix}%`, `draft/${prefix}%`];
  await dal.query(
    'DELETE FROM page_aliases WHERE slug LIKE ANY($1::text[]) OR page_id IN (SELECT id FROM pages WHERE slug LIKE ANY($1::text[]))',
    [patterns]
  );
  await dal.query('DELETE FROM pages WHERE slug LIKE ANY($1::text[])', [patterns]);
  if (userIds.length) await dal.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
};

// Pretends the draft was created long enough ago to be checked again at Publish.
const ageDraft = async (slug: string) => {
  const dal = await getDal();
  const createdAt = new Date(Date.now() - DRAFT_DUPLICATE_RECHECK_AFTER_MS - 60_000);
  await dal.query('UPDATE pages SET created_at = $2 WHERE slug = $1 AND _old_rev_of IS NULL', [slug, createdAt]);
};

const startServer = async (language?: string) => {
  const app = express();
  app.use((req, res, next) => {
    req.t = language ? i18next.getFixedT(language) : ((key: string) => key) as typeof req.t;
    req.language = language ?? 'en';
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ noindex: options?.noindex ?? null, bodyHtml: options?.bodyHtml ?? '' });
    }) as express.Response['render'];
    next();
  });
  registerPageRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

test('only the full draft/ prefix makes a draft', async () => {
  for (const slug of ['draft', 'draft-horse', 'drafts/x', 'draftx/y']) {
    assert.equal(isDraftSlug(slug), false, slug);
    assert.equal(isArticleSlug(slug), true, slug);
  }
  assert.deepEqual(resolvePageAddress('draft/draft-horse'), {
    slug: 'draft/draft-horse', namespace: 'draft', localName: 'draft-horse',
  });
  assert.equal(isArticleSlug('draft/x'), false);
  assert.equal(toDraftSlug('draft-horse'), 'draft/draft-horse');
  assert.equal(toDraftSlug('draft/x'), 'draft/x');
  assert.deepEqual(duplicateScope('draft'), ['draft', 'article']);
  assert.deepEqual(duplicateScope('article'), ['article']);

  const dal = await getDal();
  const slugs = ['draft', 'draft-horse', 'draft/x', 'draft/draft', 'drafts/x'];
  const result = await dal.query(
    `SELECT slug, ${pageNamespaceSql()} AS namespace FROM unnest($1::text[]) AS slug`, [slugs]
  );
  for (const row of result.rows) {
    assert.equal(row.namespace, resolvePageAddress(row.slug)?.namespace ?? null, row.slug);
  }
});

test('drafts stay out of search and lists but are recognized as existing link targets', async () => {
  const dal = await getDal();
  const prefix = newPrefix('draft-lists');
  const user = await createTestUser();
  try {
    const word = randomWord();
    const draft = await createWikiPage(
      dal, { slug: prefix, title: { en: `Draft ${word}` }, body: { en: 'Text.' }, draft: true }, user.id
    );
    assert.equal(draft.slug, `draft/${prefix}`);
    const horse = await createWikiPage(
      dal, { slug: `${prefix}-draft-horse`, title: { en: `Horse ${word}` }, body: { en: 'Text.' } }, user.id
    );
    await assert.rejects(
      createWikiPage(dal, { slug: `meta/${prefix}`, title: { en: 'Meta' }, draft: true }, user.id),
      { code: 'invalid_request' }
    );

    const found = (await searchWikiPages(dal, { query: word })).map(item => item.slug);
    assert.deepEqual(found, [horse.slug]);
    const listed = (await articlePages().run()).map(page => page.slug);
    assert.ok(listed.includes(horse.slug));
    assert.equal(listed.includes(draft.slug), false);

    const links = [draft.slug, horse.slug];
    assert.deepEqual([...(await findExistingWikiLinkSlugs(dal, links))].sort(), [...links].sort());
  } finally {
    await cleanup(prefix, [user.id]);
  }
});

test('a new draft is checked against articles and drafts', async () => {
  const dal = await getDal();
  const prefix = newPrefix('draft-dup');
  const user = await createTestUser();
  try {
    const title = { en: `Topic ${randomWord()}` };
    const article = await createWikiPage(dal, { slug: prefix, title }, user.id);
    await assert.rejects(
      createWikiPage(dal, { slug: `${prefix}-other`, title, draft: true }, user.id),
      (error: { code?: string; details?: { duplicates?: Array<{ slug: string }> } }) =>
        error.code === 'possible_duplicate' &&
        error.details?.duplicates?.some(page => page.slug === article.slug) === true
    );
    const draft = await createWikiPage(
      dal, { slug: `${prefix}-other`, title, draft: true, notDuplicateOf: [article.slug] }, user.id
    );
    await assert.rejects(
      createWikiPage(dal, { slug: `${prefix}-third`, title, draft: true, notDuplicateOf: [article.slug] }, user.id),
      (error: { code?: string; details?: { duplicates?: Array<{ slug: string }> } }) =>
        error.code === 'possible_duplicate' &&
        error.details?.duplicates?.some(page => page.slug === draft.slug) === true
    );
  } finally {
    await cleanup(prefix, [user.id]);
  }
});

test('publishing moves a draft to its article address and keeps the draft address', async () => {
  const dal = await getDal();
  const prefix = newPrefix('draft-publish');
  const creator = await createTestUser();
  const stranger = await createTestUser();
  try {
    const draft = await createWikiPage(
      dal, { slug: prefix, title: { en: `Publish ${randomWord()}` }, body: { en: 'Text.' }, draft: true }, creator.id
    );
    await assert.rejects(
      updateWikiPage(dal, { slug: draft.slug, newSlug: prefix, revSummary: { en: 'Move' } }, creator.id),
      { code: 'invalid_request' }
    );
    await assert.rejects(
      publishDraft(dal, { slug: draft.slug, revSummary: { en: 'Publish draft' } }, stranger.id),
      { code: 'forbidden' }
    );

    const published = await publishDraft(dal, { slug: draft.slug, revSummary: { en: 'Publish draft' } }, creator.id);
    assert.equal(published.slug, prefix);
    assert.equal(published.draftSlug, draft.slug);
    assert.equal((await findCurrentPageBySlugOrAlias(draft.slug))?.slug, prefix);
    const history = await listWikiPageRevisions(dal, prefix);
    assert.ok(history.revisions[0]?.revTags?.includes('publish'));
    await assert.rejects(
      publishDraft(dal, { slug: prefix, revSummary: { en: 'Publish draft' } }, creator.id),
      { code: 'invalid_request' }
    );

    const second = await createWikiPage(
      dal, { slug: `${prefix}-taken`, title: { en: `Taken ${randomWord()}` }, draft: true }, creator.id
    );
    await createWikiPage(dal, { slug: `${prefix}-taken`, title: { en: `Other ${randomWord()}` } }, creator.id);
    await assert.rejects(
      publishDraft(dal, { slug: second.slug, revSummary: { en: 'Publish draft' } }, creator.id),
      { code: 'conflict' }
    );
  } finally {
    await cleanup(prefix, [creator.id, stranger.id]);
  }
});

test('Publish checks for duplicates again unless the draft is new', async () => {
  const dal = await getDal();
  const prefix = newPrefix('draft-recheck');
  const user = await createTestUser();
  try {
    const title = { en: `Recheck ${randomWord()}` };
    const fresh = await createWikiPage(dal, { slug: `${prefix}-fresh`, title, draft: true }, user.id);
    const old = await createWikiPage(
      dal, { slug: `${prefix}-old`, title, draft: true, notDuplicateOf: [fresh.slug] }, user.id
    );
    // Articles are not checked against drafts, so this one appears meanwhile.
    const article = await createWikiPage(dal, { slug: `${prefix}-article`, title }, user.id);

    const publishedFresh = await publishDraft(dal, { slug: fresh.slug, revSummary: { en: 'Publish draft' } }, user.id);
    assert.equal(publishedFresh.slug, `${prefix}-fresh`);

    await ageDraft(old.slug);
    await assert.rejects(
      publishDraft(dal, { slug: old.slug, revSummary: { en: 'Publish draft' } }, user.id),
      { code: 'possible_duplicate' }
    );
    const checked = [article.slug, publishedFresh.slug];
    const published = await publishDraft(
      dal, { slug: old.slug, notDuplicateOf: checked, revSummary: { en: 'Publish draft' } }, user.id
    );
    assert.equal(published.slug, `${prefix}-old`);
    const tags = (await listWikiPageRevisions(dal, published.slug)).revisions[0]?.revTags ?? [];
    for (const slug of checked) assert.ok(tags.includes(`not-duplicate-of:${slug}`));
  } finally {
    await cleanup(prefix, [user.id]);
  }
});

test('drafts are blocked in robots.txt and marked noindex, with a banner', async () => {
  const dal = await getDal();
  const prefix = newPrefix('draft-robots');
  const user = await createTestUser();
  const server = await startServer();
  try {
    const robots = await (await fetch(`${server.url}/robots.txt`)).text();
    assert.match(robots, /^Disallow: \/draft\/$/m);
    assert.doesNotMatch(robots, /^Disallow: \/draft$/m);

    const draft = await createWikiPage(dal, { slug: prefix, title: { en: 'Draft' }, draft: true }, user.id);
    const article = await createWikiPage(dal, { slug: `${prefix}-draft`, title: { en: 'Draft horse' } }, user.id);
    const view = async (slug: string) => {
      const response = await fetch(`${server.url}/${slug}`);
      assert.equal(response.status, 200);
      return (await response.json()) as { noindex: boolean; bodyHtml: string };
    };
    const draftView = await view(draft.slug);
    assert.equal(draftView.noindex, true);
    assert.match(draftView.bodyHtml, /class="draft-banner"/);
    assert.doesNotMatch(draftView.bodyHtml, /publish-draft/);
    const articleView = await view(article.slug);
    assert.equal(articleView.noindex, false);
    assert.doesNotMatch(articleView.bodyHtml, /class="draft-banner"/);
  } finally {
    await server.close();
    await cleanup(prefix, [user.id]);
  }
});

test('MCP creates drafts and publishes them', async () => {
  const prefix = newPrefix('draft-mcp');
  const user = await createTestUser();
  const { server } = createMcpServer({ skipPolicyCheck: true });
  const client = new Client({ name: 'draft-flow-test', version: '1' });
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options, authInfo: { token: 'test', clientId: 'test', scopes: [], extra: { userId: user.id } },
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const created = await call('wiki_createPage', {
      slug: prefix, title: { en: `Mcp ${randomWord()}` }, draft: true, policyHash: 'test',
    });
    assert.equal(created.isError, undefined);
    assert.equal((created.structuredContent as { slug: string }).slug, `draft/${prefix}`);
    const published = await call('wiki_publishDraft', { slug: `draft/${prefix}`, policyHash: 'test' });
    assert.equal(published.isError, undefined);
    assert.equal((published.structuredContent as { slug: string }).slug, prefix);
    const page = await findCurrentPageBySlugOrAlias(`draft/${prefix}`);
    assert.equal(page?.slug, prefix);
    const history = await call('wiki_listRevisions', { slug: prefix });
    const tags = (history.structuredContent as { revisions: Array<{ revTags: string[] }> }).revisions[0].revTags;
    assert.ok(tags.includes('publish'));
    assert.ok(tags.includes('agent:draft-flow-test'));
  } finally {
    await client.close();
    await server.close();
    await cleanup(prefix, [user.id]);
  }
});

test('publish failures use localized messages for occupied addresses and possible duplicates', async () => {
  await initializeI18n();
  const dal = await getDal();
  const prefix = newPrefix('publish-errors');
  const user = await createTestUser();
  const server = await startServer('de');
  try {
    const { token } = await createSession(user.id);
    for (const reason of ['address', 'duplicates'] as const) {
      const slug = `${prefix}-${reason}`;
      const title = { en: randomWord() };
      const draft = await createWikiPage(
        dal, { slug, title, body: { en: 'Text.' }, draft: true }, user.id
      );
      await createWikiPage(
        dal,
        { slug: reason === 'address' ? slug : `${slug}-other`, title, body: { en: 'Text.' } },
        user.id
      );
      if (reason === 'duplicates') await ageDraft(draft.slug);
      const response = await fetch(`${server.url}/${draft.slug}/publish-draft`, {
        method: 'POST',
        headers: { cookie: `agpwiki_session=${token}` },
        redirect: 'manual',
      });
      assert.equal(response.status, 409);
      const key = reason === 'address' ? 'draft.publishAddressTaken' : 'draft.publishDuplicates';
      const expected = i18next.t(key, { lng: 'de' });
      assert.notEqual(expected, key);
      assert.notEqual(expected, i18next.t(key, { lng: 'en' }));
      const body = await response.text();
      assert.equal(body, expected);
      assert.equal((await findCurrentPageBySlugOrAlias(draft.slug))?.slug, draft.slug);
    }
  } finally {
    await server.close();
    await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [user.id]);
    await cleanup(prefix, [user.id]);
  }
});
