import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import {
  diffLocalizedField,
  diffScalarField,
  diffStructuredField,
} from '../lib/diff-engine.js';
import type { PageCheckMetrics } from '../lib/page-checks.js';
import {
  resolveSafeText,
  resolveSafeTextWithFallback,
} from '../lib/safe-text.js';
import { isBlockedSlug } from '../lib/slug.js';
import Citation from '../models/citation.js';
import PageAlias from '../models/page-alias.js';
import PageCheck from '../models/page-check.js';
import WikiPage from '../models/wiki-page.js';
import {
  concatSafeText,
  escapeHtml,
  formatDateUTC,
  renderLayout,
  renderMarkdown,
  renderToc,
} from '../render.js';
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

const citationKeyRegex = /@([\w][\w:.#$%&\-+?<>~/]*)/g;

const normalizeCitationKey = (value: string) => {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) return value;
  return value.slice(0, separatorIndex);
};

const extractCitationKeys = (value: string) => {
  const keys = new Set<string>();
  if (!value) return keys;
  for (const match of value.matchAll(citationKeyRegex)) {
    keys.add(normalizeCitationKey(match[1]));
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
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const langOverride = normalizeOverrideLang(langParam);
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

      const languageSources: Array<Record<string, string> | null> = [
        page.title ?? null,
      ];
      for (const check of checks) {
        languageSources.push(check.checkResults ?? null, check.notes ?? null);
      }
      const availableLangs = getAvailableLanguages(...languageSources);
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });

      const items: PageCheckDetailItem[] = await Promise.all(
        checks.map(async check => {
          const metrics = resolveCheckMetrics(check.metrics as PageCheckMetrics | null);
          const checkResultsSource = mlString.resolve(contentLang, check.checkResults ?? null)?.str ?? '';
          const notesSource = mlString.resolve(contentLang, check.notes ?? null)?.str ?? '';
          const checkResultsHtml = (await renderMarkdown(checkResultsSource, [])).html;
          const notesHtml = notesSource ? (await renderMarkdown(notesSource, [])).html : '';
          return {
            id: check.id,
            typeLabel: formatCheckType(check.type, req.t),
            statusLabel: formatCheckStatus(check.status, req.t),
            dateLabel: formatDateUTC(check.completedAt ?? check._revDate ?? check.createdAt),
            checkResultsHtml,
            notesHtml,
            metrics: {
              issuesFound: metrics.issues_found,
              issuesFixed: metrics.issues_fixed,
            },
            revUser: check._revUser ?? null,
            revTags: check._revTags ?? null,
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
        selectedRevision.completedAt ?? selectedRevision._revDate ?? selectedRevision.createdAt
      );
      const checkResultsSource =
        mlString.resolve(contentLang, selectedRevision.checkResults ?? null)?.str ?? '';
      const notesSource = mlString.resolve(contentLang, selectedRevision.notes ?? null)?.str ?? '';
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
      const checkResultsHtml = (await renderMarkdown(checkResultsSource, [])).html;
      const notesHtml = notesSource
        ? `<div class="check-notes">${(await renderMarkdown(notesSource, [])).html}</div>`
        : '';
      const bodyHtml = `<div class="check-card">
  <div class="check-meta">
    <dl class="citation-fields">${fieldsHtml}</dl>
  </div>
  ${metricsHtml}
  <div class="check-results">${checkResultsHtml}</div>
  ${notesHtml}
</div>`;

      const historyRevisions: PageCheckSummaryItem[] = revisions.map(rev => {
        const revMetrics = resolveCheckMetrics(rev.metrics as PageCheckMetrics | null);
        return {
          id: rev._revID,
          typeLabel: formatCheckType(rev.type, req.t),
          statusLabel: formatCheckStatus(rev.status, req.t),
          dateLabel: formatDateUTC(rev._revDate),
          summary: resolveSafeTextWithFallback(
            mlString.resolve,
            contentLang,
            rev._revSummary,
            ''
          ),
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
        const fromRev = await fetchRevisionByRevId(diffFrom);
        const toRev = await fetchRevisionByRevId(diffTo);
        if (fromRev && toRev) {
          const fromLabel = `${diffFrom} (${formatDateUTC(fromRev._revDate)})`;
          const toLabel = `${diffTo} (${formatDateUTC(toRev._revDate)})`;
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
          const fields = [];
          const checkResultsDiff = diffLocalizedField(
            'checkResults',
            fromRev.checkResults ?? null,
            toRev.checkResults ?? null
          );
          if (checkResultsDiff) {
            fields.push({
              key: 'checkResults',
              label: req.t('checks.fields.checkResults'),
              diff: checkResultsDiff,
            });
          }
          const notesDiff = diffLocalizedField('notes', fromRev.notes ?? null, toRev.notes ?? null);
          if (notesDiff) {
            fields.push({
              key: 'notes',
              label: req.t('checks.fields.notes'),
              diff: notesDiff,
            });
          }
          const typeDiff = diffScalarField('type', fromRev.type, toRev.type);
          if (typeDiff) {
            fields.push({
              key: 'type',
              label: req.t('checks.fields.type'),
              diff: typeDiff,
            });
          }
          const statusDiff = diffScalarField('status', fromRev.status, toRev.status);
          if (statusDiff) {
            fields.push({
              key: 'status',
              label: req.t('checks.fields.status'),
              diff: statusDiff,
            });
          }
          const completedDiff = diffScalarField(
            'completedAt',
            fromRev.completedAt ?? null,
            toRev.completedAt ?? null
          );
          if (completedDiff) {
            fields.push({
              key: 'completedAt',
              label: req.t('checks.fields.completed'),
              diff: completedDiff,
            });
          }
          const targetDiff = diffScalarField(
            'targetRevId',
            fromRev.targetRevId ?? null,
            toRev.targetRevId ?? null
          );
          if (targetDiff) {
            fields.push({
              key: 'targetRevId',
              label: req.t('checks.fields.targetRevision'),
              diff: targetDiff,
            });
          }
          const metricsDiff = diffStructuredField(
            'metrics',
            fromRev.metrics ?? null,
            toRev.metrics ?? null
          );
          if (metricsDiff) {
            fields.push({ key: 'metrics', diff: metricsDiff });
          }
          diffHtml = renderEntityDiff({
            fromLabel,
            toLabel,
            fromHref,
            toHref,
            fields,
            labels: diffLabels,
          });
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

      const availableLangs = getAvailableLanguages(
        selectedRevision.body ?? null,
        selectedRevision.title ?? null
      );
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });
      const resolvedBody = mlString.resolve(contentLang, selectedRevision.body ?? null);

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
          const fromLabel = formatDateUTC(fromRev._revDate)
            ? `${diffFrom} (${formatDateUTC(fromRev._revDate)})`
            : diffFrom;
          const toLabel = formatDateUTC(toRev._revDate)
            ? `${diffTo} (${formatDateUTC(toRev._revDate)})`
            : diffTo;
          const diffLabels = getDiffLabels(req.t);
          const baseHref = `/${encodeURIComponent(canonicalSlug)}`;
          const fromHref = langOverride
            ? `${baseHref}?rev=${diffFrom}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffFrom}`;
          const toHref = langOverride
            ? `${baseHref}?rev=${diffTo}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffTo}`;
          const fields = [];
          const titleDiff = diffLocalizedField('title', fromRev.title ?? null, toRev.title ?? null);
          if (titleDiff) {
            fields.push({ key: 'title', diff: titleDiff });
          }
          const bodyDiff = diffLocalizedField('body', fromRev.body ?? null, toRev.body ?? null);
          if (bodyDiff) {
            fields.push({ key: 'body', diff: bodyDiff });
          }
          const slugDiff = diffScalarField('slug', fromRev.slug ?? null, toRev.slug ?? null);
          if (slugDiff) {
            fields.push({ key: 'slug', diff: slugDiff });
          }
          const originalLangDiff = diffScalarField(
            'originalLanguage',
            fromRev.originalLanguage ?? null,
            toRev.originalLanguage ?? null
          );
          if (originalLangDiff) {
            fields.push({ key: 'originalLanguage', diff: originalLangDiff });
          }
          diffHtml = renderEntityDiff({
            fromLabel,
            toLabel,
            fromHref,
            toHref,
            fields,
            labels: diffLabels,
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
        title: resolveSafeText(mlString.resolve, contentLang, rev.title, canonicalSlug),
        summary: resolveSafeText(mlString.resolve, contentLang, rev._revSummary, ''),
        revUser: rev._revUser ?? null,
        revTags: rev._revTags ?? null,
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
