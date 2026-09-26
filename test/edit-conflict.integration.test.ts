import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test, { type TestContext } from 'node:test';

import express from 'express';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import { toToolErrorPayload } from '../src/mcp/errors.js';
import ForumComment from '../src/models/forum-comment.js';
import ForumThread from '../src/models/forum-thread.js';
import User from '../src/models/user.js';
import WikiPage from '../src/models/wiki-page.js';
import { registerForumRoutes } from '../src/routes/forum.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { createForumComment, createForumThread } from '../src/services/forum-service.js';
import { FORUM_MODERATOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

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
    username: `conflicttest${suffix}`,
    displayName: 'Conflict Test',
    email: `conflict-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const cleanupUser = async (dal: Dal, userId: string | null) => {
  if (!userId) return;
  await dal.query('DELETE FROM forum_thread_subscriptions WHERE user_id = $1', [userId]);
  await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
  await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  await dal.query('DELETE FROM users WHERE id = $1', [userId]);
};

const cleanupForumThread = async (dal: Dal, threadId: string | null) => {
  if (!threadId) return;
  await dal.query("DELETE FROM notification_jobs WHERE payload->>'threadId' = $1", [threadId]);
  await dal.query('DELETE FROM forum_thread_subscriptions WHERE thread_id = $1', [threadId]);
  await dal.query('DELETE FROM forum_comments WHERE thread_id = $1', [threadId]);
  await dal.query('DELETE FROM forum_threads WHERE id = $1 OR _old_rev_of = $1', [threadId]);
};

type RevisionedInstance = {
  id: string;
  newRevision: (user: { id: string }, options: { tags: string[] }) => Promise<unknown>;
  save: (...args: unknown[]) => Promise<unknown>;
  updatedAt?: Date | null;
};

type RevisionedModel = {
  prototype: object;
  filterWhere: (where: { id: string }) => { first: () => Promise<unknown> };
};

// Saves a second copy of the same document just before the first save() on
// the model, so that save() runs against a revision it did not load.
const saveConcurrentRevisionBeforeNextSave = (
  t: TestContext,
  Model: RevisionedModel,
  userId: string
) => {
  const prototype = Model.prototype as { save: (...args: unknown[]) => Promise<unknown> };
  const originalSave = prototype.save;
  let raced = false;
  t.mock.method(prototype, 'save', async function (this: RevisionedInstance, ...args: unknown[]) {
    if (!raced) {
      raced = true;
      const other = (await Model.filterWhere({ id: this.id }).first()) as RevisionedInstance;
      await other.newRevision({ id: userId }, { tags: ['concurrent-test'] });
      other.updatedAt = new Date();
      await originalSave.call(other);
    }
    return originalSave.apply(this, args);
  });
};

const makeTestServer = async (register: (app: express.Express) => void) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    (req as express.Request & { t: (key: string) => string }).t = key => key;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.signedIn = true;
    res.locals.accountState = { isEmailVerified: true };
    res.locals.accountBannerHtml = '';
    res.locals.currentPath = req.originalUrl || '/';
    res.render = ((view: string, options?: Record<string, unknown>) => {
      res.json({ view, bodyHtml: options?.bodyHtml });
    }) as express.Response['render'];
    next();
  });
  register(app);

  const server = http.createServer(app);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('No address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => server.close(error => (error ? rej(error) : res()))),
      });
    });
  });
};

const postForm = async (url: string, sessionToken: string, form: Record<string, string>) =>
  fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `agpwiki_session=${sessionToken}`,
    },
    body: new URLSearchParams(form).toString(),
  });

test('Saving a stale copy of a wiki page maps to a retryable MCP conflict', async () => {
  const dal = await getDal();
  const slug = `test-revision-conflict-${uniqueSuffix()}`;
  let userId: string | null = null;

  try {
    const user = await createTestUser();
    userId = user.id;
    await createWikiPage(
      dal,
      { slug, title: { en: 'Conflict' }, body: { en: 'Original.' }, originalLanguage: 'en' },
      user.id
    );

    const first = await WikiPage.filterWhere({ slug }).first();
    const second = await WikiPage.filterWhere({ slug }).first();
    assert.ok(first && second);
    const loadedRevId = first._revID;

    await first.newRevision({ id: user.id }, { tags: ['update'] });
    first.body = { en: 'First edit.' };
    await first.save();

    await second.newRevision({ id: user.id }, { tags: ['update'] });
    second.body = { en: 'Second edit.' };
    const error = await second.save().then(
      () => assert.fail('expected the stale save to be rejected'),
      (caught: unknown) => caught
    );

    assert.equal((error as Error).name, 'RevisionConflictError');
    const payload = toToolErrorPayload(error);
    assert.equal(payload.error.code, 'conflict');
    assert.equal(payload.error.retryable, true);
    assert.deepEqual(payload.error.details, {
      documentId: first.id,
      expectedRevId: loadedRevId,
      currentRevId: first._revID,
    });

    const current = await WikiPage.filterWhere({ slug }).first();
    assert.deepEqual(current?.body, { en: 'First edit.' });
  } finally {
    await dal.query('DELETE FROM pages WHERE slug = $1', [slug]);
    await cleanupUser(dal, userId);
  }
});

test('Operator edit shows an edit-conflict message when the page changes mid-save', async t => {
  const dal = await getDal();
  const slug = `test-operator-edit-conflict-${uniqueSuffix()}`;
  let userId: string | null = null;
  const server = await makeTestServer(registerPageRoutes);

  try {
    const user = await createTestUser();
    userId = user.id;
    await createWikiPage(
      dal,
      { slug, title: { en: 'Conflict' }, body: { en: 'Original.' }, originalLanguage: 'en' },
      user.id
    );
    const { token } = await createSession(user.id);

    saveConcurrentRevisionBeforeNextSave(t, WikiPage, user.id);
    const response = await postForm(`${server.url}/${slug}/operator-edit`, token, {
      lang: 'en',
      title: 'Conflict',
      body: 'Operator edit.',
      summary: 'Edit from the web.',
    });

    assert.equal(response.status, 200);
    const { bodyHtml } = (await response.json()) as { bodyHtml: string };
    assert.match(bodyHtml, /class="form-error">operatorEdit\.validation\.conflict</);
    assert.match(bodyHtml, /Operator edit\./);

    const current = await WikiPage.filterWhere({ slug }).first();
    assert.deepEqual(current?.body, { en: 'Original.' });
  } finally {
    await server.close();
    await dal.query('DELETE FROM pages WHERE slug = $1', [slug]);
    await cleanupUser(dal, userId);
  }
});

test('Forum pin responds with an edit conflict when the thread changes mid-save', async t => {
  const dal = await getDal();
  let userId: string | null = null;
  let threadId: string | null = null;
  const server = await makeTestServer(registerForumRoutes);

  try {
    const user = await createTestUser();
    userId = user.id;
    await grantRoleUpsert(dal, user.id, FORUM_MODERATOR_ROLE);
    const thread = await createForumThread(
      { category: 'general', title: `conflict-pin-${uniqueSuffix()}`, body: 'Opening.', language: 'en' },
      user.id
    );
    threadId = thread.id;
    const { token } = await createSession(user.id);

    saveConcurrentRevisionBeforeNextSave(t, ForumThread, user.id);
    const response = await postForm(`${server.url}/tool/forum/thread/${thread.id}/pin`, token, {
      pinned: 'true',
    });

    assert.equal(response.status, 409);
    assert.equal(await response.text(), 'forum.editConflict');
    const current = await ForumThread.filterWhere({ id: thread.id }).first();
    assert.equal(current?.pinned, 0);
  } finally {
    await server.close();
    await cleanupForumThread(dal, threadId);
    await cleanupUser(dal, userId);
  }
});

test('Forum reply is kept when the thread activity bump hits a revision conflict', async t => {
  const dal = await getDal();
  let userId: string | null = null;
  let threadId: string | null = null;

  try {
    const user = await createTestUser();
    userId = user.id;
    const thread = await createForumThread(
      { category: 'general', title: `conflict-reply-${uniqueSuffix()}`, body: 'Opening.', language: 'en' },
      user.id
    );
    threadId = thread.id;

    saveConcurrentRevisionBeforeNextSave(t, ForumThread, user.id);
    const reply = await createForumComment(
      { threadId: thread.id, body: 'Reply during a concurrent thread edit.', language: 'en' },
      user.id
    );

    const saved = await ForumComment.filterWhere({ id: reply.id }).first();
    assert.equal(saved?.threadId, thread.id);
  } finally {
    await cleanupForumThread(dal, threadId);
    await cleanupUser(dal, userId);
  }
});
