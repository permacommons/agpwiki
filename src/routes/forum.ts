
import type { Express, Request, Response } from 'express';
import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { diffLocalizedField } from '../lib/diff-engine.js';
import {
  commentLinkPath,
  type DiscussionTarget,
  discussionPagePath,
  discussionPath,
  discussionTargetOfThread,
  movedThreadPath,
  threadLinkPath,
} from '../lib/discussion-paths.js';
import {
  ForbiddenError,
  isRevisionConflictError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import {
  forumCategoryPath,
  forumCommentAnchor,
  forumDismissPreamblePath,
  forumIndexPath,
  forumThreadPath,
} from '../lib/forum-paths.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import { normalizeLineEndings } from '../lib/text-normalization.js';
import {
  escapeHtml,
  formatDateUTC,
  prepareTitle,
  renderText,
  type SafeText,
} from '../render.js';
import { listDiscussedPages, readDiscussion } from '../services/discussion-service.js';
import {
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
  readForumComment,
  readForumThread,
  requireSignedInUserId,
  setForumThreadPinned,
  updateForumComment,
} from '../services/forum-service.js';
import {
  subscribeUserToForumThread,
  unsubscribeUserFromForumThread,
} from '../services/forum-subscription-service.js';
import { normalizeSlugInput } from '../services/validation.js';
import { buildDiscussionContext, renderPageDiscussionForThread, renderPostDiscussionForThread } from './discussion.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { canonicalUrlFor } from './lib/canonical.js';
import { getDiffLabels, renderEntityDiff } from './lib/diff.js';
import {
  type OpenReplyForm,
  renderDiscussionPager,
  renderDiscussionSummary,
  renderDiscussionThreads,
  renderPostingGate,
  renderReplyTemplate,
  renderStartThreadForm,
} from './lib/discussion.js';
import { dismissBanner, renderDismissableBanner } from './lib/dismissable-banner.js';
import { renderForumCommentEditor } from './lib/forum-comment-editor.js';
import { fetchUserMap } from './lib/history.js';
import {
  createPreviewHandler,
  renderMarkdownPreviewHtml,
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
          ? `<a class="forum-latest-link" href="${escapeHtml(
              commentLinkPath(item.latestPost, item.latestPost.commentId)
            )}">${renderText(
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

const getCommentBodyForDisplay = (
  body: Record<string, string> | null | undefined,
  canonicalLanguage: string | null | undefined
) => {
  const source = mlString.resolve(canonicalLanguage ?? 'en', body ?? null);
  return source?.str ?? '';
};

const getThreadTitleRenderValue = (
  locale: string,
  title: Record<string, string> | null | undefined,
  fallback = ''
) => resolveSafeTextWithFallback(mlString.resolve, locale, title, fallback);

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

const resLocale = (req: Request) => (req.language ?? 'en') as string;

const canContributeToForum = (res: Response) =>
  Boolean(
    (res.locals.accountState as { isEmailVerified?: boolean } | null | undefined)?.isEmailVerified
  );

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
    : `${forumThreadPath(comment.threadId)}#${forumCommentAnchor(comment.id)}`;

const renderCommentEditPage = (
  req: Request,
  res: Response,
  comment: ForumCommentResult,
  options: { body?: string; language?: string; errorMessage?: string } = {}
) => {
  const returnPath = commentReturnPath(req.body?.return ?? req.query.return, comment);
  const editor = renderForumCommentEditor({
    commentId: comment.id,
    body: options.body ?? getCommentBodyForDisplay(comment.body, comment.canonicalLanguage),
    language: options.language ?? comment.canonicalLanguage ?? 'en',
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

const readPage = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const SECTIONS_WITH_PAGES = new Set(['articles', 'policy', 'blog']);

/** The pages of a section whose discussions are active, newest activity first. */
const renderDiscussedPages = async (
  req: Request,
  dalInstance: Awaited<ReturnType<typeof initializePostgreSQL>>,
  category: ForumCategorySlug
) => {
  const list = await listDiscussedPages(dalInstance, category, { page: readPage(req.query.list) });
  const locale = resLocale(req);
  const items = list.pages
    .map(item => {
      const title = getThreadTitleRenderValue(locale, item.title, item.slug);
      const meta = [
        req.t('discussion.threadCount', { count: item.threadCount }),
        req.t('forum.thread.commentCount', { count: item.commentCount }),
        req.t('discussion.lastActivity', {
          date: item.latestActivityAt
            ? item.latestActivityAt.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
            : '',
        }),
      ];
      const target: DiscussionTarget =
        category === 'blog' ? { kind: 'post', slug: item.slug } : { kind: 'page', slug: item.slug };
      return `<li class="discussion-page-item"><a href="${escapeHtml(discussionPath(target))}">${renderText(
        title
      )}</a> <span class="discussion-thread-meta">${meta.map(part => escapeHtml(part)).join(' · ')}</span></li>`;
    })
    .join('');
  const listPath = (page: number) => `${forumCategoryPath(category)}${page > 1 ? `?list=${page}` : ''}`;
  const pager =
    list.pageCount > 1
      ? `<nav class="discussion-pager" aria-label="${escapeHtml(req.t('discussion.pages'))}">${
          list.page > 1 ? `<a href="${escapeHtml(listPath(list.page - 1))}">${escapeHtml(req.t('discussion.previousPage'))}</a>` : ''
        }<span>${escapeHtml(req.t('discussion.pageOf', { page: list.page, count: list.pageCount }))}</span>${
          list.page < list.pageCount ? `<a href="${escapeHtml(listPath(list.page + 1))}">${escapeHtml(req.t('discussion.nextPage'))}</a>` : ''
        }</nav>`
      : '';
  return `<section class="discussion-pages" aria-labelledby="discussion-pages-title">
  <h2 id="discussion-pages-title">${escapeHtml(req.t('discussion.discussedPages'))}</h2>
  ${items ? `<ol class="discussion-page-list">${items}</ol>` : `<p class="discussion-empty">${escapeHtml(req.t('discussion.noDiscussedPages'))}</p>`}
  ${pager}
</section>`;
};

interface SectionPageState {
  threadErrorMessage?: string;
  threadPreviewHtml?: string;
  openReply?: OpenReplyForm;
  threadId?: string;
}

/**
 * A forum section. General and Technology are one discussion each; Articles
 * and Policy list the pages whose discussions are active, then the threads
 * that are not about one page.
 */
const renderSectionPage = async (
  req: Request,
  res: Response,
  category: ForumCategorySlug,
  state: SectionPageState = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const target: DiscussionTarget = { kind: 'section', category };
  const threadId = state.threadId ?? state.openReply?.threadId ?? (typeof req.query.thread === 'string' ? req.query.thread : undefined);
  const replyParentId = typeof req.query.reply === 'string' ? req.query.reply : '';
  const discussion = await readDiscussion(dalInstance, { category }, { page: readPage(req.query.page), threadId });
  const ctx = await buildDiscussionContext(dalInstance, req, res, target, discussion, {
    headingLevel: 2,
    openReply: state.openReply ?? (threadId && replyParentId ? { threadId, parentId: replyParentId } : undefined),
  });
  // Article and blog threads always belong to an article or a post, so they
  // start from it.
  const canStart = category !== 'articles' && category !== 'blog';
  const pagesHtml = SECTIONS_WITH_PAGES.has(category) && discussion.page === 1 ? await renderDiscussedPages(req, dalInstance, category) : '';
  const showThreads = discussion.threadCount > 0 || canStart;
  const startHtml = !canStart
    ? ''
    : ctx.viewer.canPost
      ? renderStartThreadForm({
          action: forumCategoryPath(category),
          t: req.t,
          languageOptions: res.locals.languageOptions,
          values: {
            title: typeof req.body?.title === 'string' ? req.body.title : '',
            body: typeof req.body?.body === 'string' ? req.body.body : '',
            language: getSelectedLanguage(req, resLocale(req)),
          },
          errorMessage: state.threadErrorMessage,
          previewHtml: state.threadPreviewHtml,
        })
      : renderPostingGate(req.t, { signedIn: Boolean(ctx.viewer.userId), canPost: ctx.viewer.canPost });
  const threadsHtml = showThreads
    ? `${SECTIONS_WITH_PAGES.has(category) ? `<h2 class="discussion-threads-heading">${escapeHtml(req.t('discussion.sectionThreads'))}</h2>` : ''}
  ${discussion.threadCount ? renderDiscussionSummary(discussion, req.t) : `<p class="discussion-empty">${escapeHtml(req.t('discussion.empty'))}</p>`}
  ${renderDiscussionThreads(discussion.threads, ctx)}
  ${renderDiscussionPager(target, discussion, req.t)}
  ${renderReplyTemplate(ctx)}
  ${startHtml}`
    : '';
  const bodyHtml = `<div class="forum-page discussion-page">
    ${renderForumBreadcrumbs(
      [{ label: req.t('forum.title'), href: forumIndexPath() }, { label: req.t(FORUM_CATEGORY_KEYS[category]) }],
      req.t
    )}
    ${pagesHtml}
    ${threadsHtml}
  </div>`;
  res.render('layout', {
    title: prepareTitle(req.t(FORUM_CATEGORY_KEYS[category])),
    canonicalUrl: canonicalUrlFor(discussionPagePath(target, discussion.page)),
    relPrev: discussion.page > 1 ? discussionPagePath(target, discussion.page - 1) : null,
    relNext: discussion.page < discussion.pageCount ? discussionPagePath(target, discussion.page + 1) : null,
    labelHtml: `<div class="page-label">${req.t('label.forum')}</div>`,
    topHtml: prependAccountBanner(res, renderForumPreamble(req)),
    bodyHtml,
  });
};

/**
 * Show the discussion holding a thread again, with the reply that could not
 * be saved still in its form.
 */
const renderReplyError = async (req: Request, res: Response, error: ValidationError | ForbiddenError) => {
  let detail: Awaited<ReturnType<typeof readForumThread>>;
  try {
    detail = await readForumThread(await initializePostgreSQL(), String(req.params.threadId));
  } catch {
    return false;
  }
  const { thread } = detail;
  const parentId = typeof req.body?.parentId === 'string' && req.body.parentId ? req.body.parentId : detail.comments[0]?.id;
  if (!parentId || thread.attachedType) return false;
  const openReply: OpenReplyForm = {
    threadId: thread.id,
    parentId,
    body: typeof req.body?.body === 'string' ? req.body.body : '',
    language: getSelectedLanguage(req, resLocale(req)),
    errorMessage: error instanceof ValidationError ? resolveForumValidationMessage(req.t, error) : error.message,
  };
  res.status(error instanceof ValidationError ? 400 : 403);
  const target = discussionTargetOfThread(thread);
  if (target.kind === 'page') {
    return renderPageDiscussionForThread(req, res, { id: thread.id, pageSlug: target.slug }, { openReply });
  }
  if (target.kind === 'post') {
    return renderPostDiscussionForThread(req, res, { id: thread.id, postSlug: target.slug }, { openReply });
  }
  await renderSectionPage(req, res, thread.category, { openReply });
  return true;
};

// A page's threads used to be listed here; they are now sections of the
// page's own discussion.
const registerPageLinkedForumRoutes = (app: Express, category: 'articles' | 'policy') => {
  const pageDiscussionPath = (slug: string) => discussionPath({ kind: 'page', slug: normalizeSlugInput(slug, 'pageSlug') });
  app.get(`/tool/forum/${category}/page/:slug`, (req, res) => {
    try {
      res.redirect(301, pageDiscussionPath(req.params.slug));
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      throw error;
    }
  });
  // 308 keeps the method and the form, so a form still open in a browser posts its thread.
  app.post(`/tool/forum/${category}/page/:slug`, (req, res) => {
    try {
      res.redirect(308, pageDiscussionPath(req.params.slug));
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      throw error;
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
      const { thread } = await readForumThread(await initializePostgreSQL(), req.params.threadId);
      res.redirect(301, movedThreadPath(thread));
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
      const threadId = req.params.threadId;
      const language = getSelectedLanguage(req, resLocale(req));
      const body = normalizeLineEndings(typeof req.body?.body === 'string' ? req.body.body : '');
      const parentId = typeof req.body?.parentId === 'string' && req.body.parentId ? req.body.parentId : null;
      const comment = await createForumComment({ threadId, parentId, body, language }, userId);
      const { thread } = await readForumThread(await initializePostgreSQL(), threadId);
      res.redirect(303, commentLinkPath(thread, comment.id));
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ForbiddenError) {
        if (!res.locals.signedIn) {
          res.redirect(303, `/tool/login?redirect=${encodeURIComponent(forumThreadPath(String(req.params.threadId)))}`);
          return;
        }
        if (await renderReplyError(req, res, error)) return;
        res.status(400).type('text').send(error.message);
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
      const { thread } = await readForumThread(await initializePostgreSQL(), req.params.threadId);

      if (req.body?.subscribed === 'true') {
        await subscribeUserToForumThread(req.params.threadId, session.userId);
      } else {
        await unsubscribeUserFromForumThread(req.params.threadId, session.userId);
      }

      res.redirect(303, threadLinkPath(thread));
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
      const thread = await setForumThreadPinned(
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
      res.redirect(303, threadLinkPath(thread));
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
      const dalInstance = await initializePostgreSQL();
      const { thread } = await readForumThread(dalInstance, req.params.threadId);
      await deleteForumThread(
        dalInstance,
        {
          threadId: req.params.threadId,
          revSummary: { en: 'Delete forum thread.' },
        },
        userId
      );
      const target = discussionTargetOfThread(thread);
      res.redirect(303, target.kind === 'section' ? forumIndexPath() : discussionPath(target));
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
      const { thread } = await readForumThread(dalInstance, comment.threadId);
      res.redirect(303, threadLinkPath(thread));
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
          const bodyText = getCommentBodyForDisplay(version.body, version.canonicalLanguage);
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
      const { thread } = await readForumThread(dalInstance, comment.threadId);
      const bodyHtml = `<div class="forum-page">
  <p><a href="${escapeHtml(commentLinkPath(thread, comment.id))}">${escapeHtml(
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
      await renderSectionPage(req, res, category);
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
        await renderSectionPage(req, res, category, { threadPreviewHtml });
        return;
      }

      const thread = await createForumThread({ category, title, body: normalizeLineEndings(body), language }, userId);
      res.redirect(303, threadLinkPath(thread));
    } catch (error) {
      if (error instanceof ValidationError) {
        const category = ensureForumCategory(req.params.category) as ForumCategorySlug;
        res.status(400);
        await renderSectionPage(req, res, category, {
          threadErrorMessage: resolveForumValidationMessage(req.t, error, { category }),
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        if (res.locals.signedIn) {
          const category = ensureForumCategory(req.params.category) as ForumCategorySlug;
          res.status(403);
          await renderSectionPage(req, res, category, {
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
