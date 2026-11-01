import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { createMcpServer } from '../src/mcp/core.js';
import User from '../src/models/user.js';
import { findPossibleDuplicates } from '../src/services/duplicate-check-service.js';
import {
  addWikiPageAlias,
  createWikiPage,
  listWikiPageRevisions,
  searchWikiPages,
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
    'DELETE FROM page_aliases WHERE slug LIKE $1 OR page_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
    [`${prefix}%`]
  );
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
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
        originalLanguage: 'en',
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
        originalLanguage: 'en',
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
        originalLanguage: 'de',
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
          originalLanguage: 'de',
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
      relatedArticles?: Array<{ slug: string }>;
    };
    assert.equal(payload.slug, newSlug);
    assert.ok(payload.relatedArticles?.some(item => item.slug === related));

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
      { slug, title: { fr: `Château ${word}` }, body: { fr: 'Texte.' }, originalLanguage: 'fr' },
      user.id
    );
    const results = await searchWikiPages(dal, { query: `château ${word}` });
    assert.deepEqual(results, [{ slug, title: `Château ${word}` }]);
  } finally {
    await cleanup(prefix, userId);
  }
});
