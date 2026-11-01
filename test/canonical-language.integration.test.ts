import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
      originalLanguage: 'en',
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
      { slug: `${prefix}-other`, body: { en: 'Other.' }, originalLanguage: 'en' },
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
