import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { ValidationError } from '../src/lib/errors.js';
import AgentAccessRequest from '../src/models/agent-access-request.js';
import User from '../src/models/user.js';
import { restoreWikiPageRevision } from '../src/services/page-revert-service.js';
import {
  applyWikiPagePatch,
  createWikiPage,
  diffWikiPageRevisions,
  readWikiPage,
  replaceWikiPageExactText,
  rewriteWikiPageSection,
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

const pause = () => new Promise(resolve => setTimeout(resolve, 5));

const createTestUser = async () => {
  await getDal();
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const user = await User.create({
    username: `canonlangtest${suffix}`,
    displayName: 'Canonical Language Test',
    email: `canonlang-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
  });
  await AgentAccessRequest.create({
    userId: user.id,
    interests: 'Translation testing',
    profileUrl: 'https://example.com/profile',
    status: 'approved',
    createdAt: new Date(),
    submittedAt: new Date(),
    reviewedAt: new Date(),
    approvedAt: new Date(),
  });
  return user;
};

const cleanup = async (prefix: string, userId: string | null) => {
  const dal = await getDal();
  await dal.query("DELETE FROM notification_jobs WHERE payload->>'slug' LIKE $1", [`${prefix}%`]);
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
  if (userId) {
    await dal.query('DELETE FROM agent_access_requests WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

const summary = (en: string) => ({ en });

const setupTranslatedPage = async (prefix: string, userId: string) => {
  const dal = await getDal();
  const slug = `${prefix}-page`;
  const created = await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Lake' },
      body: { en: 'The lake is deep.\n\n## History\n\nIt formed long ago.\n' },
      canonicalLanguage: 'en',
    },
    userId
  );
  await pause();
  const translated = await updateWikiPage(
    dal,
    {
      slug,
      title: { fr: 'Lac' },
      body: { fr: 'Le lac est profond.\n\n## Histoire\n\nIl s’est formé il y a longtemps.\n' },
      translatedFrom: { language: 'en', revId: created.currentRevId },
      revSummary: summary('Add French translation'),
    },
    userId
  );
  await pause();
  return { dal, slug, created, translated };
};

test('a translation records its canonical source and counts edits behind', async () => {
  const prefix = `test-canonlang-${Date.now()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const { dal, slug, created } = await setupTranslatedPage(prefix, user.id);

    let page = await readWikiPage(dal, slug);
    assert.deepEqual(page.translatedFrom, {
      fr: { language: 'en', revId: created.currentRevId, editsBehind: 0 },
    });

    await replaceWikiPageExactText(
      dal,
      {
        slug,
        replacements: [{ from: 'deep', to: 'very deep' }],
        lang: 'en',
        revSummary: summary('Clarify depth'),
      },
      user.id
    );
    await pause();
    // Edits to the translation alone or to the canonical title do not count.
    await updateWikiPage(
      dal,
      { slug, title: { en: 'The lake' }, body: { fr: 'Le lac est très profond.\n' }, revSummary: summary('Edit') },
      user.id
    );
    await pause();
    const latest = await rewriteWikiPageSection(
      dal,
      { slug, heading: 'History', content: 'It formed in the last ice age.\n', revSummary: summary('History') },
      user.id
    );
    await pause();

    page = await readWikiPage(dal, slug);
    assert.deepEqual(page.translatedFrom, {
      fr: { language: 'en', revId: created.currentRevId, editsBehind: 2 },
    });

    await applyWikiPagePatch(
      dal,
      {
        slug,
        lang: 'fr',
        format: 'unified',
        patch: '@@ -1 +1 @@\n-Le lac est très profond.\n+Le lac est très profond. Il s’est formé pendant la dernière glaciation.\n',
        translatedFrom: { language: 'en', revId: latest.currentRevId },
        revSummary: summary('Update French'),
      },
      user.id
    );
    page = await readWikiPage(dal, slug);
    assert.deepEqual(page.translatedFrom, {
      fr: { language: 'en', revId: latest.currentRevId, editsBehind: 0 },
    });
  } finally {
    await cleanup(prefix, userId);
  }
});

test('translatedFrom must point at the canonical version', async () => {
  const prefix = `test-canonlang-invalid-${Date.now()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const { dal, slug, created, translated } = await setupTranslatedPage(prefix, user.id);
    const other = await createWikiPage(
      dal,
      { slug: `${prefix}-other`, body: { en: 'Other.' }, canonicalLanguage: 'en' },
      user.id
    );

    const write = (translatedFrom: { language: string; revId: string }, body = { de: 'Der See.' }) =>
      updateWikiPage(dal, { slug, body, translatedFrom, revSummary: summary('German') }, user.id);

    // From another translation.
    await assert.rejects(() => write({ language: 'fr', revId: translated.currentRevId }), ValidationError);
    // A revision of another page.
    await assert.rejects(() => write({ language: 'en', revId: other.currentRevId }), ValidationError);
    // No translation written.
    await assert.rejects(
      () => write({ language: 'en', revId: created.currentRevId }, { en: 'The lake.' } as never),
      ValidationError
    );

    const noCanonical = await createWikiPage(
      dal,
      { slug: `${prefix}-nocanon`, body: { en: 'Text.' } },
      user.id
    );
    await assert.rejects(
      () =>
        updateWikiPage(
          dal,
          {
            slug: noCanonical.slug,
            body: { fr: 'Texte.' },
            translatedFrom: { language: 'en', revId: noCanonical.currentRevId },
            revSummary: summary('French'),
          },
          user.id
        ),
      ValidationError
    );

    const page = await readWikiPage(dal, slug);
    assert.deepEqual(Object.keys(page.translatedFrom ?? {}), ['fr']);
  } finally {
    await cleanup(prefix, userId);
  }
});

test('translation records follow the page history', async () => {
  const prefix = `test-canonlang-history-${Date.now()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const { dal, slug, created, translated } = await setupTranslatedPage(prefix, user.id);

    const diff = await diffWikiPageRevisions(dal, {
      slug,
      fromRevId: created.currentRevId,
      toRevId: translated.currentRevId,
    });
    assert.equal(diff.fields.translatedFrom?.kind, 'structured');

    const removed = await updateWikiPage(
      dal,
      { slug, title: { fr: null }, body: { fr: null }, revSummary: summary('Remove French') },
      user.id
    );
    assert.equal(removed.translatedFrom, null);

    await pause();
    await restoreWikiPageRevision(
      dal,
      { slug, revId: translated.currentRevId, revSummary: summary('Bring French back') },
      user.id
    );
    const page = await readWikiPage(dal, slug);
    assert.deepEqual(page.translatedFrom, {
      fr: { language: 'en', revId: created.currentRevId, editsBehind: 0 },
    });
  } finally {
    await cleanup(prefix, userId);
  }
});


test('body counters count removals and restores and survive missing source history', async () => {
  const prefix = `test-canonlang-counters-${Date.now()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const { dal, slug, created } = await setupTranslatedPage(prefix, user.id);
    await updateWikiPage(
      dal,
      { slug, body: { en: null }, revSummary: summary('Remove canonical text') },
      user.id
    );
    let page = await readWikiPage(dal, slug);
    assert.equal((page.translatedFrom?.fr as { editsBehind: number }).editsBehind, 1);
    await restoreWikiPageRevision(
      dal,
      { slug, revId: created.currentRevId, revSummary: summary('Restore canonical text') },
      user.id
    );
    await updateWikiPage(
      dal,
      {
        slug,
        body: { fr: 'Le lac.' },
        translatedFrom: { language: 'en', revId: created.currentRevId },
        revSummary: summary('Restore translation'),
      },
      user.id
    );
    page = await readWikiPage(dal, slug);
    assert.equal((page.translatedFrom?.fr as { editsBehind: number }).editsBehind, 2);
    await dal.query('DELETE FROM pages WHERE _old_rev_of = $1 AND _rev_id = $2', [
      page.id, created.currentRevId,
    ]);
    page = await readWikiPage(dal, slug);
    assert.equal((page.translatedFrom?.fr as { editsBehind: number | null }).editsBehind, null);
  } finally {
    await cleanup(prefix, userId);
  }
});

test('body counter migration backfills historical text changes', async () => {
  const dal = await getDal();
  const client = await dal.getConnection();
  const schema = `counter_test_${randomBytes(8).toString('hex')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`CREATE TABLE pages (
      id uuid PRIMARY KEY, _old_rev_of uuid, _rev_id uuid NOT NULL,
      _rev_date timestamptz NOT NULL, body jsonb
    )`);
    await client.query(`INSERT INTO pages VALUES
      ('00000000-0000-4000-8000-000000000001', NULL,
       '00000000-0000-4000-8000-000000000011', '2026-01-04', '{"en":"A"}'),
      ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000012', '2026-01-01', '{"en":"A"}'),
      ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000013', '2026-01-02', '{"en":"A","fr":"B"}'),
      ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000014', '2026-01-03', '{"fr":"B"}')`);
    const migration = await readFile(
      new URL('../migrations/036_page_body_edit_counts.sql', import.meta.url), 'utf8'
    );
    await client.query(migration);
    const result = await client.query('SELECT body_edit_counts FROM pages ORDER BY _rev_date');
    assert.deepEqual(result.rows.map(row => row.body_edit_counts), [
      { en: 1, fr: 0 }, { en: 1, fr: 1 }, { en: 2, fr: 1 }, { en: 3, fr: 2 },
    ]);
    await client.query(`UPDATE pages SET body = '{"en":"C"}' WHERE _old_rev_of IS NULL`);
    const updated = await client.query('SELECT body_edit_counts FROM pages WHERE _old_rev_of IS NULL');
    assert.deepEqual(updated.rows[0].body_edit_counts, { en: 4, fr: 2 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
