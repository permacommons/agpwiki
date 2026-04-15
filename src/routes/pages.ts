import type { Express, Request, Response } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { forumCategoryPagePath } from '../lib/forum-paths.js';
import type { PageCheckMetrics } from '../lib/page-checks.js';
import {
  resolveSafeText,
  resolveSafeTextWithFallback,
} from '../lib/safe-text.js';
import { isBlockedSlug, normalizeSlug } from '../lib/slug.js';
import { normalizeLineEndings } from '../lib/text-normalization.js';
import {
  WIKI_LINK_PREVIEW_ENDPOINT,
  WIKI_LINK_PREVIEW_PAGE_PATH_HEADER,
  WIKI_LINK_PREVIEW_TOKEN_HEADER,
} from '../lib/wiki-link-preview.js';
import {
  createWikiLinkPreviewToken,
  verifyWikiLinkPreviewToken,
} from '../lib/wiki-link-preview-token.js';
import { extractCandidateWikiLinkSlugs } from '../lib/wiki-links.js';
import {
  concatSafeText,
  escapeHtml,
  formatDateUTC,
  iconWarningTriangle,
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
  buildLocalWikiPreview,
  fetchWikipediaPreviewForSlug,
  findExistingWikiLinkSlugs,
} from '../services/wiki-link-preview-service.js';
import {
  diffWikiPageRevisions,
  listWikiPageRevisions,
  readWikiPage,
  readWikiPageRevision,
  updateWikiPage,
} from '../services/wiki-page-service.js';
import { prependAccountBanner } from './lib/account-banner.js';
import {
  extractQueryParams,
  getAvailableLanguages,
  normalizeOverrideLang,
  renderContentLanguageRow,
  resolveContentLanguage,
} from './lib/content-language.js';
import { getDiffLabels, renderEntityDiff } from './lib/diff.js';
import { dismissBanner, renderDismissableBanner } from './lib/dismissable-banner.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';
import {
  createPreviewHandler,
  renderMarkdownPreviewHtml,
  renderMarkdownPreviewPanel,
} from './lib/markdown-preview.js';
import { renderOperatorEditRelatedLink } from './lib/operator-edit-link.js';
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
import { resolveOperatorEditValidationMessage } from './lib/validation-messages.js';

const { mlString } = dal;

const resolveCheckMetrics = (metrics: PageCheckMetrics | null | undefined) => {
  const fallback = {
    issues_found: { high: 0, medium: 0, low: 0 },
    issues_fixed: { high: 0, medium: 0, low: 0 },
  };
  return metrics ?? fallback;
};

const operatorEditPath = (slug: string, lang: string) =>
  `/${encodeURIComponent(slug)}/operator-edit?lang=${encodeURIComponent(lang)}`;
const operatorEditDismissBannerPath = (slug: string, lang: string) =>
  `/${encodeURIComponent(slug)}/operator-edit/dismiss-banner?lang=${encodeURIComponent(lang)}`;
const OPERATOR_EDIT_BANNER_COOKIE = 'agpwiki_operator_edit_banner_dismissed';

const pageViewPath = (slug: string, lang?: string) =>
  lang ? `/${encodeURIComponent(slug)}?lang=${encodeURIComponent(lang)}` : `/${encodeURIComponent(slug)}`;

const buildRedLinkIntroHtml = (req: Request, signedIn: boolean) =>
  signedIn
    ? req.t('redLink.hover.signedIn', {
        link: `<a href="/meta/help">${escapeHtml(req.t('redLink.hover.signedInCta'))}</a>`,
      })
    : req.t('redLink.hover.signedOut', {
        link: `<a href="/tool/signup">${escapeHtml(req.t('redLink.hover.signedOutCta'))}</a>`,
      });

const renderOperatorEditPreviewHtml = async ({
  dalInstance,
  title,
  body,
  backToCitationLabel,
}: {
  dalInstance: Awaited<ReturnType<typeof initializePostgreSQL>>;
  title: string;
  body: string;
  backToCitationLabel: string;
}) => {
  const trimmedBody = body.trim();
  const bodyHtml = trimmedBody
    ? await renderMarkdownPreviewHtml(dalInstance, body, backToCitationLabel)
    : '';

  return `<article class="operator-edit-preview-article">
  ${title.trim() ? `<h1>${escapeHtml(title)}</h1>` : ''}
  ${bodyHtml}
</article>`;
};

const renderOperatorEditForm = ({
  req,
  slug,
  lang,
  languageLabel,
  titleValue,
  bodyValue,
  summaryValue,
  previewHtml,
  errorMessage,
}: {
  req: Request;
  slug: string;
  lang: string;
  languageLabel: string;
  titleValue: string;
  bodyValue: string;
  summaryValue: string;
  previewHtml?: string;
  errorMessage?: string;
}) => {
  const action = operatorEditPath(slug, lang);
  return `<section class="form-card operator-edit-card">
  <p class="form-help">${escapeHtml(
    req.t('operatorEdit.intro', { language: languageLabel })
  )}</p>
  ${errorMessage ? `<div class="form-error">${escapeHtml(errorMessage)}</div>` : ''}
  <form method="post" action="${action}" id="operator-edit-form">
    <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
    <label class="form-field">
      <span>${escapeHtml(req.t('operatorEdit.fields.title'))}</span>
      <input
        type="text"
        name="title"
        value="${escapeHtml(titleValue)}"
        maxlength="200"
        data-markdown-preview-field
      />
    </label>
    <label class="form-field">
      <span>${escapeHtml(req.t('operatorEdit.fields.body'))}</span>
      <textarea
        id="operator-edit-body"
        name="body"
        rows="18"
        data-markdown-preview-field
      >${escapeHtml(bodyValue)}</textarea>
    </label>
    <label class="form-field">
      <span>${escapeHtml(req.t('operatorEdit.fields.summary'))}</span>
      <input type="text" name="summary" value="${escapeHtml(summaryValue)}" maxlength="300" />
    </label>
    <p class="form-help">${escapeHtml(req.t('operatorEdit.summaryHelp'))}</p>
    ${renderMarkdownPreviewPanel({
      formId: 'operator-edit-form',
      previewId: 'operator-edit-preview',
      endpoint: '/api/render-page-edit-preview',
      texts: {
        title: req.t('common.preview.title'),
        empty: req.t('common.preview.empty'),
        error: req.t('common.preview.error'),
      },
      previewHtml,
    })}
    <div class="form-actions">
      <button type="submit" name="intent" value="save">${escapeHtml(
        req.t('operatorEdit.actions.save')
      )}</button>
      <a href="${pageViewPath(slug, lang)}">${escapeHtml(req.t('common.actions.cancel'))}</a>
      <noscript>
        <button type="submit" name="intent" value="preview">${escapeHtml(
          req.t('common.actions.preview')
        )}</button>
      </noscript>
    </div>
  </form>
</section>`;
};

const renderOperatorEditPage = async ({
  req,
  res,
  slug,
  lang,
  titleValue,
  bodyValue,
  summaryValue,
  errorMessage,
  previewHtml,
}: {
  req: Request;
  res: Response;
  slug: string;
  lang: string;
  titleValue: string;
  bodyValue: string;
  summaryValue: string;
  errorMessage?: string;
  previewHtml?: string;
}) => {
  const dalInstance = await initializePostgreSQL();
  const page = await readWikiPage(dalInstance, slug);
  const pageTitle = resolveSafeText(mlString.resolve, lang, page.title, page.slug);
  const languageLabel =
    res.locals.languageOptions.find((option: { code: string; label: string }) => option.code === lang)
      ?.label ?? lang;
  const bannerHtml = renderDismissableBanner({
    req,
    cookieName: OPERATOR_EDIT_BANNER_COOKIE,
    unsafeBodyHtml: escapeHtml(req.t('operatorEdit.banner')),
    dismissPath: operatorEditDismissBannerPath(slug, lang),
    dismissLabel: req.t('common.dismiss'),
  });

  const html = renderLayout({
    title: concatSafeText(pageTitle, ` · ${req.t('operatorEdit.title')}`),
    labelHtml: `<div class="page-label">${escapeHtml(req.t('operatorEdit.title'))}</div>`,
    bodyHtml: renderOperatorEditForm({
      req,
      slug,
      lang,
      languageLabel,
      titleValue,
      bodyValue,
      summaryValue,
      errorMessage,
      previewHtml,
    }),
    signedIn: true,
    currentUserName: res.locals.currentUserName,
    currentPath: res.locals.currentPath,
    locale: res.locals.locale,
    languageOptions: res.locals.languageOptions,
    topHtml: prependAccountBanner(res, bannerHtml),
  });

  res.type('html').send(html);
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

  app.post(
    '/api/render-page-edit-preview',
    createPreviewHandler(
      body => {
        const payload = body as Record<string, unknown>;
        return {
          title: typeof payload.title === 'string' ? payload.title : '',
          body: typeof payload.body === 'string' ? payload.body : '',
        };
      },
      async ({ title, body }, req) => {
        const dalInstance = await initializePostgreSQL();
        return title.trim() || body.trim()
          ? renderOperatorEditPreviewHtml({
              dalInstance,
              title,
              body,
              backToCitationLabel: req.t('citation.backToCitationAria'),
            })
          : '';
      }
    )
  );

  app.get(WIKI_LINK_PREVIEW_ENDPOINT, async (req, res) => {
    const rawSlug = typeof req.query.slug === 'string' ? req.query.slug : '';
    const slug = normalizeSlug(rawSlug);
    const token = req.get(WIKI_LINK_PREVIEW_TOKEN_HEADER) ?? '';
    const pagePath = req.get(WIKI_LINK_PREVIEW_PAGE_PATH_HEADER) ?? '';
    if (!slug) {
      res.status(400).json({ error: 'missing_slug' });
      return;
    }
    const tokenPayload = verifyWikiLinkPreviewToken(token);
    if (!tokenPayload) {
      res.status(403).json({ error: 'invalid_token' });
      return;
    }
    if (pagePath !== tokenPayload.pagePath) {
      res.status(403).json({ error: 'invalid_token' });
      return;
    }

    const dalInstance = await initializePostgreSQL();
    const local = await buildLocalWikiPreview(dalInstance, slug, tokenPayload.locale);
    if (local) {
      res.json({ kind: 'local', local });
      return;
    }

    const wikipedia = await fetchWikipediaPreviewForSlug(slug);
    res.json({ kind: 'missing', wikipedia });
  });

  app.post(/^\/(.+)\/operator-edit\/dismiss-banner$/, (req, res) => {
    const slug = req.params[0];
    const lang = normalizeOverrideLang(typeof req.query.lang === 'string' ? req.query.lang : undefined) ?? 'en';
    dismissBanner({
      res,
      cookieName: OPERATOR_EDIT_BANNER_COOKIE,
      redirectTo: operatorEditPath(slug, lang),
    });
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
      const markdownOptions = {
        backToCitationLabel: req.t('citation.backToCitationAria', {
          defaultValue: 'Back to citation',
        }),
      };
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
          const checkResultsHtml = (
            await renderMarkdown(checkResultsSource, citationEntries, markdownOptions)
          ).html;
          const notesHtml = notesSource
            ? (await renderMarkdown(notesSource, citationEntries, markdownOptions)).html
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
        topHtml: prependAccountBanner(res),
        sidebarHtml,
        signedIn,
        currentUserName: res.locals.currentUserName,
        currentPath: res.locals.currentPath,
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
      const markdownOptions = {
        backToCitationLabel: req.t('citation.backToCitationAria', {
          defaultValue: 'Back to citation',
        }),
      };
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
      const checkResultsHtml = (
        await renderMarkdown(checkResultsSource, citationEntries, markdownOptions)
      ).html;
      const notesHtml = notesSource
        ? `<div class="check-notes">${(await renderMarkdown(
            notesSource,
            citationEntries,
            markdownOptions
          )).html}</div>`
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
        bodyHtml: `${bodyHtml}${languageRow}`,
        topHtml: prependAccountBanner(res, topHtml),
        sidebarHtml,
        signedIn,
        currentUserName: res.locals.currentUserName,
        currentPath: res.locals.currentPath,
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

  app.get(/^\/(.+)\/operator-edit$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
      return;
    }

    try {
      const dalInstance = await initializePostgreSQL();
      const page = await readWikiPage(dalInstance, slug);
      const availableLangs = getAvailableLanguages(page.body, page.title);
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: normalizeOverrideLang(typeof req.query.lang === 'string' ? req.query.lang : undefined),
        availableLangs,
      });

      await renderOperatorEditPage({
        req,
        res,
        slug,
        lang: contentLang,
        titleValue: mlString.resolve(contentLang, page.title)?.str ?? '',
        bodyValue: mlString.resolve(contentLang, page.body)?.str ?? '',
        summaryValue: '',
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to render operator edit page:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(/^\/(.+)\/operator-edit$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
      return;
    }

    const lang = normalizeOverrideLang(typeof req.body?.lang === 'string' ? req.body.lang : undefined) ?? 'en';
    const titleValue = normalizeLineEndings(
      typeof req.body?.title === 'string' ? req.body.title : ''
    );
    const bodyValue = normalizeLineEndings(
      typeof req.body?.body === 'string' ? req.body.body : ''
    );
    const summaryValue = normalizeLineEndings(
      typeof req.body?.summary === 'string' ? req.body.summary : ''
    );
    const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'save';

    try {
      const dalInstance = await initializePostgreSQL();

      if (intent === 'preview') {
        const previewHtml = await renderOperatorEditPreviewHtml({
          dalInstance,
          title: titleValue,
          body: bodyValue,
          backToCitationLabel: req.t('citation.backToCitationAria'),
        });
        await renderOperatorEditPage({
          req,
          res,
          slug,
          lang,
          titleValue,
          bodyValue,
          summaryValue,
          previewHtml,
        });
        return;
      }

      await updateWikiPage(
        dalInstance,
        {
          slug,
          title: { [lang]: titleValue },
          body: { [lang]: bodyValue },
          revSummary: { [lang]: summaryValue },
        },
        session.userId
      );

      res.redirect(303, pageViewPath(slug, lang));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (error instanceof ValidationError || error instanceof ConflictError) {
        const previewHtml =
          titleValue.trim() || bodyValue.trim()
            ? await renderOperatorEditPreviewHtml({
                dalInstance: await initializePostgreSQL(),
                title: titleValue,
                body: bodyValue,
                backToCitationLabel: req.t('citation.backToCitationAria'),
              })
            : undefined;
        await renderOperatorEditPage({
          req,
          res,
          slug,
          lang,
          titleValue,
          bodyValue,
          summaryValue,
          errorMessage: resolveOperatorEditValidationMessage(req.t, error),
          previewHtml,
        });
        return;
      }
      console.error('Failed to save operator edit:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
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
      const markdownOptions = {
        backToCitationLabel: req.t('citation.backToCitationAria', {
          defaultValue: 'Back to citation',
        }),
      };
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
      const candidateLinkSlugs = extractCandidateWikiLinkSlugs(bodySource);
      const [citationEntries, existingLinkSlugs] = await Promise.all([
        loadCitationEntriesForSources(dalInstance, [bodySource]),
        findExistingWikiLinkSlugs(dalInstance, candidateLinkSlugs),
      ]);
      const missingLinkSlugs = new Set(
        candidateLinkSlugs.filter(candidateSlug => !existingLinkSlugs.has(candidateSlug))
      );

      const { html: bodyHtml, toc } = await renderMarkdown(
        bodySource,
        citationEntries,
        {
          ...markdownOptions,
          wikiLinks: {
            missingSlugs: missingLinkSlugs,
          },
        }
      );

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
      const isArticle = !canonicalSlug.startsWith('meta/') && !canonicalSlug.startsWith('tool/');
      const hasCompletedCheck = pageChecksResult.checks.some(c => c.status === 'completed');
      const draftNoticeHtml =
        isArticle && !hasCompletedCheck
          ? `<aside class="article-draft-notice" role="note"><span class="article-draft-notice-icon" aria-hidden="true">${iconWarningTriangle}</span><span>${escapeHtml(req.t('warning.neverFactChecked'))}</span></aside>`
          : '';

      const latestRevDate = revisions[0]?.revDate;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const highSeverityRows = isArticle
        ? pageChecksResult.checks
            .filter(c => {
              if (c.status !== 'completed' || !c.metrics) return false;
              const checkDate = c.completedAt ?? c.revDate ?? c.createdAt;
              if (latestRevDate && checkDate && latestRevDate.getTime() - checkDate.getTime() > thirtyDaysMs)
                return false;
              const unresolved = c.metrics.issues_found.high - c.metrics.issues_fixed.high;
              return unresolved > 0;
            })
            .map(c => ({
              id: c.id,
              typeLabel: formatCheckType(c.type, req.t),
              unresolved: (c.metrics?.issues_found.high ?? 0) - (c.metrics?.issues_fixed.high ?? 0),
            }))
        : [];
      const issuesNoticeHtml =
        highSeverityRows.length > 0
          ? `<aside class="article-issues-notice" role="note"><span class="article-issues-notice-icon" aria-hidden="true">${iconWarningTriangle}</span><div class="article-issues-notice-body"><span>${req.t('warning.highSeverityIssues', { checksHref: `/${encodeURIComponent(canonicalSlug)}/checks` })}</span><div class="article-issues-rows">${highSeverityRows.map(row => `<div class="article-issues-row"><a href="/${encodeURIComponent(canonicalSlug)}/checks/${encodeURIComponent(row.id)}">${escapeHtml(row.typeLabel)}</a><span>${escapeHtml(req.t('warning.unresolvedIssues', { count: row.unresolved }))}</span></div>`).join('')}</div></div></aside>`
          : '';

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
      const forumPath = isArticle
        ? forumCategoryPagePath('articles', canonicalSlug)
        : canonicalSlug.startsWith('meta/')
          ? forumCategoryPagePath('policy', canonicalSlug)
          : '';
      const signedIn = Boolean(await resolveSessionUser(req));
      const canShowOperatorEditLink = !revIdParam && !diffFrom && !diffTo;
      const operatorEditLinkHtml = renderOperatorEditRelatedLink({
        signedIn,
        visible: canShowOperatorEditLink,
        operatorEditHref: operatorEditPath(canonicalSlug, contentLang),
        loginHref: `/tool/login?redirect=${encodeURIComponent(
          operatorEditPath(canonicalSlug, contentLang)
        )}`,
        signupHref: '/tool/create-account',
        t: req.t,
      });
      const relatedLinks = [
        forumPath
          ? `<a href="${forumPath}">${escapeHtml(req.t('forum.discussThisPage'))}</a>`
          : '',
        operatorEditLinkHtml,
      ].filter(Boolean);
      const forumLinkHtml = relatedLinks.length
        ? `<div class="tool-related">
  <span class="tool-related-label">${escapeHtml(req.t('page.actions'))}</span>
  <span class="tool-related-links">${relatedLinks.join(' · ')}</span>
</div>`
        : '';
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const html = renderLayout({
        title,
        labelHtml: metaLabel,
        bodyHtml: `${draftNoticeHtml}${issuesNoticeHtml}${bodyHtml}${languageRow}${forumLinkHtml}`,
        topHtml: prependAccountBanner(res, topHtml),
        sidebarHtml,
        signedIn,
        currentUserName: res.locals.currentUserName,
        currentPath: res.locals.currentPath,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
        wikiLinkPreviewConfig: {
          endpoint: WIKI_LINK_PREVIEW_ENDPOINT,
          introHtml: buildRedLinkIntroHtml(req, signedIn),
          missingLoading: req.t('redLink.hover.loading'),
          token: createWikiLinkPreviewToken({
            pagePath: req.path,
            locale: res.locals.locale,
          }),
          wikipediaAttributionHtml: req.t('redLink.hover.wikipediaAttribution', {
            license: '<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer noopener">CC-BY-SA 4.0</a>',
          }),
          wikipediaHeading: req.t('redLink.hover.wikipediaHeading'),
          wikipediaLinkLabel: req.t('redLink.hover.wikipediaLinkLabel'),
        },
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render wiki page:', message);
    }
  });
};
