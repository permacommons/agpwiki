import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { resolveAuthUserId } from '../src/mcp/auth.js';
import {
  applyWikiPagePatch,
  createCitation,
  createWikiPage,
  listWikiPageRevisions,
  updateWikiPage,
} from '../src/mcp/handlers.js';
import ApiToken from '../src/models/api-token.js';
import User from '../src/models/user.js';
import { renderMarkdown } from '../src/render.js';

const generateToken = () => `agp_${randomBytes(24).toString('hex')}`;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

const getDal = async () => {
  if (sharedDal) return sharedDal;
  sharedDal = await initializePostgreSQL();
  return sharedDal;
};

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const createTestUser = async (dal: Awaited<ReturnType<typeof initializePostgreSQL>>) => {
  const email = `mcp-test-${Date.now()}@example.com`;
  const user = await User.create({
    displayName: 'MCP Test',
    email,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });

  const token = generateToken();
  await ApiToken.create({
    userId: user.id,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 8),
    label: 'integration-test',
    createdAt: new Date(),
  });

  return { user, token };
};

const cleanupTestArtifacts = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  {
    slugPrefix,
    citationPrefix,
    userId,
  }: { slugPrefix?: string; citationPrefix?: string; userId?: string }
) => {
  if (slugPrefix) {
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (citationPrefix) {
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [citationPrefix]);
  }
  if (userId) {
    await dal.query('DELETE FROM api_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

test('MCP auth + wiki create/update writes revisions', async () => {
  const dal = await getDal();
  const slug = `test-mcp-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;

    const userId = await resolveAuthUserId();
    assert.equal(userId, user.id);

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'MCP Test' },
        body: { en: 'Initial content.' },
        originalLanguage: 'en',
      },
      userId,
    );

    await updateWikiPage(
      dal,
      {
        slug,
        body: { en: 'Updated content.' },
        revSummary: { en: 'Update content.' },
      },
      userId,
    );

    const revisions = await listWikiPageRevisions(dal, slug);
    assert.equal(revisions.pageId.length > 0, true);
    assert.ok(revisions.revisions.length >= 2);
    assert.ok(revisions.revisions.every(rev => rev.revUser === userId));
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP apply patch updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Patch Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = [
      '--- before',
      '+++ after',
      '@@ -1 +1 @@',
      '-Hello old world',
      '+Hello new world',
    ].join('\n');

    const result = await applyWikiPagePatch(
      dal,
      {
        slug,
        patch,
        format: 'unified',
        lang: 'en',
        revSummary: { en: 'Patch update.' },
      },
      userId
    );

    assert.equal(result.body?.en, 'Hello new world');
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('renderMarkdown includes bibliography entries for citations', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Agpedia Test Citation',
          URL: 'https://example.com/test-citation',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const html = await renderMarkdown(`Testing [@${citationKey}].`, [citation.data ?? {}]);
    assert.match(html, /Agpedia Test Citation/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});
