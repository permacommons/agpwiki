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
import { setProposalLinks } from '../src/services/proposal-links-service.js';
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

test('Proposal history renders the selected revision status, links and decision author', async () => {
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
    await setProposalLinks(dal, {
      slug, pullRequests: ['https://github.com/permacommons/agpwiki/pull/86'],
    }, author.id);
    const adopted = await setProposalStatus(dal, {
      slug, status: 'adopted', decisionNote: { en: 'Historical adoption rationale.' },
    }, admin.id);
    const withdrawn = await setProposalStatus(dal, { slug, status: 'withdrawn' }, author.id);
    await setProposalLinks(dal, {
      slug, pullRequests: ['https://github.com/permacommons/agpwiki/pull/87'],
    }, author.id);
    const header = async (query = '') => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${slug}${query}`);
      assert.equal(response.status, 200);
      const { bodyHtml } = await response.json() as { bodyHtml: string };
      const match = bodyHtml.match(/<section class="proposal-header[\s\S]*?<\/section>/);
      assert.ok(match);
      return match[0];
    };
    assert.match(await header(`?rev=${page.currentRevId}`), /No status set yet/);
    const adoptedHeader = await header(`?rev=${adopted.currentRevId}`);
    assert.match(adoptedHeader, /Adopted, not yet applied/);
    assert.match(adoptedHeader, /Historical adoption rationale\./);
    assert.ok(adoptedHeader.includes(admin.displayName!));
    assert.match(adoptedHeader, /pull\/86/);
    assert.doesNotMatch(adoptedHeader, /pull\/87|proposal-manage/);
    const diffHeader = await header(`?diffFrom=${withdrawn.currentRevId}&diffTo=${adopted.currentRevId}`);
    assert.match(diffHeader, /Adopted, not yet applied/);
    assert.match(diffHeader, /pull\/86/);
    assert.doesNotMatch(diffHeader, /pull\/87|proposal-manage/);
    const currentHeader = await header();
    assert.match(currentHeader, /Withdrawn/);
    assert.match(currentHeader, /pull\/87/);
    assert.doesNotMatch(currentHeader, /pull\/86/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await cleanup();
  }
});
