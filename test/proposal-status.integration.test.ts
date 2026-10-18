import './_setup-i18n.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import i18next from 'i18next';
import { initializePostgreSQL } from '../src/db.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { protectWikiPage } from '../src/services/page-protection-service.js';
import { setProposalStatus } from '../src/services/proposal-status-service.js';
import { grantRoleUpsert, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { createWikiPage, readWikiPage } from '../src/services/wiki-page-service.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | undefined;
test.after(async () => { await sharedDal?.disconnect(); });

const setup = async () => {
  const dal = sharedDal ??= await initializePostgreSQL();
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const users = [];
  for (const role of ['author', 'admin']) {
    users.push(await User.create({
      username: `proposal-${role}-${suffix}`,
      displayName: `Proposal ${role} ${suffix}`,
      email: `proposal-${role}-${suffix}@example.com`,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
    }));
  }
  const [author, admin] = users;
  await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);
  const slug = `meta/proposals/regression-${suffix}`;
  const page = await createWikiPage(dal, {
    slug, title: { en: 'Proposal regression' }, body: { en: 'Proposal text.' }, originalLanguage: 'en',
  }, author.id);
  const cleanup = async () => {
    await dal.query('DELETE FROM admin_events WHERE target_id = $1', [page.id]);
    await dal.query('DELETE FROM page_protections WHERE page_id = $1', [page.id]);
    await dal.query('DELETE FROM pages WHERE id = $1 OR _old_rev_of = $1', [page.id]);
    for (const user of users) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
      await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
    }
  };
  return { dal, author, admin, slug, page, cleanup };
};

test('Proposal status respects page protection', async () => {
  const { dal, author, admin, slug, page, cleanup } = await setup();
  try {
    await protectWikiPage(dal, { slug, reason: 'Protected proposal.' }, admin.id);
    await assert.rejects(() => setProposalStatus(dal, { slug, status: 'open' }, author.id), ForbiddenError);
    assert.equal((await readWikiPage(dal, slug)).currentRevId, page.currentRevId);
    const opened = await setProposalStatus(dal, { slug, status: 'open' }, admin.id);
    assert.equal(opened.proposal?.status, 'open');
  } finally { await cleanup(); }
});

test('Proposal decisions reject whitespace-only notes and trim valid notes', async () => {
  const { dal, admin, slug, page, cleanup } = await setup();
  try {
    for (const status of ['adopted', 'applied', 'not_adopted', 'superseded']) {
      await assert.rejects(() => setProposalStatus(dal, {
        slug, status, decisionNote: { en: ' \n\t ', de: '  ' }, appliedTo: ['meta/values'], supersededBy: slug,
      }, admin.id), (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(field => field.field === 'decisionNote'));
        return true;
      });
    }
    assert.equal((await readWikiPage(dal, slug)).currentRevId, page.currentRevId);
    const adopted = await setProposalStatus(dal, {
      slug, status: 'adopted', decisionNote: { en: '  Adopted after discussion.\n', de: '  ' },
    }, admin.id);
    assert.deepEqual(adopted.proposal?.decisionNote, { en: 'Adopted after discussion.' });
    const applied = await setProposalStatus(dal, {
      slug, status: 'applied', decisionNote: { en: '  ' }, appliedTo: ['meta/values'],
    }, admin.id);
    assert.deepEqual(applied.proposal?.decisionNote, adopted.proposal?.decisionNote);
  } finally { await cleanup(); }
});

test('Proposal history renders the selected revision status and decision author', async () => {
  const { dal, author, admin, slug, page, cleanup } = await setup();
  const app = express();
  app.use((req, res, next) => {
    req.t = i18next.t.bind(i18next);
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
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
    const adopted = await setProposalStatus(dal, {
      slug, status: 'adopted', decisionNote: { en: 'Historical adoption rationale.' },
    }, admin.id);
    await setProposalStatus(dal, { slug, status: 'withdrawn' }, author.id);
    const banner = async (revId?: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${slug}${revId ? `?rev=${revId}` : ''}`);
      assert.equal(response.status, 200);
      const { bodyHtml } = await response.json() as { bodyHtml: string };
      const match = bodyHtml.match(/<aside class="proposal-banner[\s\S]*?<\/aside>/);
      assert.ok(match);
      return match[0];
    };
    assert.match(await banner(page.currentRevId), /No status set yet/);
    const adoptedBanner = await banner(adopted.currentRevId);
    assert.match(adoptedBanner, /Adopted, not yet applied/);
    assert.match(adoptedBanner, /Historical adoption rationale\./);
    assert.ok(adoptedBanner.includes(admin.displayName!));
    assert.match(await banner(), /Withdrawn/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await cleanup();
  }
});
