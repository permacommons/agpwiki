import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { createMcpServer } from '../src/mcp/core.js';
import { toToolErrorPayload } from '../src/mcp/errors.js';
import BlogPost from '../src/models/blog-post.js';
import Citation from '../src/models/citation.js';
import CitationClaim from '../src/models/citation-claim.js';
import Media from '../src/models/media.js';
import PageCheck from '../src/models/page-check.js';
import User from '../src/models/user.js';
import WikiPage from '../src/models/wiki-page.js';
import { createBlogPost } from '../src/services/blog-post-service.js';
import { createCitationClaim } from '../src/services/citation-claim-service.js';
import { createCitation } from '../src/services/citation-service.js';
import { createMedia, refreshMedia } from '../src/services/media-service.js';
import { createPageCheck } from '../src/services/page-check-service.js';
import { BLOG_AUTHOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

type ToolResult = { isError?: boolean; structuredContent: unknown };

type ToolHandler = (
  args: unknown,
  extra?: { authInfo?: { extra?: { userId?: string } } }
) => Promise<ToolResult>;

type ErrorPayload = {
  error: {
    code: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
};

type RevisionedInstance = {
  _revID: string;
  newRevision: (user: { id: string }, options: { tags: string[] }) => Promise<unknown>;
  updatedAt?: Date | null;
};

type RevisionedModel = {
  prototype: object;
  filterWhere: (where: Record<string, unknown>) => { first: () => Promise<unknown> };
};

type Fixture = {
  Model: RevisionedModel;
  id: string;
  revisionParam: 'expectedRevId' | 'baseRevId';
  invoke: (revisionId: string | undefined, step: number) => Promise<ToolResult>;
  snapshot: (current: Record<string, unknown>) => unknown;
  cleanup: () => Promise<void>;
};

let sharedDal: Dal | null = null;

const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const uniqueSuffix = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;

const createTestUser = async () => {
  const suffix = uniqueSuffix();
  return User.create({
    username: `expectedrev${suffix}`,
    displayName: 'Expected Revision Test',
    email: `expected-rev-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const cleanupUser = async (dal: Dal, userId: string) => {
  await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  await dal.query('DELETE FROM users WHERE id = $1', [userId]);
};

const getTools = () => {
  const { server } = createMcpServer({ skipPolicyCheck: true });
  return (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })
    ._registeredTools;
};

const readCurrent = async (fixture: Fixture) => {
  const current = (await fixture.Model.filterWhere({
    id: fixture.id,
    _oldRevOf: null,
    _revDeleted: false,
  }).first()) as (RevisionedInstance & Record<string, unknown>) | null;
  assert.ok(current, 'fixture document exists');
  return current;
};

const stubCommonsFetcher = async () => ({
  mediaType: 'image' as const,
  data: {
    commonsPageUrl: 'https://commons.wikimedia.org/wiki/File:Expected_Revision.jpg',
    mime: 'image/jpeg',
    width: 800,
    height: 600,
    thumbnailUrlTemplate: 'https://example/thumb/Expected_Revision.jpg/960px-Expected_Revision.jpg',
    originalUrl: 'https://example/Expected_Revision.jpg',
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    author: 'Jane Doe',
    fetchedAt: new Date().toISOString(),
  },
});

// Saves a concurrent revision of the same document right before the next
// save() on the model, i.e. after the service has checked the expected
// revision but before its own save reaches the database.
const saveConcurrentRevisionBeforeNextSave = (
  t: TestContext,
  Model: RevisionedModel,
  userId: string
) => {
  const prototype = Model.prototype as { save: (...args: unknown[]) => Promise<unknown> };
  const originalSave = prototype.save;
  let raced = false;
  const saveMock = t.mock.method(
    prototype,
    'save',
    async function (this: RevisionedInstance & { id: string }, ...args: unknown[]) {
      if (!raced) {
        raced = true;
        const other = (await Model.filterWhere({ id: this.id }).first()) as RevisionedInstance;
        await other.newRevision({ id: userId }, { tags: ['concurrent-test'] });
        other.updatedAt = new Date();
        await originalSave.call(other);
      }
      return originalSave.apply(this, args);
    }
  );
  return () => saveMock.mock.restore();
};

const assertWriteSucceeded = (result: ToolResult, label: string) => {
  assert.equal(result.isError, undefined, `${label}: ${JSON.stringify(result.structuredContent)}`);
  const payload = result.structuredContent as { currentRevId?: string };
  assert.match(payload.currentRevId ?? '', /^[0-9a-f-]{36}$/, `${label} returns currentRevId`);
  return payload.currentRevId as string;
};

const assertErrorPayload = (result: ToolResult, label: string) => {
  assert.equal(result.isError, true, `${label} fails`);
  return (result.structuredContent as ErrorPayload).error;
};

const runExpectedRevisionScenario = async (
  t: TestContext,
  userId: string,
  fixture: Fixture
) => {
  const { revisionParam } = fixture;
  const initial = await readCurrent(fixture);
  const staleRevId = initial._revID;

  await t.test('an omitted expected revision saves as before', async () => {
    const newRevId = assertWriteSucceeded(await fixture.invoke(undefined, 1), 'omitted');
    assert.notEqual(newRevId, staleRevId);
    assert.equal((await readCurrent(fixture))._revID, newRevId);
  });

  await t.test('a stale expected revision fails and writes nothing', async () => {
    const before = await readCurrent(fixture);
    const error = assertErrorPayload(await fixture.invoke(staleRevId, 2), 'stale');
    assert.equal(error.code, 'precondition_failed');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, {
      currentRevId: before._revID,
      [revisionParam]: staleRevId,
    });

    const after = await readCurrent(fixture);
    assert.equal(after._revID, before._revID);
    assert.deepEqual(fixture.snapshot(after), fixture.snapshot(before));
  });

  await t.test('the current revision saves', async () => {
    const before = await readCurrent(fixture);
    const newRevId = assertWriteSucceeded(await fixture.invoke(before._revID, 3), 'current');
    assert.notEqual(newRevId, before._revID);
    assert.equal((await readCurrent(fixture))._revID, newRevId);
  });

  await t.test('a race after the check is still precondition_failed', async subtest => {
    const before = await readCurrent(fixture);
    const restore = saveConcurrentRevisionBeforeNextSave(subtest, fixture.Model, userId);
    const result = await fixture.invoke(before._revID, 4);
    restore();

    const error = assertErrorPayload(result, 'race with expected revision');
    const after = await readCurrent(fixture);
    assert.notEqual(after._revID, before._revID, 'the concurrent revision was saved');
    assert.equal(error.code, 'precondition_failed');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, {
      currentRevId: after._revID,
      [revisionParam]: before._revID,
    });
    assert.deepEqual(fixture.snapshot(after), fixture.snapshot(before));
  });

  await t.test('a race without an expected revision stays a retryable conflict', async subtest => {
    const before = await readCurrent(fixture);
    const restore = saveConcurrentRevisionBeforeNextSave(subtest, fixture.Model, userId);
    const result = await fixture.invoke(undefined, 5);
    restore();

    const error = assertErrorPayload(result, 'race without expected revision');
    const after = await readCurrent(fixture);
    assert.equal(error.code, 'conflict');
    assert.equal(error.retryable, true);
    assert.equal(error.details?.currentRevId, after._revID);
    assert.deepEqual(fixture.snapshot(after), fixture.snapshot(before));
  });
};

const withFixture = async (
  t: TestContext,
  build: (context: { dal: Dal; userId: string }) => Promise<Fixture>
) => {
  const dal = await getDal();
  const user = await createTestUser();
  let fixture: Fixture | null = null;
  try {
    fixture = await build({ dal, userId: user.id });
    await runExpectedRevisionScenario(t, user.id, fixture);
  } finally {
    await fixture?.cleanup();
    await cleanupUser(dal, user.id);
  }
};

const createWikiFixture = async (dal: Dal, userId: string) => {
  const slug = `test-expected-rev-${uniqueSuffix()}`;
  const page = await createWikiPage(
    dal,
    { slug, title: { en: 'Expected Revision' }, body: { en: 'Body 0' }, originalLanguage: 'en' },
    userId
  );
  return {
    slug,
    id: page.id,
    cleanup: async () => {
      await dal.query('DELETE FROM pages WHERE slug = $1', [slug]);
    },
  };
};

const wikiToolFixture = (
  tool: string,
  revisionParam: Fixture['revisionParam'],
  buildArgs: (slug: string, currentBody: string, step: number) => Record<string, unknown>
) =>
  async ({ dal, userId }: { dal: Dal; userId: string }): Promise<Fixture> => {
    const { slug, id, cleanup } = await createWikiFixture(dal, userId);
    const tools = getTools();
    const authInfo = { extra: { userId } };
    return {
      Model: WikiPage,
      id,
      revisionParam,
      invoke: async (revisionId, step) => {
        const current = (await WikiPage.filterWhere({ id }).first()) as { body?: { en?: string } };
        return tools[tool].handler(
          {
            ...buildArgs(slug, current.body?.en ?? '', step),
            ...(revisionId ? { [revisionParam]: revisionId } : {}),
            revSummary: { en: `Step ${step}.` },
          },
          { authInfo }
        );
      },
      snapshot: current => current.body,
      cleanup,
    };
  };

test('wiki_updatePage honors expectedRevId', async t => {
  await withFixture(
    t,
    wikiToolFixture('wiki_updatePage', 'expectedRevId', (slug, _body, step) => ({
      slug,
      body: { en: `Body ${step}` },
    }))
  );
});

test('wiki_applyPatch keeps honoring baseRevId', async t => {
  await withFixture(
    t,
    wikiToolFixture('wiki_applyPatch', 'baseRevId', (slug, body, step) => ({
      slug,
      format: 'unified',
      patch: `--- a/${slug}\n+++ b/${slug}\n@@ -1 +1 @@\n-${body}\n+Body ${step}\n`,
    }))
  );
});

test('wiki_rewriteSection honors expectedRevId', async t => {
  await withFixture(
    t,
    wikiToolFixture('wiki_rewriteSection', 'expectedRevId', (slug, _body, step) => ({
      slug,
      target: 'lead',
      mode: 'replace',
      content: `Body ${step}`,
    }))
  );
});

test('wiki_replaceExactText honors expectedRevId', async t => {
  await withFixture(
    t,
    wikiToolFixture('wiki_replaceExactText', 'expectedRevId', (slug, body, step) => ({
      slug,
      replacements: [{ from: body, to: `Body ${step}` }],
    }))
  );
});

test('blog_updatePost honors expectedRevId', async t => {
  await withFixture(t, async ({ dal, userId }) => {
    await grantRoleUpsert(dal, userId, BLOG_AUTHOR_ROLE);
    const slug = `test-expected-rev-post-${uniqueSuffix()}`;
    const post = await createBlogPost(
      dal,
      { slug, title: { en: 'Expected Revision' }, body: { en: 'Body 0' } },
      userId
    );
    const tools = getTools();
    return {
      Model: BlogPost,
      id: post.id,
      revisionParam: 'expectedRevId',
      invoke: (expectedRevId, step) =>
        tools.blog_updatePost.handler(
          { slug, body: { en: `Body ${step}` }, expectedRevId, revSummary: { en: `Step ${step}.` } },
          { authInfo: { extra: { userId } } }
        ),
      snapshot: current => current.body,
      cleanup: async () => {
        await dal.query('DELETE FROM posts WHERE slug = $1', [slug]);
      },
    };
  });
});

const citationData = (step: number) => ({
  type: 'webpage',
  title: `Expected revision citation ${step}`,
  URL: 'https://example.com/expected-revision',
});

test('citation_update honors expectedRevId', async t => {
  await withFixture(t, async ({ dal, userId }) => {
    const key = `test-expected-rev-cite-${uniqueSuffix()}`;
    const citation = await createCitation(dal, { key, data: citationData(0) }, userId);
    const tools = getTools();
    return {
      Model: Citation,
      id: citation.id,
      revisionParam: 'expectedRevId',
      invoke: (expectedRevId, step) =>
        tools.citation_update.handler(
          { key, data: citationData(step), expectedRevId, revSummary: { en: `Step ${step}.` } },
          { authInfo: { extra: { userId } } }
        ),
      snapshot: current => current.data,
      cleanup: async () => {
        await dal.query('DELETE FROM citations WHERE key = $1', [key]);
      },
    };
  });
});

test('claim_update honors expectedRevId', async t => {
  await withFixture(t, async ({ dal, userId }) => {
    const key = `test-expected-rev-claim-${uniqueSuffix()}`;
    const claimId = 'expected-rev-claim';
    const citation = await createCitation(dal, { key, data: citationData(0) }, userId);
    const claim = await createCitationClaim(
      dal,
      { key, claimId, assertion: { en: 'Assertion 0.' } },
      userId
    );
    const tools = getTools();
    return {
      Model: CitationClaim,
      id: claim.id,
      revisionParam: 'expectedRevId',
      invoke: (expectedRevId, step) =>
        tools.claim_update.handler(
          {
            key,
            claimId,
            assertion: { en: `Assertion ${step}.` },
            expectedRevId,
            revSummary: { en: `Step ${step}.` },
          },
          { authInfo: { extra: { userId } } }
        ),
      snapshot: current => current.assertion,
      cleanup: async () => {
        await dal.query('DELETE FROM citation_claims WHERE citation_id = $1', [citation.id]);
        await dal.query('DELETE FROM citations WHERE key = $1', [key]);
      },
    };
  });
});

const createMediaFixture = async (dal: Dal, userId: string) => {
  const slug = `test-expected-rev-media-${uniqueSuffix()}`;
  const media = await createMedia(
    dal,
    { slug, commonsTitle: `File:Expected_Revision_${uniqueSuffix()}.jpg` },
    userId,
    { commonsFetcher: stubCommonsFetcher }
  );
  return {
    slug,
    id: media.id,
    cleanup: async () => {
      await dal.query('DELETE FROM media WHERE slug = $1', [slug]);
    },
  };
};

test('media_update honors expectedRevId', async t => {
  await withFixture(t, async ({ dal, userId }) => {
    const { slug, id, cleanup } = await createMediaFixture(dal, userId);
    const tools = getTools();
    return {
      Model: Media,
      id,
      revisionParam: 'expectedRevId',
      invoke: (expectedRevId, step) =>
        tools.media_update.handler(
          { slug, caption: { en: `Caption ${step}` }, expectedRevId, revSummary: { en: `Step ${step}.` } },
          { authInfo: { extra: { userId } } }
        ),
      snapshot: current => current.caption ?? null,
      cleanup,
    };
  });
});

// The media_refresh tool fetches from Commons, so this drives the service with
// a stubbed fetcher and maps errors the same way the MCP layer does.
test('media_refresh honors expectedRevId', async t => {
  await withFixture(t, async ({ dal, userId }) => {
    const { slug, id, cleanup } = await createMediaFixture(dal, userId);
    return {
      Model: Media,
      id,
      revisionParam: 'expectedRevId',
      invoke: async (expectedRevId, step) => {
        try {
          const result = await refreshMedia(
            dal,
            { slug, expectedRevId, revSummary: { en: `Step ${step}.` } },
            userId,
            { commonsFetcher: stubCommonsFetcher }
          );
          return { structuredContent: result };
        } catch (error) {
          return { isError: true, structuredContent: toToolErrorPayload(error) };
        }
      },
      snapshot: current => (current.data as { fetchedAt?: string } | null)?.fetchedAt ?? null,
      cleanup,
    };
  });
});

const checkMetrics = {
  issues_found: { high: 0, medium: 0, low: 1 },
  issues_fixed: { high: 0, medium: 0, low: 0 },
};

test('page_check_update honors expectedRevId', async t => {
  await withFixture(t, async ({ dal, userId }) => {
    const { slug, cleanup } = await createWikiFixture(dal, userId);
    const page = (await WikiPage.filterWhere({ slug }).first()) as { id: string; _revID: string };
    const check = await createPageCheck(
      dal,
      {
        slug,
        type: 'copy_edit',
        status: 'completed',
        checkResults: { en: 'Results 0.' },
        metrics: checkMetrics,
        targetRevId: page._revID,
      },
      userId
    );
    const tools = getTools();
    return {
      Model: PageCheck,
      id: check.id,
      revisionParam: 'expectedRevId',
      invoke: (expectedRevId, step) =>
        tools.page_check_update.handler(
          {
            checkId: check.id,
            checkResults: { en: `Results ${step}.` },
            expectedRevId,
            revSummary: { en: `Step ${step}.` },
          },
          { authInfo: { extra: { userId } } }
        ),
      snapshot: current => current.checkResults,
      cleanup: async () => {
        await dal.query('DELETE FROM page_checks WHERE page_id = $1', [page.id]);
        await cleanup();
      },
    };
  });
});
