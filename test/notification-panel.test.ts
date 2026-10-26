import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import hbs from 'hbs';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import User from '../src/models/user.js';
import { registerNotificationRoutes } from '../src/routes/notifications.js';
import { countUnreadNotifications } from '../src/services/site-notification-service.js';

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

const createTestUser = async () => {
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  return User.create({
    username: `paneltest${suffix}`,
    displayName: 'Panel Test',
    email: `panel-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const startServer = async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.t = ((key: string, options?: Record<string, unknown>) => {
      if (key === 'notifications.kind.forumReply') return `${options?.name} replied in ${options?.subject}`;
      return key;
    }) as typeof req.t;
    next();
  });
  registerNotificationRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/tool/notifications`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
};

test('The panel endpoint returns only your own latest notifications, and mark-all-read answers in JSON', async () => {
  const dal = await getDal();
  const userIds: string[] = [];
  const server = await startServer();
  try {
    const me = await createTestUser();
    const other = await createTestUser();
    userIds.push(me.id, other.id);
    await dal.query(
      `INSERT INTO notifications (user_id, kind, actor_user_id, url, subject, excerpt, created_at, read_at)
       SELECT $1, 'forum.reply', $2, '/tool/forum', 'Mine ' || n, CASE WHEN n = 1 THEN 'A <b>reply</b>' END,
              NOW() - n * INTERVAL '1 minute', CASE WHEN n > 3 THEN NOW() END
         FROM generate_series(1, 10) AS n`,
      [me.id, other.id]
    );
    await dal.query(
      `INSERT INTO notifications (user_id, kind, url, subject) VALUES ($1, 'forum.reply', '/tool/forum', 'Not mine')`,
      [other.id]
    );
    const session = await createSession(me.id);
    const headers = { cookie: `agpwiki_session=${session.token}`, accept: 'application/json' };

    const anonymous = await fetch(`${server.url}/panel.json`);
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${server.url}/panel.json`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = (await response.json()) as {
      unreadCount: number;
      items: Array<{ id: string; html: string; excerpt: string | null; date: string; unread: boolean }>;
    };
    assert.equal(data.unreadCount, 3);
    assert.equal(data.items.length, 8, 'the panel shows the latest eight');
    assert.ok(data.items.every(item => !item.html.includes('Not mine')));
    assert.match(data.items[0].html, /<strong>Panel Test<\/strong> replied in <a href="\/tool\/notifications\/[^"]+\/open">Mine 1<\/a>/);
    assert.equal(data.items[0].excerpt, 'A <b>reply</b>', 'excerpts are sent as text, the script escapes them');
    assert.deepEqual(
      data.items.map(item => item.unread),
      [true, true, true, false, false, false, false, false]
    );

    const anonymousRead = await fetch(`${server.url}/read`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({}),
    });
    assert.equal(anonymousRead.status, 401);

    const read = await fetch(`${server.url}/read`, { method: 'POST', headers, body: new URLSearchParams({}) });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { unreadCount: 0 });
    assert.equal(await countUnreadNotifications(dal, me.id), 0);
    assert.equal(await countUnreadNotifications(dal, other.id), 1, "someone else's notifications stay unread");
  } finally {
    await server.close();
    for (const id of userIds) {
      await dal.query('DELETE FROM notifications WHERE user_id = $1', [id]);
      await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      await dal.query('DELETE FROM users WHERE id = $1', [id]);
    }
  }
});

test('The header keeps the bell as a link and adds the panel, with your own links on the right', () => {
  const handlebars = hbs.create().handlebars;
  handlebars.registerHelper('__', (key: string) => key);
  handlebars.registerHelper('urlencode', (value: string) => encodeURIComponent(value));
  handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  handlebars.registerHelper('findLanguageLabel', () => '');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'views/partials/header.hbs'), 'utf8');
  const render = handlebars.compile(source);

  const signedIn = render({ signedIn: true, currentUserName: 'Panel', unreadNotificationCount: 2, notificationBellLabel: 'Bell' });
  assert.match(signedIn, /<a class="notification-bell notification-bell--unread" href="\/tool\/notifications"[^>]*aria-controls="notification-panel"[^>]*data-notification-bell>/);
  assert.match(signedIn, /<div class="notification-panel" id="notification-panel" role="dialog"[^>]* hidden/);
  assert.match(signedIn, /data-endpoint="\/tool\/notifications\/panel\.json"/);
  assert.match(signedIn, /<a class="notification-panel-all" href="\/tool\/notifications">notifications\.bar\.all<\/a>/);

  const signedOut = render({ signedIn: false, currentPath: '/belt-buckle' });
  assert.doesNotMatch(signedOut, /notification-panel/);
  assert.match(signedOut, /class="nav-link nav-link--account" href="\/tool\/login\?redirect=%2Fbelt-buckle"/);

  // On wide screens the header is ordered with CSS: search (2), language (3), bell (4), your name or Log in (5).
  const css = fs.readFileSync(path.resolve(process.cwd(), 'public/styles/site.css'), 'utf8');
  const order = (selector: string) => {
    const match = css.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{[^}]*?order: (\\d+);`));
    assert.ok(match, selector);
    return Number(match[1]);
  };
  assert.ok(order('.search-form') < order('.notification-bell'));
  assert.ok(order('.lang-menu') < order('.notification-bell'));
  assert.ok(order('.notification-bell') < order('.user-menu'));
  assert.equal(order('.nav-link--account'), order('.user-menu'));
});
