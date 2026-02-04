import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import type { PageCheckMetrics } from '../lib/page-checks.js';
import { resolveOptionalSafeText, resolveSafeText, resolveSafeTextRequired } from '../lib/safe-text.js';
import { isBlockedSlug } from '../lib/slug.js';
import Citation from '../models/citation.js';
import type { PageCheckInstance } from '../models/manifests/page-check.js';
import PageAlias from '../models/page-alias.js';
import PageCheck from '../models/page-check.js';
import WikiPage from '../models/wiki-page.js';
import {
  concatSafeText,
  escapeHtml,
  formatDateUTC,
  renderLayout,
  renderMarkdown,
  renderSafeText,
  renderToc,
} from '../render.js';
import { renderRevisionDiff } from './lib/diff.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';
import {
  formatCheckStatus,
  formatCheckType,
  getCheckMetaParts,
  type PageCheckDetailItem,
  type PageCheckSummaryItem,
  renderPageCheckHistory,
  renderPageChecksList,
  renderPageChecksSummary,
} from './lib/page-checks.js';

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

const resolveCheckMetrics = (metrics: PageCheckMetrics | null | undefined) => {
  const fallback = {
    issues_found: { high: 0, medium: 0, low: 0 },
    issues_fixed: { high: 0, medium: 0, low: 0 },
  };
  return metrics ?? fallback;
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
  app.use((req, res, next) => {
    if (!req.originalUrl || req.originalUrl === '/') {
      next();
      return;
    }

    const url = new URL(`http://local${req.originalUrl}`);
    if (!url.pathname.endsWith('/')) {
      next();
      return;
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
    if (normalizedPath === url.pathname) {
      next();
      return;
    }

    res.redirect(308, `${normalizedPath}${url.search}`);
  });

  app.get('/', (_req, res) => {
    res.redirect(302, '/meta/welcome');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(/^\/(.+)\/checks$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      const page = await resolvePageBySlug(slug);
      if (!page) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const dalInstance = await initializePostgreSQL();
      const checks = await PageCheck.filterWhere({
        pageId: page.id,
        _oldRevOf: null,
        _revDeleted: false,
      } as Record<string, unknown>)
        .orderBy('_revDate', 'DESC')
        .run();

      const userIds = checks
        .map(check => check._revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const items: PageCheckDetailItem[] = checks.map(check => {
        const metrics = resolveCheckMetrics(check.metrics as PageCheckMetrics | null);
        return {
          id: check.id,
          typeLabel: formatCheckType(check.type, req.t),
          statusLabel: formatCheckStatus(check.status, req.t),
          dateLabel: formatDateUTC(check.completedAt ?? check._revDate ?? check.createdAt),
          checkResults: resolveSafeTextRequired(mlString.resolve, 'en', check.checkResults),
          notes: resolveOptionalSafeText(mlString.resolve, 'en', check.notes),
          metrics: {
            issuesFound: metrics.issues_found,
            issuesFixed: metrics.issues_fixed,
          },
          revUser: check._revUser ?? null,
          revTags: check._revTags ?? null,
        };
      });

      const pageTitle = resolveSafeText(mlString.resolve, 'en', page.title, page.slug);
      const title = concatSafeText(pageTitle, ` · ${req.t('checks.title')}`);
      const bodyHtml = `<section class="check-list">${renderPageChecksList({
        checks: items,
        userMap,
        slug: page.slug,
        t: req.t,
      })}</section>`;
      const sidebarHtml = '';
      const signedIn = Boolean(await resolveSessionUser(req));
      const labelHtml = `<div class="page-label">${req.t('checks.title')}</div>`;
      const html = renderLayout({
        title,
        labelHtml,
        bodyHtml,
        sidebarHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render checks list:', message);
    }
  });

  app.get(/^\/(.+)\/checks\/([^/]+)$/, async (req, res) => {
    const slug = req.params[0];
    const checkId = req.params[1];
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;

    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      const page = await resolvePageBySlug(slug);
      if (!page) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const dalInstance = await initializePostgreSQL();
      const check = await PageCheck.filterWhere({
        id: checkId,
        pageId: page.id,
        _oldRevOf: null,
        _revDeleted: false,
      } as Record<string, unknown>).first();

      if (!check) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const revisions = await PageCheck.filterWhere({})
        .getAllRevisions(check.id)
        .orderBy('_revDate', 'DESC')
        .run();
      const userIds = revisions
        .map(rev => rev._revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const fetchRevisionByRevId = async (revId: string) => {
        return PageCheck.filterWhere({}).getRevisionByRevId(revId, check.id).first();
      };
      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : check;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send(req.t('page.revisionNotFound'));
        return;
      }

      const resolveRevisionText = (rev: PageCheckInstance) => {
        const resolvedMetrics = resolveCheckMetrics(rev.metrics as PageCheckMetrics | null);
        const resolvedCheckResults = renderSafeText(
          resolveSafeTextRequired(mlString.resolve, 'en', rev.checkResults)
        );
        const resolvedNotes = renderSafeText(
          resolveSafeTextRequired(mlString.resolve, 'en', rev.notes, '')
        );
        const resolvedDate = formatDateUTC(rev.completedAt ?? rev._revDate ?? rev.createdAt);
        const lines = [
          `${req.t('checks.fields.type')}: ${formatCheckType(rev.type, req.t)}`,
          `${req.t('checks.fields.status')}: ${formatCheckStatus(rev.status, req.t)}`,
          `${req.t('checks.fields.completed')}: ${resolvedDate}`,
          `${req.t('checks.fields.targetRevision')}: ${rev.targetRevId ?? ''}`,
          `${req.t('checks.metrics.found')}: ${resolvedMetrics.issues_found.high}/${resolvedMetrics.issues_found.medium}/${resolvedMetrics.issues_found.low}`,
          `${req.t('checks.metrics.fixed')}: ${resolvedMetrics.issues_fixed.high}/${resolvedMetrics.issues_fixed.medium}/${resolvedMetrics.issues_fixed.low}`,
          '',
          `${req.t('checks.fields.checkResults')}:`,
          resolvedCheckResults,
        ];
        if (resolvedNotes) {
          lines.push('', `${req.t('checks.fields.notes')}:`, resolvedNotes);
        }
        return lines.join('\n');
      };

      const metrics = resolveCheckMetrics(selectedRevision.metrics as PageCheckMetrics | null);
      const typeLabel = formatCheckType(selectedRevision.type, req.t);
      const statusLabel = formatCheckStatus(selectedRevision.status, req.t);
      const dateLabel = formatDateUTC(
        selectedRevision.completedAt ?? selectedRevision._revDate ?? selectedRevision.createdAt
      );
      const checkResults = resolveSafeTextRequired(
        mlString.resolve,
        'en',
        selectedRevision.checkResults
      );
      const notes = resolveOptionalSafeText(mlString.resolve, 'en', selectedRevision.notes);
      const targetRevId = selectedRevision.targetRevId;

      const meta = getCheckMetaParts(
        selectedRevision._revUser ?? null,
        selectedRevision._revTags ?? null,
        userMap,
        req.t
      );
      const agentLabel = [meta.agentTag, meta.agentVersion].filter(Boolean).join(' · ');
      const operatorValue = meta.displayName
        ? [meta.displayName, agentLabel].filter(Boolean).join('\n')
        : agentLabel;
      const fields = [
        { label: req.t('checks.fields.type'), value: typeLabel },
        { label: req.t('checks.fields.status'), value: statusLabel },
        { label: req.t('checks.fields.completed'), value: dateLabel },
        {
          label: req.t('checks.fields.targetRevision'),
          value: targetRevId,
          href: targetRevId ? `/${encodeURIComponent(page.slug)}?rev=${targetRevId}` : '',
        },
        ...(operatorValue
          ? [{ label: req.t('checks.fields.operator'), value: operatorValue }]
          : []),
      ];

      const fieldsHtml = fields
        .filter(field => field.value)
        .map(field => {
          const value = String(field.value);
          const renderedValue = field.href
            ? `<a href="${escapeHtml(field.href)}">${escapeHtml(value)}</a>`
            : escapeHtml(value);
          const valueHtml = renderedValue.replace(/\n/g, '<br />');
          return `<div class="citation-field">
  <dt>${escapeHtml(field.label)}</dt>
  <dd>${valueHtml}</dd>
</div>`;
        })
        .join('\n');

      const metricsHtml = `<table class="check-metrics-table">
  <thead>
    <tr>
      <th>${escapeHtml(req.t('checks.metrics.severity'))}</th>
      <th>${escapeHtml(req.t('checks.metrics.high'))}</th>
      <th>${escapeHtml(req.t('checks.metrics.medium'))}</th>
      <th>${escapeHtml(req.t('checks.metrics.low'))}</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>${escapeHtml(req.t('checks.metrics.found'))}</th>
      <td>${metrics.issues_found.high}</td>
      <td>${metrics.issues_found.medium}</td>
      <td>${metrics.issues_found.low}</td>
    </tr>
    <tr>
      <th>${escapeHtml(req.t('checks.metrics.fixed'))}</th>
      <td>${metrics.issues_fixed.high}</td>
      <td>${metrics.issues_fixed.medium}</td>
      <td>${metrics.issues_fixed.low}</td>
    </tr>
  </tbody>
</table>`;
      const notesHtml = notes
        ? `<div class="check-notes">${renderSafeText(notes)}</div>`
        : '';
      const bodyHtml = `<div class="check-card">
  <div class="check-meta">
    <dl class="citation-fields">${fieldsHtml}</dl>
  </div>
  ${metricsHtml}
  <div class="check-results">${renderSafeText(checkResults)}</div>
  ${notesHtml}
</div>`;

      const historyRevisions: PageCheckSummaryItem[] = revisions.map(rev => {
        const revMetrics = resolveCheckMetrics(rev.metrics as PageCheckMetrics | null);
        return {
          id: rev._revID,
          typeLabel: formatCheckType(rev.type, req.t),
          statusLabel: formatCheckStatus(rev.status, req.t),
          dateLabel: formatDateUTC(rev._revDate),
          metrics: {
            issuesFound: revMetrics.issues_found,
            issuesFixed: revMetrics.issues_fixed,
          },
          revUser: rev._revUser ?? null,
          revTags: rev._revTags ?? null,
        };
      });

      const historyHtml = renderPageCheckHistory({
        revisions: historyRevisions,
        userMap,
        slug: page.slug,
        checkId: check.id,
        diffFrom,
        diffTo,
        t: req.t,
      });

      const pageTitle = resolveSafeText(mlString.resolve, 'en', page.title, page.slug);
      const title = concatSafeText(pageTitle, ` · ${req.t('checks.title')}`);
      const labelHtml = `<div class="page-label">${req.t('checks.title')}</div>`;
      const signedIn = Boolean(await resolveSessionUser(req));
      let diffHtml = '';
      if (diffFrom && diffTo) {
        const fromRev = await fetchRevisionByRevId(diffFrom);
        const toRev = await fetchRevisionByRevId(diffTo);
        if (fromRev && toRev) {
          const fromLabel = `${diffFrom} (${formatDateUTC(fromRev._revDate)})`;
          const toLabel = `${diffTo} (${formatDateUTC(toRev._revDate)})`;
          diffHtml = renderRevisionDiff({
            fromLabel,
            toLabel,
            fromText: resolveRevisionText(fromRev),
            toText: resolveRevisionText(toRev),
          });
        }
      }

      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const sidebarHtml = historyHtml;
      const html = renderLayout({
        title,
        labelHtml,
        bodyHtml: topHtml + bodyHtml,
        sidebarHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render check detail:', message);
    }
  });

  app.get(/^\/(.+)$/, async (req, res) => {
    const slug = req.params[0];
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;
    const formatParam = typeof req.query.format === 'string' ? req.query.format : undefined;

    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      const page = await resolvePageBySlug(slug);

      if (!page) {
        res.status(404).type('text').send(req.t('page.notFound'));
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
      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : page;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send(req.t('page.revisionNotFound'));
        return;
      }

      const resolvedBody = mlString.resolve('en', selectedRevision.body ?? null);

      const canonicalSlug = page.slug;
      const title = resolveSafeText(mlString.resolve, 'en', selectedRevision.title, canonicalSlug);
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

      const pageChecks = await PageCheck.filterWhere({
        pageId: page.id,
        _oldRevOf: null,
        _revDeleted: false,
      } as Record<string, unknown>)
        .orderBy('_revDate', 'DESC')
        .limit(10)
        .run();

      const userIds = new Set<string>();
      for (const rev of revisions) {
        if (rev._revUser) userIds.add(rev._revUser);
      }
      for (const check of pageChecks) {
        if (check._revUser) userIds.add(check._revUser);
      }
      const userMap = await fetchUserMap(dalInstance, [...userIds]);

      const historyRevisions = revisions.map(rev => ({
        revId: rev._revID,
        dateLabel: formatDateUTC(rev._revDate),
        title: resolveSafeText(mlString.resolve, 'en', rev.title, canonicalSlug),
        summary: resolveSafeText(mlString.resolve, 'en', rev._revSummary, ''),
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

      const checkItems: PageCheckSummaryItem[] = pageChecks.map(check => {
        const metrics = resolveCheckMetrics(check.metrics as PageCheckMetrics | null);
        const dateLabel = formatDateUTC(check.completedAt ?? check._revDate ?? check.createdAt);
        return {
          id: check.id,
          typeLabel: formatCheckType(check.type, req.t),
          statusLabel: formatCheckStatus(check.status, req.t),
          dateLabel,
          metrics: {
            issuesFound: metrics.issues_found,
            issuesFixed: metrics.issues_fixed,
          },
          revUser: check._revUser ?? null,
          revTags: check._revTags ?? null,
        };
      });
      const checksHtml = renderPageChecksSummary({
        checks: checkItems,
        userMap,
        slug: canonicalSlug,
        t: req.t,
      });
      const tocHtml = renderToc(toc, { expanded: true, label: req.t('toc.title') });
      const sidebarHtml = checksHtml + historyHtml + tocHtml;

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
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render wiki page:', message);
    }
  });
};
