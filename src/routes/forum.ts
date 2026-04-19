import { decodeHTML } from 'entities';
import type { Express, Request, Response } from 'express';
import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import {
  forumCategoryPagePath,
  forumCategoryPath,
  forumCommentAnchor,
  forumCommentDeletePath,
  forumDismissPreamblePath,
  forumIndexPath,
  forumThreadCommentPath,
  forumThreadDeletePath,
  forumThreadPath,
  forumThreadPinPath,
} from '../lib/forum-paths.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import {
  escapeHtml,
  formatDateUTC,
  prepareTitle,
  renderMarkdown,
  renderText,
  type SafeText,
} from '../render.js';
import {
  buildForumQuote,
  createForumComment,
  createForumThread,
  deleteForumComment,
  deleteForumThread,
  ensureForumCategory,
  FORUM_CATEGORY_KEYS,
  type ForumCategorySlug,
  listForumCategories,
  listForumThreads,
  readForumComment,
  readForumThread,
  requireSignedInUserId,
  resolveForumPageTarget,
  setForumThreadPinned,
} from '../services/forum-service.js';
import { FORUM_MODERATOR_ROLE, userHasRole } from '../services/roles.js';
import { normalizeSlugInput } from '../services/validation.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { dismissBanner, renderDismissableBanner } from './lib/dismissable-banner.js';
import { fetchUserMap } from './lib/history.js';
import {
  createPreviewHandler,
  renderMarkdownPreviewHtml,
  renderMarkdownPreviewPanel,
} from './lib/markdown-preview.js';
import { resolveForumValidationMessage } from './lib/validation-messages.js';

const { mlString } = dal;

const FORUM_PREAMBLE_COOKIE = 'agpwiki_forum_preamble_dismissed';

const renderForumPreamble = (req: Request) => {
  return renderDismissableBanner({
    req,
    cookieName: FORUM_PREAMBLE_COOKIE,
    unsafeBodyHtml: req.t('forum.preamble'),
    dismissPath: forumDismissPreamblePath(),
    dismissLabel: req.t('common.dismiss'),
    className: 'dismissable-banner forum-preamble',
  });
};

const renderLanguageSelector = (
  languageOptions: Array<{ code: string; label: string }>,
  selected: string,
  t: Request['t']
) => `<div class="forum-compose-language-control">
  <details class="lang-menu forum-compose-lang-menu">
  <summary
    class="lang-menu-summary"
    aria-label="${t('forum.compose.language')}"
    title="${t('forum.compose.language')}"
  >
    <span class="lang-menu-icon" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M415.9 344L225 344C227.9 408.5 242.2 467.9 262.5 511.4C273.9 535.9 286.2 553.2 297.6 563.8C308.8 574.3 316.5 576 320.5 576C324.5 576 332.2 574.3 343.4 563.8C354.8 553.2 367.1 535.8 378.5 511.4C398.8 467.9 413.1 408.5 416 344zM224.9 296L415.8 296C413 231.5 398.7 172.1 378.4 128.6C367 104.2 354.7 86.8 343.3 76.2C332.1 65.7 324.4 64 320.4 64C316.4 64 308.7 65.7 297.5 76.2C286.1 86.8 273.8 104.2 262.4 128.6C242.1 172.1 227.8 231.5 224.9 296zM176.9 296C180.4 210.4 202.5 130.9 234.8 78.7C142.7 111.3 74.9 195.2 65.5 296L176.9 296zM65.5 344C74.9 444.8 142.7 528.7 234.8 561.3C202.5 509.1 180.4 429.6 176.9 344L65.5 344zM463.9 344C460.4 429.6 438.3 509.1 406 561.3C498.1 528.6 565.9 444.8 575.3 344L463.9 344zM575.3 296C565.9 195.2 498.1 111.3 406 78.7C438.3 130.9 460.4 210.4 463.9 296L575.3 296z"/></svg>
    </span>
    <span class="lang-menu-prefix">${t('language.selector')}</span>
    <span class="lang-menu-label">${escapeHtml(selected)}</span>
  </summary>
  <div class="lang-menu-panel">
    ${languageOptions
      .map(
        option =>
          `<div class="forum-language-option">
  <input
    class="forum-language-radio"
    type="radio"
    name="language"
    id="forum-language-${escapeHtml(option.code)}"
    value="${escapeHtml(option.code)}"${
            option.code === selected ? ' checked' : ''
          }
  />
  <label
    class="lang-menu-option${option.code === selected ? ' lang-menu-option--active' : ''}"
    for="forum-language-${escapeHtml(option.code)}"
  >${escapeHtml(option.label)}</label>
</div>`
      )
      .join('')}
  </div>
  </details>
</div>`;

const renderCategoryCards = (
  items: Awaited<ReturnType<typeof listForumCategories>>,
  locale: string,
  t: Request['t']
) =>
  `<div class="forum-category-grid">
    ${items
      .map(item => {
        const latestTitle = getThreadTitleRenderValue(locale, item.latestPost?.title ?? null);
        const latestHtml = item.latestPost
          ? `<a class="forum-latest-link" href="${forumThreadPath(item.latestPost.threadId)}#${forumCommentAnchor(item.latestPost.commentId)}">${renderText(
              latestTitle
            )}</a>`
          : `<span class="forum-empty">${t('forum.index.noThreads')}</span>`;
        return `<section class="forum-category-card">
  <h2><a href="${forumCategoryPath(item.slug)}">${t(item.labelKey)}</a></h2>
  <div class="forum-category-meta">
    <span>${t('forum.index.threadCount', { count: item.threadCount })}</span>
    ${
      item.latestPost?.createdAt
        ? `<span>${t('forum.index.latestPostAt', {
            date: escapeHtml(formatDateUTC(item.latestPost.createdAt)),
          })}</span>`
        : ''
    }
  </div>
  ${latestHtml}
</section>`;
      })
      .join('')}
  </div>`;

const renderForumIndexDescription = (req: Request) => {
  const articlesCategoryLink = `<a href="${forumCategoryPath('articles')}">${escapeHtml(
    req.t(FORUM_CATEGORY_KEYS.articles)
  )}</a>`;
  const generalCategoryLink = `<a href="${forumCategoryPath('general')}">${escapeHtml(
    req.t(FORUM_CATEGORY_KEYS.general)
  )}</a>`;

  return req.t('forum.index.descriptionHtml', {
    articlesCategory: articlesCategoryLink,
    generalCategory: generalCategoryLink,
  });
};

const renderForumBreadcrumbs = (
  items: Array<{ label: SafeText | string; href?: string }>,
  t: Request['t']
) => `<nav class="forum-breadcrumbs" aria-label="${t('forum.breadcrumbs')}">
  ${items
    .map((item, index) => {
      const content = item.href
        ? `<a href="${escapeHtml(item.href)}">${renderText(item.label)}</a>`
        : `<span>${renderText(item.label)}</span>`;
      const separator =
        index < items.length - 1
          ? `<span class="forum-breadcrumb-separator" aria-hidden="true">›</span>`
          : '';
      return `${content}${separator}`;
    })
    .join('')}
</nav>`;

const renderThreadList = (
  threads: Awaited<ReturnType<typeof listForumThreads>>,
  locale: string,
  t: Request['t'],
  options: { showPageSlug?: boolean; pageCategory?: ForumCategorySlug } = {}
) => {
  if (threads.length === 0) {
    return `<p class="forum-empty">${t('forum.category.empty')}</p>`;
  }

  return `<ol class="forum-thread-list">
    ${threads
      .map(thread => {
        const threadTitle = getThreadTitleRenderValue(locale, thread.title);
        const pinHtml = thread.pinned
          ? `<span class="forum-pin-badge">${t('forum.thread.pinned')}</span>`
          : '';
        return `<li class="forum-thread-list-item">
  <h2 class="forum-thread-title-row"><a class="forum-thread-title-link" href="${forumThreadPath(thread.id)}">${renderText(threadTitle)}</a>${pinHtml}</h2>
  <div class="forum-thread-meta">
    <span>${t('forum.thread.commentCount', { count: thread.commentCount ?? 0 })}</span>
    <span>${t('forum.thread.createdAt', { date: escapeHtml(formatDateUTC(thread.createdAt)) })}</span>
    ${
      options.showPageSlug && thread.pageSlug && options.pageCategory
        ? `<span>${t('forum.thread.pageLabel', {
            page: `<a href="${forumCategoryPagePath(options.pageCategory, thread.pageSlug)}">${escapeHtml(thread.pageSlug)}</a>`,
          })}</span>`
        : ''
    }
  </div>
</li>`;
      })
      .join('')}
  </ol>`;
};

interface ForumComposeBaseValues {
  body: string;
  language: string;
}

interface ForumThreadFormValues extends ForumComposeBaseValues {
  pageSlug?: string;
  title: string;
}

const renderComposeForm = ({
  t,
  heading,
  action,
  formId,
  textareaId,
  previewId,
  bodyValue,
  language,
  languageOptions,
  submitLabel,
  previewHtml,
  errorMessage,
  sectionId,
  titleValue,
  extraFieldsHtml,
}: {
  t: Request['t'];
  heading: string;
  action: string;
  formId: string;
  textareaId: string;
  previewId: string;
  bodyValue: string;
  language: string;
  languageOptions: Array<{ code: string; label: string }>;
  submitLabel: string;
  previewHtml?: string;
  errorMessage?: string;
  sectionId?: string;
  titleValue?: string;
  extraFieldsHtml?: string;
}) => `<section class="form-card forum-compose-card"${
  sectionId ? ` id="${escapeHtml(sectionId)}"` : ''
}>
  <h2>${heading}</h2>
  ${errorMessage ? `<div class="form-error">${escapeHtml(errorMessage)}</div>` : ''}
  <form method="post" action="${action}" class="forum-compose-form" id="${escapeHtml(formId)}">
    ${
      typeof titleValue === 'string'
        ? `<label class="form-field">
      <span>${t('forum.compose.title')}</span>
      <input type="text" name="title" value="${escapeHtml(titleValue)}" maxlength="200" />
    </label>`
        : ''
    }
    ${extraFieldsHtml ?? ''}
    <label class="form-field">
      <span>${t('forum.compose.body')}</span>
      <textarea
        id="${escapeHtml(textareaId)}"
        name="body"
        rows="10"
        data-markdown-preview-field
      >${escapeHtml(bodyValue)}</textarea>
    </label>
    ${renderMarkdownPreviewPanel({
      formId,
      previewId,
      endpoint: '/api/render-markdown',
      texts: {
        title: t('common.preview.title'),
        empty: t('common.preview.empty'),
        error: t('common.preview.error'),
      },
      previewHtml,
    })}
    <div class="form-actions">
      <div class="forum-compose-primary-actions">
        ${renderLanguageSelector(languageOptions, language, t)}
        <button type="submit" name="intent" value="post">${submitLabel}</button>
      </div>
      <noscript>
        <button type="submit" name="intent" value="preview">${t('common.actions.preview')}</button>
      </noscript>
    </div>
  </form>
</section>`;

const renderThreadForm = ({
  t,
  languageOptions,
  values,
  previewHtml,
  errorMessage,
  pageMode,
}: {
  t: Request['t'];
  languageOptions: Array<{ code: string; label: string }>;
  values: ForumThreadFormValues;
  previewHtml?: string;
  errorMessage?: string;
  pageMode?:
    | {
        mode: 'generic';
        category: 'articles' | 'policy';
      }
    | {
        mode: 'scoped';
        category: 'articles' | 'policy';
        pageSlug: string;
        pageLabel: SafeText | string;
        pageHref?: string;
      };
}) => {
  const pageSearchScope =
    pageMode?.mode === 'generic'
      ? pageMode.category === 'articles'
        ? 'content_only'
        : 'meta_only'
      : '';
  return renderComposeForm({
    t,
    heading: t('forum.compose.newThread'),
    action: '',
    formId: 'forum-thread-form',
    textareaId: 'forum-thread-body',
    previewId: 'forum-thread-preview',
    bodyValue: values.body,
    language: values.language,
    languageOptions,
    submitLabel: t('forum.compose.postThread'),
    previewHtml,
    errorMessage,
    titleValue: values.title,
    extraFieldsHtml:
      pageMode?.mode === 'generic'
        ? `<div class="form-field forum-article-picker" data-page-search-root data-page-search-scope="${pageSearchScope}">
      <span>${t('forum.compose.page')}</span>
      <input
        type="text"
        class="search-input forum-article-search-input"
        name="pageSearch"
        value="${escapeHtml(values.pageSlug ?? '')}"
        maxlength="200"
        autocomplete="off"
        placeholder="${escapeHtml(t('forum.compose.pageSearchPlaceholder'))}"
        data-page-search-input
      />
      <input type="hidden" name="pageSlug" value="${escapeHtml(values.pageSlug ?? '')}" data-page-search-slug />
      <ul class="search-suggestions" role="listbox" data-page-search-suggestions></ul>
    </div>
    ${
      pageMode.category === 'policy'
        ? `<p class="form-help">${t('forum.compose.pageOptionalHelp')}</p>`
        : ''
    }
    <noscript>
      <label class="form-field">
        <span>${t('forum.compose.pageSlug')}</span>
        <input type="text" name="pageSlug" value="${escapeHtml(values.pageSlug ?? '')}" maxlength="200" />
      </label>
    </noscript>
    `
        : pageMode?.mode === 'scoped'
          ? `<input type="hidden" name="pageSlug" value="${escapeHtml(pageMode.pageSlug)}" />
    <p class="form-help">${t('forum.compose.pageContext', {
      page: pageMode.pageHref
        ? `<a href="${escapeHtml(pageMode.pageHref)}">${renderText(pageMode.pageLabel)}</a>`
        : renderText(pageMode.pageLabel),
    })}</p>`
          : '',
  });
};

const renderCommentForm = ({
  t,
  threadId,
  languageOptions,
  values,
  previewHtml,
  errorMessage,
}: {
  t: Request['t'];
  threadId: string;
  languageOptions: Array<{ code: string; label: string }>;
  values: ForumComposeBaseValues;
  previewHtml?: string;
  errorMessage?: string;
}) =>
  renderComposeForm({
    t,
    heading: t('forum.compose.reply'),
    action: forumThreadCommentPath(threadId),
    formId: 'forum-comment-form',
    textareaId: 'forum-comment-body',
    previewId: 'forum-comment-preview',
    bodyValue: values.body,
    language: values.language,
    languageOptions,
    submitLabel: t('forum.compose.postReply'),
    previewHtml,
    errorMessage,
    sectionId: 'reply-form',
  });

const getCommentBodyForDisplay = (
  body: Record<string, string> | null | undefined,
  originalLanguage: string | null | undefined
) => {
  const source = mlString.resolve(originalLanguage ?? 'en', body ?? null);
  return source?.str ?? '';
};

const getThreadTitleRenderValue = (
  locale: string,
  title: Record<string, string> | null | undefined,
  fallback = ''
) => resolveSafeTextWithFallback(mlString.resolve, locale, title, fallback);

const getThreadTitlePlainText = (
  locale: string,
  title: Record<string, string> | null | undefined,
  fallback = ''
) => decodeHTML(mlString.resolve([locale, 'en'], title ?? null)?.str ?? fallback);

const withForumPage = (
  res: Response,
  title: string,
  bodyHtml: string,
  labelHtml: string
) =>
  res.render('layout', {
    title: prepareTitle(title),
    labelHtml,
    topHtml: prependAccountBanner(res, renderForumPreamble(res.req)),
    bodyHtml,
  });

const getSelectedLanguage = (req: Request, fallback = 'en') =>
  typeof req.body?.language === 'string' && req.body.language.trim().length > 0
    ? req.body.language
    : fallback;

const getThreadValues = (req: Request): ForumThreadFormValues => ({
  pageSlug: typeof req.body?.pageSlug === 'string' ? req.body.pageSlug : '',
  title: typeof req.body?.title === 'string' ? req.body.title : '',
  body: typeof req.body?.body === 'string' ? req.body.body : '',
  language: getSelectedLanguage(req, resLocale(req)),
});

const getCommentValues = (req: Request, initialBody = ''): ForumComposeBaseValues => ({
  body: typeof req.body?.body === 'string' ? req.body.body : initialBody,
  language: getSelectedLanguage(req, resLocale(req)),
});

const resLocale = (req: Request) => (req.language ?? 'en') as string;

const canContributeToForum = (res: Response) =>
  Boolean(
    (res.locals.accountState as { isEmailVerified?: boolean } | null | undefined)?.isEmailVerified
  );

const renderForumComposeGate = (req: Request, res: Response) => {
  if (!res.locals.signedIn) {
    return `<p class="forum-empty">${req.t('forum.signInToPost')}</p>`;
  }
  if (!canContributeToForum(res)) {
    return `<p class="forum-empty">${req.t('forum.verifyEmailToPost')}</p>`;
  }
  return '';
};

const requireForumSession = async (req: Request, res: Response) => {
  const userId = requireSignedInUserId((await resolveSessionUser(req))?.userId);
  if (!canContributeToForum(res)) {
    throw new ForbiddenError(req.t('forum.verifyEmailToPost'));
  }
  return userId;
};

const getPageLabel = (
  locale: string,
  title: Record<string, string> | null | undefined,
  fallback: string
) => resolveSafeTextWithFallback(mlString.resolve, locale, title, fallback);

const getPageSlugFromRequest = (req: Request) =>
  typeof req.body?.pageSlug === 'string' ? req.body.pageSlug : '';

const renderCategoryPage = async (
  req: Request,
  res: Response,
  category: ForumCategorySlug,
  options: {
    threadPreviewHtml?: string;
    threadErrorMessage?: string;
  } = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const threads = await listForumThreads(dalInstance, category);
  const bodyHtml = `<div class="forum-page">
    ${renderForumBreadcrumbs(
      [
        { label: req.t('forum.title'), href: forumIndexPath() },
        { label: req.t(FORUM_CATEGORY_KEYS[category]) },
      ],
      req.t
    )}
    ${renderThreadList(threads, resLocale(req), req.t, {
      showPageSlug: category === 'articles' || category === 'policy',
      pageCategory: category === 'articles' || category === 'policy' ? category : undefined,
    })}
    ${
      res.locals.signedIn && canContributeToForum(res)
        ? renderThreadForm({
            t: req.t,
            languageOptions: res.locals.languageOptions,
            values: getThreadValues(req),
            previewHtml: options.threadPreviewHtml,
            errorMessage: options.threadErrorMessage,
            pageMode:
              category === 'articles' || category === 'policy'
                ? { mode: 'generic', category }
                : undefined,
          })
        : renderForumComposeGate(req, res)
    }
  </div>`;

  withForumPage(
    res,
    req.t(FORUM_CATEGORY_KEYS[category]),
    bodyHtml,
    `<div class="page-label">${req.t('label.forum')}</div>`
  );
};

const renderPageLinkedCategoryPage = async (
  req: Request,
  res: Response,
  category: 'articles' | 'policy',
  requestedSlug: string,
  options: {
    threadPreviewHtml?: string;
    threadErrorMessage?: string;
  } = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const normalizedRequestedSlug = normalizeSlugInput(requestedSlug, 'pageSlug');
  const target = await resolveForumPageTarget(normalizedRequestedSlug);
  const storedSlug = target?.canonicalSlug ?? normalizedRequestedSlug;
  const pageLabel = getPageLabel(
    resLocale(req),
    target?.title ?? null,
    storedSlug
  );
  const pageTitle = getThreadTitlePlainText(
    resLocale(req),
    target?.title ?? null,
    storedSlug
  );
  const threads = await listForumThreads(dalInstance, category, {
    pageSlug: storedSlug,
  });
  const composeHtml = !res.locals.signedIn || !canContributeToForum(res)
    ? renderForumComposeGate(req, res)
    : target
      ? renderThreadForm({
          t: req.t,
          languageOptions: res.locals.languageOptions,
          values: {
            ...getThreadValues(req),
            pageSlug: storedSlug,
          },
          previewHtml: options.threadPreviewHtml,
          errorMessage: options.threadErrorMessage,
          pageMode: {
            mode: 'scoped',
            category,
            pageSlug: storedSlug,
            pageLabel,
            pageHref: `/${storedSlug}`,
          },
        })
      : category === 'articles'
        ? `<p class="forum-empty">${req.t('forum.pageLink.cannotCreateMissingPageRequired')}</p>`
        : `<p class="forum-empty">${req.t('forum.pageLink.cannotCreateMissingPageOptional')}</p>`;
  const bodyHtml = `<div class="forum-page">
    ${renderForumBreadcrumbs(
      [
        { label: req.t('forum.title'), href: forumIndexPath() },
        {
          label: req.t(FORUM_CATEGORY_KEYS[category]),
          href: forumCategoryPath(category),
        },
        { label: pageLabel },
      ],
      req.t
    )}
    <p class="forum-page-context">${
      target
        ? req.t('forum.pageLink.context', {
            page: `<a href="/${encodeURIComponent(storedSlug)}">${renderText(pageLabel)}</a>`,
          })
        : req.t('forum.pageLink.orphanedContext', {
            slug: escapeHtml(storedSlug),
          })
    }</p>
    ${renderThreadList(threads, resLocale(req), req.t)}
    ${composeHtml}
  </div>`;

  withForumPage(
    res,
    pageTitle,
    bodyHtml,
    `<div class="page-label">${req.t('label.forum')}</div>`
  );
};

const renderThreadPage = async (
  req: Request,
  res: Response,
  threadId: string,
  options: {
    commentPreviewHtml?: string;
    commentErrorMessage?: string;
  } = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const session = await resolveSessionUser(req);
  const isModerator = session
    ? await userHasRole(dalInstance, session.userId, FORUM_MODERATOR_ROLE)
    : false;
  const detail = await readForumThread(dalInstance, threadId);
  const quoteId = typeof req.query.quote === 'string' ? req.query.quote : '';
  let quotedBody = '';
  if (!req.body?.body && quoteId) {
    try {
      const quotedComment = await readForumComment(quoteId);
      quotedBody = buildForumQuote(
        getCommentBodyForDisplay(quotedComment.body, quotedComment.originalLanguage)
      );
    } catch (_error) {
      quotedBody = '';
    }
  }

  const sources = detail.comments.map(comment =>
    getCommentBodyForDisplay(comment.body, comment.originalLanguage)
  );
  const previewSource =
    typeof req.body?.body === 'string' ? req.body.body : quotedBody;
  if (previewSource) sources.push(previewSource);
  const previewHtml = options.commentPreviewHtml;
  const threadTitle = getThreadTitlePlainText(
    resLocale(req),
    detail.thread.title,
    detail.thread.id
  );
  const pageTarget = detail.thread.pageSlug
    ? await resolveForumPageTarget(detail.thread.pageSlug)
    : null;
  const pageLabel =
    detail.thread.pageSlug
      ? getPageLabel(
          resLocale(req),
          pageTarget?.title ?? null,
          detail.thread.pageSlug
        )
      : null;
  const userIds = detail.comments
    .map(comment => comment.revUser)
    .filter((value): value is string => Boolean(value));
  const userMap = await fetchUserMap(dalInstance, userIds);
  const citationEntries = await loadCitationEntriesForSources(dalInstance, sources);
  const commentsHtml = (
    await Promise.all(
      detail.comments.map(async comment => {
        const bodySource = getCommentBodyForDisplay(comment.body, comment.originalLanguage);
        const bodyHtml = (
          await renderMarkdown(bodySource, citationEntries, {
            backToCitationLabel: req.t('citation.backToCitationAria'),
          })
        ).html;
        const quoteUrl = `${forumThreadPath(threadId)}?quote=${encodeURIComponent(comment.id)}#reply-form`;
        const moderatorControls = isModerator
          ? `<form method="post" action="${forumCommentDeletePath(comment.id)}" class="forum-inline-form">
  <button type="submit">${req.t('forum.comment.delete')}</button>
</form>`
          : '';
        const authorName = comment.revUser ? userMap.get(comment.revUser) ?? null : null;
        const operatorLabel = authorName ?? req.t('forum.comment.unknownOperator');
        const authorHtml = `<span>${req.t('history.operator', {
          name: escapeHtml(operatorLabel),
        })}</span>`;
        return `<article class="forum-comment-card" id="comment-${encodeURIComponent(comment.id)}">
  <div class="forum-comment-meta">
    ${authorHtml}
    <span>${req.t('forum.comment.postedAt', { date: escapeHtml(formatDateUTC(comment.createdAt)) })}</span>
    <span>${req.t('forum.comment.languageLabel', {
      language: escapeHtml(comment.originalLanguage ?? 'en'),
    })}</span>
  </div>
  <div class="forum-comment-body">${bodyHtml}</div>
  <div class="forum-comment-actions">
    <a href="${quoteUrl}" class="forum-quote-link--fallback">${req.t('forum.comment.quote')}</a>
    <button
      type="button"
      class="forum-quote-button"
      data-forum-quote-button
      data-forum-quote-target="forum-comment-body"
      data-forum-quote-markdown="${escapeHtml(buildForumQuote(bodySource))}"
    >${req.t('forum.comment.quote')}</button>
    ${moderatorControls}
  </div>
</article>`;
      })
    )
  ).join('');

  const moderatorThreadControls = isModerator
    ? `<div class="forum-thread-controls">
  <form method="post" action="${forumThreadPinPath(threadId)}" class="forum-inline-form">
    <input type="hidden" name="pinned" value="${detail.thread.pinned ? 'false' : 'true'}" />
    <button type="submit">${req.t(
      detail.thread.pinned ? 'forum.thread.unpin' : 'forum.thread.pin'
    )}</button>
  </form>
  <form method="post" action="${forumThreadDeletePath(threadId)}" class="forum-inline-form">
    <button type="submit">${req.t('forum.thread.delete')}</button>
  </form>
</div>`
    : '';

  const bodyHtml = `<div class="forum-page">
    ${renderForumBreadcrumbs(
      [
        { label: req.t('forum.title'), href: forumIndexPath() },
        {
          label: req.t(FORUM_CATEGORY_KEYS[detail.thread.category]),
          href: forumCategoryPath(detail.thread.category),
        },
        ...((detail.thread.category === 'articles' || detail.thread.category === 'policy') &&
        detail.thread.pageSlug
          ? [
              {
                label: pageLabel ?? detail.thread.pageSlug,
                href: forumCategoryPagePath(detail.thread.category, detail.thread.pageSlug),
              },
            ]
          : []),
        { label: threadTitle },
      ].filter(Boolean) as Array<{ label: SafeText | string; href?: string }>,
      req.t
    )}
    <div class="forum-thread-header">
      <div class="forum-thread-meta">
        <span>${req.t(FORUM_CATEGORY_KEYS[detail.thread.category])}</span>
        ${
          (detail.thread.category === 'articles' || detail.thread.category === 'policy') &&
          detail.thread.pageSlug
            ? `<span>${req.t('forum.thread.pageLabel', {
                page: `<a href="${forumCategoryPagePath(detail.thread.category, detail.thread.pageSlug)}">${renderText(
                  pageLabel ?? detail.thread.pageSlug
                )}</a>`,
              })}</span>`
            : ''
        }
        <span>${req.t('forum.thread.createdAt', {
          date: escapeHtml(formatDateUTC(detail.thread.createdAt)),
        })}</span>
        <span>${req.t('forum.thread.commentCount', { count: detail.comments.length })}</span>
      </div>
      ${detail.thread.pinned ? `<div class="forum-pin-badge">${req.t('forum.thread.pinned')}</div>` : ''}
      ${moderatorThreadControls}
    </div>
    <section class="forum-comments">${commentsHtml}</section>
    ${
      res.locals.signedIn && canContributeToForum(res)
        ? renderCommentForm({
            t: req.t,
            threadId,
            languageOptions: res.locals.languageOptions,
            values: getCommentValues(req, quotedBody),
            previewHtml,
            errorMessage: options.commentErrorMessage,
          })
        : renderForumComposeGate(req, res)
    }
  </div>`;

  withForumPage(
    res,
    threadTitle,
    bodyHtml,
    `<div class="page-label">${req.t('label.forum')}</div>`
  );
};

const registerPageLinkedForumRoutes = (
  app: Express,
  category: 'articles' | 'policy'
) => {
  app.get(`/tool/forum/${category}/page/:slug`, async (req, res) => {
    try {
      await renderPageLinkedCategoryPage(req, res, category, req.params.slug);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error(`Failed to render page-linked ${category} forum category:`, error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(`/tool/forum/${category}/page/:slug`, async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'post';
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      const body = typeof req.body?.body === 'string' ? req.body.body : '';
      const language = getSelectedLanguage(req, resLocale(req));
      const pageSlug = req.params.slug;

      if (intent === 'preview') {
        const dalInstance = await initializePostgreSQL();
        const threadPreviewHtml = await renderMarkdownPreviewHtml(
          dalInstance,
          body,
          req.t('citation.backToCitationAria')
        );
        await renderPageLinkedCategoryPage(req, res, category, pageSlug, {
          threadPreviewHtml,
        });
        return;
      }

      const thread = await createForumThread(
        { category, pageSlug, title, body, language },
        userId
      );
      res.redirect(303, forumThreadPath(thread.id));
    } catch (error) {
      if (error instanceof ValidationError) {
        await renderPageLinkedCategoryPage(req, res, category, req.params.slug, {
          threadErrorMessage: resolveForumValidationMessage(req.t, error, { category }),
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        if (res.locals.signedIn) {
          await renderPageLinkedCategoryPage(req, res, category, req.params.slug, {
            threadErrorMessage: error.message,
          });
          return;
        }
        res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error(`Failed to create page-linked ${category} forum thread:`, error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });
};

export const registerForumRoutes = (app: Express) => {
  app.post('/tool/forum/dismiss-preamble', (req, res) => {
    dismissBanner({
      res,
      cookieName: FORUM_PREAMBLE_COOKIE,
      redirectTo: req.get('Referer') ?? forumIndexPath(),
    });
  });

  app.post(
    '/api/render-markdown',
    createPreviewHandler(
      body => {
        const payload = body as { source?: unknown; body?: unknown } | null | undefined;
        return {
          source:
            typeof payload?.source === 'string'
              ? payload.source
              : typeof payload?.body === 'string'
                ? payload.body
                : '',
        };
      },
      async ({ source }, req) => {
        const dalInstance = await initializePostgreSQL();
        return source.trim()
          ? renderMarkdownPreviewHtml(
              dalInstance,
              source,
              req.t('citation.backToCitationAria')
            )
          : '';
      }
    )
  );

  app.get('/tool/forum', async (req, res) => {
    try {
      const dalInstance = await initializePostgreSQL();
      const categories = await listForumCategories(dalInstance);
      const bodyHtml = `<div class="forum-page">
  <p>${renderForumIndexDescription(req)}</p>
  ${renderCategoryCards(categories, resLocale(req), req.t)}
</div>`;
      withForumPage(
        res,
        req.t('forum.title'),
        bodyHtml,
        `<div class="page-label">${req.t('label.forum')}</div>`
      );
    } catch (error) {
      console.error('Failed to render forum index:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.get('/tool/forum/thread/:threadId', async (req, res) => {
    try {
      await renderThreadPage(req, res, req.params.threadId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to render forum thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  registerPageLinkedForumRoutes(app, 'articles');
  registerPageLinkedForumRoutes(app, 'policy');

  app.post('/tool/forum/thread/:threadId/comment', async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'post';
      const threadId = req.params.threadId;
      const language = getSelectedLanguage(req, resLocale(req));
      const body = typeof req.body?.body === 'string' ? req.body.body : '';

      if (intent === 'preview') {
        const dalInstance = await initializePostgreSQL();
        const commentPreviewHtml = await renderMarkdownPreviewHtml(
          dalInstance,
          body,
          req.t('citation.backToCitationAria')
        );
        await renderThreadPage(req, res, threadId, { commentPreviewHtml });
        return;
      }

      await createForumComment({ threadId, body, language }, userId);
      res.redirect(303, `${forumThreadPath(threadId)}#reply-form`);
    } catch (error) {
      if (error instanceof ValidationError) {
        await renderThreadPage(req, res, req.params.threadId, {
          commentErrorMessage: error.message,
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        if (res.locals.signedIn) {
          await renderThreadPage(req, res, req.params.threadId, {
            commentErrorMessage: error.message,
          });
          return;
        }
        res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to create forum comment:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post('/tool/forum/thread/:threadId/pin', async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      const pinned = req.body?.pinned === 'true';
      await setForumThreadPinned(
        await initializePostgreSQL(),
        {
          threadId: req.params.threadId,
          pinned,
          revSummary: {
            en: pinned ? 'Pin forum thread.' : 'Unpin forum thread.',
          },
        },
        userId
      );
      res.redirect(303, forumThreadPath(req.params.threadId));
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('page.accessDenied'));
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to pin forum thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post('/tool/forum/thread/:threadId/delete', async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      await deleteForumThread(
        await initializePostgreSQL(),
        {
          threadId: req.params.threadId,
          revSummary: { en: 'Delete forum thread.' },
        },
        userId
      );
      res.redirect(303, forumIndexPath());
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('page.accessDenied'));
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to delete forum thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post('/tool/forum/comment/:commentId/delete', async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      const dalInstance = await initializePostgreSQL();
      const comment = await readForumComment(req.params.commentId);
      await deleteForumComment(
        dalInstance,
        {
          commentId: req.params.commentId,
          revSummary: { en: 'Delete forum comment.' },
        },
        userId
      );
      res.redirect(303, forumThreadPath(comment.threadId));
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('page.accessDenied'));
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to delete forum comment:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.get('/tool/forum/:category', async (req, res) => {
    try {
      const category = ensureForumCategory(req.params.category) as ForumCategorySlug;
      await renderCategoryPage(req, res, category);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to render forum category:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post('/tool/forum/:category', async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      const category = ensureForumCategory(req.params.category) as ForumCategorySlug;
      const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'post';
      const pageSlug = getPageSlugFromRequest(req);
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      const body = typeof req.body?.body === 'string' ? req.body.body : '';
      const language = getSelectedLanguage(req, resLocale(req));

      if (intent === 'preview') {
        const dalInstance = await initializePostgreSQL();
        const threadPreviewHtml = await renderMarkdownPreviewHtml(
          dalInstance,
          body,
          req.t('citation.backToCitationAria')
        );
        await renderCategoryPage(req, res, category, { threadPreviewHtml });
        return;
      }

      const thread = await createForumThread(
        { category, pageSlug, title, body, language },
        userId
      );
      res.redirect(303, forumThreadPath(thread.id));
    } catch (error) {
      if (error instanceof ValidationError) {
        const category = ensureForumCategory(req.params.category) as ForumCategorySlug;
        await renderCategoryPage(req, res, category, {
          threadErrorMessage: resolveForumValidationMessage(req.t, error, { category }),
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        if (res.locals.signedIn) {
          const category = ensureForumCategory(req.params.category) as ForumCategorySlug;
          await renderCategoryPage(req, res, category, {
            threadErrorMessage: error.message,
          });
          return;
        }
        res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to create forum thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });
};
