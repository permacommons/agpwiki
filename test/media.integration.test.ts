import './_use-database.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { MediaStorage, StoredThumbnail } from '../src/lib/media-storage.js';
import { getOrFetchThumbnail } from '../src/services/media-thumbnail-service.js';
import { ForbiddenError, NotFoundError } from '../src/lib/errors.js';
import { WIKI_ADMIN_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { createTestUser, getDal } from './_service-fixtures.js';

const buildStubCommonsResponse = (
  overrides: Partial<{
    license: string;
    licenseUrl: string;
    author: string;
    fetchedAt: string;
    width: number;
  }> = {}
) => ({
  mediaType: 'image' as const,
  data: {
    commonsPageUrl: 'https://commons.wikimedia.org/wiki/File:Test_Media.jpg',
    mime: 'image/jpeg',
    width: overrides.width ?? 4096,
    height: 3072,
    thumbnailUrlTemplate:
      'https://example/wikipedia/commons/thumb/0/03/Test_Media.jpg/960px-Test_Media.jpg',
    originalUrl: 'https://example/full.jpg',
    license: overrides.license ?? 'CC-BY-SA-4.0',
    licenseUrl: overrides.licenseUrl ?? 'https://creativecommons.org/licenses/by-sa/4.0/',
    author: overrides.author ?? 'Jane Doe',
    fetchedAt: overrides.fetchedAt ?? '2026-05-02T00:00:00Z',
  },
});

test('Service createMedia persists fetched Commons metadata as a first revision', async () => {
  const { createMedia, readMedia } = await import('../src/services/media-service.js');
  const dal = await getDal();
  const slug = `test-media-${Date.now()}`;

  const user = await createTestUser();

  const stubFetcher = async () => buildStubCommonsResponse();

  const created = await createMedia(
    dal,
    {
      slug,
      commonsTitle: 'File:Test Media.jpg',
      title: { en: 'Test Media' },
      caption: { en: 'Sample caption' },
      revSummary: { en: 'Initial registration.' },
    },
    user.id,
    { commonsFetcher: stubFetcher }
  );

  assert.equal(created.slug, slug);
  assert.equal(created.commonsTitle, 'File:Test Media.jpg');
  assert.equal(created.mediaType, 'image');
  assert.equal(created.title?.en, 'Test Media');
  assert.equal(created.caption?.en, 'Sample caption');

  const reread = await readMedia(dal, slug);
  assert.equal(reread.id, created.id);
  assert.equal(reread.commonsTitle, 'File:Test Media.jpg');
  assert.equal((reread.data as { license?: string }).license, 'CC-BY-SA-4.0');
});

const testThumbnailStorage = () => {
  const cached = new Map<string, StoredThumbnail>();
  const fetched: string[] = [];
  const storage: MediaStorage = {
    findStored: async (key, step) => cached.get(`${key}:${step}`) ?? null,
    storeThumbnail: async (key, step, source) => {
      fetched.push(source);
      const entry: StoredThumbnail = { path: `${key}/${step}.jpg`, extension: 'jpg' };
      cached.set(`${key}:${step}`, entry);
      return entry;
    },
    deleteAllForSlug: async () => { throw new Error('Injected cleanup failure'); },
    renameSlug: async () => { throw new Error('Cache directories must not be moved'); },
  };
  return { storage, cached, fetched };
};

test('Media cache cleanup failures preserve successful edits without serving stale thumbnails', async t => {
  const { createMedia, updateMedia, refreshMedia, readMedia, deleteMedia } = await import(
    '../src/services/media-service.js'
  );
  const dal = await getDal();
  const slug = `test-media-cache-failure-${Date.now()}`;
  const renamedSlug = `${slug}-renamed`;
  const user = await createTestUser();
  const cleanupLog = t.mock.method(console, 'error', () => {});
  const { storage, cached, fetched } = testThumbnailStorage();
  const commonsFetcher = async () => buildStubCommonsResponse();
  const created = await createMedia(dal, {
    slug, commonsTitle: `File:${slug}.jpg`,
  }, user.id, { commonsFetcher });
  // Legacy slug-only cache entries must not bypass the current database state.
  cached.set(`${slug}:250`, { path: 'legacy.jpg', extension: 'jpg' });
  const originalThumbnail = await getOrFetchThumbnail(slug, 250, storage);
  assert.notEqual(originalThumbnail.path, 'legacy.jpg');
  assert.deepEqual(await getOrFetchThumbnail(slug, 250, storage), originalThumbnail);
  assert.equal(fetched.length, 1);

  const renamed = await updateMedia(dal, {
    slug, newSlug: renamedSlug, expectedRevId: created.currentRevId,
    revSummary: { en: 'Rename despite failed cache reclamation.' },
  }, user.id, { storage });
  assert.equal((await readMedia(dal, renamedSlug)).currentRevId, renamed.currentRevId);
  await assert.rejects(() => getOrFetchThumbnail(slug, 250, storage), NotFoundError);
  const renamedThumbnail = await getOrFetchThumbnail(renamedSlug, 250, storage);
  assert.notEqual(renamedThumbnail.path, originalThumbnail.path);

  const refreshed = await refreshMedia(dal, {
    slug: renamedSlug, expectedRevId: renamed.currentRevId,
    revSummary: { en: 'Refresh despite failed cache reclamation.' },
  }, user.id, { storage, commonsFetcher });
  assert.equal((await readMedia(dal, renamedSlug)).currentRevId, refreshed.currentRevId);
  const refreshedThumbnail = await getOrFetchThumbnail(renamedSlug, 250, storage);
  assert.notEqual(refreshedThumbnail.path, renamedThumbnail.path);
  assert.equal(fetched.length, 3);

  await assert.rejects(() => refreshMedia(dal, {
    slug: renamedSlug, expectedRevId: renamed.currentRevId,
    revSummary: { en: 'Stale retry must not create another revision.' },
  }, user.id, { storage, commonsFetcher }), /Revision mismatch/);
  assert.equal(cleanupLog.mock.callCount(), 2);

  await createMedia(dal, { slug, commonsTitle: `File:${slug}-replacement.jpg` }, user.id, { commonsFetcher });
  assert.notEqual((await getOrFetchThumbnail(slug, 250, storage)).path, originalThumbnail.path);
  await grantRoleUpsert(dal, user.id, WIKI_ADMIN_ROLE);
  await deleteMedia(dal, {
    slug: renamedSlug, revSummary: { en: 'Delete despite failed cache reclamation.' },
  }, user.id, { storage });
  await assert.rejects(() => getOrFetchThumbnail(renamedSlug, 250, storage), NotFoundError);
  assert.equal(cleanupLog.mock.callCount(), 3);
});

test('A thumbnail fetch finishing after refresh cannot populate the new revision cache', { timeout: 10000 }, async () => {
  const { createMedia, refreshMedia } = await import('../src/services/media-service.js');
  const dal = await getDal();
  const slug = `test-media-cache-race-${Date.now()}`;
  const user = await createTestUser();
  const { storage, fetched } = testThumbnailStorage();
  const commonsFetcher = async () => buildStubCommonsResponse();
  let releaseFetch: () => void;
  const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
  let markStarted: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const store = storage.storeThumbnail;
  let calls = 0;
  storage.storeThumbnail = async (...args) => {
    if (++calls === 1) { markStarted(); await gate; }
    return store(...args);
  };
  storage.deleteAllForSlug = async () => {};
  let oldFetch: Promise<StoredThumbnail> | undefined;
  try {
    await createMedia(dal, { slug, commonsTitle: `File:${slug}.jpg` }, user.id, { commonsFetcher });
    oldFetch = getOrFetchThumbnail(slug, 250, storage);
    await started;
    await refreshMedia(dal, { slug, revSummary: { en: 'Refresh during fetch.' } }, user.id,
      { commonsFetcher, storage });
    const freshThumbnail = await getOrFetchThumbnail(slug, 250, storage);
    releaseFetch();
    const oldThumbnail = await oldFetch;
    assert.notEqual(oldThumbnail.path, freshThumbnail.path);
    assert.deepEqual(await getOrFetchThumbnail(slug, 250, storage), freshThumbnail);
    assert.equal(fetched.length, 2);
  } finally {
    releaseFetch();
    await oldFetch;
  }
});

test('getRecentMediaChanges orders newest-first and threads prevRevId via LEAD()', async () => {
  const { getRecentMediaChanges } = await import('../src/services/recent-changes-service.js');
  const { createMedia, updateMedia } = await import('../src/services/media-service.js');
  const dal = await getDal();
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const slugA = `test-recent-media-${suffix}-a`;
  const renamedSlugA = `test-recent-media-${suffix}-a-renamed`;
  const slugB = `test-recent-media-${suffix}-b`;

  const user = await createTestUser();

  const stubFetcher = async () => buildStubCommonsResponse();

  await createMedia(
    dal,
    {
      slug: slugA,
      commonsTitle: `File:RecentA_${suffix}.jpg`,
      revSummary: { en: 'Initial A.' },
    },
    user.id,
    { commonsFetcher: stubFetcher }
  );
  // Sub-millisecond ties on _rev_date would make ORDER BY fall back to
  // _rev_id (UUID) and lose chronological meaning. A small pause keeps
  // the ordering deterministic.
  await new Promise(resolve => setTimeout(resolve, 5));

  await updateMedia(
    dal,
    {
      slug: slugA,
      newSlug: renamedSlugA,
      caption: { en: 'Updated caption' },
      revSummary: { en: 'Update A.' },
    },
    user.id
  );
  await new Promise(resolve => setTimeout(resolve, 5));

  await createMedia(
    dal,
    {
      slug: slugB,
      commonsTitle: `File:RecentB_${suffix}.jpg`,
      revSummary: { en: 'Initial B.' },
    },
    user.id,
    { commonsFetcher: stubFetcher }
  );

  // Fetch a generous window; the suite has concurrent media tests so
  // narrow our assertions to our own slugs.
  const allChanges = await getRecentMediaChanges(dal, 100);
  const ours = allChanges.filter(
    change => change.slug === renamedSlugA || change.slug === slugB
  );
  assert.equal(ours.length, 3, 'expected 3 revisions: B-create, A-update, A-create');

  const [newest, middle, oldest] = ours;

  // Ordering: B-create is newest, then A-update, then A-create.
  assert.equal(newest.slug, slugB);
  assert.equal(middle.slug, renamedSlugA);
  assert.equal(oldest.slug, renamedSlugA);
  assert.notEqual(middle.revId, oldest.revId);

  // prevRevId chain: B has no prior rev in its own partition; A-update
  // points at A-create; A-create is the oldest in its partition.
  assert.equal(newest.prevRevId, null, 'B-create has no prior revision');
  assert.equal(
    middle.prevRevId,
    oldest.revId,
    'A-update prevRevId should point at A-create'
  );
  assert.equal(oldest.prevRevId, null, 'A-create has no prior revision');

  // Field mapping spot-checks on the newest row. commonsTitle is
  // stored normalized (underscores → spaces by normalizeCommonsTitle).
  assert.equal(newest.commonsTitle, `File:RecentB ${suffix}.jpg`);
  assert.equal(newest.mediaType, 'image');
  assert.equal(newest.revUser, user.id);
  assert.ok(Array.isArray(newest.revTags));
  assert.ok(newest.data && typeof newest.data === 'object');
  assert.equal((newest.data as { mime?: string }).mime, 'image/jpeg');
});

test('Service updateMedia merges captions into a new revision without re-fetching Commons', async () => {
  const { createMedia, readMedia, readMediaRevision, updateMedia } = await import(
    '../src/services/media-service.js'
  );
  const dal = await getDal();
  const slug = `test-media-history-update-${Date.now()}`;

  const user = await createTestUser();
  const title = { en: 'History Media', de: 'Verlaufsmedium' };
  const stubCommons = buildStubCommonsResponse();
  let fetchCount = 0;

  const created = await createMedia(
    dal,
    {
      slug,
      commonsTitle: `File:HistoryUpdate_${Date.now()}.jpg`,
      title,
      caption: { en: 'Old caption', de: 'Deutsche Bildunterschrift' },
      revSummary: { en: 'Initial.' },
    },
    user.id,
    {
      commonsFetcher: async () => {
        fetchCount += 1;
        return stubCommons;
      },
    }
  );

  const updated = await updateMedia(
    dal,
    {
      slug,
      caption: { en: 'New caption' },
      expectedRevId: created.currentRevId,
      revSummary: { en: 'Revise English caption.' },
    },
    user.id
  );
  assert.notEqual(updated.currentRevId, created.currentRevId);

  const { revision: previous } = await readMediaRevision(dal, slug, created.currentRevId);
  assert.deepEqual(previous.caption, { en: 'Old caption', de: 'Deutsche Bildunterschrift' });
  assert.deepEqual(previous.title, title);
  assert.deepEqual(previous.data, stubCommons.data);

  const current = await readMedia(dal, slug);
  assert.equal(current.currentRevId, updated.currentRevId);
  assert.deepEqual(current.caption, { en: 'New caption', de: 'Deutsche Bildunterschrift' });
  assert.deepEqual(current.title, title);
  assert.deepEqual(current.data, stubCommons.data);
  assert.equal(fetchCount, 1);
});

test('Service refreshMedia stores re-fetched metadata as a tagged new revision', async () => {
  const { createMedia, listMediaRevisions, readMedia, readMediaRevision, refreshMedia } = await import(
    '../src/services/media-service.js'
  );
  const dal = await getDal();
  const slug = `test-media-history-refresh-${Date.now()}`;

  const user = await createTestUser();
  const title = { en: 'Refresh History', de: 'Aktualisierungsverlauf' };
  const caption = { en: 'Caption', de: 'Bildunterschrift' };
  const initialCommons = buildStubCommonsResponse({ license: 'CC-BY-2.0' });
  const refreshedCommons = buildStubCommonsResponse({
    license: 'CC-BY-SA-4.0',
    fetchedAt: '2026-05-03T00:00:00Z',
  });

  const created = await createMedia(
    dal,
    {
      slug,
      commonsTitle: `File:HistoryRefresh_${Date.now()}.jpg`,
      title,
      caption,
      revSummary: { en: 'Initial.' },
    },
    user.id,
    { commonsFetcher: async () => initialCommons }
  );

  const refreshed = await refreshMedia(
    dal,
    {
      slug,
      expectedRevId: created.currentRevId,
      revSummary: { en: 'License updated upstream.' },
    },
    user.id,
    { commonsFetcher: async () => refreshedCommons }
  );
  assert.notEqual(refreshed.currentRevId, created.currentRevId);

  const { revision: previous } = await readMediaRevision(dal, slug, created.currentRevId);
  assert.deepEqual(previous.data, initialCommons.data);
  assert.deepEqual(previous.title, title);
  assert.deepEqual(previous.caption, caption);

  const current = await readMedia(dal, slug);
  assert.equal(current.currentRevId, refreshed.currentRevId);
  assert.deepEqual(current.data, refreshedCommons.data);
  assert.deepEqual(current.title, title);
  assert.deepEqual(current.caption, caption);

  const { revisions } = await listMediaRevisions(dal, slug);
  assert.equal(revisions.length, 2);
  assert.ok(revisions[0].revTags?.includes('refresh'));
});

test('Service deleteMedia requires wiki_admin role', async () => {
  const { createMedia, deleteMedia } = await import('../src/services/media-service.js');
  const dal = await getDal();
  const slug = `test-media-del-${Date.now()}`;

  const user = await createTestUser();

  await createMedia(
    dal,
    {
      slug,
      commonsTitle: `File:DeleteTest_${Date.now()}.jpg`,
      revSummary: { en: 'Initial.' },
    },
    user.id,
    { commonsFetcher: async () => buildStubCommonsResponse() }
  );

  await assert.rejects(
    () =>
      deleteMedia(
        dal,
        { slug, revSummary: { en: 'Admin deletion.' } },
        user.id
      ),
    error => {
      assert.ok(error instanceof ForbiddenError);
      return true;
    }
  );

  await grantRoleUpsert(dal, user.id, WIKI_ADMIN_ROLE);

  const result = await deleteMedia(
    dal,
    { slug, revSummary: { en: 'Admin deletion.' } },
    user.id
  );
  assert.equal(result.deleted, true);

  const { readMedia } = await import('../src/services/media-service.js');
  await assert.rejects(() => readMedia(dal, slug), NotFoundError);
});
