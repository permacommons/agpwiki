import { decodeHTML } from 'entities';
import type { Express, Request, Response } from 'express';
import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { diffLocalizedField } from '../lib/diff-engine.js';
import {
  ForbiddenError,
  isRevisionConflictError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import {
  forumCategoryPagePath,
  forumCategoryPath,
  forumCommentAnchor,
  forumCommentDeletePath,
  forumCommentHistoryPath,
  forumDismissPreamblePath,
  forumIndexPath,
  forumPageCategory,
  forumThreadCommentPath,
  forumThreadDeletePath,
  forumThreadPath,
  forumThreadPinPath,
} from '../lib/forum-paths.js';
import { readNotificationChannel } from '../lib/notification-preferences.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import PageSignoff from '../models/page-signoff.js';
import User from '../models/user.js';
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
  type ForumCommentResult,
  findForumCommentAuthorId,
  listForumCategories,
  listForumCommentVersions,
  listForumThreads,
  readForumComment,
  readForumThread,
  requireSignedInUserId,
  resolveForumPageTarget,
  setForumThreadPinned,
  updateForumComment,
} from '../services/forum-service.js';
import {
  isUserSubscribedToForumThread,
  subscribeUserToForumThread,
  unsubscribeUserFromForumThread,
} from '../services/forum-subscription-service.js';
import { FORUM_MODERATOR_ROLE, userHasRole } from '../services/roles.js';
import { normalizeSlugInput } from '../services/validation.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { getDiffLabels, renderEntityDiff } from './lib/diff.js';
import { dismissBanner, renderDismissableBanner } from './lib/dismissable-banner.js';
import { renderFollowControl } from './lib/follow-control.js';
import { renderFormLanguageSelector } from './lib/form-language-selector.js';
import { renderForumCommentEditLink, renderForumCommentEditor } from './lib/forum-comment-editor.js';
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
        ${renderFormLanguageSelector({
          languageOptions,
          selected: language,
          name: 'language',
          idPrefix: `${formId}-language`,
          label: t('forum.compose.language'),
          prefixLabel: t('language.selector'),
        })}
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

const commentReturnPath = (value: unknown, comment: ForumCommentResult) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') &&
  !/[\\\r\n\t]/.test(value)
    ? value
    : `${forumThreadPath(comment.threadId)}#comment-${comment.id}`;

const renderCommentEditPage = (
  req: Request,
  res: Response,
  comment: ForumCommentResult,
  options: { body?: string; language?: string; errorMessage?: string } = {}
) => {
  const returnPath = commentReturnPath(req.body?.return ?? req.query.return, comment);
  const editor = renderForumCommentEditor({
    commentId: comment.id,
    body: options.body ?? getCommentBodyForDisplay(comment.body, comment.originalLanguage),
    language: options.language ?? comment.originalLanguage ?? 'en',
    languageOptions: res.locals.languageOptions,
    returnPath,
    t: req.t,
  });
  withForumPage(
    res,
    req.t('forum.comment.edit'),
    `<div class="forum-page"><h1>${escapeHtml(req.t('forum.comment.edit'))}</h1>${options.errorMessage ? `<p class="form-error" role="alert">${escapeHtml(options.errorMessage)}</p>` : ''}${editor}</div>`,
    `<div class="page-label">${req.t('label.forum')}</div>`
  );
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
  if (target && forumPageCategory(storedSlug) !== category) {
    const targetCategory = forumPageCategory(storedSlug);
    if (!targetCategory) throw new NotFoundError('Page discussion not available.');
    res.redirect(303, forumCategoryPagePath(targetCategory, storedSlug));
    return;
  }
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
  const detail = await readForumThread(dalInstance, threadId);
  const session = await resolveSessionUser(req);
  const currentUser = session ? await User.filterWhere({ id: session.userId }).first() : null;
  const isModerator = session
    ? await userHasRole(dalInstance, session.userId, FORUM_MODERATOR_ROLE)
    : false;
  const isSubscribed = session
    ? await isUserSubscribedToForumThread(threadId, session.userId)
    : false;
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
        // Only authors edit their posts, so the latest version's user is the author.
        const isOwn = Boolean(session && comment.revUser === session.userId);
        const editedHtml = comment.edited
          ? `<span><a href="${forumCommentHistoryPath(comment.id)}">${escapeHtml(req.t('forum.comment.edited'))}</a></span>`
          : '';
        const returnPath = `${forumThreadPath(threadId)}#comment-${comment.id}`;
        const editHtml = isOwn
          ? renderForumCommentEditor({
              commentId: comment.id, body: bodySource, language: comment.originalLanguage ?? 'en',
              languageOptions: res.locals.languageOptions, returnPath, t: req.t, hidden: true,
            })
          : '';
        const authorName = comment.revUser ? userMap.get(comment.revUser) ?? null : null;
        const operatorLabel = authorName ?? req.t('forum.comment.unknownOperator');
        const authorHtml = `<span>${req.t('history.operator', {
          name: escapeHtml(operatorLabel),
        })}</span>`;
        return `<article class="forum-comment-card" id="comment-${encodeURIComponent(comment.id)}" data-comment-edit>
  <div class="forum-comment-meta">
    ${authorHtml}
    <span>${req.t('forum.comment.postedAt', { date: escapeHtml(formatDateUTC(comment.createdAt)) })}</span>
    <span>${req.t('forum.comment.languageLabel', {
      language: escapeHtml(comment.originalLanguage ?? 'en'),
    })}</span>
    ${editedHtml}
  </div>
  <div class="forum-comment-body" data-comment-content>${bodyHtml}</div>
  <div class="forum-comment-actions" data-comment-actions>
    ${isOwn ? renderForumCommentEditLink(comment.id, returnPath, req.t) : ''}
    <a href="${quoteUrl}" class="forum-quote-link--fallback no-js-only">${req.t('forum.comment.quote')}</a>
    <button
      type="button"
      class="forum-quote-button requires-js"
      data-forum-quote-button
      data-forum-quote-target="forum-comment-body"
      data-forum-quote-markdown="${escapeHtml(buildForumQuote(bodySource))}"
    >${req.t('forum.comment.quote')}</button>
    ${moderatorControls}
  </div>
  ${editHtml}
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
  const subscriptionControls = session
    ? `<div class="forum-thread-controls">${renderFollowControl({
        action: `${forumThreadPath(threadId)}/subscription`,
        following: isSubscribed,
        fields: { subscribed: isSubscribed ? 'false' : 'true' },
        t: req.t,
      })}</div>`
    : '';
  const subscriptionHelp =
    session && readNotificationChannel(currentUser?.notificationPreferences, 'forum.reply') === 'none'
      ? `<p class="form-help">${req.t('forum.thread.notificationsDisabled', {
          settingsHref: '/tool/settings',
        })}</p>`
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
      ${subscriptionControls}
      ${moderatorThreadControls}
    </div>
    ${subscriptionHelp}
    ${await renderAttachedPositionContext(req, dalInstance, detail.thread, pageLabel)}
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

/** For a thread of replies to a position: the position, quoted, with a link back. */
const renderAttachedPositionContext = async (
  req: Request,
  dalInstance: Awaited<ReturnType<typeof initializePostgreSQL>>,
  thread: { attachedType: string | null; attachedId: string | null; pageSlug?: string | null },
  pageLabel: SafeText | string | null
) => {
  if (thread.attachedType !== 'position' || !thread.attachedId || !thread.pageSlug) return '';
  const signoff = await PageSignoff.filterWhere({ id: thread.attachedId }).first();
  if (!signoff) return '';
  const names = await fetchUserMap(dalInstance, [signoff.userId]);
  const proposalLink = `<a href="/${escapeHtml(thread.pageSlug)}#page-signoffs-title">${renderText(
    pageLabel ?? thread.pageSlug
  )}</a>`;
  return `<aside class="forum-position-context">
  <div class="forum-position-context-label">${req.t('forum.position.context', { proposal: proposalLink })}</div>
  <div><span class="page-signoff-stance page-signoff-stance--${escapeHtml(signoff.stance)}">${escapeHtml(
    req.t(`signoff.stance.${signoff.stance}`)
  )}</span> <strong>${escapeHtml(names.get(signoff.userId) ?? req.t('signoff.unknownUser'))}</strong> · ${escapeHtml(
    formatDateUTC(signoff.signedAt)
  )}</div>
  ${signoff.comment ? `<blockquote dir="auto"${signoff.commentLanguage ? ` lang="${escapeHtml(signoff.commentLanguage)}"` : ''}>${escapeHtml(signoff.comment)}</blockquote>` : ''}
  ${signoff.withdrawnAt ? `<p class="forum-position-context-note">${escapeHtml(req.t('forum.position.withdrawn'))}</p>` : ''}
</aside>`;
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

  app.post('/tool/forum/thread/:threadId/subscription', async (req, res) => {
    try {
      const session = await resolveSessionUser(req);
      if (!session) {
        res.redirect(
          303,
          `/tool/login?redirect=${encodeURIComponent(forumThreadPath(req.params.threadId))}`
        );
        return;
      }
      await readForumThread(await initializePostgreSQL(), req.params.threadId);

      if (req.body?.subscribed === 'true') {
        await subscribeUserToForumThread(req.params.threadId, session.userId);
      } else {
        await unsubscribeUserFromForumThread(req.params.threadId, session.userId);
      }

      res.redirect(303, forumThreadPath(req.params.threadId));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to update forum thread subscription:', error);
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
      if (isRevisionConflictError(error)) {
        res.status(409).type('text').send(req.t('forum.editConflict'));
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
      if (isRevisionConflictError(error)) {
        res.status(409).type('text').send(req.t('forum.editConflict'));
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
      if (isRevisionConflictError(error)) {
        res.status(409).type('text').send(req.t('forum.editConflict'));
        return;
      }
      console.error('Failed to delete forum comment:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.get('/tool/forum/comment/:commentId/edit', async (req, res) => {
    try {
      const userId = await requireForumSession(req, res);
      const dalInstance = await initializePostgreSQL();
      const comment = await readForumComment(req.params.commentId);
      if ((await findForumCommentAuthorId(dalInstance, comment.id)) !== userId) {
        throw new ForbiddenError('Only the author can edit a post.');
      }
      renderCommentEditPage(req, res, comment);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('forum.comment.forbiddenEdit'));
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to show comment editor:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post('/tool/forum/comment/:commentId/edit', async (req, res) => {
    let originalComment: ForumCommentResult | undefined;
    try {
      const userId = await requireForumSession(req, res);
      const dalInstance = await initializePostgreSQL();
      originalComment = await readForumComment(req.params.commentId);
      if ((await findForumCommentAuthorId(dalInstance, originalComment.id)) !== userId) {
        throw new ForbiddenError('Only the author can edit a post.');
      }
      const comment = await updateForumComment(
        dalInstance,
        {
          commentId: req.params.commentId,
          body: typeof req.body?.body === 'string' ? req.body.body : '',
          language: getSelectedLanguage(req, resLocale(req)),
        },
        userId
      );
      res.redirect(303, commentReturnPath(req.body?.return, comment));
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(403).type('text').send(req.t('forum.comment.forbiddenEdit'));
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      if (originalComment && (error instanceof ValidationError || isRevisionConflictError(error))) {
        res.status(error instanceof ValidationError ? 400 : 409);
        renderCommentEditPage(req, res, originalComment, {
          body: typeof req.body?.body === 'string' ? req.body.body : '',
          language: getSelectedLanguage(req, resLocale(req)),
          errorMessage: req.t(error instanceof ValidationError ? 'operatorEdit.validation.generic' : 'forum.editConflict'),
        });
        return;
      }
      console.error('Failed to edit forum comment:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  // Every version of a post, newest first, each compared with the one before.
  app.get('/tool/forum/comment/:commentId/history', async (req, res) => {
    try {
      const dalInstance = await initializePostgreSQL();
      const comment = await readForumComment(req.params.commentId);
      const versions = await listForumCommentVersions(dalInstance, comment.id);
      const names = await fetchUserMap(
        dalInstance,
        versions.map(version => version.revUser).filter((id): id is string => Boolean(id))
      );
      const labels = getDiffLabels(req.t);
      const items = versions
        .map((version, index) => {
          const who = escapeHtml((version.revUser && names.get(version.revUser)) || req.t('forum.comment.unknownOperator'));
          const when = escapeHtml(formatDateUTC(version.revDate));
          const heading = req.t(index === 0 ? 'forum.comment.historyFirst' : 'forum.comment.historyEdit', {
            name: who,
            date: when,
          });
          const previous = versions[index - 1];
          const diff = previous ? diffLocalizedField('body', previous.body, version.body) : null;
          const bodyText = getCommentBodyForDisplay(version.body, version.originalLanguage);
          return `<li class="forum-comment-version">
  <h2>${heading}</h2>
  ${
    diff
      ? renderEntityDiff({
          fromLabel: req.t('forum.comment.historyBefore'),
          toLabel: req.t('forum.comment.historyAfter'),
          fields: [{ key: 'body', label: req.t('forum.comment.historyText'), diff }],
          labels,
        })
      : `<pre class="forum-comment-version-text" dir="auto">${escapeHtml(bodyText)}</pre>`
  }
</li>`;
        })
        .reverse()
        .join('');
      const bodyHtml = `<div class="forum-page">
  <p><a href="${forumThreadPath(comment.threadId)}#comment-${encodeURIComponent(comment.id)}">${escapeHtml(
    req.t('forum.comment.historyBack')
  )}</a></p>
  <ol class="forum-comment-versions">${items}</ol>
</div>`;
      withForumPage(res, req.t('forum.comment.historyTitle'), bodyHtml, `<div class="page-label">${req.t('label.forum')}</div>`);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to render forum comment history:', error);
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
