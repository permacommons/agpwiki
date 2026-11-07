import type { Express, Request, Response } from 'express';
import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import {
  type DiscussionTarget,
  discussionPagePath,
  discussionPath,
  threadPermalink,
} from '../lib/discussion-paths.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { forumPageCategory } from '../lib/forum-paths.js';
import { isArticleSlug, resolvePageAddress } from '../lib/page-address.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import { isBlockedSlug, toAddressForm } from '../lib/slug.js';
import { normalizeLineEndings } from '../lib/text-normalization.js';
import { escapeHtml, prepareTitle, renderText, toSafeText } from '../render.js';
import {
  countPageDiscussionComments,
  type DiscussionPage,
  findOrphanedDiscussion,
  listPageDiscussionSlugs,
  readDiscussion,
} from '../services/discussion-service.js';
import { createForumThread, requireSignedInUserId } from '../services/forum-service.js';
import { getWikiPageEditability } from '../services/page-protection-service.js';
import { isFollowingPage } from '../services/page-subscription-service.js';
import { FORUM_MODERATOR_ROLE, userHasRole } from '../services/roles.js';
import { findCurrentPageBySlugOrAlias, readWikiPage } from '../services/wiki-page-service.js';
import { FOLLOW_PATH } from './follow.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { canonicalUrlFor, queryStringOf } from './lib/canonical.js';
import {
  type DiscussionRenderContext,
  type DiscussionViewer,
  discussionCommentsOf,
  listFollowedThreadIds,
  loadDiscussionRenderData,
  type OpenReplyForm,
  renderDiscussionPager,
  renderDiscussionSummary,
  renderDiscussionThreads,
  renderPostingGate,
  renderReplyTemplate,
  renderStartThreadForm,
  type StartThreadValues,
} from './lib/discussion.js';
import { HISTORY_ANCHOR } from './lib/history.js';
import { renderMarkdownPreviewHtml } from './lib/markdown-preview.js';
import { howToEditPath } from './lib/operator-edit-link.js';
import { renderPageTabs } from './lib/page-tabs.js';
import { resolveForumValidationMessage } from './lib/validation-messages.js';

const { mlString } = dal;

/** Threads shown under a page's own text; the rest are on its discussion. */
export const THREADS_UNDER_PAGE = 5;

const DISCUSSION_ROUTE = /^\/(.+)\/discussion$/;

interface DiscussionPageRecord {
  id: string | null;
  discussionSlugs?: string[];
  slug: string;
  title: Record<string, string> | null | undefined;
}

const pageHrefOf = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;

const canPostIn = (res: Response) =>
  Boolean((res.locals.accountState as { isEmailVerified?: boolean } | null | undefined)?.isEmailVerified);

const readPositiveInt = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const readString = (value: unknown) => (typeof value === 'string' ? value : '');

/** Who is reading and what they may do, for the threads shown. */
export const loadDiscussionViewer = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  threadIds: string[]
): Promise<DiscussionViewer> => {
  const session = await resolveSessionUser(req);
  const userId = session?.userId ?? null;
  return {
    userId,
    canPost: Boolean(userId) && canPostIn(res),
    isModerator: userId ? await userHasRole(dalInstance, userId, FORUM_MODERATOR_ROLE) : false,
    followedThreadIds: await listFollowedThreadIds(dalInstance, threadIds, userId),
  };
};

/** The rendering context for one page of a discussion. */
export const buildDiscussionContext = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  target: DiscussionTarget,
  discussion: DiscussionPage,
  { headingLevel, openReply }: { headingLevel: 2 | 3; openReply?: OpenReplyForm }
): Promise<DiscussionRenderContext> => {
  const locale = (res.locals.locale as string | undefined) ?? req.language ?? 'en';
  const viewer = await loadDiscussionViewer(
    dalInstance,
    req,
    res,
    discussion.threads.map(thread => thread.id)
  );
  const { bodies, authors } = await loadDiscussionRenderData(dalInstance, discussionCommentsOf(discussion.threads), {
    backToCitationLabel: req.t('citation.backToCitationAria'),
    locale,
  });
  return {
    target,
    t: req.t,
    locale,
    language: req.language ?? 'en',
    languageOptions: res.locals.languageOptions,
    viewer,
    authors,
    bodies,
    headingLevel,
    openReply,
  };
};

const startThreadValues = (req: Request): StartThreadValues => ({
  title: readString(req.body?.title),
  body: readString(req.body?.body),
  language: readString(req.body?.language) || req.language || 'en',
});

const renderStartThread = (
  req: Request,
  res: Response,
  target: DiscussionTarget,
  viewer: DiscussionViewer,
  options: { errorMessage?: string; previewHtml?: string } = {}
) =>
  viewer.canPost
    ? renderStartThreadForm({
        action: discussionPath(target),
        t: req.t,
        languageOptions: res.locals.languageOptions,
        values: startThreadValues(req),
        errorMessage: options.errorMessage,
        previewHtml: options.previewHtml,
      })
    : renderPostingGate(req.t, { signedIn: Boolean(viewer.userId), canPost: viewer.canPost });

/**
 * The discussion shown under a page's own text: the threads with the most
 * recent activity, a link to the whole discussion, and the form to start a
 * thread.
 */
export const renderDiscussionUnderPage = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  page: { id: string; slug: string }
) => {
  const target: DiscussionTarget = { kind: 'page', slug: page.slug };
  const discussion = await readDiscussion(
    dalInstance,
    { pageSlugs: await listPageDiscussionSlugs(dalInstance, page) },
    { pageSize: THREADS_UNDER_PAGE }
  );
  const ctx = await buildDiscussionContext(dalInstance, req, res, target, discussion, { headingLevel: 3 });
  const fullLink = ` · <a href="${escapeHtml(discussionPath(target))}">${escapeHtml(req.t('discussion.openFull'))}</a>`;
  const moreHtml =
    discussion.threadCount > discussion.threads.length
      ? `<p class="discussion-more"><a href="${escapeHtml(discussionPagePath(target, 1))}">${escapeHtml(
          req.t('discussion.seeAllThreads', { count: discussion.threadCount })
        )}</a></p>`
      : '';
  return `<section class="page-discussion" aria-labelledby="page-discussion-title">
  <h2 id="page-discussion-title">${escapeHtml(req.t('discussion.title'))}</h2>
  ${renderDiscussionSummary(discussion, req.t, fullLink)}
  ${renderDiscussionThreads(discussion.threads, ctx)}
  ${moreHtml}
  ${renderReplyTemplate(ctx)}
  ${renderStartThread(req, res, target, ctx.viewer)}
</section>`;
};

/** The page whose discussion this address names, or a redirect to its current address. */
const resolveDiscussionPage = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  slug: string
): Promise<DiscussionPageRecord | null> => {
  if (isBlockedSlug(slug) || !forumPageCategory(slug)) {
    res.status(404).type('text').send(req.t('page.notFound'));
    return null;
  }
  let page: DiscussionPageRecord | null = null;
  try {
    page = await readWikiPage(dalInstance, slug);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    const addressForm = toAddressForm(slug);
    page = addressForm !== slug ? await findCurrentPageBySlugOrAlias(addressForm) : null;
    if (!page) {
      const orphan = await findOrphanedDiscussion(dalInstance, addressForm);
      if (!orphan) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return null;
      }
      page = { id: null, slug: orphan.slug, title: null, discussionSlugs: orphan.slugs };
    }
  }
  if (page.slug !== slug) {
    res.redirect(301, `${discussionPath({ kind: 'page', slug: page.slug })}${queryStringOf(req.originalUrl)}`);
    return null;
  }
  return page;
};

export interface DiscussionPageState {
  openReply?: OpenReplyForm;
  threadErrorMessage?: string;
  threadPreviewHtml?: string;
  threadId?: string;
}

/** A page's discussion on its own page, at the page's address plus /discussion. */
export const renderPageDiscussionPage = async (
  req: Request,
  res: Response,
  page: DiscussionPageRecord,
  state: DiscussionPageState = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const target: DiscussionTarget = { kind: 'page', slug: page.slug };
  const slugs = page.id
    ? await listPageDiscussionSlugs(dalInstance, { id: page.id, slug: page.slug })
    : page.discussionSlugs ?? [page.slug];
  const replyParentId = readString(req.query.reply);
  const threadId = state.threadId ?? state.openReply?.threadId ?? (readString(req.query.thread) || undefined);
  const discussion = await readDiscussion(
    dalInstance,
    { pageSlugs: slugs },
    { page: readPositiveInt(req.query.page), threadId }
  );
  const openReply =
    state.openReply ?? (threadId && replyParentId ? { threadId, parentId: replyParentId } : undefined);
  const ctx = await buildDiscussionContext(dalInstance, req, res, target, discussion, {
    headingLevel: 2,
    openReply,
  });
  const session = ctx.viewer.userId;
  const locale = ctx.locale;
  const pageHref = pageHrefOf(page.slug);
  const titleText = resolveSafeTextWithFallback(mlString.resolve, locale, page.title, page.slug);
  const editability = session && page.id
    ? await getWikiPageEditability(dalInstance, { id: page.id }, session)
    : { isProtected: false, isEditable: false };
  const canEditDirectly = Boolean(session) && (!editability.isProtected || editability.isEditable);
  const tabsHtml = renderPageTabs({
    isArticle: isArticleSlug(page.slug),
    pageHref,
    isCurrentView: Boolean(page.id),
    discussHref: discussionPath(target),
    discussCount: await countPageDiscussionComments(dalInstance, slugs),
    discussCurrent: true,
    editHref: canEditDirectly ? `${pageHref}/operator-edit` : howToEditPath(page.slug),
    historyHref: `${pageHref}#${HISTORY_ANCHOR}`,
    follow: session && page.id
      ? {
          slug: page.slug,
          following: await isFollowingPage(dalInstance, page.id, session),
          returnTo: req.originalUrl || discussionPath(target),
          action: FOLLOW_PATH,
        }
      : undefined,
    t: req.t,
  });
  const emptyHtml = discussion.threadCount
    ? ''
    : `<p class="discussion-empty">${escapeHtml(req.t('discussion.empty'))}</p>`;
  const bodyHtml = `<div class="discussion-page">
  ${page.id ? '' : `<p class="forum-page-context">${escapeHtml(req.t('forum.pageLink.orphanedContext', { slug: page.slug }))}</p>`}
  ${renderDiscussionSummary(discussion, req.t)}
  ${emptyHtml}
  ${renderDiscussionThreads(discussion.threads, ctx)}
  ${renderDiscussionPager(target, discussion, req.t)}
  ${renderReplyTemplate(ctx)}
  ${page.id ? renderStartThread(req, res, target, ctx.viewer, {
    errorMessage: state.threadErrorMessage,
    previewHtml: state.threadPreviewHtml,
  }) : `<p class="forum-empty">${escapeHtml(req.t('forum.pageLink.cannotCreateMissingPageRequired'))}</p>`}
</div>`;
  const pageType = resolvePageAddress(page.slug)?.namespace === 'meta' ? req.t('label.meta') : req.t('label.article');
  res.render('layout', {
    title: prepareTitle(toSafeText(req.t('discussion.pageTitle', { title: renderText(titleText) }))),
    canonicalUrl: canonicalUrlFor(discussionPagePath(target, discussion.page)),
    relPrev: discussion.page > 1 ? discussionPagePath(target, discussion.page - 1) : null,
    relNext: discussion.page < discussion.pageCount ? discussionPagePath(target, discussion.page + 1) : null,
    // An empty discussion has nothing for search engines yet.
    noindex: discussion.threadCount === 0,
    labelHtml: `<div class="page-label-row"><div class="page-label">${escapeHtml(pageType)}</div></div>`,
    tabsHtml,
    topHtml: prependAccountBanner(res, ''),
    bodyHtml,
  });
};

/**
 * Show the discussion holding a thread, for instance again after a reply
 * could not be saved. Returns false when the thread is not about a page.
 */
export const renderPageDiscussionForThread = async (
  req: Request,
  res: Response,
  thread: { id: string; pageSlug: string },
  state: DiscussionPageState
) => {
  const dalInstance = await initializePostgreSQL();
  let page: DiscussionPageRecord | null = await findCurrentPageBySlugOrAlias(thread.pageSlug);
  if (!page) {
    const orphan = await findOrphanedDiscussion(dalInstance, thread.pageSlug);
    if (!orphan) return false;
    page = { id: null, slug: orphan.slug, title: null, discussionSlugs: orphan.slugs };
  }
  await renderPageDiscussionPage(req, res, page, { ...state, threadId: thread.id });
  return true;
};

export const registerDiscussionRoutes = (app: Express) => {
  app.get(DISCUSSION_ROUTE, async (req, res) => {
    try {
      const dalInstance = await initializePostgreSQL();
      const page = await resolveDiscussionPage(dalInstance, req, res, req.params[0]);
      if (!page) return;
      await renderPageDiscussionPage(req, res, page);
    } catch (error) {
      console.error('Failed to render page discussion:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  // Start a thread in a page's discussion.
  app.post(DISCUSSION_ROUTE, async (req, res) => {
    const slug = req.params[0];
    try {
      const dalInstance = await initializePostgreSQL();
      const page = await resolveDiscussionPage(dalInstance, req, res, slug);
      if (!page) return;
      if (!page.id) {
        res.status(403);
        await renderPageDiscussionPage(req, res, page);
        return;
      }
      const session = await resolveSessionUser(req);
      if (!session) {
        res.redirect(303, `/tool/login?redirect=${encodeURIComponent(discussionPath({ kind: 'page', slug: page.slug }))}`);
        return;
      }
      try {
        const userId = requireSignedInUserId(session.userId);
        if (!canPostIn(res)) throw new ForbiddenError(req.t('forum.verifyEmailToPost'));
        const values = startThreadValues(req);
        const body = normalizeLineEndings(values.body);
        if (req.body?.intent === 'preview') {
          const threadPreviewHtml = await renderMarkdownPreviewHtml(
            dalInstance,
            body,
            req.t('citation.backToCitationAria')
          );
          await renderPageDiscussionPage(req, res, page, { threadPreviewHtml });
          return;
        }
        const category = forumPageCategory(page.slug) ?? 'articles';
        const thread = await createForumThread(
          { category, pageSlug: page.slug, title: values.title, body, language: values.language },
          userId
        );
        res.redirect(303, threadPermalink({ kind: 'page', slug: page.slug }, thread.id));
      } catch (error) {
        if (error instanceof ValidationError || error instanceof ForbiddenError) {
          res.status(error instanceof ValidationError ? 400 : 403);
          await renderPageDiscussionPage(req, res, page, {
            threadErrorMessage:
              error instanceof ValidationError ? resolveForumValidationMessage(req.t, error) : error.message,
          });
          return;
        }
        throw error;
      }
    } catch (error) {
      console.error('Failed to start a discussion thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });
};

