import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { initializePostgreSQL } from '../src/db.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { PROMPT_SPECS, promptPageSlug } from '../src/lib/prompt-registry.js';
import { createMcpServer } from '../src/mcp/core.js';
import { loadPromptText } from '../src/mcp/prompts.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { getWikiPageEditability } from '../src/services/page-protection-service.js';
import { grantRoleUpsert, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { readWikiPage, replaceWikiPageExactText, updateWikiPage } from '../src/services/wiki-page-service.js';

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

const createTestUser = async () => {
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  return User.create({
    username: `prompttest${suffix}`,
    displayName: 'Prompt Test',
    email: `prompt-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

test('Every prompt has an admin-protected page with its placeholders, imported by the migration', async () => {
  const dal = await getDal();
  for (const spec of PROMPT_SPECS) {
    const page = await readWikiPage(dal, promptPageSlug(spec.id));
    const text = page.body?.en ?? '';
    assert.ok(text.includes(`{{${spec.placeholder.name}}}`), `${spec.id} keeps {{${spec.placeholder.name}}}`);
    assert.ok(text.includes('{{metaPages}}'), `${spec.id} keeps {{metaPages}}`);
    const editability = await getWikiPageEditability(dal, { id: page.id }, null);
    assert.equal(editability.isProtected, true);
    assert.equal(editability.protection?.level, 'admins');
  }
});

test('Agents get the prompt text from the wiki, filled in and naming its revision', async () => {
  const dal = await getDal();
  const { server } = createMcpServer();
  const prompts = (server as unknown as {
    _registeredPrompts: Record<
      string,
      { callback: (args: Record<string, string>) => Promise<{ messages: Array<{ content: { text: string } }> }> }
    >;
  })._registeredPrompts;
  assert.deepEqual(Object.keys(prompts).sort(), PROMPT_SPECS.map(spec => spec.id).sort());

  const page = await readWikiPage(dal, 'meta/prompts/fact-check');
  const result = await prompts['fact-check'].callback({ slug: 'belt-buckle' });
  const text = result.messages[0].content.text;
  assert.ok(text.includes('belt-buckle'));
  assert.ok(!text.includes('{{slug}}') && !text.includes('{{metaPages}}'));
  assert.ok(text.includes('/meta/values'));
  assert.ok(text.endsWith(`(Prompt text from /meta/prompts/fact-check, revision ${page.currentRevId}.)`));

  const created = await prompts['create-article'].callback({ topic: 'Belt buckle' });
  assert.ok(created.messages[0].content.text.includes('"Belt buckle"'));
});

test('A missing prompt page gives a clear message', async () => {
  await assert.rejects(
    () =>
      loadPromptText(
        { ...PROMPT_SPECS[1], id: `missing-${Date.now()}`, title: 'Missing Check' },
        'belt-buckle'
      ),
    (error: unknown) => error instanceof Error && /"Missing Check" prompt is unavailable: the page meta\/prompts\/missing-/.test(error.message)
  );
});

test('A save that would remove a prompt placeholder is refused, and only admins can edit', async () => {
  const dal = await getDal();
  let adminId: string | null = null;
  let editorId: string | null = null;
  try {
    const admin = await createTestUser();
    const editor = await createTestUser();
    adminId = admin.id;
    editorId = editor.id;
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);
    const slug = 'meta/prompts/fact-check';
    const before = await readWikiPage(dal, slug);

    await assert.rejects(
      () => updateWikiPage(dal, { slug, body: { en: 'No placeholders.' }, revSummary: { en: 'Try.' } }, editor.id),
      ForbiddenError
    );
    await assert.rejects(
      () => updateWikiPage(dal, { slug, body: { en: 'Check {{metaPages}} only.' }, revSummary: { en: 'Try.' } }, admin.id),
      (error: unknown) =>
        error instanceof ValidationError && (error.fieldErrors ?? []).some(item => item.message.includes('{{slug}}'))
    );
    await assert.rejects(
      () =>
        replaceWikiPageExactText(
          dal,
          { slug, replacements: [{ from: '{{metaPages}}', to: 'Read the policies.' }], revSummary: { en: 'Try.' } },
          admin.id
        ),
      ValidationError
    );
    // Nothing was written.
    assert.equal((await readWikiPage(dal, slug)).currentRevId, before.currentRevId);
  } finally {
    const ids = [adminId, editorId].filter((id): id is string => Boolean(id));
    await dal.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [ids]);
    await dal.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  }
});

test('A prompt page shows its placeholders to readers', async () => {
  const app = express();
  app.use((req, res, next) => {
    req.t = ((key: string) => key) as typeof req.t;
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
    const response = await fetch(`http://127.0.0.1:${address.port}/meta/prompts/fact-check`);
    const { bodyHtml } = (await response.json()) as { bodyHtml: string };
    assert.match(bodyHtml, /<code class="prompt-placeholder">\{\{slug\}\}<\/code>/);
    assert.match(bodyHtml, /<code class="prompt-placeholder">\{\{metaPages\}\}<\/code>/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
