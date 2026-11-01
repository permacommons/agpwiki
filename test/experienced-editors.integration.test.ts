import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import { ForbiddenError } from '../src/lib/errors.js';
import AgentAccessRequest from '../src/models/agent-access-request.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { registerToolRoutes } from '../src/routes/tools.js';
import {
  ADMIN_EVENT_EXPERIENCED_STATUS_CHANGED,
  getExperiencedStatus,
  getExperiencedStatuses,
  setExperiencedOverride,
} from '../src/services/experienced-editor-service.js';
import { getWikiPageEditability, protectWikiPage } from '../src/services/page-protection-service.js';
import { canUseRevertAction, restoreWikiPageRevision } from '../src/services/page-revert-service.js';
import { grantRoleUpsert, SITE_ADMIN_ROLE, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { createWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';

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
const noJobs = { enqueueJob: async () => {} };

const createTestUser = async ({ approved = true } = {}) => {
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const user = await User.create({
    username: `experiencedtest${suffix}`,
    displayName: `Experienced Test ${suffix.slice(-4)}`,
    email: `experienced-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
  });
  if (approved) {
    await AgentAccessRequest.create({
      userId: user.id,
      interests: 'Testing',
      profileUrl: 'https://example.com/profile',
      status: 'approved',
      createdAt: new Date(),
      submittedAt: new Date(),
      reviewedAt: new Date(),
      approvedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
  }
  return user;
};

const cleanup = async (prefix: string, userIds: string[]) => {
  const dal = await getDal();
  await dal.query('DELETE FROM admin_events WHERE actor_user_id = ANY($1) OR target_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
    `${prefix}%`,
  ]);
  await dal.query('DELETE FROM page_protections WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
    `${prefix}%`,
  ]);
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM experienced_editor_overrides WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM agent_access_requests WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
};

/** Makes every revision of the test pages look eight days old. */
const ageEdits = async (prefix: string) => {
  const dal = await getDal();
  await dal.query("UPDATE pages SET _rev_date = _rev_date - INTERVAL '8 days' WHERE slug LIKE $1", [`${prefix}%`]);
};

/** The author creates two pages; the editor makes three edits to one and two to the other. */
const setupEdits = async (prefix: string) => {
  const dal = await getDal();
  const author = await createTestUser();
  const editor = await createTestUser();
  const first = await createWikiPage(dal, { slug: `${prefix}-a`, title: { en: 'A' }, body: { en: 'A0.' } }, author.id);
  await createWikiPage(dal, { slug: `${prefix}-b`, title: { en: 'B' }, body: { en: 'B0.' } }, author.id);
  for (const [slug, text] of [
    [`${prefix}-a`, 'A1.'],
    [`${prefix}-a`, 'A2.'],
    [`${prefix}-a`, 'A3.'],
    [`${prefix}-b`, 'B1.'],
    [`${prefix}-b`, 'B2.'],
  ]) {
    await pause();
    await updateWikiPage(dal, { slug, body: { en: text }, revSummary: { en: 'Edit.' } }, editor.id);
  }
  return { dal, author, editor, first };
};

test('Editors become experienced after five lasting edits more than a week old', async () => {
  const prefix = `test-experienced-auto-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor, first } = await setupEdits(prefix);
    userIds.push(author.id, editor.id);

    const fresh = await getExperiencedStatus(dal, editor.id);
    assert.equal(fresh.isExperienced, false);
    assert.equal(fresh.countedEdits, 0);
    assert.equal(await canUseRevertAction(dal, editor.id, 'rollback'), false);

    await ageEdits(prefix);
    const aged = await getExperiencedStatus(dal, editor.id);
    assert.equal(aged.isExperienced, true);
    assert.equal(aged.override, null);
    assert.ok(aged.since && aged.since.getTime() <= Date.now());
    assert.equal(await canUseRevertAction(dal, editor.id, 'rollback'), true);

    // Reverting the three edits on page A leaves only two lasting edits.
    const reviewer = await createTestUser();
    userIds.push(reviewer.id);
    await restoreWikiPageRevision(
      dal,
      { slug: `${prefix}-a`, revId: first.currentRevId, revSummary: { en: 'Unsourced.' } },
      reviewer.id,
      noJobs
    );
    const reverted = await getExperiencedStatus(dal, editor.id);
    assert.equal(reverted.isExperienced, false);
    assert.equal(reverted.countedEdits, 2);
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('Admins can take the status away or give it early, and it is logged', async () => {
  const prefix = `test-experienced-override-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor } = await setupEdits(prefix);
    userIds.push(author.id, editor.id);
    await ageEdits(prefix);
    const siteAdmin = await createTestUser();
    const wikiAdmin = await createTestUser();
    const newcomer = await createTestUser();
    userIds.push(siteAdmin.id, wikiAdmin.id, newcomer.id);
    await grantRoleUpsert(dal, siteAdmin.id, SITE_ADMIN_ROLE);
    await grantRoleUpsert(dal, wikiAdmin.id, WIKI_ADMIN_ROLE);

    await assert.rejects(
      () => setExperiencedOverride(dal, { userId: editor.id, override: 'revoked', reason: 'Misuse.' }, wikiAdmin.id),
      ForbiddenError
    );

    const revoked = await setExperiencedOverride(
      dal,
      { userId: editor.id, override: 'revoked', reason: 'Rolled back good edits.' },
      siteAdmin.id
    );
    assert.equal(revoked.status.isExperienced, false);
    assert.equal(revoked.status.override, 'revoked');

    const granted = await setExperiencedOverride(
      dal,
      { userId: newcomer.id, override: 'granted', reason: 'Known Wikipedia editor.' },
      siteAdmin.id
    );
    assert.equal(granted.status.isExperienced, true);
    assert.equal(granted.status.override, 'granted');

    const back = await setExperiencedOverride(dal, { userId: editor.id, override: null, reason: 'Resolved.' }, siteAdmin.id);
    assert.equal(back.status.isExperienced, true);
    assert.equal(back.status.override, null);

    const events = await dal.query('SELECT details FROM admin_events WHERE event_type = $1 AND target_id = $2', [
      ADMIN_EVENT_EXPERIENCED_STATUS_CHANGED,
      editor.id,
    ]);
    assert.deepEqual(
      (events.rows as Array<{ details: { nextOverride: string | null; reason: string } }>)
        .map(row => row.details.nextOverride)
        .sort(),
      ['revoked', null].sort()
    );
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('Pages protected for experienced editors are open to them and to admins only', async () => {
  const prefix = `test-experienced-protect-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor } = await setupEdits(prefix);
    userIds.push(author.id, editor.id);
    await ageEdits(prefix);
    const admin = await createTestUser();
    const newcomer = await createTestUser();
    userIds.push(admin.id, newcomer.id);
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);

    const slug = `${prefix}-a`;
    const protection = await protectWikiPage(dal, { slug, reason: 'Vandalism.', level: 'experienced' }, admin.id);
    assert.equal(protection.level, 'experienced');
    const pageId = protection.pageId;

    assert.equal((await getWikiPageEditability(dal, { id: pageId }, editor.id)).isEditable, true);
    assert.equal((await getWikiPageEditability(dal, { id: pageId }, admin.id)).isEditable, true);
    assert.equal((await getWikiPageEditability(dal, { id: pageId }, newcomer.id)).isEditable, false);
    await assert.rejects(
      () => updateWikiPage(dal, { slug, body: { en: 'New.' }, revSummary: { en: 'Try.' } }, newcomer.id),
      (error: unknown) => error instanceof ForbiddenError && error.details?.level === 'experienced'
    );
    await updateWikiPage(dal, { slug, body: { en: 'Fixed.' }, revSummary: { en: 'Fix.' } }, editor.id);

    const raised = await protectWikiPage(dal, { slug, reason: 'Still under attack.', level: 'admins' }, admin.id);
    assert.equal(raised.level, 'admins');
    assert.equal((await getWikiPageEditability(dal, { id: pageId }, editor.id)).isEditable, false);
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('The lock shows the level, and site admins manage the status in the user rights tool', async () => {
  const prefix = `test-experienced-routes-${Date.now()}`;
  const userIds: string[] = [];
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.t = ((key: string, options?: Record<string, unknown>) =>
      options ? `${key}${JSON.stringify(options)}` : key) as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ bodyHtml: options?.bodyHtml, labelHtml: options?.labelHtml });
    }) as express.Response['render'];
    next();
  });
  registerToolRoutes(app);
  registerPageRoutes(app);
  const server = http.createServer(app);
  try {
    const { dal, author, editor } = await setupEdits(prefix);
    userIds.push(author.id, editor.id);
    const siteAdmin = await createTestUser();
    userIds.push(siteAdmin.id);
    await grantRoleUpsert(dal, siteAdmin.id, SITE_ADMIN_ROLE);
    await protectWikiPage(dal, { slug: `${prefix}-a`, level: 'experienced' }, siteAdmin.id);
    await protectWikiPage(dal, { slug: `${prefix}-b` }, siteAdmin.id);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;

    const label = async (slug: string) =>
      ((await (await fetch(`${base}/${slug}`)).json()) as { labelHtml: string }).labelHtml;
    assert.match(await label(`${prefix}-a`), /page-protection-icon--experienced" data-meta="true" title="page\.protectedExperienced"/);
    assert.match(await label(`${prefix}-b`), /page-protection-icon--admins" data-meta="true" title="page\.protectedDetails"/);

    const { token } = await createSession(siteAdmin.id);
    const cookie = `agpwiki_session=${token}`;
    const tool = await fetch(`${base}/tool/user-rights?q=${encodeURIComponent(editor.username)}`, { headers: { cookie } });
    const { bodyHtml } = (await tool.json()) as { bodyHtml: string };
    assert.match(bodyHtml, /experienced\.status\.notYet\{&quot;count&quot;:0,&quot;total&quot;:5\}/);
    assert.ok(bodyHtml.includes(`/tool/user-rights/${editor.id}/experienced`));

    const saved = await fetch(`${base}/tool/user-rights/${editor.id}/experienced`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ override: 'granted', reason: 'Trusted.', redirectTo: '/tool/user-rights' }).toString(),
    });
    assert.equal(saved.status, 302);
    assert.match(saved.headers.get('location') ?? '', /status=experienced/);
    assert.equal((await getExperiencedStatus(dal, editor.id)).override, 'granted');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup(prefix, userIds);
  }
});

test('Batch status lookup isolates users and uses one query regardless of batch size', async () => {
  const prefix = `test-experienced-batch-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor } = await setupEdits(prefix);
    userIds.push(author.id, editor.id);
    const unapproved = await createTestUser({ approved: false });
    const blocked = await createTestUser();
    userIds.push(unapproved.id, blocked.id);
    await ageEdits(prefix);
    await dal.query('UPDATE users SET blocked_at = NOW() WHERE id = $1', [blocked.id]);
    await dal.query(
      `INSERT INTO experienced_editor_overrides (user_id, status)
       VALUES ($1, 'granted'), ($2, 'granted'), ($3, 'revoked')`,
      [unapproved.id, blocked.id, author.id]
    );
    let queries = 0;
    const countedDal = new Proxy(dal, {
      get(target, key) {
        if (key === 'query') {
          queries++;
          return target.query.bind(target);
        }
        return Reflect.get(target, key);
      },
    });
    assert.equal((await getExperiencedStatuses(countedDal, [])).size, 0);
    assert.equal(queries, 0);
    const missingId = '00000000-0000-4000-8000-000000000000';
    const statuses = await getExperiencedStatuses(countedDal, [...userIds, editor.id, missingId]);
    assert.equal(queries, 1);
    assert.equal(statuses.size, 5);
    assert.equal(statuses.get(editor.id)?.isExperienced, true);
    assert.equal(statuses.get(editor.id)?.countedEdits, 5);
    assert.equal(statuses.get(author.id)?.override, 'revoked');
    assert.equal(statuses.get(author.id)?.isExperienced, false);
    assert.equal(statuses.get(unapproved.id)?.isExperienced, true);
    assert.equal(statuses.get(unapproved.id)?.countedEdits, 0);
    assert.equal(statuses.get(blocked.id)?.isExperienced, false);
    assert.equal(statuses.get(blocked.id)?.countedEdits, 0);
    assert.equal(statuses.get(missingId)?.isExperienced, false);
    for (const id of userIds) {
      assert.deepEqual(statuses.get(id), await getExperiencedStatus(dal, id));
    }
    assert.equal(await canUseRevertAction(dal, unapproved.id, 'restore'), false);
    assert.equal(await canUseRevertAction(dal, blocked.id, 'rollback'), false);
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('Override inserts, updates and resets roll back together with failed audit entries', async t => {
  const dal = await getDal();
  const prefix = `test-experienced-audit-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const admin = await createTestUser();
    const user = await createTestUser();
    userIds.push(admin.id, user.id);
    await grantRoleUpsert(dal, admin.id, SITE_ADMIN_ROLE);
    const eventModel = dal.getModel('admin_events');
    const createEvent = eventModel.create.bind(eventModel);
    const auditFailure = () => t.mock.method(eventModel, 'create', async (...args: Parameters<typeof eventModel.create>) => {
      await createEvent(...args);
      throw new Error('Audit persistence failed');
    });
    const readOverrideRows = async () => (await dal.query(
      'SELECT * FROM experienced_editor_overrides WHERE user_id = $1', [user.id]
    )).rows;
    const readEvents = async () => (await dal.query(
      'SELECT * FROM admin_events WHERE target_id = $1', [user.id]
    )).rows;

    const failedInsert = auditFailure();
    try {
      await assert.rejects(
        setExperiencedOverride(dal, { userId: user.id, override: 'granted', reason: 'Grant.' }, admin.id),
        /Audit persistence failed/
      );
      assert.deepEqual(await readOverrideRows(), []);
      assert.deepEqual(await readEvents(), []);
    } finally {
      failedInsert.mock.restore();
    }

    await setExperiencedOverride(dal, { userId: user.id, override: 'granted', reason: 'Grant.' }, admin.id);
    const originalOverride = await readOverrideRows();
    const originalEvents = await readEvents();
    const failedChanges = auditFailure();
    try {
      for (const override of ['revoked', null] as const) {
        await assert.rejects(
          setExperiencedOverride(dal, { userId: user.id, override, reason: 'Change.' }, admin.id),
          /Audit persistence failed/
        );
        assert.deepEqual(await readOverrideRows(), originalOverride);
        assert.deepEqual(await readEvents(), originalEvents);
        assert.equal((await getExperiencedStatus(dal, user.id)).override, 'granted');
      }
    } finally {
      failedChanges.mock.restore();
    }
  } finally {
    await cleanup(prefix, userIds);
  }
});
