import type { Express, Request, Response } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import {
  ConflictError,
  ForbiddenError,
  isRevisionConflictError,
  NotFoundError,
  PreconditionFailedError,
  toRevisionConflictError,
  ValidationError,
} from '../lib/errors.js';
import { forumCategoryPagePath, forumPageCategory } from '../lib/forum-paths.js';
import { loadMediaEntriesForSources } from '../lib/media-render.js';
import type { PageCheckMetrics } from '../lib/page-checks.js';
import { isPromptPageSlug } from '../lib/prompt-registry.js';
import {
  resolveSafeText,
  resolveSafeTextWithFallback,
} from '../lib/safe-text.js';
import { encodeSlugPath, isBlockedSlug, normalizeSlug, toAddressForm } from '../lib/slug.js';
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
  prepareTitle,
  renderMarkdown,
  renderToc,
} from '../render.js';
import { countForumCommentsForPage } from '../services/forum-service.js';
import { HOME_PAGE_SLUG, loadHomeSections } from '../services/home-service.js';
import { renderArticleInfobox } from '../services/infobox-service.js';
import {
  diffPageCheckRevisions,
  listPageCheckRevisions,
  listPageChecks,
  readPageCheckRevision,
} from '../services/page-check-service.js';
import { getWikiPageEditability, type ProtectionLevel } from '../services/page-protection-service.js';
import { canUseRevertAction } from '../services/page-revert-service.js';
import {
  canSignOffPages,
  findRevisionsWithChangedText,
  isSignoffPageSlug,
  listActivePageSignoffs,
  signOffPage,
  withdrawPageSignoff,
} from '../services/page-signoff-service.js';
import { listPositionReplies, replyToPosition } from '../services/position-reply-service.js';
import { listProposalParts, setProposalLinks } from '../services/proposal-links-service.js';
import {
  getProposalStatusPermissions,
  setProposalStatus,
} from '../services/proposal-status-service.js';
import { pullRequestStates } from '../services/pull-request-state.js';
import {
  buildLocalWikiPreview,
  fetchWikipediaPreviewForSlug,
  findExistingWikiLinkSlugs,
} from '../services/wiki-link-preview-service.js';
import {
  diffWikiPageRevisions,
  type EditableSection,
  findCurrentPageById,
  findCurrentPageBySlugOrAlias,
  listEditableSections,
  listWikiPageRevisions,
  readWikiPage,
  readWikiPageRevision,
  rewriteWikiPageSection,
  sectionFingerprint,
  updateWikiPage,
} from '../services/wiki-page-service.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { canonicalUrlFor, queryStringOf, slugPath } from './lib/canonical.js';
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
import { renderHomeSections } from './lib/home-sections.js';
import {
  createPreviewHandler,
  renderMarkdownPreviewHtml,
  renderMarkdownPreviewPanel,
} from './lib/markdown-preview.js';
import { howToEditPath, renderOperatorEditRelatedLink } from './lib/operator-edit-link.js';
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
import { renderPageSignoffs } from './lib/page-signoffs.js';
import { renderPageTabs } from './lib/page-tabs.js';
import {
  renderProposalHeader,
  renderProposalLinks,
  renderProposalLinksForm,
  renderProposalParts,
  renderProposalStatusForm,
} from './lib/proposal-status.js';
import { resolveOperatorEditValidationMessage } from './lib/validation-messages.js';
import { REVERT_PATH, registerRevertRoutes } from './revert.js';

const { mlString } = dal;

const resolveCheckMetrics = (metrics: PageCheckMetrics | null | undefined) => {
  const fallback = {
    issues_found: { high: 0, medium: 0, low: 0 },
    issues_fixed: { high: 0, medium: 0, low: 0 },
  };
  return metrics ?? fallback;
};

const operatorEditPath = (slug: string, lang: string) =>
  `/${encodeSlugPath(slug)}/operator-edit?lang=${encodeURIComponent(lang)}`;
const operatorEditDismissBannerPath = (slug: string, lang: string) =>
  `/${encodeSlugPath(slug)}/operator-edit/dismiss-banner?lang=${encodeURIComponent(lang)}`;
const OPERATOR_EDIT_BANNER_COOKIE = 'agpwiki_operator_edit_banner_dismissed';

const pageViewPath = (slug: string, lang?: string) =>
  lang ? `/${encodeSlugPath(slug)}?lang=${encodeURIComponent(lang)}` : `/${encodeSlugPath(slug)}`;

const iconLock =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M256 160L256 224L384 224L384 160C384 124.7 355.3 96 320 96C284.7 96 256 124.7 256 160zM192 224L192 160C192 89.3 249.3 32 320 32C390.7 32 448 89.3 448 160L448 224C483.3 224 512 252.7 512 288L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 288C128 252.7 156.7 224 192 224z"/></svg>';

// The shackle is lifted to the side: a half-open lock for the middle level.
const iconLockHalfOpen =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M128 288C128 252.7 156.7 224 192 224L448 224C483.3 224 512 252.7 512 288L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512z"/><path d="M352 200L352 136C352 100.7 380.7 72 416 72C451.3 72 480 100.7 480 136L480 152" fill="none" stroke="currentColor" stroke-width="64" stroke-linecap="round"/></svg>';

const protectionTooltipKey = (level: ProtectionLevel, editable: boolean) => {
  if (level === 'experienced') {
    return editable ? 'page.protectedExperiencedEditable' : 'page.protectedExperienced';
  }
  return editable ? 'page.protectedDetailsAdmin' : 'page.protectedDetails';
};

const renderPageTypeLabel = (
  req: Request,
  label: string,
  protection?: { editable: boolean; level: ProtectionLevel }
) => {
  const protectedHtml = !protection
    ? ''
    : `<span class="page-protection-icon page-protection-icon--${protection.level}" data-meta="true" title="${escapeHtml(
        req.t(protectionTooltipKey(protection.level, protection.editable))
      )}">${protection.level === 'experienced' ? iconLockHalfOpen : iconLock}</span>`;
  return `<div class="page-label-row">
  <div class="page-label">${escapeHtml(label)}</div>
  ${protectedHtml}
</div>`;
};

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

// What the edit form carries to find a section again when it is saved.
type SectionFormState = {
  target: 'lead' | 'heading';
  heading: string;
  level: string;
  occurrence: string;
  fingerprint: string;
  name: string;
};

const trimBlankLines = (text: string) => text.replace(/^\n+/, '').replace(/\n+$/, '');

const toSectionFormState = (section: EditableSection, t: Request['t']): SectionFormState => ({
  target: section.target,
  heading: section.heading ?? '',
  level: section.level ? String(section.level) : '',
  occurrence: section.occurrence ? String(section.occurrence) : '',
  fingerprint: sectionFingerprint(section.content),
  name: section.target === 'lead' ? t('sectionEdit.lead') : (section.heading ?? ''),
});

const readSectionFormState = (body: Record<string, unknown> | undefined, t: Request['t']) => {
  const field = (name: string) => (typeof body?.[name] === 'string' ? (body[name] as string) : '');
  const target = field('sectionTarget');
  if (target !== 'lead' && target !== 'heading') return undefined;
  const state: SectionFormState = {
    target,
    heading: field('sectionHeading'),
    level: field('sectionLevel'),
    occurrence: field('sectionOccurrence'),
    fingerprint: field('sectionFingerprint'),
    name: target === 'lead' ? t('sectionEdit.lead') : field('sectionHeading'),
  };
  return state;
};

const findSection = (text: string, state: SectionFormState) =>
  listEditableSections(text).find(section =>
    state.target === 'lead'
      ? section.target === 'lead'
      : section.target === 'heading' &&
        section.heading === state.heading &&
        String(section.level) === state.level &&
        String(section.occurrence) === state.occurrence
  );

const renderEditorToolbar = (req: Request) => {
  const button = (action: string, labelKey: string, text: string) =>
    `<button type="button" class="editor-toolbar-button" data-action="${action}" title="${escapeHtml(
      req.t(labelKey)
    )}" aria-label="${escapeHtml(req.t(labelKey))}">${text}</button>`;
  return `<div class="editor-toolbar requires-js" role="toolbar" aria-label="${escapeHtml(req.t('sectionEdit.toolbarLabel'))}"
    data-editor-toolbar
    data-target="operator-edit-body"
    data-link-prompt="${escapeHtml(req.t('sectionEdit.articleLinkPrompt'))}"
    data-citation-endpoint="/api/citation-search"
    data-citation-none="${escapeHtml(req.t('sectionEdit.citationNone'))}">
    ${button('bold', 'sectionEdit.bold', '<b>B</b>')}
    ${button('italic', 'sectionEdit.italic', '<i>I</i>')}
    ${button('link', 'sectionEdit.articleLink', '&#128279;')}
    ${button('heading', 'sectionEdit.heading', 'H')}
    ${button('list', 'sectionEdit.list', '&#8226;')}
    ${button('citation', 'sectionEdit.citation', '[@]')}
    <div class="editor-citation-search" hidden data-citation-search>
      <input type="search" placeholder="${escapeHtml(req.t('sectionEdit.citationSearch'))}" aria-label="${escapeHtml(
        req.t('sectionEdit.citationSearch')
      )}" />
      <ul class="editor-citation-results"></ul>
    </div>
  </div>`;
};

const renderOperatorEditForm = ({
  req,
  slug,
  lang,
  languageLabel,
  titleValue,
  bodyValue,
  summaryValue,
  wikidataValue,
  previewHtml,
  errorMessage,
  section,
}: {
  req: Request;
  slug: string;
  lang: string;
  languageLabel: string;
  titleValue: string;
  bodyValue: string;
  summaryValue: string;
  wikidataValue: string;
  previewHtml?: string;
  errorMessage?: string;
  section?: SectionFormState;
}) => {
  const action = operatorEditPath(slug, lang);
  const sectionHtml = section
    ? `<p class="section-edit-heading">${escapeHtml(req.t('sectionEdit.editing', { section: section.name }))} · <a href="${escapeHtml(
        action
      )}">${escapeHtml(req.t('sectionEdit.wholePage'))}</a></p>
    <input type="hidden" name="sectionTarget" value="${escapeHtml(section.target)}" />
    <input type="hidden" name="sectionHeading" value="${escapeHtml(section.heading)}" />
    <input type="hidden" name="sectionLevel" value="${escapeHtml(section.level)}" />
    <input type="hidden" name="sectionOccurrence" value="${escapeHtml(section.occurrence)}" />
    <input type="hidden" name="sectionFingerprint" value="${escapeHtml(section.fingerprint)}" />`
    : '';
  const titleFieldHtml = section
    ? ''
    : `<label class="form-field">
      <span>${escapeHtml(req.t('operatorEdit.fields.title'))}</span>
      <input
        type="text"
        name="title"
        value="${escapeHtml(titleValue)}"
        maxlength="200"
        data-markdown-preview-field
      />
    </label>`;
  const wikidataFieldHtml = section
    ? ''
    : `<label class="form-field">
      <span>${escapeHtml(req.t('operatorEdit.fields.wikidata'))}</span>
      <input
        type="text"
        name="wikidata"
        value="${escapeHtml(wikidataValue)}"
        maxlength="13"
        pattern="Q[1-9][0-9]*"
        placeholder="Q42"
      />
    </label>
    <p class="form-help">${escapeHtml(req.t('operatorEdit.wikidataHelp'))}</p>`;
  return `<section class="form-card operator-edit-card">
  <p class="form-help">${escapeHtml(
    req.t('operatorEdit.intro', { language: languageLabel })
  )}</p>
  ${errorMessage ? `<div class="form-error">${escapeHtml(errorMessage)}</div>` : ''}
  <form method="post" action="${action}" id="operator-edit-form">
    <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
    ${sectionHtml}
    ${titleFieldHtml}
    <label class="form-field">
      <span>${escapeHtml(req.t('operatorEdit.fields.body'))}</span>
      ${renderEditorToolbar(req)}
      <textarea
        id="operator-edit-body"
        name="body"
        rows="18"
        data-markdown-preview-field
      >${escapeHtml(bodyValue)}</textarea>
    </label>
    ${wikidataFieldHtml}
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
  wikidataValue,
  errorMessage,
  previewHtml,
  section,
}: {
  req: Request;
  res: Response;
  slug: string;
  lang: string;
  titleValue: string;
  bodyValue: string;
  summaryValue: string;
  wikidataValue?: string;
  errorMessage?: string;
  previewHtml?: string;
  section?: SectionFormState;
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

  res.render('layout', {
    title: prepareTitle(concatSafeText(pageTitle, ` · ${req.t('operatorEdit.title')}`)),
    labelHtml: `<div class="page-label">${escapeHtml(req.t('operatorEdit.title'))}</div>`,
    bodyHtml: renderOperatorEditForm({
      req,
      slug,
      lang,
      languageLabel,
      titleValue,
      bodyValue,
      summaryValue,
      wikidataValue: wikidataValue ?? page.wikidata ?? '',
      errorMessage,
      previewHtml,
      section,
    }),
    topHtml: prependAccountBanner(res, bannerHtml),
  });
};

export const registerPageRoutes = (app: Express) => {
  registerRevertRoutes(app);
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
      const [citationEntries, mediaRegistry] = await Promise.all([
        loadCitationEntriesForSources(dalInstance, checkSources),
        loadMediaEntriesForSources(dalInstance, checkSources),
      ]);
      const checksMarkdownOptions = {
        ...markdownOptions,
        mediaRegistry,
        locale: res.locals.locale as string | undefined,
      };

      const items: PageCheckDetailItem[] = await Promise.all(
        checks.map(async check => {
          const metrics = resolveCheckMetrics(check.metrics as PageCheckMetrics | null);
          const checkResultsSource = mlString.resolve(contentLang, check.checkResults)?.str ?? '';
          const notesSource = mlString.resolve(contentLang, check.notes)?.str ?? '';
          const checkResultsHtml = (
            await renderMarkdown(checkResultsSource, citationEntries, checksMarkdownOptions)
          ).html;
          const notesHtml = notesSource
            ? (await renderMarkdown(notesSource, citationEntries, checksMarkdownOptions)).html
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
      const labelHtml = `<div class="page-label">${req.t('checks.title')}</div>`;
      const languageRow = renderContentLanguageRow({
        label: req.t('language.available'),
        currentLang: contentLang,
        availableLangs,
        languageOptions: res.locals.languageOptions,
        path: req.path,
        queryParams: extractQueryParams(req.query),
      });
      res.render('layout', {
        title: prepareTitle(title),
        labelHtml,
        bodyHtml: `${bodyHtml}${languageRow}`,
        topHtml: prependAccountBanner(res),
      });
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
      const [citationEntries, mediaRegistry] = await Promise.all([
        loadCitationEntriesForSources(dalInstance, [checkResultsSource, notesSource]),
        loadMediaEntriesForSources(dalInstance, [checkResultsSource, notesSource]),
      ]);
      const checkRenderOptions = {
        ...markdownOptions,
        mediaRegistry,
        locale: res.locals.locale as string | undefined,
      };
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
            ? `/${encodeSlugPath(page.slug)}?rev=${targetRevId}${
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
        await renderMarkdown(checkResultsSource, citationEntries, checkRenderOptions)
      ).html;
      const notesHtml = notesSource
        ? `<div class="check-notes">${(await renderMarkdown(
            notesSource,
            citationEntries,
            checkRenderOptions
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
          const baseHref = `/${encodeSlugPath(page.slug)}/checks/${encodeURIComponent(
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
      res.render('layout', {
        title: prepareTitle(title),
        labelHtml,
        bodyHtml: `${bodyHtml}${languageRow}`,
        topHtml: prependAccountBanner(res, topHtml),
        sidebarHtml: historyHtml,
      });
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
      const editability = await getWikiPageEditability(dalInstance, { id: page.id }, session.userId);
      if (editability.isProtected && !editability.isEditable) {
        res
          .status(403)
          .type('text')
          .send(
            req.t(
              editability.protection?.level === 'experienced'
                ? 'operatorEdit.protectedForbiddenExperienced'
                : 'operatorEdit.protectedForbidden'
            )
          );
        return;
      }
      const availableLangs = getAvailableLanguages(page.body, page.title);
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: normalizeOverrideLang(typeof req.query.lang === 'string' ? req.query.lang : undefined),
        availableLangs,
      });

      const bodyText = mlString.resolve(contentLang, page.body)?.str ?? '';
      const sectionParam =
        typeof req.query.section === 'string' && /^\d+$/.test(req.query.section)
          ? Number(req.query.section)
          : undefined;
      const section = sectionParam === undefined ? undefined : listEditableSections(bodyText)[sectionParam];
      await renderOperatorEditPage({
        req,
        res,
        slug,
        lang: contentLang,
        titleValue: mlString.resolve(contentLang, page.title)?.str ?? '',
        bodyValue: section ? trimBlankLines(section.content) : bodyText,
        summaryValue: '',
        section: section ? toSectionFormState(section, req.t) : undefined,
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
    const wikidataValue = typeof req.body?.wikidata === 'string' ? req.body.wikidata.trim() : '';
    const section = readSectionFormState(req.body, req.t);

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
          wikidataValue,
          previewHtml,
          section,
        });
        return;
      }

      if (section) {
        const current = await readWikiPage(dalInstance, slug);
        const currentSection = findSection(mlString.resolve(lang, current.body)?.str ?? '', section);
        if (!currentSection) {
          throw new ConflictError('Section not found.', { slug, heading: section.heading });
        }
        // Keep the blank lines around the section as they were; the form shows it without them.
        const edges = trimBlankLines(currentSection.content)
          ? {
              before: currentSection.content.match(/^\n*/)?.[0] ?? '',
              after: currentSection.content.match(/\n*$/)?.[0] ?? '',
            }
          : { before: '', after: currentSection.content };
        await rewriteWikiPageSection(
          dalInstance,
          {
            slug,
            target: section.target,
            heading: section.target === 'heading' ? section.heading : undefined,
            headingLevel: section.target === 'heading' ? Number(section.level) : undefined,
            occurrence: section.target === 'heading' ? Number(section.occurrence) : undefined,
            mode: 'replace',
            content: `${edges.before}${trimBlankLines(bodyValue)}${edges.after}`,
            lang,
            expectedSectionFingerprint: section.fingerprint,
            revSummary: { [lang]: summaryValue.trim() ? `${section.name}: ${summaryValue}` : '' },
          },
          session.userId
        );
        res.redirect(303, pageViewPath(slug, lang));
        return;
      }

      await updateWikiPage(
        dalInstance,
        {
          slug,
          title: { [lang]: titleValue },
          body: { [lang]: bodyValue },
          wikidata: wikidataValue || null,
          revSummary: { [lang]: summaryValue },
        },
        session.userId
      );

      res.redirect(303, pageViewPath(slug, lang));
    } catch (caught) {
      const error = isRevisionConflictError(caught) ? toRevisionConflictError(caught) : caught;
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (error instanceof ForbiddenError) {
        res
          .status(403)
          .type('text')
          .send(
            req.t(
              error.details?.level === 'experienced'
                ? 'operatorEdit.protectedForbiddenExperienced'
                : 'operatorEdit.protectedForbidden'
            )
          );
        return;
      }
      // Saving a section without changes: nothing to do.
      if (section && error instanceof PreconditionFailedError) {
        res.redirect(303, pageViewPath(slug, lang));
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
          wikidataValue,
          errorMessage:
            section && error instanceof ConflictError
              ? req.t('sectionEdit.changed')
              : resolveOperatorEditValidationMessage(req.t, error),
          previewHtml,
          section,
        });
        return;
      }
      console.error('Failed to save operator edit:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(/^\/(.+)\/proposal-links$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug) || !isSignoffPageSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(pageViewPath(slug))}`);
      return;
    }
    const pullRequests =
      typeof req.body?.pullRequests === 'string'
        ? req.body.pullRequests
            .split(/[\r\n]+/)
            .map((line: string) => line.trim())
            .filter(Boolean)
        : [];
    try {
      const dalInstance = await initializePostgreSQL();
      await setProposalLinks(
        dalInstance,
        {
          slug,
          pullRequests,
          parent: typeof req.body?.parent === 'string' ? req.body.parent : null,
        },
        session.userId
      );
      res.redirect(303, pageViewPath(slug));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('proposalLinks.forbidden'));
        return;
      }
      if (error instanceof ValidationError) {
        res.status(400).type('text').send(`${req.t('proposalLinks.invalid')} ${error.message}`);
        return;
      }
      console.error('Failed to set proposal links:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(/^\/(.+)\/proposal-status$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug) || !isSignoffPageSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(pageViewPath(slug))}`);
      return;
    }
    const lang = normalizeOverrideLang(typeof req.body?.lang === 'string' ? req.body.lang : undefined) ?? 'en';
    const note = typeof req.body?.decisionNote === 'string' ? normalizeLineEndings(req.body.decisionNote).trim() : '';
    const appliedTo =
      typeof req.body?.appliedTo === 'string'
        ? req.body.appliedTo
            .split(/[\r\n]+/)
            .map((line: string) => line.trim())
            .filter(Boolean)
        : [];
    try {
      const dalInstance = await initializePostgreSQL();
      await setProposalStatus(
        dalInstance,
        {
          slug,
          status: typeof req.body?.status === 'string' ? req.body.status : '',
          decisionNote: note ? { [lang]: note } : undefined,
          appliedTo,
          supersededBy: typeof req.body?.supersededBy === 'string' ? req.body.supersededBy : undefined,
        },
        session.userId
      );
      res.redirect(303, pageViewPath(slug));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('proposalStatus.forbidden'));
        return;
      }
      if (error instanceof ValidationError) {
        res.status(400).type('text').send(`${req.t('proposalStatus.invalid')} ${error.message}`);
        return;
      }
      console.error('Failed to set proposal status:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(/^\/(.+)\/position-reply$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug) || !isSignoffPageSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(pageViewPath(slug))}`);
      return;
    }
    const field = (name: string) => (typeof req.body?.[name] === 'string' ? req.body[name] : '');
    try {
      const dalInstance = await initializePostgreSQL();
      const reply = await replyToPosition(
        dalInstance,
        {
          slug,
          signoffId: field('signoffId'),
          body: normalizeLineEndings(field('body')),
          language: field('language'),
        },
        session.userId
      );
      res.redirect(303, `${pageViewPath(slug)}#reply-${reply.commentId}`);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('signoff.reply.forbidden'));
        return;
      }
      if (error instanceof ValidationError) {
        res.status(400).type('text').send(req.t('signoff.reply.invalid'));
        return;
      }
      console.error('Failed to save reply:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(/^\/(.+)\/sign-off$/, async (req, res) => {
    const slug = req.params[0];
    if (isBlockedSlug(slug) || !isSignoffPageSlug(slug)) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(pageViewPath(slug))}`);
      return;
    }

    const intent = req.body?.intent === 'withdraw' ? 'withdraw' : 'signoff';
    const comment = normalizeLineEndings(typeof req.body?.comment === 'string' ? req.body.comment : '');

    try {
      const dalInstance = await initializePostgreSQL();
      if (intent === 'withdraw') {
        await withdrawPageSignoff(dalInstance, { slug }, session.userId);
      } else {
        const stance = typeof req.body?.stance === 'string' ? req.body.stance : '';
        const commentLanguage = typeof req.body?.commentLanguage === 'string' ? req.body.commentLanguage : undefined;
        await signOffPage(dalInstance, { slug, stance, comment, commentLanguage }, session.userId);
      }
      res.redirect(303, `${pageViewPath(slug)}#page-signoffs-title`);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('signoff.forbidden'));
        return;
      }
      if (error instanceof ConflictError || error instanceof ValidationError) {
        res.status(400).type('text').send(req.t('signoff.invalid'));
        return;
      }
      console.error('Failed to record sign-off:', error);
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
            const addressForm = toAddressForm(slug);
            const match = addressForm !== slug ? await findCurrentPageBySlugOrAlias(addressForm) : null;
            if (match) {
              res.redirect(301, `${slugPath(match.slug)}${queryStringOf(req.originalUrl)}`);
              return null;
            }
            res.status(404).type('text').send(req.t('page.notFound'));
            return null;
          }
          throw error;
        }
      })();
      if (!pageResult) return;
      const { page, revisionsResult } = pageResult;
      if (page.slug !== slug) {
        res.redirect(301, `${slugPath(page.slug)}${queryStringOf(req.originalUrl)}`);
        return;
      }
      const session = await resolveSessionUser(req);
      const editability = await getWikiPageEditability(
        dalInstance,
        { id: page.id },
        session?.userId ?? null
      );

      const revisions = revisionsResult.revisions;
      const selectedRevId = revIdParam ?? (diffFrom && diffTo ? diffTo : undefined);
      const selectedRevision = selectedRevId
        ? await (async () => {
            try {
              return (await readWikiPageRevision(dalInstance, slug, selectedRevId)).revision;
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
      const bodySource = resolvedBody?.str ?? '';

      if (formatParam === 'raw') {
        res.type('text/plain').send(bodySource);
        return;
      }
      const candidateLinkSlugs = extractCandidateWikiLinkSlugs(bodySource);
      const [citationEntries, mediaRegistry, existingLinkSlugs] = await Promise.all([
        loadCitationEntriesForSources(dalInstance, [bodySource]),
        loadMediaEntriesForSources(dalInstance, [bodySource]),
        findExistingWikiLinkSlugs(dalInstance, candidateLinkSlugs),
      ]);
      const missingLinkSlugs = new Set(
        candidateLinkSlugs.filter(candidateSlug => !existingLinkSlugs.has(candidateSlug))
      );

      const titleOfProposal = (title: Record<string, string> | null | undefined, fallback: string) =>
        resolveSafeText(mlString.resolve, contentLang, title, fallback);
      const proposalParts = isSignoffPageSlug(canonicalSlug)
        ? await listProposalParts(dalInstance, page.id)
        : [];
      const partsHtml = renderProposalParts({
        parts: proposalParts.map(part => ({ ...part, title: titleOfProposal(part.title, part.slug) })),
        t: req.t,
      });
      const canEditSections =
        Boolean(session) &&
        (!editability.isProtected || editability.isEditable) &&
        !revIdParam &&
        !diffFrom &&
        !diffTo;
      const editableSections = canEditSections ? listEditableSections(bodySource) : [];
      const sectionEditHref = (index: number) => `${operatorEditPath(canonicalSlug, contentLang)}&section=${index}`;
      const sectionEditLink = canEditSections
        ? (index: number) =>
            ` <span class="section-edit">[<a href="${escapeHtml(sectionEditHref(index))}" aria-label="${escapeHtml(
              req.t('sectionEdit.linkLabel', { section: editableSections[index]?.heading ?? '' })
            )}">${escapeHtml(req.t('sectionEdit.link'))}</a>]</span>`
        : undefined;
      const leadEditHtml =
        canEditSections && trimBlankLines(editableSections[0]?.content ?? '').trim()
          ? `<p class="section-edit section-edit--lead">[<a href="${escapeHtml(sectionEditHref(0))}" aria-label="${escapeHtml(
              req.t('sectionEdit.editLead')
            )}" title="${escapeHtml(req.t('sectionEdit.editLead'))}"><span aria-hidden="true">↑ </span>${escapeHtml(
              req.t('sectionEdit.link')
            )}</a>]</p>`
          : '';
      const { html: bodyHtml, toc } = await renderMarkdown(
        bodySource,
        citationEntries,
        {
          ...markdownOptions,
          afterLeadHtml: `${leadEditHtml}${partsHtml}`,
          sectionEditLink,
          wikiLinks: {
            missingSlugs: missingLinkSlugs,
          },
          mediaRegistry,
          locale: res.locals.locale as string | undefined,
          showUnknownVariables: isPromptPageSlug(canonicalSlug),
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
          const baseHref = `/${encodeSlugPath(canonicalSlug)}`;
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
          ? `<aside class="article-issues-notice" role="note"><span class="article-issues-notice-icon" aria-hidden="true">${iconWarningTriangle}</span><div class="article-issues-notice-body"><span>${req.t('warning.highSeverityIssues', { checksHref: `/${encodeSlugPath(canonicalSlug)}/checks` })}</span><div class="article-issues-rows">${highSeverityRows.map(row => `<div class="article-issues-row"><a href="/${encodeSlugPath(canonicalSlug)}/checks/${encodeURIComponent(row.id)}">${escapeHtml(row.typeLabel)}</a><span>${escapeHtml(req.t('warning.unresolvedIssues', { count: row.unresolved }))}</span></div>`).join('')}</div></div></aside>`
          : '';

      const userIds = new Set<string>();
      for (const rev of revisions) {
        if (rev.revUser) userIds.add(rev.revUser);
      }
      for (const check of pageChecks) {
        if (check.revUser) userIds.add(check.revUser);
      }
      const signoffs = isSignoffPageSlug(canonicalSlug)
        ? await listActivePageSignoffs(dalInstance, page.id)
        : null;
      for (const signoff of signoffs ?? []) {
        userIds.add(signoff.userId);
      }
      const replyThreads = signoffs
        ? await listPositionReplies(
            dalInstance,
            signoffs.map(signoff => signoff.id)
          )
        : new Map();
      const replySources = [...replyThreads.values()].flatMap(thread => thread.replies.map(reply => reply.body));
      const replyCitations = replySources.length
        ? await loadCitationEntriesForSources(dalInstance, replySources)
        : [];
      const signoffReplies = new Map(
        await Promise.all(
          [...replyThreads.entries()].map(async ([signoffId, thread]) => {
            for (const reply of thread.replies) if (reply.authorId) userIds.add(reply.authorId);
            const replies = await Promise.all(
              thread.replies.map(async reply => ({
                ...reply,
                bodyHtml: (
                  await renderMarkdown(reply.body, replyCitations, {
                    backToCitationLabel: req.t('citation.backToCitationAria'),
                  })
                ).html,
              }))
            );
            return [signoffId, { threadId: thread.threadId, replies }] as const;
          })
        )
      );
      if (selectedRevision.proposal?.decidedBy) userIds.add(selectedRevision.proposal.decidedBy);
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
      const [canRestore, canRollback] = editability.isEditable
        ? await Promise.all([
            canUseRevertAction(dalInstance, session?.userId, 'restore'),
            canUseRevertAction(dalInstance, session?.userId, 'rollback'),
          ])
        : [false, false];
      const rollbackOffered =
        canRollback &&
        revisions[0]?.revUser !== session?.userId &&
        revisions.some(rev => rev.revUser !== revisions[0]?.revUser);
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: historyAction,
        viewHref: revId =>
          langOverride
            ? `/${canonicalSlug}?rev=${revId}&lang=${encodeURIComponent(langOverride)}`
            : `/${canonicalSlug}?rev=${revId}`,
        extraActions: (rev, index) => {
          if (index === 0) {
            return rollbackOffered
              ? [{ label: req.t('revert.rollback.link'), href: `${REVERT_PATH}?page=${canonicalSlug}&action=rollback` }]
              : [];
          }
          return canRestore
            ? [
                {
                  label: req.t('revert.restore.link'),
                  href: `${REVERT_PATH}?page=${canonicalSlug}&rev=${encodeURIComponent(rev.revId)}`,
                },
              ]
            : [];
        },
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
      const discussionCategory = forumPageCategory(canonicalSlug);
      const forumPath = discussionCategory
        ? forumCategoryPagePath(discussionCategory, canonicalSlug)
        : '';
      const signedIn = Boolean(session);
      const canShowOperatorEditLink =
        !revIdParam && !diffFrom && !diffTo && (!editability.isProtected || editability.isEditable);
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
      const isCurrentView = !revIdParam && !diffFrom && !diffTo;
      const canEditDirectly = signedIn && (!editability.isProtected || editability.isEditable);
      const tabsHtml = renderPageTabs({
        isArticle,
        pageHref: pageViewPath(canonicalSlug, langOverride),
        isCurrentView,
        discussHref: forumPath || null,
        discussCount: discussionCategory ? await countForumCommentsForPage(dalInstance, canonicalSlug, discussionCategory) : 0,
        editHref: canEditDirectly ? operatorEditPath(canonicalSlug, contentLang) : howToEditPath(canonicalSlug),
        t: req.t,
      });
      const forumLinkHtml = relatedLinks.length
        ? `<div class="tool-related">
  <span class="tool-related-label">${escapeHtml(req.t('page.actions'))}</span>
  <span class="tool-related-links">${relatedLinks.join(' · ')}</span>
</div>`
        : '';
      const changedRevIds = signoffs
        ? await findRevisionsWithChangedText(
            dalInstance,
            page.id,
            [...new Set(signoffs.map(signoff => signoff.revId))].filter(id => id !== page.currentRevId)
          )
        : new Set<string>();
      const proposalPermissions = signoffs
        ? await getProposalStatusPermissions(dalInstance, page.id, session?.userId)
        : { canChange: false, isAdmin: false };
      const proposalHtml = signoffs
        ? await (async () => {
            const links = selectedRevision.proposalLinks;
            const [pullRequests, parentPage] = await Promise.all([
              pullRequestStates.getStates(links?.pullRequests ?? []),
              links?.parent?.slug ? findCurrentPageById(links.parent.id) : null,
            ]);
            const parent = parentPage
              ? { slug: parentPage.slug, title: titleOfProposal(parentPage.title, parentPage.slug) }
              : null;
            const canEditLinks =
              signedIn && editability.isEditable && !selectedRevId;
            return renderProposalHeader({
              info: selectedRevision.proposal,
              userMap,
              locale: (res.locals.locale as string | undefined) ?? 'en',
              contentLang,
              linksHtml: renderProposalLinks({ pullRequests, parent, t: req.t }),
              statusFormHtml: proposalPermissions.canChange && editability.isEditable && !selectedRevId
                ? renderProposalStatusForm({
                    slug: canonicalSlug, info: page.proposal,
                    isAdmin: proposalPermissions.isAdmin, contentLang, t: req.t,
                  })
                : '',
              linksFormHtml: canEditLinks
                ? renderProposalLinksForm({ slug: canonicalSlug, pullRequests, parent, contentLang, t: req.t })
                : '',
              t: req.t,
            });
          })()
        : '';
      const signoffsHtml = signoffs
        ? renderPageSignoffs({
            slug: canonicalSlug,
            currentRevId: page.currentRevId,
            changedRevIds,
            signoffs,
            userMap,
            viewerId: session?.userId ?? null,
            canSignOff: await canSignOffPages(dalInstance, session?.userId),
            canReply:
              (await canSignOffPages(dalInstance, session?.userId)) &&
              Boolean((res.locals.accountState as { isEmailVerified?: boolean } | null)?.isEmailVerified),
            t: req.t,
            language: req.language ?? 'en',
            languageOptions: res.locals.languageOptions,
            replies: signoffReplies,
          })
        : '';
      const wikidataHtml =
        isArticle && selectedRevision.wikidata
          ? `<p class="page-wikidata">${escapeHtml(req.t('page.wikidata'))} <a href="https://www.wikidata.org/wiki/${encodeURIComponent(selectedRevision.wikidata)}" rel="noopener">${escapeHtml(selectedRevision.wikidata)}</a></p>`
          : '';
      const infoboxHtml =
        isArticle && selectedRevision.wikidata && !diffFrom && !diffTo
          ? await renderArticleInfobox(dalInstance, {
              pageId: page.id,
              qid: selectedRevision.wikidata,
              localValues: selectedRevision.infoboxValues,
              titleHtml: typeof title === 'string' ? escapeHtml(title) : title.value,
              locale: (res.locals.locale as string | undefined) ?? 'en',
              t: req.t,
              isOldRevision: Boolean(revIdParam),
            })
          : '';
      // The home page shows what is new below its own text, on the current version only.
      const homeHtml =
        canonicalSlug === HOME_PAGE_SLUG && !selectedRevId && !diffHtml
          ? renderHomeSections(await loadHomeSections(dalInstance, contentLang), req.t, contentLang)
          : '';
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const pageTypeLabel = canonicalSlug.startsWith('meta/')
        ? req.t('label.meta')
        : canonicalSlug.startsWith('tool/')
          ? req.t('label.tool')
          : req.t('label.article');
      const labelHtml = renderPageTypeLabel(
        req,
        pageTypeLabel,
        editability.isProtected
          ? { editable: editability.isEditable, level: editability.protection?.level ?? 'admins' }
          : undefined
      );
      res.render('layout', {
        title: prepareTitle(title),
        canonicalUrl: canonicalUrlFor(slugPath(canonicalSlug)),
        labelHtml,
        tabsHtml,
        bodyHtml: `${draftNoticeHtml}${issuesNoticeHtml}${proposalHtml}${infoboxHtml}${bodyHtml}${homeHtml}${signoffsHtml}${wikidataHtml}${languageRow}${forumLinkHtml}`,
        topHtml: prependAccountBanner(res, topHtml),
        sidebarHtml,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render wiki page:', message);
    }
  });
};
