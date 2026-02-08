import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { NotFoundError } from '../lib/errors.js';
import type { PageCheckMetrics } from '../lib/page-checks.js';
import {
  resolveSafeText,
  resolveSafeTextWithFallback,
} from '../lib/safe-text.js';
import { isBlockedSlug } from '../lib/slug.js';
import {
  concatSafeText,
  escapeHtml,
  formatDateUTC,
  renderLayout,
  renderMarkdown,
  renderToc,
} from '../render.js';
import {
  diffPageCheckRevisions,
  listPageCheckRevisions,
  listPageChecks,
  readPageCheckRevision,
} from '../services/page-check-service.js';
import {
  diffWikiPageRevisions,
  listWikiPageRevisions,
  readWikiPage,
  readWikiPageRevision,
} from '../services/wiki-page-service.js';
import {
  extractQueryParams,
  getAvailableLanguages,
  normalizeOverrideLang,
  renderContentLanguageRow,
  resolveContentLanguage,
} from './lib/content-language.js';
import { getDiffLabels, renderEntityDiff } from './lib/diff.js';
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

const resolveCheckMetrics = (metrics: PageCheckMetrics | null | undefined) => {
  const fallback = {
    issues_found: { high: 0, medium: 0, low: 0 },
    issues_fixed: { high: 0, medium: 0, low: 0 },
  };
  return metrics ?? fallback;
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
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const langOverride = normalizeOverrideLang(langParam);
    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      // Keep route concerns (HTTP + rendering) separate from domain lookup logic.
      const page = await (async () => {
        try {
          return await readWikiPage(await initializePostgreSQL(), slug);
        } catch (error) {
          if (error instanceof NotFoundError) {
            res.status(404).type('text').send(req.t('page.notFound'));
            return null;
          }
          throw error;
        }
      })();
      if (!page) return;

      const dalInstance = await initializePostgreSQL();
      const checksResult = await listPageChecks(dalInstance, slug);
      const checks = checksResult.checks;

      const userIds = checks
        .map(check => check.revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const languageSources: Array<Record<string, string> | null> = [
        page.title ?? null,
      ];
      for (const check of checks) {
        languageSources.push(check.checkResults, check.notes);
      }
      const availableLangs = getAvailableLanguages(...languageSources);
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });
      const checkSources = checks.flatMap(check => {
        const checkResultsSource = mlString.resolve(contentLang, check.checkResults)?.str ?? '';
        const notesSource = mlString.resolve(contentLang, check.notes)?.str ?? '';
        return [checkResultsSource, notesSource];
      });
      const citationEntries = await loadCitationEntriesForSources(dalInstance, checkSources);

      const items: PageCheckDetailItem[] = await Promise.all(
        checks.map(async check => {
          const metrics = resolveCheckMetrics(check.metrics as PageCheckMetrics | null);
          const checkResultsSource = mlString.resolve(contentLang, check.checkResults)?.str ?? '';
          const notesSource = mlString.resolve(contentLang, check.notes)?.str ?? '';
          const checkResultsHtml = (await renderMarkdown(checkResultsSource, citationEntries)).html;
          const notesHtml = notesSource
            ? (await renderMarkdown(notesSource, citationEntries)).html
            : '';
          return {
            id: check.id,
            typeLabel: formatCheckType(check.type, req.t),
            statusLabel: formatCheckStatus(check.status, req.t),
            dateLabel: formatDateUTC(check.completedAt ?? check.revDate ?? check.createdAt),
            checkResultsHtml,
            notesHtml,
            metrics: {
              issuesFound: metrics.issues_found,
              issuesFixed: metrics.issues_fixed,
            },
            revUser: check.revUser ?? null,
            revTags: check.revTags ?? null,
          };
        })
      );

      const pageTitle = resolveSafeText(mlString.resolve, contentLang, page.title, page.slug);
      const title = concatSafeText(pageTitle, ` · ${req.t('checks.title')}`);
      const bodyHtml = `<section class="check-list">${renderPageChecksList({
        checks: items,
        userMap,
        slug: page.slug,
        langOverride,
        t: req.t,
      })}</section>`;
      const sidebarHtml = '';
      const signedIn = Boolean(await resolveSessionUser(req));
      const labelHtml = `<div class="page-label">${req.t('checks.title')}</div>`;
      const languageRow = renderContentLanguageRow({
        label: req.t('language.available'),
        currentLang: contentLang,
        availableLangs,
        languageOptions: res.locals.languageOptions,
        path: req.path,
        queryParams: extractQueryParams(req.query),
      });
      const html = renderLayout({
        title,
        labelHtml,
        bodyHtml: `${bodyHtml}${languageRow}`,
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
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const langOverride = normalizeOverrideLang(langParam);

    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      const page = await (async () => {
        try {
          return await readWikiPage(await initializePostgreSQL(), slug);
        } catch (error) {
          if (error instanceof NotFoundError) {
            res.status(404).type('text').send(req.t('page.notFound'));
            return null;
          }
          throw error;
        }
      })();
      if (!page) return;

      const dalInstance = await initializePostgreSQL();
      const checksResult = await listPageChecks(dalInstance, slug);
      const check = checksResult.checks.find(entry => entry.id === checkId);
      if (!check) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      const revisionsResult = await listPageCheckRevisions(dalInstance, checkId);
      const revisions = revisionsResult.revisions;
      const userIds = revisions
        .map(rev => rev.revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);
      const selectedRevision = revIdParam
        ? await (async () => {
            try {
              return (await readPageCheckRevision(dalInstance, checkId, revIdParam)).revision;
            } catch (error) {
              if (error instanceof NotFoundError) {
                res.status(404).type('text').send(req.t('page.revisionNotFound'));
                return null;
              }
              throw error;
            }
          })()
        : revisions[0];
      if (!selectedRevision) return;

      const availableLangs = getAvailableLanguages(
        selectedRevision.checkResults ?? null,
        selectedRevision.notes ?? null
      );
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });

      const metrics = resolveCheckMetrics(selectedRevision.metrics as PageCheckMetrics | null);
      const typeLabel = formatCheckType(selectedRevision.type, req.t);
      const statusLabel = formatCheckStatus(selectedRevision.status, req.t);
      const dateLabel = formatDateUTC(
        selectedRevision.completedAt ?? selectedRevision.revDate ?? selectedRevision.createdAt
      );
      const checkResultsSource =
        mlString.resolve(contentLang, selectedRevision.checkResults)?.str ?? '';
      const notesSource = mlString.resolve(contentLang, selectedRevision.notes)?.str ?? '';
      const citationEntries = await loadCitationEntriesForSources(dalInstance, [
        checkResultsSource,
        notesSource,
      ]);
      const targetRevId = selectedRevision.targetRevId;

      const meta = getCheckMetaParts(
        selectedRevision.revUser ?? null,
        selectedRevision.revTags ?? null,
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
          href: targetRevId
            ? `/${encodeURIComponent(page.slug)}?rev=${targetRevId}${
                langOverride ? `&lang=${encodeURIComponent(langOverride)}` : ''
              }`
            : '',
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
          return `<div class="detail-field">
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
      const checkResultsHtml = (await renderMarkdown(checkResultsSource, citationEntries)).html;
      const notesHtml = notesSource
        ? `<div class="check-notes">${(await renderMarkdown(notesSource, citationEntries)).html}</div>`
        : '';
      const bodyHtml = `<div class="check-card">
  <div class="check-meta">
    <dl class="detail-fields">${fieldsHtml}</dl>
  </div>
  ${metricsHtml}
  <div class="check-results">${checkResultsHtml}</div>
  ${notesHtml}
</div>`;

      const historyRevisions: PageCheckSummaryItem[] = revisions.map(rev => {
        const revMetrics = resolveCheckMetrics(rev.metrics as PageCheckMetrics | null);
        return {
          id: rev.revId,
          typeLabel: formatCheckType(rev.type, req.t),
          statusLabel: formatCheckStatus(rev.status, req.t),
          dateLabel: formatDateUTC(rev.revDate),
          summary: resolveSafeTextWithFallback(
            mlString.resolve,
            contentLang,
            rev.revSummary,
            ''
          ),
          metrics: {
            issuesFound: revMetrics.issues_found,
            issuesFixed: revMetrics.issues_fixed,
          },
          revUser: rev.revUser ?? null,
          revTags: rev.revTags ?? null,
        };
      });

      const historyHtml = renderPageCheckHistory({
        revisions: historyRevisions,
        userMap,
        slug: page.slug,
        checkId: check.id,
        langOverride,
        diffFrom,
        diffTo,
        t: req.t,
      });

      const pageTitle = resolveSafeText(mlString.resolve, contentLang, page.title, page.slug);
      const title = concatSafeText(pageTitle, ` · ${req.t('checks.title')}`);
      const labelHtml = `<div class="page-label">${req.t('checks.title')}</div>`;
      const signedIn = Boolean(await resolveSessionUser(req));
      let diffHtml = '';
      if (diffFrom && diffTo) {
        try {
          // Reuse service-level diff semantics so MCP and web stay aligned.
          const diff = await diffPageCheckRevisions(dalInstance, {
            checkId: check.id,
            fromRevId: diffFrom,
            toRevId: diffTo,
            lang: contentLang,
          });
          const fromLabel = `${diff.fromRevId} (${formatDateUTC(diff.from.revDate)})`;
          const toLabel = `${diff.toRevId} (${formatDateUTC(diff.to.revDate)})`;
          const diffLabels = getDiffLabels(req.t);
          const baseHref = `/${encodeURIComponent(page.slug)}/checks/${encodeURIComponent(
            check.id
          )}`;
          const fromHref = langOverride
            ? `${baseHref}?rev=${diffFrom}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffFrom}`;
          const toHref = langOverride
            ? `${baseHref}?rev=${diffTo}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffTo}`;
          const fieldLabels: Record<string, string> = {
            checkResults: req.t('checks.fields.checkResults'),
            notes: req.t('checks.fields.notes'),
            type: req.t('checks.fields.type'),
            status: req.t('checks.fields.status'),
            completedAt: req.t('checks.fields.completed'),
            targetRevId: req.t('checks.fields.targetRevision'),
          };
          const fields = Object.entries(diff.fields).map(([fieldKey, fieldDiff]) => ({
            key: fieldKey,
            ...(fieldLabels[fieldKey] ? { label: fieldLabels[fieldKey] } : {}),
            diff: fieldDiff,
          }));
          diffHtml = renderEntityDiff({
            fromLabel,
            toLabel,
            fromHref,
            toHref,
            fields,
            labels: diffLabels,
          });
        } catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw error;
          }
        }
      }

      const languageRow = renderContentLanguageRow({
        label: req.t('language.available'),
        currentLang: contentLang,
        availableLangs,
        languageOptions: res.locals.languageOptions,
        path: req.path,
        queryParams: extractQueryParams(req.query),
      });
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const sidebarHtml = historyHtml;
      const html = renderLayout({
        title,
        labelHtml,
        bodyHtml: `${topHtml}${bodyHtml}${languageRow}`,
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
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const langOverride = normalizeOverrideLang(langParam);

    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();
      const dalInstance = await initializePostgreSQL();
      // Route handles response mapping; service handles not-found/validation behavior.
      const pageResult = await (async () => {
        try {
          const page = await readWikiPage(dalInstance, slug);
          const revisionsResult = await listWikiPageRevisions(dalInstance, slug);
          return { page, revisionsResult };
        } catch (error) {
          if (error instanceof NotFoundError) {
            res.status(404).type('text').send(req.t('page.notFound'));
            return null;
          }
          throw error;
        }
      })();
      if (!pageResult) return;
      const { page, revisionsResult } = pageResult;

      const revisions = revisionsResult.revisions;
      const selectedRevision = revIdParam
        ? await (async () => {
            try {
              return (await readWikiPageRevision(dalInstance, slug, revIdParam)).revision;
            } catch (error) {
              if (error instanceof NotFoundError) {
                res.status(404).type('text').send(req.t('page.revisionNotFound'));
                return null;
              }
              throw error;
            }
          })()
        : revisions[0];
      if (!selectedRevision) return;

      const availableLangs = getAvailableLanguages(
        selectedRevision.body,
        selectedRevision.title
      );
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });
      const resolvedBody = mlString.resolve(contentLang, selectedRevision.body);

      const canonicalSlug = page.slug;
      const title = resolveSafeText(
        mlString.resolve,
        contentLang,
        selectedRevision.title,
        canonicalSlug
      );
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
      const citationEntries = await loadCitationEntriesForSources(dalInstance, [bodySource]);

      const { html: bodyHtml, toc } = await renderMarkdown(bodySource, citationEntries);

      let diffHtml = '';
      if (diffFrom && diffTo) {
        try {
          // Service diff output is rendered directly into route-specific UI.
          const diff = await diffWikiPageRevisions(dalInstance, {
            slug,
            fromRevId: diffFrom,
            toRevId: diffTo,
            lang: contentLang,
          });
          const fromLabel = formatDateUTC(diff.from.revDate)
            ? `${diff.fromRevId} (${formatDateUTC(diff.from.revDate)})`
            : diff.fromRevId;
          const toLabel = formatDateUTC(diff.to.revDate)
            ? `${diff.toRevId} (${formatDateUTC(diff.to.revDate)})`
            : diff.toRevId;
          const diffLabels = getDiffLabels(req.t);
          const baseHref = `/${encodeURIComponent(canonicalSlug)}`;
          const fromHref = langOverride
            ? `${baseHref}?rev=${diffFrom}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffFrom}`;
          const toHref = langOverride
            ? `${baseHref}?rev=${diffTo}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffTo}`;
          const fields = Object.entries(diff.fields).map(([fieldKey, fieldDiff]) => ({
            key: fieldKey,
            diff: fieldDiff,
          }));
          diffHtml = renderEntityDiff({
            fromLabel,
            toLabel,
            fromHref,
            toHref,
            fields,
            labels: diffLabels,
          });
        } catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw error;
          }
        }
      }

      const pageChecksResult = await listPageChecks(dalInstance, slug);
      const pageChecks = pageChecksResult.checks.slice(0, 10);

      const userIds = new Set<string>();
      for (const rev of revisions) {
        if (rev.revUser) userIds.add(rev.revUser);
      }
      for (const check of pageChecks) {
        if (check.revUser) userIds.add(check.revUser);
      }
      const userMap = await fetchUserMap(dalInstance, [...userIds]);

      const historyRevisions = revisions.map(rev => ({
        revId: rev.revId,
        dateLabel: formatDateUTC(rev.revDate),
        title: resolveSafeText(mlString.resolve, contentLang, rev.title, canonicalSlug),
        summary: resolveSafeText(mlString.resolve, contentLang, rev.revSummary, ''),
        revUser: rev.revUser ?? null,
        revTags: rev.revTags ?? null,
      }));
      const queryParams = extractQueryParams(req.query);
      const historyAction = langOverride
        ? `/${canonicalSlug}?lang=${encodeURIComponent(langOverride)}`
        : `/${canonicalSlug}`;
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: historyAction,
        viewHref: revId =>
          langOverride
            ? `/${canonicalSlug}?rev=${revId}&lang=${encodeURIComponent(langOverride)}`
            : `/${canonicalSlug}?rev=${revId}`,
        userMap,
        t: req.t,
      });

      const checkItems: PageCheckSummaryItem[] = pageChecks.map(check => {
        const metrics = resolveCheckMetrics(check.metrics as PageCheckMetrics | null);
        const dateLabel = formatDateUTC(check.completedAt ?? check.revDate ?? check.createdAt);
        return {
          id: check.id,
          typeLabel: formatCheckType(check.type, req.t),
          statusLabel: formatCheckStatus(check.status, req.t),
          dateLabel,
          metrics: {
            issuesFound: metrics.issues_found,
            issuesFixed: metrics.issues_fixed,
          },
          revUser: check.revUser ?? null,
          revTags: check.revTags ?? null,
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

      const languageRow = renderContentLanguageRow({
        label: req.t('language.available'),
        currentLang: contentLang,
        availableLangs,
        languageOptions: res.locals.languageOptions,
        path: req.path,
        queryParams,
      });
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const signedIn = Boolean(await resolveSessionUser(req));
      const html = renderLayout({
        title,
        labelHtml: metaLabel,
        bodyHtml: `${bodyHtml}${languageRow}`,
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
