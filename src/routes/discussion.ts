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
import { isArticleSlug, isDraftSlug, resolvePageAddress } from '../lib/page-address.js';
import { profileSlug } from '../lib/profile-paths.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import { isBlockedSlug, toAddressForm } from '../lib/slug.js';
import { normalizeLineEndings } from '../lib/text-normalization.js';
import { escapeHtml, prepareTitle, renderText, toSafeText } from '../render.js';
import { findCurrentPostBySlugOrAlias } from '../services/blog-post-service.js';
import {
  countPageDiscussionComments,
  type DiscussionScope,
  findOrphanedDiscussion,
  listPageDiscussionSlugs,
  listPostDiscussionSlugs,
  readDiscussion,
} from '../services/discussion-service.js';
import { createForumThread, requireSignedInUserId } from '../services/forum-service.js';
import { getWikiPageEditability } from '../services/page-protection-service.js';
import {
  canSignOffPages,
  findRevisionsWithChangedText,
  isSignoffPageSlug,
  listActivePageSignoffs,
} from '../services/page-signoff-service.js';
import { isFollowingPage } from '../services/page-subscription-service.js';
import { listPositionReplies, listWithdrawnPositionsWithReplies } from '../services/position-reply-service.js';
import { findProfileOwnerBySlug, type ProfileOwner } from '../services/profile-service.js';
import { FORUM_MODERATOR_ROLE, userHasRole } from '../services/roles.js';
import { findCurrentPageBySlugOrAlias, readWikiPage } from '../services/wiki-page-service.js';
import { FOLLOW_PATH } from './follow.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { canonicalUrlFor, queryStringOf } from './lib/canonical.js';
import {
  type DiscussionViewer,
  listFollowedThreadIds,
  loadDiscussionRenderData,
  type OpenReplyForm,
  renderDiscussionSummary,
  renderDiscussionThreads,
  renderPaginatedDiscussion,
  renderPostingGate,
  renderReplyTemplate,
  renderStartThreadForm,
  type StartThreadValues,
} from './lib/discussion.js';
import { buildDiscussionContext, loadDiscussionPage } from './lib/discussion-page.js';
import { HISTORY_ANCHOR } from './lib/history.js';
import { renderMarkdownPreviewHtml } from './lib/markdown-preview.js';
import { howToEditPath } from './lib/operator-edit-link.js';
import { renderPageSignoffs } from './lib/page-signoffs.js';
import { renderPageTabs } from './lib/page-tabs.js';
import { loadProfileContext, renderProfileLabel, renderProfileTabs } from './lib/profile.js';
import { resolveForumValidationMessage } from './lib/validation-messages.js';

const { mlString } = dal;

/** Threads shown under a page's own text; the rest are on its discussion. */
export const THREADS_UNDER_PAGE = 5;

const DISCUSSION_ROUTE = /^\/(.+)\/discussion$/;

interface DiscussionPageRecord {
  id: string | null;
  discussionSlugs?: string[];
  deletedPageId?: string;
  slug: string;
  currentRevId: string;
  title: Record<string, string> | null | undefined;
  // Set on a profile's Talk tab, which exists whether or not the profile has text.
  profile?: ProfileOwner;
}

const pageHrefOf = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;

const canPostIn = (res: Response) =>
  Boolean((res.locals.accountState as { isEmailVerified?: boolean } | null | undefined)?.isEmailVerified);

const readString = (value: unknown) => (typeof value === 'string' ? value : '');

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
) =>
  renderDiscussionUnder(
    dalInstance,
    req,
    res,
    { kind: 'page', slug: page.slug },
    { pageSlugs: await listPageDiscussionSlugs(dalInstance, page) }
  );

/** The discussion shown under a blog post, as under a wiki page. */
export const renderDiscussionUnderPost = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  post: { id: string; slug: string }
) =>
  renderDiscussionUnder(
    dalInstance,
    req,
    res,
    { kind: 'post', slug: post.slug },
    { postSlugs: await listPostDiscussionSlugs(dalInstance, post) }
  );

const renderDiscussionUnder = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  target: DiscussionTarget,
  scope: DiscussionScope
) => {
  const discussion = await readDiscussion(dalInstance, scope, { pageSize: THREADS_UNDER_PAGE });
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
  ${
    discussion.threadCount
      ? renderDiscussionSummary(discussion, req.t, fullLink)
      : `<p class="discussion-empty">${escapeHtml(req.t('discussion.empty'))}</p>`
  }
  ${renderDiscussionThreads(discussion.threads, ctx)}
  ${moreHtml}
  ${renderReplyTemplate(ctx)}
  ${renderStartThread(req, res, target, ctx.viewer)}
</section>`;
};

export interface OpenPositionReply {
  signoffId: string;
  body?: string;
  language?: string;
  errorMessage?: string;
}

/**
 * The positions on a proposal, each a top-level comment with its replies one
 * level under it, and the form to state your own position.
 */
export const renderPositionsSection = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  page: { id: string; slug: string; currentRevId: string },
  { showDiscussionLink = true, openReply, readOnly = false }: {
    showDiscussionLink?: boolean; openReply?: OpenPositionReply; readOnly?: boolean;
  } = {}
) => {
  const signoffs = await listActivePageSignoffs(dalInstance, page.id);
  const withdrawn = await listWithdrawnPositionsWithReplies(dalInstance, page.id);
  const replyThreads = await listPositionReplies(
    dalInstance,
    [...signoffs, ...withdrawn].map(signoff => signoff.id)
  );
  const locale = (res.locals.locale as string | undefined) ?? req.language ?? 'en';
  const replies = [...replyThreads.values()].flatMap(thread => thread.replies);
  const { bodies, authors } = await loadDiscussionRenderData(
    dalInstance,
    replies.map(reply => ({
      id: reply.id,
      authorId: reply.authorId,
      body: { [reply.bodyLanguage ?? 'en']: reply.body },
      canonicalLanguage: reply.bodyLanguage,
    })),
    { backToCitationLabel: req.t('citation.backToCitationAria'), locale }
  );
  const userMap = new Map([...authors].map(([id, author]) => [id, author.name]));
  const usernames = new Map([...authors].map(([id, author]) => [id, author.username]));
  const missing = [...signoffs, ...withdrawn].map(signoff => signoff.userId).filter(id => !userMap.has(id));
  if (missing.length) {
    const result = await dalInstance.query('SELECT id, display_name, username FROM users WHERE id = ANY($1)', [missing]);
    for (const row of result.rows as Array<{ id: string; display_name: string; username: string }>) {
      userMap.set(row.id, row.display_name);
      usernames.set(row.id, row.username);
    }
  }
  const session = await resolveSessionUser(req);
  const followedThreadIds = await listFollowedThreadIds(
    dalInstance,
    [...replyThreads.values()].map(thread => thread.threadId),
    session?.userId ?? null
  );
  const canSignOff = !readOnly && (await canSignOffPages(dalInstance, session?.userId));
  const changedRevIds = await findRevisionsWithChangedText(
    dalInstance,
    page.id,
    [...new Set(signoffs.map(signoff => signoff.revId))].filter(id => id !== page.currentRevId)
  );
  return renderPageSignoffs({
    slug: page.slug,
    currentRevId: page.currentRevId,
    changedRevIds,
    signoffs,
    withdrawn,
    userMap,
    usernames,
    viewerId: session?.userId ?? null,
    followedThreadIds,
    canSignOff,
    canReply: canSignOff && canPostIn(res),
    isModerator: session ? await userHasRole(dalInstance, session.userId, FORUM_MODERATOR_ROLE) : false,
    t: req.t,
    language: req.language ?? 'en',
    languageOptions: res.locals.languageOptions,
    replies: new Map(
      [...replyThreads].map(([signoffId, thread]) => [
        signoffId,
        {
          threadId: thread.threadId,
          replies: thread.replies.map(reply => ({ ...reply, bodyHtml: bodies.get(reply.id) ?? '' })),
        },
      ])
    ),
    openReply,
    showDiscussionLink,
    locale,
  });
};

const profileWithoutText = (profile: ProfileOwner): DiscussionPageRecord => ({
  id: null, slug: profileSlug(profile.username), title: null, currentRevId: '', profile,
});

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
  let page: DiscussionPageRecord;
  const profile = await findProfileOwnerBySlug(dalInstance, slug);
  try {
    page = { ...(await readWikiPage(dalInstance, slug)), profile: profile ?? undefined };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (profile && profileSlug(profile.username) === slug) return profileWithoutText(profile);
    const addressForm = toAddressForm(slug);
    const match = addressForm !== slug ? await findCurrentPageBySlugOrAlias(addressForm) : null;
    page = match ? await readWikiPage(dalInstance, match.slug) : null;
    if (!page) {
      const orphan = await findOrphanedDiscussion(dalInstance, addressForm);
      if (!orphan) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return null;
      }
      page = {
        id: null, slug: orphan.slug, title: null, currentRevId: orphan.currentRevId,
        discussionSlugs: orphan.slugs, deletedPageId: orphan.deletedPageId,
      };
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
  openPosition?: OpenPositionReply;
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
  const { discussion, ctx } = await loadDiscussionPage(dalInstance, req, res, target, { pageSlugs: slugs }, state);
  const threadId = ctx.requestedThreadId;
  const session = ctx.viewer.userId;
  const locale = ctx.locale;
  const pageHref = pageHrefOf(page.slug);
  const titleText = page.profile
    ? page.profile.displayName
    : resolveSafeTextWithFallback(mlString.resolve, locale, page.title, page.slug);
  const editability = session && page.id
    ? await getWikiPageEditability(dalInstance, { id: page.id, slug: page.slug }, session)
    : { isProtected: false, isEditable: false };
  const canEditDirectly = Boolean(session) && (!editability.isProtected || editability.isEditable);
  const isDraft = isDraftSlug(page.slug);
  const profile = page.profile
    ? await loadProfileContext(dalInstance, page.profile, { viewerId: session, t: req.t, locale })
    : null;
  const tabsHtml = profile
    ? renderProfileTabs(profile, { current: 'talk', hasText: Boolean(page.id), t: req.t })
    : renderPageTabs({
    isArticle: isArticleSlug(page.slug) || isDraft,
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
  // A proposal's positions come first, on the first page only.
  const isProposal = isSignoffPageSlug(page.slug);
  const positionPageId = page.id ?? page.deletedPageId;
  const positionsHtml =
    isProposal && positionPageId && discussion.page === 1
      ? await renderPositionsSection(
          dalInstance,
          req,
          res,
          { id: positionPageId, slug: page.slug, currentRevId: page.currentRevId },
          {
            showDiscussionLink: false,
            readOnly: !page.id,
            openReply:
              state.openPosition ??
              (replyParentId && !threadId ? { signoffId: replyParentId } : undefined),
          }
        )
      : '';
  const canStart = Boolean(page.id || profile);
  const contextHtml = profile
    ? `<p class="profile-talk-intro">${escapeHtml(req.t('profile.talkIntro', { username: profile.owner.username }))}</p>`
    : page.id
      ? ''
      : `<p class="forum-page-context">${escapeHtml(req.t('forum.pageLink.orphanedContext', { slug: page.slug }))}</p>`;
  const bodyHtml = `<div class="discussion-page">
  ${contextHtml}
  ${positionsHtml}
  ${isProposal ? `<h2 class="discussion-threads-heading">${escapeHtml(req.t('discussion.threads'))}</h2>` : ''}
  ${discussion.threadCount ? renderDiscussionSummary(discussion, req.t) : emptyHtml}
  ${renderPaginatedDiscussion(discussion, ctx)}
  ${renderReplyTemplate(ctx)}
  ${canStart ? renderStartThread(req, res, target, ctx.viewer, {
    errorMessage: state.threadErrorMessage,
    previewHtml: state.threadPreviewHtml,
  }) : `<p class="forum-empty">${escapeHtml(req.t('forum.pageLink.cannotCreateMissingPageRequired'))}</p>`}
</div>`;
  const pageType = isDraft ? req.t('label.draft')
    : resolvePageAddress(page.slug)?.namespace === 'meta' ? req.t('label.meta') : req.t('label.article');
  res.render('layout', {
    title: prepareTitle(
      profile
        ? toSafeText(req.t('profile.talkTitle', { name: renderText(titleText) }))
        : toSafeText(req.t('discussion.pageTitle', { title: renderText(titleText) }))
    ),
    canonicalUrl: canonicalUrlFor(discussionPagePath(target, discussion.page)),
    relPrev: discussion.page > 1 ? discussionPagePath(target, discussion.page - 1) : null,
    relNext: discussion.page < discussion.pageCount ? discussionPagePath(target, discussion.page + 1) : null,
    noindex: isDraft || discussion.threadCount === 0 || Boolean(profile),
    labelHtml: profile
      ? renderProfileLabel(req.t)
      : `<div class="page-label-row"><div class="page-label">${escapeHtml(pageType)}</div></div>`,
    tabsHtml,
    sidebarHtml: profile?.accountBoxHtml,
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
  const match = await findCurrentPageBySlugOrAlias(thread.pageSlug);
  const profile = await findProfileOwnerBySlug(dalInstance, thread.pageSlug);
  let page: DiscussionPageRecord | null = match
    ? { ...(await readWikiPage(dalInstance, match.slug)), profile: profile ?? undefined }
    : profile
      ? profileWithoutText(profile)
      : null;
  if (!page) {
    const orphan = await findOrphanedDiscussion(dalInstance, thread.pageSlug);
    if (!orphan) return false;
    page = {
      id: null, slug: orphan.slug, title: null, currentRevId: orphan.currentRevId,
      discussionSlugs: orphan.slugs, deletedPageId: orphan.deletedPageId,
    };
  }
  await renderPageDiscussionPage(req, res, page, { ...state, threadId: thread.id });
  return true;
};

interface DiscussionPostRecord {
  id: string;
  slug: string;
  title: Record<string, string> | null | undefined;
}

/** The blog post whose discussion this address names, or a redirect to its current address. */
const resolveDiscussionPost = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  slug: string
): Promise<DiscussionPostRecord | null> => {
  const post = await findCurrentPostBySlugOrAlias(dalInstance, slug);
  if (!post) {
    res.status(404).type('text').send(req.t('page.notFound'));
    return null;
  }
  if (post.slug !== slug) {
    res.redirect(301, `${discussionPath({ kind: 'post', slug: post.slug })}${queryStringOf(req.originalUrl)}`);
    return null;
  }
  return post;
};

/** A blog post's discussion on its own page, at the post's address plus /discussion. */
export const renderPostDiscussionPage = async (
  req: Request,
  res: Response,
  post: DiscussionPostRecord,
  state: DiscussionPageState = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const target: DiscussionTarget = { kind: 'post', slug: post.slug };
  const { discussion, ctx } = await loadDiscussionPage(
    dalInstance, req, res, target,
    { postSlugs: await listPostDiscussionSlugs(dalInstance, post) }, state
  );
  const titleText = resolveSafeTextWithFallback(mlString.resolve, ctx.locale, post.title, post.slug);
  const postHref = `/blog/${encodeURIComponent(post.slug)}`;
  const bodyHtml = `<div class="discussion-page">
  <p class="discussion-back"><a href="${escapeHtml(postHref)}">${renderText(titleText)}</a></p>
  ${
    discussion.threadCount
      ? renderDiscussionSummary(discussion, req.t)
      : `<p class="discussion-empty">${escapeHtml(req.t('discussion.empty'))}</p>`
  }
  ${renderPaginatedDiscussion(discussion, ctx)}
  ${renderReplyTemplate(ctx)}
  ${renderStartThread(req, res, target, ctx.viewer, {
    errorMessage: state.threadErrorMessage,
    previewHtml: state.threadPreviewHtml,
  })}
</div>`;
  res.render('layout', {
    title: prepareTitle(toSafeText(req.t('discussion.pageTitle', { title: renderText(titleText) }))),
    canonicalUrl: canonicalUrlFor(discussionPagePath(target, discussion.page)),
    relPrev: discussion.page > 1 ? discussionPagePath(target, discussion.page - 1) : null,
    relNext: discussion.page < discussion.pageCount ? discussionPagePath(target, discussion.page + 1) : null,
    noindex: discussion.threadCount === 0,
    labelHtml: `<div class="page-label">${escapeHtml(req.t('label.blogPost'))}</div>`,
    topHtml: prependAccountBanner(res, ''),
    bodyHtml,
  });
};

/** As {@link renderPageDiscussionForThread}, for a thread about a blog post. */
export const renderPostDiscussionForThread = async (
  req: Request,
  res: Response,
  thread: { id: string; postSlug: string },
  state: DiscussionPageState
) => {
  const post = await findCurrentPostBySlugOrAlias(await initializePostgreSQL(), thread.postSlug);
  if (!post) return false;
  await renderPostDiscussionPage(req, res, post, { ...state, threadId: thread.id });
  return true;
};

/** Start a thread about a page or a post, or show the form again with what went wrong. */
const startThread = async (
  req: Request,
  res: Response,
  target: Extract<DiscussionTarget, { kind: 'page' | 'post' }>,
  render: (state: DiscussionPageState) => Promise<void>
) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(303, `/tool/login?redirect=${encodeURIComponent(discussionPath(target))}`);
    return;
  }
  try {
    const userId = requireSignedInUserId(session.userId);
    if (!canPostIn(res)) throw new ForbiddenError(req.t('forum.verifyEmailToPost'));
    const values = startThreadValues(req);
    const body = normalizeLineEndings(values.body);
    if (req.body?.intent === 'preview') {
      const threadPreviewHtml = await renderMarkdownPreviewHtml(
        await initializePostgreSQL(),
        body,
        req.t('citation.backToCitationAria')
      );
      await render({ threadPreviewHtml });
      return;
    }
    const category = target.kind === 'post' ? 'blog' : (forumPageCategory(target.slug) ?? 'articles');
    const thread = await createForumThread(
      { category, pageSlug: target.slug, title: values.title, body, language: values.language },
      userId
    );
    res.redirect(303, threadPermalink(target, thread.id));
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ForbiddenError) {
      res.status(error instanceof ValidationError ? 400 : 403);
      await render({
        threadErrorMessage: error instanceof ValidationError ? resolveForumValidationMessage(req.t, error) : error.message,
      });
      return;
    }
    throw error;
  }
};

export const registerDiscussionRoutes = (app: Express) => {
  app.get('/blog/:slug/discussion', async (req, res) => {
    try {
      const post = await resolveDiscussionPost(await initializePostgreSQL(), req, res, req.params.slug);
      if (!post) return;
      await renderPostDiscussionPage(req, res, post);
    } catch (error) {
      console.error('Failed to render blog post discussion:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post('/blog/:slug/discussion', async (req, res) => {
    try {
      const post = await resolveDiscussionPost(await initializePostgreSQL(), req, res, req.params.slug);
      if (!post) return;
      await startThread(req, res, { kind: 'post', slug: post.slug }, state => renderPostDiscussionPage(req, res, post, state));
    } catch (error) {
      console.error('Failed to start a blog discussion thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

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
    try {
      const page = await resolveDiscussionPage(await initializePostgreSQL(), req, res, req.params[0]);
      if (!page) return;
      if (!page.id && !page.profile) {
        res.status(403);
        await renderPageDiscussionPage(req, res, page);
        return;
      }
      await startThread(req, res, { kind: 'page', slug: page.slug }, state => renderPageDiscussionPage(req, res, page, state));
    } catch (error) {
      console.error('Failed to start a discussion thread:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });
};

