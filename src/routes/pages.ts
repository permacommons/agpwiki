import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { isBlockedSlug } from '../lib/slug.js';
import Citation from '../models/citation.js';
import PageAlias from '../models/page-alias.js';
import WikiPage from '../models/wiki-page.js';
import { formatDateUTC, renderLayout, renderMarkdown, renderToc } from '../render.js';
import { renderRevisionDiff } from './lib/diff.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';

const { mlString } = dal;

const citationKeyRegex = /@([\w][\w:.#$%&\-+?<>~/]*)/g;

const extractCitationKeys = (value: string) => {
  const keys = new Set<string>();
  if (!value) return keys;
  for (const match of value.matchAll(citationKeyRegex)) {
    keys.add(match[1]);
  }
  return keys;
};

const findCurrentPageBySlug = async (slug: string) =>
  WikiPage.filterWhere({
    slug,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentPageById = async (id: string) =>
  WikiPage.filterWhere({
    id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const resolvePageBySlug = async (slug: string) => {
  const direct = await findCurrentPageBySlug(slug);
  if (direct) return direct;

  const alias = await PageAlias.filterWhere({ slug }).first();
  if (!alias) return null;

  return findCurrentPageById(alias.pageId);
};

export const registerPageRoutes = (app: Express) => {
  app.get('/', (_req, res) => {
    res.redirect(302, '/meta/welcome');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(/^\/(.+)$/, async (req, res) => {
    const slug = req.params[0];
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;
    const formatParam = typeof req.query.format === 'string' ? req.query.format : undefined;

    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send('Not found');
      return;
    }

    try {
      await initializePostgreSQL();

      const page = await resolvePageBySlug(slug);

      if (!page) {
        res.status(404).type('text').send('Not found');
        return;
      }

      const dalInstance = await initializePostgreSQL();

      const fetchRevisionByRevId = async (revId: string) => {
        return WikiPage.filterWhere({}).getRevisionByRevId(revId, page.id).first();
      };

      const revisions = await WikiPage.filterWhere({})
        .getAllRevisions(page.id)
        .orderBy('_revDate', 'DESC')
        .run();
      const userIds = revisions
        .map(rev => rev._revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : page;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send('Revision not found');
        return;
      }

      const resolvedTitle = mlString.resolve('en', selectedRevision.title ?? null);
      const resolvedBody = mlString.resolve('en', selectedRevision.body ?? null);

      const canonicalSlug = page.slug;
      const title = resolvedTitle?.str ?? canonicalSlug;
      const metaLabel = canonicalSlug.startsWith('meta/')
        ? `<div class="page-label">${req.t('label.meta')}</div>`
        : canonicalSlug.startsWith('tool/')
          ? `<div class="page-label">${req.t('label.tool')}</div>`
          : `<div class="page-label">${req.t('label.article')}</div>`;
      const bodySource = resolvedBody?.str ?? '';

      if (formatParam === 'raw') {
        res.type('text/plain').send(bodySource);
        return;
      }
      const citationKeys = extractCitationKeys(bodySource);
      const citationEntries: Array<Record<string, unknown>> = [];

      if (citationKeys.size > 0) {
        const keys = Array.from(citationKeys);
        const result = await dalInstance.query(
          `SELECT * FROM ${Citation.tableName} WHERE key = ANY($1) AND _old_rev_of IS NULL AND _rev_deleted = false`,
          [keys]
        );
        for (const row of result.rows) {
          const item = (row.data ?? {}) as Record<string, unknown>;
          const id = row.key;
          citationEntries.push({ ...item, id });
        }
      }

      const { html: bodyHtml, toc } = await renderMarkdown(bodySource, citationEntries);

      let diffHtml = '';
      if (diffFrom && diffTo) {
        const fromRev = await fetchRevisionByRevId(diffFrom);
        const toRev = await fetchRevisionByRevId(diffTo);
        if (fromRev && toRev) {
          const fromText = mlString.resolve('en', fromRev.body ?? null)?.str ?? '';
          const toText = mlString.resolve('en', toRev.body ?? null)?.str ?? '';
          const fromLabel = formatDateUTC(fromRev._revDate)
            ? `${diffFrom} (${formatDateUTC(fromRev._revDate)})`
            : diffFrom;
          const toLabel = formatDateUTC(toRev._revDate)
            ? `${diffTo} (${formatDateUTC(toRev._revDate)})`
            : diffTo;
          diffHtml = renderRevisionDiff({
            fromLabel,
            toLabel,
            fromText,
            toText,
          });
        }
      }

      const historyRevisions = revisions.map(rev => ({
        revId: rev._revID,
        dateLabel: formatDateUTC(rev._revDate),
        title: mlString.resolve('en', rev.title ?? null)?.str ?? canonicalSlug,
        summary: mlString.resolve('en', rev._revSummary ?? null)?.str ?? '',
        revUser: rev._revUser ?? null,
        revTags: rev._revTags ?? null,
      }));
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: `/${canonicalSlug}`,
        viewHref: revId => `/${canonicalSlug}?rev=${revId}`,
        userMap,
        t: req.t,
      });
      const tocHtml = renderToc(toc, { expanded: true, label: req.t('toc.title') });
      const sidebarHtml = historyHtml + tocHtml;

      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const signedIn = Boolean(await resolveSessionUser(req));
      const html = renderLayout({
        title,
        labelHtml: metaLabel,
        bodyHtml,
        topHtml,
        sidebarHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send('Server error');
      console.error('Failed to render wiki page:', message);
    }
  });
};
