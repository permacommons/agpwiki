import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import i18next from 'i18next';
import './_setup-i18n.js';
import { initializePostgreSQL } from '../src/db.js';
import { ValidationError } from '../src/lib/errors.js';
import type { WikidataSnapshot } from '../src/lib/wikidata.js';
import AgentAccessRequest from '../src/models/agent-access-request.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { createCitation } from '../src/services/citation-service.js';
import { createInfoboxService } from '../src/services/infobox-service.js';
import { restoreWikiPageRevision } from '../src/services/page-revert-service.js';
import {
  createWikiPage,
  diffWikiPageRevisions,
  readWikiPage,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

let sharedDal: Dal | null = null;
const getDal = async () => {
  if (!sharedDal) sharedDal = await initializePostgreSQL();
  return sharedDal;
};
test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const uniqueSuffix = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;
// Item IDs far above real ones, so parallel runs and real data never meet.
const testQid = () => `Q9${randomInt(100_000_000, 999_999_999)}`;

// Approved for editing, so it can also restore earlier versions.
const createTestUser = async () => {
  const suffix = uniqueSuffix();
  const user = await User.create({
    username: `infoboxtest${suffix}`,
    displayName: 'Infobox Test',
    email: `infobox-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
  });
  await AgentAccessRequest.create({
    userId: user.id,
    interests: 'Infobox testing',
    profileUrl: 'https://example.com/profile',
    status: 'approved',
    createdAt: new Date(),
    submittedAt: new Date(),
    reviewedAt: new Date(),
    approvedAt: new Date(),
  });
  return user;
};

const createTestCitation = (dal: Dal, key: string, userId: string) =>
  createCitation(
    dal,
    { key, data: { id: key, type: 'webpage', title: 'Infobox source', URL: 'https://example.com/source' } },
    userId
  );

const personSnapshot = (qid: string): WikidataSnapshot => ({
  qid,
  boxId: 'person',
  claims: {
    P569: [{ value: { type: 'time', time: '+1964-05-30T00:00:00Z', precision: 11 } }],
    P106: [{ value: { type: 'item', id: 'Q855091' } }],
  },
  labels: { Q855091: { en: 'guitarist' } },
  classification: [],
  images: {},
});

const cleanup = async (dal: Dal, { slug, userId, citationKey, qid }: Record<string, string | null>) => {
  if (slug) {
    await dal.query(
      'DELETE FROM infobox_mismatches WHERE page_id IN (SELECT id FROM pages WHERE slug = $1)',
      [slug]
    );
    await dal.query('DELETE FROM pages WHERE slug = $1 OR _old_rev_of IN (SELECT id FROM pages WHERE slug = $1)', [slug]);
  }
  if (qid) await dal.query('DELETE FROM wikidata_items WHERE qid = $1', [qid]);
  if (citationKey) await dal.query('DELETE FROM citations WHERE key = $1', [citationKey]);
  if (userId) {
    await dal.query('DELETE FROM agent_access_requests WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

test('Wikidata items are cached, and refreshed in the background once old', async () => {
  const dal = await getDal();
  const qid = testQid();
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const fetched: string[] = [];
  const service = createInfoboxService({
    fetchEnabled: true,
    refreshAfterMs: 60_000,
    now: () => clock,
    fetchSnapshot: async id => {
      fetched.push(id);
      return personSnapshot(id);
    },
  });
  try {
    const first = await service.getSnapshot(dal, qid);
    assert.equal(first?.boxId, 'person');
    assert.equal((await service.getSnapshot(dal, qid))?.qid, qid);
    assert.deepEqual(fetched, [qid], 'a cached item is not fetched again');

    clock += 120_000;
    const stale = await service.getSnapshot(dal, qid);
    assert.equal(stale?.qid, qid, 'an old item is still shown while it is refreshed');
    await service.refresh(dal, qid);
    assert.equal(fetched.length >= 2, true);

    const offline = createInfoboxService({ fetchEnabled: false, fetchSnapshot: async () => assert.fail('no fetch') });
    assert.equal(await offline.getSnapshot(dal, testQid()), null);
  } finally {
    await cleanup(dal, { qid, slug: null, userId: null, citationKey: null });
  }
});

test('Infobox values are checked, merged, kept in history and restored by reverts', async () => {
  const dal = await getDal();
  const slug = `test-infobox-values-${uniqueSuffix()}`;
  const citationKey = `infobox-source-${uniqueSuffix()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    await createTestCitation(dal, citationKey, user.id);

    const invalid = await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Values' },
        body: { en: 'Text.' },
        infoboxValues: { P9999: { value: 'x', citation: citationKey }, P569: { value: '1964', citation: 'no-such-citation' } },
      },
      user.id
    ).catch(error => error);
    assert.ok(invalid instanceof ValidationError);
    const fields = (invalid.fieldErrors ?? []).map((error: { field: string }) => error.field);
    assert.deepEqual(fields.sort(), ['infoboxValues.P569.citation', 'infoboxValues.P9999']);

    const created = await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Values' },
        body: { en: 'Text.' },
        wikidata: 'Q297552',
        infoboxValues: { P1477: { value: ' Thomas Baptist Morello ', citation: citationKey } },
      },
      user.id
    );
    assert.deepEqual(created.infoboxValues, { P1477: { value: 'Thomas Baptist Morello', citation: citationKey } });
    assert.equal(created.wikidata, 'Q297552');

    const updated = await updateWikiPage(
      dal,
      {
        slug,
        infoboxValues: { P569: { value: '1964-05-30', citation: citationKey } },
        revSummary: { en: 'Add date of birth.' },
      },
      user.id
    );
    assert.deepEqual(Object.keys(updated.infoboxValues ?? {}).sort(), ['P1477', 'P569'], 'values are merged');

    const removed = await updateWikiPage(
      dal,
      { slug, infoboxValues: { P1477: null }, revSummary: { en: 'Remove birth name.' } },
      user.id
    );
    assert.deepEqual(Object.keys(removed.infoboxValues ?? {}), ['P569']);
    assert.equal((await readWikiPage(dal, slug)).wikidata, 'Q297552', 'the Wikidata ID is untouched');

    const diff = await diffWikiPageRevisions(dal, { slug, fromRevId: created.currentRevId, toRevId: removed.currentRevId });
    assert.ok(diff.fields.infoboxValues);

    const restored = await restoreWikiPageRevision(
      dal,
      { slug, revId: created.currentRevId, revSummary: { en: 'Back to the first version.' } },
      user.id
    );
    assert.deepEqual(restored.page.infoboxValues, {
      P1477: { value: 'Thomas Baptist Morello', citation: citationKey },
    });
  } finally {
    await cleanup(dal, { slug, userId, citationKey, qid: null });
  }
});

test('Articles show the infobox from the cache and record differences with Wikidata', async () => {
  const dal = await getDal();
  const slug = `test-infobox-page-${uniqueSuffix()}`;
  const citationKey = `infobox-source-${uniqueSuffix()}`;
  const qid = testQid();
  let userId: string | null = null;
  const app = express();
  app.use((req, res, next) => {
    req.t = i18next.t.bind(i18next) as unknown as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ bodyHtml: options?.bodyHtml });
    }) as express.Response['render'];
    next();
  });
  registerPageRoutes(app);
  const server = http.createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const bodyOf = async (query = '') => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${slug}${query}`);
      assert.equal(response.status, 200);
      return ((await response.json()) as { bodyHtml: string }).bodyHtml;
    };

    const user = await createTestUser();
    userId = user.id;
    await createTestCitation(dal, citationKey, user.id);
    // Tests never reach Wikidata: the item is put in the cache directly.
    await dal.query('INSERT INTO wikidata_items (qid, snapshot, fetched_at) VALUES ($1, $2, NOW())', [
      qid,
      JSON.stringify(personSnapshot(qid)),
    ]);
    const created = await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Tom Morello' },
        body: { en: 'An American guitarist.' },
        wikidata: qid,
        infoboxValues: {
          P569: { value: '1964-05-31', citation: citationKey },
          P1477: { value: 'Thomas Baptist Morello', citation: citationKey },
        },
      },
      user.id
    );

    const body = await bodyOf();
    assert.match(body, /<aside class="infobox infobox--person"[^>]*>\n<div class="infobox-title">Tom Morello<\/div>/);
    assert.ok(body.indexOf('class="infobox') < body.indexOf('An American guitarist.'), 'the box comes before the text');
    assert.match(body, /<td>May 30, 1964/);
    assert.match(body, /Thomas Baptist Morello <span class="infobox-local">/);

    const mismatches = await dal.query(
      'SELECT property, agpedia_value, wikidata_value FROM infobox_mismatches WHERE page_id = $1',
      [created.id]
    );
    assert.deepEqual(mismatches.rows, [{ property: 'P569', agpedia_value: '1964-05-31', wikidata_value: '1964-05-30' }]);

    // Once the two agree, the record goes away.
    const fixed = await updateWikiPage(
      dal,
      { slug, infoboxValues: { P569: { value: '1964-05-30', citation: citationKey } }, revSummary: { en: 'Fix date.' } },
      user.id
    );
    await bodyOf();
    const after = await dal.query('SELECT 1 FROM infobox_mismatches WHERE page_id = $1', [created.id]);
    assert.equal(after.rowCount, 0);

    const old = await bodyOf(`?rev=${created.currentRevId}`);
    assert.match(old, /class="infobox-note"/);
    assert.ok(fixed.currentRevId);
  } finally {
    server.close();
    await cleanup(dal, { slug, userId, citationKey, qid });
  }
});
