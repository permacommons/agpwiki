import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import { ConflictError } from '../src/lib/errors.js';
import User from '../src/models/user.js';
import WikiPage from '../src/models/wiki-page.js';
import { renderMarkdown } from '../src/render.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { registerSearchRoutes } from '../src/routes/search.js';
import {
  createWikiPage,
  listEditableSections,
  rewriteWikiPageSection,
  sectionFingerprint,
} from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

const BODY = [
  'The lead.',
  '',
  '## History',
  '',
  'Old history.',
  '',
  '### Early years',
  '',
  'Early text.',
  '',
  '## Uses',
  '',
  'Uses text.',
  '',
  '## History',
  '',
  'A second history.',
  '',
].join('\n');

test('listEditableSections numbers the lead and each heading, with subsections inside their parent', () => {
  const sections = listEditableSections(BODY);
  assert.deepEqual(
    sections.map(section => [section.index, section.target, section.heading, section.level, section.occurrence]),
    [
      [0, 'lead', undefined, undefined, undefined],
      [1, 'heading', 'History', 2, 1],
      [2, 'heading', 'Early years', 3, 1],
      [3, 'heading', 'Uses', 2, 1],
      [4, 'heading', 'History', 2, 2],
    ]
  );
  assert.equal(sections[0].content, 'The lead.\n');
  assert.equal(sections[1].content, '\nOld history.\n\n### Early years\n\nEarly text.\n');
  assert.equal(sections[3].content, '\nUses text.\n');
  assert.equal(sectionFingerprint(sections[3].content), sectionFingerprint('\nUses text.\n'));
  assert.notEqual(sectionFingerprint(sections[1].content), sectionFingerprint(sections[4].content));
});

test('renderMarkdown adds edit links inside the headings of the source, numbered like the sections', async () => {
  const { html } = await renderMarkdown(BODY, [], {
    sectionEditLink: index => `<a class="edit" href="?section=${index}">edit</a>`,
  });
  const links = [...html.matchAll(/<h([23]) id="[^"]+">([^<]+)<a class="edit" href="\?section=(\d)">edit<\/a><\/h\1>/g)].map(
    match => [match[2], match[3]]
  );
  assert.deepEqual(links, [
    ['History', '1'],
    ['Early years', '2'],
    ['Uses', '3'],
    ['History', '4'],
  ]);
  const plain = await renderMarkdown(BODY, []);
  assert.doesNotMatch(plain.html, /class="edit"/);
});

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
    username: `sectiontest${suffix}`,
    displayName: 'Section Test',
    email: `section-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const cleanup = async (dal: Dal, slug: string, userId: string | null) => {
  await dal.query('DELETE FROM pages WHERE slug = $1', [slug]);
  if (userId) {
    await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

const currentBody = async (slug: string) => {
  const page = await WikiPage.filterWhere({ slug, _oldRevOf: null } as Record<string, unknown>).first();
  return (page?.body as Record<string, string>).en;
};

test('Saving a section is refused only when that same section changed since it was loaded', async () => {
  const dal = await getDal();
  const slug = `test-section-save-${uniqueSuffix()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    await createWikiPage(dal, { slug, title: { en: 'Sections' }, body: { en: BODY }, originalLanguage: 'en' }, user.id);
    const loaded = listEditableSections(BODY);
    const usesFingerprint = sectionFingerprint(loaded[3].content);
    const historyFingerprint = sectionFingerprint(loaded[1].content);

    // Someone else edits the History section in the meantime.
    await rewriteWikiPageSection(
      dal,
      { slug, heading: 'History', headingLevel: 2, occurrence: 1, content: '\nNew history.\n', revSummary: { en: 'Other edit.' } },
      user.id
    );

    // Editing Uses still works: it did not change.
    await rewriteWikiPageSection(
      dal,
      {
        slug,
        heading: 'Uses',
        headingLevel: 2,
        occurrence: 1,
        content: '\nBetter uses text.\n',
        expectedSectionFingerprint: usesFingerprint,
        revSummary: { en: 'Uses: clearer.' },
      },
      user.id
    );
    const body = await currentBody(slug);
    assert.match(body, /New history\./);
    assert.match(body, /## Uses\n\nBetter uses text\.\n\n## History\n\nA second history\./);

    // Saving History with the old fingerprint is refused, and nothing changes.
    await assert.rejects(
      () =>
        rewriteWikiPageSection(
          dal,
          {
            slug,
            heading: 'History',
            headingLevel: 2,
            occurrence: 1,
            content: '\nMy history.\n',
            expectedSectionFingerprint: historyFingerprint,
            revSummary: { en: 'History.' },
          },
          user.id
        ),
      ConflictError
    );
    assert.equal(await currentBody(slug), body);
  } finally {
    await cleanup(dal, slug, userId);
  }
});

const makeServer = async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    (req as express.Request & { t: (key: string, options?: Record<string, unknown>) => string }).t = (
      key,
      options
    ) => (key === 'sectionEdit.lead' ? 'Introduction' : options ? `${key}${JSON.stringify(options)}` : key);
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.locals.currentPath = req.originalUrl || '/';
    res.render = ((view: string, options?: Record<string, unknown>) => {
      res.json({ view, bodyHtml: options?.bodyHtml ?? '' });
    }) as express.Response['render'];
    next();
  });
  registerSearchRoutes(app);
  registerPageRoutes(app);
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

test('Editors see section edit links; the section form edits and saves only that section', async () => {
  const dal = await getDal();
  const slug = `test-section-form-${uniqueSuffix()}`;
  let userId: string | null = null;
  const server = await makeServer();
  try {
    const user = await createTestUser();
    userId = user.id;
    await createWikiPage(dal, { slug, title: { en: 'Sections' }, body: { en: BODY }, originalLanguage: 'en' }, user.id);
    const { token } = await createSession(user.id);
    const cookie = `agpwiki_session=${token}`;
    const getBody = async (path: string, withSession = true) => {
      const response = await fetch(`${server.url}${path}`, { headers: withSession ? { cookie } : {} });
      assert.equal(response.status, 200, path);
      return ((await response.json()) as { bodyHtml: string }).bodyHtml;
    };

    const signedOut = await getBody(`/${slug}`, false);
    assert.doesNotMatch(signedOut, /section-edit/);
    const view = await getBody(`/${slug}`);
    assert.ok(view.includes(`href="/${slug}/operator-edit?lang=en&amp;section=3" aria-label="sectionEdit.linkLabel{&quot;section&quot;:&quot;Uses&quot;}"`));
    assert.ok(view.includes(`class="section-edit section-edit--lead">[<a href="/${slug}/operator-edit?lang=en&amp;section=0">`));
    const revId = (await dal.query('SELECT _rev_id FROM pages WHERE slug = $1 AND _old_rev_of IS NULL', [slug])).rows[0]
      ._rev_id as string;
    assert.doesNotMatch(await getBody(`/${slug}?rev=${revId}`), /section-edit/, 'no links on an old revision');

    const form = await getBody(`/${slug}/operator-edit?lang=en&section=3`);
    assert.match(form, /<textarea[^>]*>Uses text\.<\/textarea>/);
    assert.match(form, /name="sectionTarget" value="heading"/);
    assert.match(form, /name="sectionHeading" value="Uses"/);
    assert.doesNotMatch(form, /name="title"/);
    assert.doesNotMatch(form, /name="wikidata"/);
    assert.match(form, /data-editor-toolbar/);
    const fingerprint = form.match(/name="sectionFingerprint" value="([0-9a-f]+)"/)?.[1];
    assert.ok(fingerprint);

    const whole = await getBody(`/${slug}/operator-edit?lang=en&section=99`);
    assert.match(whole, /name="title"/, 'an unknown section opens the whole page');

    const post = (fields: Record<string, string>) =>
      fetch(`${server.url}/${slug}/operator-edit`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          lang: 'en',
          sectionTarget: 'heading',
          sectionHeading: 'Uses',
          sectionLevel: '2',
          sectionOccurrence: '1',
          sectionFingerprint: fingerprint,
          ...fields,
        }).toString(),
      });

    const saved = await post({ body: 'Uses text,\r\nnow longer.', summary: 'more detail' });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), `/${slug}?lang=en`);
    const body = await currentBody(slug);
    assert.equal(body, BODY.replace('Uses text.\n', 'Uses text,\nnow longer.\n'));
    const summary = (
      await dal.query('SELECT _rev_summary FROM pages WHERE slug = $1 AND _old_rev_of IS NULL', [slug])
    ).rows[0]._rev_summary as Record<string, string>;
    assert.equal(summary.en, 'Uses: more detail');

    // The same form again is now stale: the section changed since it was loaded.
    const stale = await post({ body: 'Something else.', summary: 'again' });
    assert.equal(stale.status, 200);
    assert.match(((await stale.json()) as { bodyHtml: string }).bodyHtml, /class="form-error">sectionEdit\.changed</);
    assert.equal(await currentBody(slug), body);
  } finally {
    await server.close();
    await cleanup(dal, slug, userId);
  }
});

test('The citation search finds citations by title or author, at least two characters', async () => {
  const server = await makeServer();
  try {
    const short = await fetch(`${server.url}/api/citation-search?q=a`);
    assert.deepEqual(await short.json(), { results: [] });
    const response = await fetch(`${server.url}/api/citation-search?q=zzzz-no-such-citation`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [] });
  } finally {
    await server.close();
  }
});
