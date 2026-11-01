import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import { ConflictError, ForbiddenError, InvalidRequestError, ValidationError } from '../src/lib/errors.js';
import { getRecentWikiChanges } from '../src/lib/recent-changes.js';
import { createMcpServer } from '../src/mcp/core.js';
import AgentAccessRequest from '../src/models/agent-access-request.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { notificationJobHandlers } from '../src/services/forum-notification-service.js';
import { enqueueNotificationJob } from '../src/services/notification-queue.js';
import {
  PAGE_REVERTED_NOTIFICATION,
  type PageRevertedPayload,
  REVERT_TAG,
  restoreWikiPageRevision,
  rollbackWikiPage,
} from '../src/services/page-revert-service.js';
import { grantRoleUpsert, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { listSiteNotifications } from '../src/services/site-notification-service.js';
import { createWikiPage, readWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';

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

const createTestUser = async ({ approved = true } = {}) => {
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const user = await User.create({
    username: `reverttest${suffix}`,
    displayName: `Revert Test ${suffix.slice(-4)}`,
    email: `revert-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
  });
  if (approved) {
    await AgentAccessRequest.create({
      userId: user.id,
      interests: 'Revert testing',
      profileUrl: 'https://example.com/profile',
      status: 'approved',
      createdAt: new Date(),
      submittedAt: new Date(),
      reviewedAt: new Date(),
      approvedAt: new Date(),
    });
  }
  return user;
};

const cleanup = async (prefix: string, userIds: string[]) => {
  const dal = await getDal();
  await dal.query("DELETE FROM notification_jobs WHERE payload->>'slug' LIKE $1", [`${prefix}%`]);
  await dal.query('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM page_aliases WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
    `${prefix}%`,
  ]);
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM agent_access_requests WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
};

/** A page with one version by the author and two later ones by another editor. */
const setupPage = async (prefix: string) => {
  const dal = await getDal();
  const author = await createTestUser();
  const editor = await createTestUser();
  const slug = `${prefix}-page`;
  const first = await createWikiPage(
    dal,
    { slug, title: { en: 'Original' }, body: { en: 'Original text.' }, originalLanguage: 'en' },
    author.id
  );
  await pause();
  await updateWikiPage(dal, { slug, body: { en: 'Changed once.', fr: 'Ajout.' }, revSummary: { en: 'Edit 1.' } }, editor.id);
  await pause();
  const latest = await updateWikiPage(
    dal,
    { slug, title: { en: 'Changed' }, body: { en: 'Changed twice.' }, revSummary: { en: 'Edit 2.' } },
    editor.id
  );
  await pause();
  return { dal, author, editor, slug, first, latest };
};

// Other test files share the notification queue and claim or clear every job
// in it, so jobs are captured here instead of queued.
const captureJobs = () => {
  const jobs: Array<{ type: string; payload: PageRevertedPayload }> = [];
  return {
    jobs,
    options: {
      enqueueJob: async (type: string, payload: PageRevertedPayload) => {
        jobs.push({ type, payload });
      },
    },
  };
};

// The agent tools and the web form queue for real; drop those jobs at once.
const dropQueuedJobs = async (slug: string) => {
  const dal = await getDal();
  await dal.query("DELETE FROM notification_jobs WHERE payload->>'slug' = $1", [slug]);
};

const processJob = async (payload: PageRevertedPayload) => {
  const dal = await getDal();
  const job = await enqueueNotificationJob(PAGE_REVERTED_NOTIFICATION, payload);
  try {
    await notificationJobHandlers[PAGE_REVERTED_NOTIFICATION](
      dal,
      { id: job.id, type: PAGE_REVERTED_NOTIFICATION, payload } as never,
      async () => ({ skipped: true }) as never
    );
  } finally {
    await dal.query('DELETE FROM notification_deliveries WHERE job_id = $1', [job.id]);
  }
};

test('Restoring a version brings back its exact text, is tagged and notifies the reverted editor', async () => {
  const prefix = `test-revert-restore-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor, slug, first, latest } = await setupPage(prefix);
    userIds.push(author.id, editor.id);
    const reviewer = await createTestUser();
    const unapproved = await createTestUser({ approved: false });
    userIds.push(reviewer.id, unapproved.id);

    await assert.rejects(
      () => restoreWikiPageRevision(dal, { slug, revId: first.currentRevId, revSummary: { en: 'No.' } }, unapproved.id),
      ForbiddenError
    );
    await assert.rejects(
      () => restoreWikiPageRevision(dal, { slug, revId: first.currentRevId, revSummary: { en: '' } }, reviewer.id),
      ValidationError
    );
    await assert.rejects(
      () => restoreWikiPageRevision(dal, { slug, revId: latest.currentRevId, revSummary: { en: 'Same.' } }, reviewer.id),
      InvalidRequestError
    );

    const captured = captureJobs();
    const result = await restoreWikiPageRevision(
      dal,
      { slug, revId: first.currentRevId, revSummary: { en: 'No sources for the change.' } },
      reviewer.id,
      captured.options
    );
    assert.equal(result.restoredRevId, first.currentRevId);
    assert.equal(result.revertedRevIds.length, 2);
    assert.deepEqual(result.revertedUserIds, [editor.id]);
    assert.equal(captured.jobs.length, 1);
    assert.deepEqual(captured.jobs[0].payload.recipientUserIds, [editor.id]);

    const page = await readWikiPage(dal, slug);
    assert.deepEqual(page.title, { en: 'Original' });
    // The French text added later is gone: the version is brought back exactly.
    assert.deepEqual(page.body, { en: 'Original text.' });

    const [change] = (await getRecentWikiChanges(dal, 50, { tag: REVERT_TAG })).filter(item => item.slug === slug);
    assert.ok(change);
    assert.ok(change.revTags.includes(REVERT_TAG));
    assert.ok(change.revTags.includes(`restored:${first.currentRevId}`));
    assert.equal(change.prevRevId, latest.currentRevId);

    await processJob(captured.jobs[0].payload);
    const notifications = await listSiteNotifications(dal, editor.id, { limit: 10 });
    const notification = notifications.find(item => item.kind === 'page.revert');
    assert.ok(notification);
    assert.equal(notification.excerpt, 'No sources for the change.');
    assert.equal(notification.subject, 'Original');
    // The link shows what was undone: from the replaced version to the revert.
    assert.ok(notification.url.includes(`diffFrom=${latest.currentRevId}&diffTo=${change.revId}`));
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('Roll back is for wiki admins and undoes the latest run of edits by one person', async () => {
  const prefix = `test-revert-rollback-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor, slug, first } = await setupPage(prefix);
    userIds.push(author.id, editor.id);
    const reviewer = await createTestUser();
    const admin = await createTestUser();
    userIds.push(reviewer.id, admin.id);
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);

    const { options } = captureJobs();
    await assert.rejects(() => rollbackWikiPage(dal, { slug, revSummary: { en: 'Vandalism.' } }, reviewer.id, options), ForbiddenError);
    await assert.rejects(() => rollbackWikiPage(dal, { slug, revSummary: { en: 'Mine.' } }, editor.id, options), ForbiddenError);

    const result = await rollbackWikiPage(dal, { slug, revSummary: { en: 'Vandalism.' } }, admin.id, options);
    assert.equal(result.restoredRevId, first.currentRevId);
    assert.equal(result.revertedRevIds.length, 2);
    assert.equal((await readWikiPage(dal, slug)).title?.en, 'Original');

    // The latest edit is now the admin's own: roll back only undoes others.
    await assert.rejects(
      () => rollbackWikiPage(dal, { slug, revSummary: { en: 'Again.' } }, admin.id, options),
      InvalidRequestError
    );
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('A revert that would undo a revert of your own revert is refused', async () => {
  const prefix = `test-revert-guard-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { dal, author, editor, slug, first, latest } = await setupPage(prefix);
    userIds.push(author.id, editor.id);
    const reviewer = await createTestUser();
    userIds.push(reviewer.id);

    const { options } = captureJobs();
    const restore = (revId: string, reason: string, userId: string) =>
      restoreWikiPageRevision(dal, { slug, revId, revSummary: { en: reason } }, userId, options);

    await restore(first.currentRevId, 'Unsourced.', reviewer.id);
    await pause();
    // The editor undoes the reviewer's revert.
    await restore(latest.currentRevId, 'It was fine.', editor.id);
    await pause();

    await assert.rejects(
      () => restore(first.currentRevId, 'Again.', reviewer.id),
      (error: unknown) => error instanceof ConflictError && error.details?.reason === 'edit_war_guard'
    );

    // Someone else can still act on the page.
    const third = await createTestUser();
    userIds.push(third.id);
    await restore(first.currentRevId, 'Third opinion.', third.id);
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('The restore and roll back agent tools follow the same rules as the buttons', async () => {
  const prefix = `test-revert-mcp-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const { author, editor, slug, first, latest } = await setupPage(prefix);
    userIds.push(author.id, editor.id);
    const reviewer = await createTestUser();
    userIds.push(reviewer.id);

    const { server } = createMcpServer({ skipPolicyCheck: true });
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: unknown,
            extra?: { authInfo?: { extra?: { userId?: string } } }
          ) => Promise<{ isError?: boolean; structuredContent: unknown }>;
        }
      >;
    })._registeredTools;
    const as = (userId: string) => ({ authInfo: { extra: { userId } } });

    const rollback = await tools.wiki_rollbackPage.handler({ slug, revSummary: { en: 'Vandalism.' } }, as(reviewer.id));
    assert.equal(rollback.isError, true);
    assert.equal((rollback.structuredContent as { error: { code: string } }).error.code, 'forbidden');

    const stale = await tools.wiki_restoreRevision.handler(
      { slug, revId: first.currentRevId, expectedRevId: first.currentRevId, revSummary: { en: 'Unsourced.' } },
      as(reviewer.id)
    );
    assert.equal(stale.isError, true);
    assert.equal((stale.structuredContent as { error: { code: string } }).error.code, 'precondition_failed');

    const restored = await tools.wiki_restoreRevision.handler(
      { slug, revId: first.currentRevId, expectedRevId: latest.currentRevId, revSummary: { en: 'Unsourced.' } },
      as(reviewer.id)
    );
    await dropQueuedJobs(slug);
    assert.equal(restored.isError, undefined);
    const payload = restored.structuredContent as { restoredRevId: string; revertedRevIds: string[]; slug: string };
    assert.equal(payload.restoredRevId, first.currentRevId);
    assert.equal(payload.revertedRevIds.length, 2);
    await pause();

    await tools.wiki_restoreRevision.handler(
      { slug, revId: latest.currentRevId, revSummary: { en: 'It was fine.' } },
      as(editor.id)
    );
    await dropQueuedJobs(slug);
    await pause();
    const guarded = await tools.wiki_restoreRevision.handler(
      { slug, revId: first.currentRevId, revSummary: { en: 'Again.' } },
      as(reviewer.id)
    );
    assert.equal(guarded.isError, true);
    const error = (guarded.structuredContent as { error: { code: string; details?: { reason?: string } } }).error;
    assert.equal(error.code, 'conflict');
    assert.equal(error.details?.reason, 'edit_war_guard');
  } finally {
    await cleanup(prefix, userIds);
  }
});

test('The history offers restore and roll back, and the form needs a reason', async () => {
  const prefix = `test-revert-route-${Date.now()}`;
  const userIds: string[] = [];
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.t = ((key: string) => key) as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ bodyHtml: options?.bodyHtml, sidebarHtml: options?.sidebarHtml });
    }) as express.Response['render'];
    next();
  });
  registerPageRoutes(app);
  const server = http.createServer(app);
  try {
    const { dal, author, editor, slug, first } = await setupPage(prefix);
    userIds.push(author.id, editor.id);
    const admin = await createTestUser();
    userIds.push(admin.id);
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);
    const { token } = await createSession(admin.id);
    const cookie = `agpwiki_session=${token}`;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;

    const signedOut = await fetch(`${base}/tool/revert?page=${slug}&rev=${first.currentRevId}`, { redirect: 'manual' });
    assert.equal(signedOut.status, 303);

    const view = await fetch(`${base}/${slug}`, { headers: { cookie } });
    const { sidebarHtml } = (await view.json()) as { sidebarHtml: string };
    assert.ok(sidebarHtml.includes(`/tool/revert?page=${slug}&amp;action=rollback`));
    assert.ok(sidebarHtml.includes(`/tool/revert?page=${slug}&amp;rev=${first.currentRevId}`));

    const form = await fetch(`${base}/tool/revert?page=${slug}&rev=${first.currentRevId}`, { headers: { cookie } });
    assert.equal(form.status, 200);
    const { bodyHtml } = (await form.json()) as { bodyHtml: string };
    assert.match(bodyHtml, /name="reason"[^>]*required/);

    const post = (fields: Record<string, string>) =>
      fetch(`${base}/tool/revert`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    const empty = await post({ page: slug, action: 'restore', rev: first.currentRevId, reason: ' ' });
    assert.equal(empty.status, 400);
    assert.match(((await empty.json()) as { bodyHtml: string }).bodyHtml, /revert\.reasonRequired/);

    const done = await post({ page: slug, action: 'rollback', reason: 'Vandalism.' });
    await dropQueuedJobs(slug);
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), `/${slug}`);
    assert.equal((await readWikiPage(dal, slug)).title?.en, 'Original');

    const afterView = await fetch(`${base}/${slug}`, { headers: { cookie } });
    const after = (await afterView.json()) as { sidebarHtml: string };
    assert.match(after.sidebarHtml, /rev-tag-revert/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup(prefix, userIds);
  }
});
