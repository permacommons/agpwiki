import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { pageNamespaceSql, resolvePageAddress } from '../src/lib/page-address.js';
import { createMcpServer } from '../src/mcp/core.js';
import User from '../src/models/user.js';
import { findPossibleDuplicates } from '../src/services/duplicate-check-service.js';
import {
  addWikiPageAlias,
  createWikiPage,
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
    username: `duptest${suffix}`,
    displayName: 'Duplicate Test',
    email: `duplicate-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

// Letters only, so titles stay unique among pages other tests create.
const randomWord = () =>
  Array.from({ length: 10 }, () => String.fromCharCode(97 + randomInt(26))).join('');

const randomWikidataId = () => `Q${randomInt(100_000_000, 999_999_999)}`;

type ToolResult = { isError?: boolean; structuredContent: unknown };
type ToolHandler = (
  args: unknown,
  extra?: { authInfo?: { extra?: { userId?: string } } }
) => Promise<ToolResult>;

const getToolHandlers = (server: object) =>
  (server as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools;

const cleanup = async (prefix: string, userId: string | null) => {
  const dal = await getDal();
  await dal.query(
    'DELETE FROM page_aliases WHERE slug LIKE $1 OR slug LIKE $2 OR page_id IN (SELECT id FROM pages WHERE slug LIKE $1 OR slug LIKE $2)',
    [`${prefix}%`, `meta/${prefix}%`]
  );
  await dal.query('DELETE FROM pages WHERE slug LIKE $1 OR slug LIKE $2', [`${prefix}%`, `meta/${prefix}%`]);
  if (userId) await dal.query('DELETE FROM users WHERE id = $1', [userId]);
};

test('Possible duplicates are found by Wikidata item, title, alias and address', async () => {
  const dal = await getDal();
  const prefix = `test-dup-${Date.now()}`;
  const word = randomWord();
  const wikidata = randomWikidataId();
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const slug = `${prefix}-gutenberg-bible`;
    await createWikiPage(
      dal,
      {
        slug,
        title: { en: `Gutenberg Bible ${word}` },
        body: { en: 'Text.' },
        canonicalLanguage: 'en',
        wikidata,
      },
      user.id
    );
    await addWikiPageAlias(dal, { slug: `${prefix}-bible-of-mainz`, pageSlug: slug }, user.id);

    const matchesFor = async (input: Parameters<typeof findPossibleDuplicates>[1]) =>
      (await findPossibleDuplicates(dal, input)).duplicates.find(item => item.slug === slug)
        ?.matchedBy;

    assert.deepEqual(await matchesFor({ titles: [`Gutenberg-Bibel ${randomWord()}`], wikidata }), [
      'wikidata',
    ]);
    assert.deepEqual(await matchesFor({ titles: [`GUTENBERG bíble — ${word}`] }), ['title']);
    assert.deepEqual(await matchesFor({ titles: [`${prefix} Bible of Mainz`] }), ['alias']);
    assert.deepEqual(
      await matchesFor({ titles: [randomWord()], slug: `${prefix}-gutenbergbibles` }),
      ['address']
    );
    assert.equal(await matchesFor({ titles: [`Gutenberg Bible ${randomWord()}`] }), undefined);

    const meta = await findPossibleDuplicates(dal, {
      titles: [`Gutenberg Bible ${word}`],
      slug: 'meta/proposals/some-proposal',
      wikidata,
    });
    assert.deepEqual(meta, { duplicates: [], related: [] });
  } finally {
    await cleanup(prefix, userId);
  }
});

test('Related articles share main title words and never count as duplicates', async () => {
  const dal = await getDal();
  const prefix = `test-dup-related-${Date.now()}`;
  const word = randomWord();
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const relatedSlug = `${prefix}-france-world-wars`;
    await createWikiPage(
      dal,
      {
        slug: relatedSlug,
        title: {
          fr: `La France ${word} dans les guerres mondiales`,
          en: `${word} France in the World Wars`,
        },
        body: { en: 'Text.' },
      },
      user.id
    );
    await createWikiPage(
      dal,
      { slug: `${prefix}-other`, title: { en: `${word} History of Spain` }, body: { en: 'Text.' } },
      user.id
    );

    const result = await findPossibleDuplicates(dal, { titles: [`${word} France in World War II`] });
    assert.equal(
      result.duplicates.some(item => item.slug.startsWith(prefix)),
      false
    );
    const related = result.related.filter(item => item.slug.startsWith(prefix));
    assert.deepEqual(
      related.map(item => item.slug),
      [relatedSlug]
    );
    assert.deepEqual(related[0]?.languages.sort(), ['en', 'fr']);

    const singleTitle = await findPossibleDuplicates(dal, { titles: [word] });
    const translatedTitles = await findPossibleDuplicates(dal, { titles: [word, randomWord()] });
    const fixtureSlugs = (result: typeof singleTitle) =>
      result.related.filter(page => page.slug.startsWith(prefix)).map(page => page.slug);
    assert.deepEqual(fixtureSlugs(singleTitle), [relatedSlug, `${prefix}-other`].sort());
    assert.deepEqual(fixtureSlugs(translatedTitles), fixtureSlugs(singleTitle));
  } finally {
    await cleanup(prefix, userId);
  }
});

test('wiki_createPage refuses a possible duplicate unless every match is set aside', async () => {
  const dal = await getDal();
  const prefix = `test-dup-create-${Date.now()}`;
  const word = randomWord();
  const wikidata = randomWikidataId();
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const existing = `${prefix}-gutenberg-bible`;
    await createWikiPage(
      dal,
      {
        slug: existing,
        title: { en: `Gutenberg Bible ${word}` },
        body: { en: 'Text.' },
        canonicalLanguage: 'en',
        wikidata,
      },
      user.id
    );
    const sameTitle = `${prefix}-other-bible`;
    await createWikiPage(
      dal,
      {
        slug: sameTitle,
        title: { de: `Gutenberg-Bibel ${word}` },
        body: { de: 'Text.' },
        canonicalLanguage: 'de',
      },
      user.id
    );
    const related = `${prefix}-printing`;
    await createWikiPage(
      dal,
      {
        slug: related,
        title: { en: `Printing of the Gutenberg Bibel ${word}` },
        body: { en: 'Text.' },
      },
      user.id
    );

    const { server } = createMcpServer({ skipPolicyCheck: true });
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };
    const newSlug = `${prefix}-gutenberg-bibel`;
    const create = (notDuplicateOf?: string[]) =>
      tools.wiki_createPage.handler(
        {
          slug: newSlug,
          title: { de: `Gutenberg-Bibel ${word}` },
          body: { de: 'Text.' },
          canonicalLanguage: 'de',
          wikidata,
          notDuplicateOf,
        },
        { authInfo }
      );
    type Refusal = {
      error: {
        code: string;
        message: string;
        details: { duplicates: Array<{ slug: string; matchedBy: string[] }> };
      };
    };

    const refused = await create();
    assert.equal(refused.isError, true);
    const refusal = refused.structuredContent as Refusal;
    assert.equal(refusal.error.code, 'possible_duplicate');
    assert.deepEqual(
      refusal.error.details.duplicates.map(item => item.slug),
      [existing, sameTitle]
    );
    assert.match(refusal.error.message, /^Not created: "Gutenberg-Bibel /);
    assert.ok(refusal.error.message.includes(`English, same Wikidata item ${wikidata}`));
    assert.ok(refusal.error.message.includes(`notDuplicateOf: ["${existing}","${sameTitle}"]`));

    const partial = await create([existing]);
    assert.equal(partial.isError, true);
    assert.deepEqual(
      (partial.structuredContent as Refusal).error.details.duplicates.map(item => item.slug),
      [sameTitle]
    );

    const accepted = await create([existing, sameTitle.toUpperCase()]);
    assert.equal(accepted.isError, undefined);
    const payload = accepted.structuredContent as {
      slug: string;
      relatedPages?: Array<{ slug: string }>;
    };
    assert.equal(payload.slug, newSlug);
    assert.ok(payload.relatedPages?.some(item => item.slug === related));

    const history = await listWikiPageRevisions(dal, newSlug);
    const tags = history.revisions[0]?.revTags ?? [];
    assert.ok(tags.includes(`not-duplicate-of:${existing}`));
    assert.ok(tags.includes(`not-duplicate-of:${sameTitle}`));

    const metaSlug = `meta/${prefix}`;
    const meta = await tools.wiki_createPage.handler(
      { slug: metaSlug, title: { en: `Gutenberg Bible ${word}` }, body: { en: 'Text.' }, wikidata },
      { authInfo }
    );
    assert.equal(meta.isError, undefined);
    await dal.query('DELETE FROM pages WHERE slug = $1', [metaSlug]);

    const found = await tools.wiki_findPossibleDuplicates.handler({
      title: `gutenberg bible ${word}`,
    });
    assert.equal(found.isError, undefined);
    assert.ok(
      (found.structuredContent as { duplicates: Array<{ slug: string }> }).duplicates.some(
        item => item.slug === existing
      )
    );
  } finally {
    await cleanup(prefix, userId);
  }
});

test('Search finds titles in every language', async () => {
  const dal = await getDal();
  const prefix = `test-dup-search-${Date.now()}`;
  const word = randomWord();
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const slug = `${prefix}-chateau`;
    await createWikiPage(
      dal,
      { slug, title: { fr: `Château ${word}` }, body: { fr: 'Texte.' }, canonicalLanguage: 'fr' },
      user.id
    );
    const results = await searchWikiPages(dal, { query: `château ${word}` });
    assert.deepEqual(results, [{ slug, title: `Château ${word}` }]);
  } finally {
    await cleanup(prefix, userId);
  }
});


test('Meta duplicates are enforced in the service and stay separate from articles', async () => {
  const dal = await getDal();
  const prefix = `test-namespace-${Date.now()}`;
  const word = randomWord();
  const title = { en: `Values ${word}` };
  const wikidata = randomWikidataId();
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const article = await createWikiPage(dal, { slug: prefix, title, wikidata }, user.id);
    const meta = await createWikiPage(dal, { slug: `meta/${prefix}`, title, wikidata }, user.id);
    const matches = await findPossibleDuplicates(dal, {
      titles: Object.values(title), slug: `meta/${prefix}-new`, wikidata,
    });
    assert.deepEqual(matches.duplicates.map(page => page.slug), [meta.slug]);
    assert.deepEqual((await findPossibleDuplicates(dal, {
      titles: Object.values(title), wikidata,
    })).duplicates.map(page => page.slug), [article.slug]);

    await assert.rejects(createWikiPage(dal, {
      slug: `meta/${prefix}-new`, title, wikidata,
    }, user.id), { code: 'possible_duplicate' });
    const missing = await dal.query('SELECT id FROM pages WHERE slug = $1', [`meta/${prefix}-new`]);
    assert.equal(missing.rows.length, 0);
    await assert.rejects(createWikiPage(dal, {
      slug: `tool/${prefix}`, title, wikidata,
    }, user.id), { code: 'invalid_request' });
    await assert.rejects(findPossibleDuplicates(dal, {
      titles: Object.values(title), slug: `tool/${prefix}`,
    }), { code: 'invalid_request' });

    const accepted = await createWikiPage(dal, {
      slug: `meta/${prefix}-new`, title, wikidata, notDuplicateOf: [meta.slug],
    }, user.id);
    const history = await listWikiPageRevisions(dal, accepted.slug);
    assert.ok(history.revisions[0]?.revTags?.includes(`not-duplicate-of:${meta.slug}`));
  } finally {
    await cleanup(prefix, userId);
  }
});

test('Aliases keep their own namespace when a page moves between namespaces', async () => {
  const dal = await getDal();
  const prefix = `test-namespace-alias-${Date.now()}`;
  const word = randomWord();
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    await createWikiPage(dal, { slug: prefix, title: { en: word } }, user.id);
    const moved = await updateWikiPage(dal, {
      slug: prefix, newSlug: `meta/${prefix}`, revSummary: { en: 'Move test page' },
    }, user.id);
    const titles = await findPossibleDuplicates(dal, { titles: [word] });
    assert.equal(titles.duplicates.some(page => page.slug === moved.slug), false);
    const aliases = await findPossibleDuplicates(dal, { titles: [prefix] });
    assert.deepEqual(aliases.duplicates.map(page => [page.slug, page.matchedBy]), [
      [moved.slug, ['alias']],
    ]);
    const addresses = await findPossibleDuplicates(dal, { titles: [], slug: prefix });
    assert.deepEqual(addresses.duplicates.map(page => page.slug), [moved.slug]);
    await dal.query('UPDATE pages SET _rev_deleted = true WHERE id = $1', [moved.id]);
    const deleted = await findPossibleDuplicates(dal, { titles: [prefix], slug: prefix });
    assert.deepEqual(deleted, { duplicates: [], related: [] });
  } finally {
    await cleanup(prefix, userId);
  }
});


test('Database namespace scoping agrees with address classification', async () => {
  const dal = await getDal();
  const slugs = ['values', 'meta/values', 'meta/proposals/x', 'foo/bar', 'metadata/x',
    'tool/x', 'api/x', 'blog/x', 'mcp', '.well-known/x'];
  const result = await dal.query(
    `SELECT slug, ${pageNamespaceSql()} AS namespace FROM unnest($1::text[]) AS slug`, [slugs]
  );
  for (const row of result.rows) {
    assert.equal(row.namespace, resolvePageAddress(row.slug)?.namespace ?? null);
  }
});

test('MCP transport supports meta duplicate discovery, refusal and override', async () => {
  const dal = await getDal();
  const prefix = `test-namespace-mcp-${Date.now()}`;
  const title = `Scope ${randomWord()}`;
  const { server } = createMcpServer({ skipPolicyCheck: true });
  const client = new Client({ name: 'namespace-flow-test', version: '1' });
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options, authInfo: { token: 'test', clientId: 'test', scopes: [], extra: { userId: user.id } },
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const input = { slug: `meta/${prefix}`, title: { en: title }, canonicalLanguage: 'en', policyHash: 'test' };
    const created = await call('wiki_createPage', input);
    assert.equal(created.isError, undefined);
    const article = await call('wiki_createPage', { ...input, slug: prefix });
    assert.equal(article.isError, undefined);
    const discovered = await call('wiki_findPossibleDuplicates', { title, slug: input.slug });
    assert.deepEqual((discovered.structuredContent as { duplicates: Array<{ slug: string }> }).duplicates.map(page => page.slug), [input.slug]);
    const duplicate = { ...input, slug: `meta/${prefix}-second` };
    const refused = await call('wiki_createPage', duplicate);
    assert.equal(refused.isError, true);
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'possible_duplicate');
    const accepted = await call('wiki_createPage', { ...duplicate, notDuplicateOf: [input.slug] });
    assert.equal(accepted.isError, undefined);
    const history = await call('wiki_listRevisions', { slug: duplicate.slug });
    const tags = (history.structuredContent as { revisions: Array<{ revTags: string[] }> }).revisions[0].revTags;
    assert.ok(tags.includes(`not-duplicate-of:${input.slug}`));
    assert.ok(tags.includes('agent:namespace-flow-test'));
    const reserved = await call('wiki_findPossibleDuplicates', { title, slug: `tool/${prefix}` });
    assert.equal(reserved.isError, true);
  } finally {
    await client.close();
    await server.close();
    await cleanup(prefix, userId);
  }
});
