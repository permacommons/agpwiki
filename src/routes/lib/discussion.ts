import type { TFunction } from 'i18next';
import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { loadCitationEntriesForSources } from '../../lib/citation-render.js';
import {
  commentAnchor,
  commentPermalink,
  type DiscussionTarget,
  discussionPagePath,
  discussionPath,
  threadAnchor,
  threadLocationPath,
  threadPermalink,
} from '../../lib/discussion-paths.js';
import {
  forumCommentDeletePath,
  forumCommentHistoryPath,
  forumThreadCommentPath,
  forumThreadDeletePath,
  forumThreadPath,
  forumThreadPinPath,
} from '../../lib/forum-paths.js';
import { loadMediaEntriesForSources } from '../../lib/media-render.js';
import { resolveSafeTextWithFallback } from '../../lib/safe-text.js';
import { escapeHtml, type LanguageOption, renderMarkdown, renderText } from '../../render.js';
import { DISCUSSION_PAGE_SIZE, type DiscussionComment, type DiscussionPage, type DiscussionThread } from '../../services/discussion-service.js';
import { loadMarkdownMentions } from '../../services/mention-service.js';
import { renderFormLanguageSelector } from './form-language-selector.js';
import {
  renderAgentLabel,
  renderForumCommentEditLink,
  renderForumCommentEditor,
  renderRemoveAgentLabel,
} from './forum-comment-editor.js';
import { renderMarkdownPreviewPanel } from './markdown-preview.js';

const { mlString } = dal;

export interface DiscussionAuthor {
  name: string;
  username: string;
}

/** What a reader may do in a discussion. */
export interface DiscussionViewer {
  userId: string | null;
  // Signed in with a confirmed email address: may post and reply.
  canPost: boolean;
  isModerator: boolean;
  followedThreadIds: Set<string>;
}

/** A reply form shown open by the server: without JavaScript, or after an error. */
export interface OpenReplyForm {
  threadId: string;
  parentId: string;
  body?: string;
  language?: string;
  errorMessage?: string;
}

export interface DiscussionRenderContext {
  target: DiscussionTarget;
  t: TFunction;
  locale: string;
  language: string;
  languageOptions: LanguageOption[];
  viewer: DiscussionViewer;
  authors: Map<string, DiscussionAuthor>;
  bodies: Map<string, string>;
  // Thread titles are h3 under a page and h2 on the discussion's own page.
  headingLevel: 2 | 3;
  openReply?: OpenReplyForm;
  requestedThreadId?: string;
}

// Feather icons (MIT) — link
const iconLink =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

export const getThreadTitle = (locale: string, title: Record<string, string> | null | undefined) =>
  resolveSafeTextWithFallback(mlString.resolve, locale, title, '');

const bodySourceOf = (comment: Pick<DiscussionComment, 'body' | 'canonicalLanguage'>) =>
  mlString.resolve(comment.canonicalLanguage ?? 'en', comment.body ?? null)?.str ?? '';

const formatDay = (date: Date | null, locale: string) =>
  date
    ? date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';

const allComments = (threads: DiscussionThread[]) =>
  threads.flatMap(thread => thread.comments.flatMap(comment => [comment, ...comment.replies]));

/**
 * Everything a discussion needs besides its threads: who wrote each comment,
 * each comment rendered from Markdown, and which threads the reader follows.
 */
export const loadDiscussionRenderData = async (
  dalInstance: DataAccessLayer,
  comments: Array<Pick<DiscussionComment, 'id' | 'authorId' | 'body' | 'canonicalLanguage'>>,
  { backToCitationLabel, locale }: { backToCitationLabel: string; locale: string }
) => {
  const sources = comments.map(bodySourceOf);
  const [citationEntries, mediaRegistry, mentions] = await Promise.all([
    loadCitationEntriesForSources(dalInstance, sources),
    loadMediaEntriesForSources(dalInstance, sources),
    loadMarkdownMentions(dalInstance, sources),
  ]);
  const bodies = new Map<string, string>();
  for (const comment of comments) {
    const rendered = await renderMarkdown(bodySourceOf(comment), citationEntries, {
      backToCitationLabel,
      citationIdPrefix: `comment-${comment.id}-`,
      mediaRegistry,
      locale,
      mentions,
    });
    bodies.set(comment.id, rendered.html);
  }
  const authorIds = [...new Set(comments.map(comment => comment.authorId).filter((id): id is string => Boolean(id)))];
  const authors = new Map<string, DiscussionAuthor>();
  if (authorIds.length) {
    const result = await dalInstance.query('SELECT id, display_name, username FROM users WHERE id = ANY($1)', [
      authorIds,
    ]);
    for (const row of result.rows as Array<{ id: string; display_name: string; username: string }>) {
      authors.set(row.id, { name: row.display_name, username: row.username });
    }
  }
  return { bodies, authors };
};

/** The threads among these that the reader follows. */
export const listFollowedThreadIds = async (
  dalInstance: DataAccessLayer,
  threadIds: string[],
  userId: string | null
) => {
  if (!userId || !threadIds.length) return new Set<string>();
  const result = await dalInstance.query(
    `SELECT thread_id FROM forum_thread_subscriptions
      WHERE user_id = $1 AND thread_id = ANY($2) AND unsubscribed_at IS NULL`,
    [userId, threadIds]
  );
  return new Set((result.rows as Array<{ thread_id: string }>).map(row => row.thread_id));
};

export const discussionCommentsOf = allComments;

interface ReplyFormParams {
  action: string;
  fields: Record<string, string>;
  idPrefix: string;
  language: string;
  languageOptions: LanguageOption[];
  t: TFunction;
  body?: string;
  errorMessage?: string;
  cancelHref?: string;
}

/** A short form to reply under a comment. */
export const renderReplyForm = ({
  action,
  fields,
  idPrefix,
  language,
  languageOptions,
  t,
  body = '',
  errorMessage,
  cancelHref,
}: ReplyFormParams) => {
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join('');
  return `<form method="post" action="${escapeHtml(action)}" class="discussion-reply-form" data-reply-form>
  ${hidden}
  ${errorMessage ? `<p class="form-error" role="alert">${escapeHtml(errorMessage)}</p>` : ''}
  <textarea name="body" rows="3" dir="auto" required data-mention-suggest aria-label="${escapeHtml(t('discussion.replyLabel'))}" placeholder="${escapeHtml(
    t('discussion.replyPlaceholder')
  )}">${escapeHtml(body)}</textarea>
  <div class="form-actions">
    ${renderFormLanguageSelector({
      languageOptions,
      selected: language,
      name: 'language',
      idPrefix,
      label: t('forum.compose.language'),
      prefixLabel: t('language.selector'),
    })}
    <button type="submit">${escapeHtml(t('forum.compose.postReply'))}</button>
    ${cancelHref ? `<a href="${escapeHtml(cancelHref)}" data-reply-cancel>${escapeHtml(t('common.actions.cancel'))}</a>` : ''}
  </div>
</form>`;
};

/**
 * One reply form the browser copies under whichever comment the reader
 * answers, instead of a form under every comment.
 */
export const renderReplyTemplate = (ctx: Pick<DiscussionRenderContext, 't' | 'language' | 'languageOptions' | 'viewer'>) =>
  ctx.viewer.canPost
    ? `<template data-reply-template>${renderReplyForm({
        action: '',
        fields: {},
        idPrefix: 'discussion-reply-language',
        language: ctx.language,
        languageOptions: ctx.languageOptions,
        t: ctx.t,
        cancelHref: '#',
      })}</template>`
    : '';

const plainClick = 'data-plain-click';

/** The meta line of a comment or a position: who wrote it and when. */
export const renderCommentMeta = (name: string, date: Date | null, extraHtml = '', locale = 'en', labelHtml = '') =>
  `<div class="discussion-comment-meta"><strong class="discussion-author">${escapeHtml(name)}</strong>${labelHtml} <span class="discussion-date">· ${escapeHtml(
    formatDay(date, locale)
  )}</span>${extraHtml}</div>`;

const renderComment = (
  comment: DiscussionComment,
  thread: DiscussionThread,
  ctx: DiscussionRenderContext,
  parent: DiscussionComment | null
): string => {
  const { t, viewer, target } = ctx;
  const author = comment.authorId ? ctx.authors.get(comment.authorId) : undefined;
  const name = author?.name ?? t('forum.comment.unknownOperator');
  const permalink = commentPermalink(target, thread.id, comment.id);
  const own = Boolean(viewer.userId && viewer.userId === comment.authorId);
  const replyParent = parent ?? comment;
  const replyHref = `${threadLocationPath(target, thread.id)}&reply=${encodeURIComponent(replyParent.id)}#reply-form-${encodeURIComponent(replyParent.id)}`;
  const replyHtml = viewer.canPost
    ? `<a href="${escapeHtml(replyHref)}" data-reply-to="${escapeHtml(replyParent.id)}" data-reply-action="${escapeHtml(
        forumThreadCommentPath(thread.id)
      )}" data-reply-fields="${escapeHtml(JSON.stringify({ parentId: replyParent.id }))}"${
        parent && author ? ` data-reply-mention="${escapeHtml(author.username)}"` : ''
      } ${plainClick}>${escapeHtml(t('discussion.reply'))}</a>`
    : '';
  const editedHtml = comment.edited
    ? ` <span class="discussion-edited">· <a href="${escapeHtml(forumCommentHistoryPath(comment.id))}">${escapeHtml(
        t('forum.comment.edited')
      )}</a></span>`
    : '';
  const deleteHtml = viewer.isModerator
    ? `<form method="post" action="${escapeHtml(forumCommentDeletePath(comment.id))}" class="forum-inline-form">
  <button type="submit">${escapeHtml(t('forum.comment.delete'))}</button>
</form>`
    : '';
  const bodySource = bodySourceOf(comment);
  const editHtml = own
    ? renderForumCommentEditor({
        commentId: comment.id,
        body: bodySource,
        language: comment.canonicalLanguage ?? ctx.language,
        languageOptions: ctx.languageOptions,
        returnPath: permalink,
        t,
        hidden: true,
      })
    : '';
  const openReply =
    !parent && ctx.openReply?.threadId === thread.id && ctx.openReply.parentId === comment.id && viewer.canPost
      ? `<div id="reply-form-${escapeHtml(comment.id)}">${renderReplyForm({
          action: forumThreadCommentPath(thread.id),
          fields: { parentId: comment.id },
          idPrefix: `discussion-reply-language-${comment.id}`,
          language: ctx.openReply.language ?? ctx.language,
          languageOptions: ctx.languageOptions,
          t,
          body: ctx.openReply.body,
          errorMessage: ctx.openReply.errorMessage,
          cancelHref: permalink,
        })}</div>`
      : '';
  const repliesHtml = parent
    ? ''
    : `<div class="discussion-replies" data-replies="${escapeHtml(comment.id)}">${comment.replies
        .map(reply => renderComment(reply, thread, ctx, comment))
        .join('')}${openReply}</div>`;
  return `<article class="discussion-comment${parent ? ' discussion-comment--reply' : ''}" id="${commentAnchor(comment.id)}" data-comment-edit>
  ${renderCommentMeta(name, comment.createdAt, editedHtml, ctx.locale, renderAgentLabel(comment, name, t))}
  <div class="discussion-comment-body" data-comment-content${comment.canonicalLanguage ? ` lang="${escapeHtml(comment.canonicalLanguage)}"` : ''} dir="auto">${
    ctx.bodies.get(comment.id) ?? ''
  }</div>
  <div class="discussion-comment-actions" data-comment-actions>
    ${replyHtml}
    <a href="${escapeHtml(permalink)}" data-permalink ${plainClick}>${escapeHtml(t('discussion.commentLink'))}</a>
    ${own ? renderForumCommentEditLink(comment.id, permalink, t) : ''}
    ${own && comment.agentAuthored ? renderRemoveAgentLabel(comment.id, permalink, t) : ''}
    ${deleteHtml}
  </div>
  ${editHtml}
</article>${repliesHtml}`;
};

// Following is a small text button beside the thread's counts; pinning and
// deleting are for moderators only.
export const renderFollowThread = (
  thread: Pick<DiscussionThread, 'id'>,
  ctx: { viewer: Pick<DiscussionViewer, 'userId' | 'followedThreadIds'>; t: TFunction }
) => {
  if (!ctx.viewer.userId) return '';
  const following = ctx.viewer.followedThreadIds.has(thread.id);
  return ` · <form method="post" action="${escapeHtml(`${forumThreadPath(thread.id)}/subscription`)}" class="forum-inline-form discussion-follow">
  <input type="hidden" name="subscribed" value="${following ? 'false' : 'true'}" />
  <button type="submit" aria-pressed="${following}">${escapeHtml(
    ctx.t(following ? 'followControl.unfollow' : 'followControl.follow')
  )}</button>
</form>`;
};

const renderModeratorControls = (thread: DiscussionThread, ctx: DiscussionRenderContext) =>
  ctx.viewer.isModerator
    ? `<div class="discussion-thread-controls">
  <form method="post" action="${escapeHtml(forumThreadPinPath(thread.id))}" class="forum-inline-form">
    <input type="hidden" name="pinned" value="${thread.pinned ? 'false' : 'true'}" />
    <button type="submit">${escapeHtml(ctx.t(thread.pinned ? 'forum.thread.unpin' : 'forum.thread.pin'))}</button>
  </form>
  <form method="post" action="${escapeHtml(forumThreadDeletePath(thread.id))}" class="forum-inline-form">
    <button type="submit">${escapeHtml(ctx.t('forum.thread.delete'))}</button>
  </form>
</div>`
    : '';

/** A thread: a section of the discussion, its title a plain subheading. */
export const renderThreadSection = (thread: DiscussionThread, ctx: DiscussionRenderContext) => {
  const { t, locale } = ctx;
  const tag = `h${ctx.headingLevel}`;
  const title = getThreadTitle(locale, thread.title);
  const permalink = threadPermalink(ctx.target, thread.id);
  const linkLabel = t('discussion.threadLink');
  const metaParts = [
    t('forum.thread.commentCount', { count: thread.commentCount }),
    t('discussion.lastActivity', { date: formatDay(thread.latestActivityAt, locale) }),
  ];
  return `<section class="discussion-thread" id="${threadAnchor(thread.id)}" aria-labelledby="${threadAnchor(thread.id)}-title">
  ${ctx.requestedThreadId === thread.id ? '<span id="thread" class="discussion-thread-anchor" aria-hidden="true"></span>' : ''}
  <div class="discussion-thread-head">
    <${tag} class="discussion-thread-title" id="${threadAnchor(thread.id)}-title">${renderText(title)}<a class="discussion-thread-link" href="${escapeHtml(
      permalink
    )}" title="${escapeHtml(linkLabel)}" aria-label="${escapeHtml(linkLabel)}" data-permalink ${plainClick}>${iconLink}</a></${tag}>
    <span class="discussion-thread-meta">${thread.pinned ? `<span class="forum-pin-badge">${escapeHtml(t('forum.thread.pinned'))}</span> ` : ''}${metaParts
      .map(part => escapeHtml(part))
      .join(' · ')}${renderFollowThread(thread, ctx)}</span>
  </div>
  ${renderModeratorControls(thread, ctx)}
  ${thread.comments.map(comment => renderComment(comment, thread, ctx, null)).join('')}
</section>`;
};

export const renderDiscussionThreads = (threads: DiscussionThread[], ctx: DiscussionRenderContext) =>
  `<div class="discussion-threads" data-discussion-threads>${threads
    .map(thread => renderThreadSection(thread, ctx))
    .join('')}</div>`;

/** "2 threads · 5 comments · most recent activity first" */
export const renderDiscussionSummary = (
  { threadCount, commentCount }: { threadCount: number; commentCount: number },
  t: TFunction,
  extraHtml = ''
) =>
  `<p class="discussion-summary">${escapeHtml(t('discussion.threadCount', { count: threadCount }))} · ${escapeHtml(
    t('forum.thread.commentCount', { count: commentCount })
  )} · ${escapeHtml(t('discussion.order'))}${extraHtml}</p>`;

const renderDiscussionNewer = (
  target: DiscussionTarget,
  { page }: { page: number },
  t: TFunction
) => `<nav class="discussion-pager" data-discussion-newer-nav aria-label="${escapeHtml(t('discussion.pages'))}">${page > 1
  ? `<a href="${escapeHtml(discussionPagePath(target, page - 1))}" rel="prev" data-discussion-newer>${escapeHtml(t('discussion.loadNewer'))}</a>` : ''}</nav>`;

const renderDiscussionPager = (
  target: DiscussionTarget,
  { page, pageCount, threadIds }: { page: number; pageCount: number; threadIds: string[] },
  t: TFunction
) => `<nav class="discussion-pager" aria-label="${escapeHtml(t('discussion.pages'))}" data-discussion-pager
  data-thread-ids="${escapeHtml(JSON.stringify(threadIds))}" data-page="${page}" data-page-size="${DISCUSSION_PAGE_SIZE}"
  data-newer-label="${escapeHtml(t('discussion.loadNewer'))}" data-older-label="${escapeHtml(t('discussion.loadOlder'))}"
  data-automatic-label="${escapeHtml(t('discussion.automatic'))}"
  data-loading-label="${escapeHtml(t('discussion.loading'))}"
  data-error-label="${escapeHtml(t('discussion.loadError'))}"
  data-range-label="${escapeHtml(t('discussion.loadedRange', { start: '{start}', end: '{end}', total: '{total}' }))}"
  data-no-newer-label="${escapeHtml(t('discussion.noNewer'))}"
  data-end-label="${escapeHtml(t('discussion.noOlder'))}">
  <span data-discussion-range role="status" aria-live="polite" aria-atomic="true">${escapeHtml(t('discussion.pageOf', { page, count: pageCount }))}</span>
  ${page < pageCount ? `<a href="${escapeHtml(discussionPagePath(target, page + 1))}" rel="next" data-discussion-older>${escapeHtml(t('discussion.loadOlder'))}</a>` : `<span data-discussion-end>${escapeHtml(t('discussion.noOlder'))}</span>`}
</nav>`;

export const renderPaginatedDiscussion = (discussion: DiscussionPage, ctx: DiscussionRenderContext) =>
  `${renderDiscussionNewer(ctx.target, discussion, ctx.t)}
  ${renderDiscussionThreads(discussion.threads, ctx)}
  ${renderDiscussionPager(ctx.target, discussion, ctx.t)}`;

export interface StartThreadValues {
  title: string;
  body: string;
  language: string;
}

/** The form to start a thread: a title is required. */
export const renderStartThreadForm = ({
  action,
  t,
  languageOptions,
  values,
  errorMessage,
  previewHtml,
  hiddenFields = {},
}: {
  action: string;
  t: TFunction;
  languageOptions: LanguageOption[];
  values: StartThreadValues;
  errorMessage?: string;
  previewHtml?: string;
  hiddenFields?: Record<string, string>;
}) => {
  const hidden = Object.entries(hiddenFields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join('');
  return `<section class="form-card discussion-start" id="start-thread">
  <h2>${escapeHtml(t('discussion.startThread'))}</h2>
  ${errorMessage ? `<div class="form-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
  <form method="post" action="${escapeHtml(action)}" class="forum-compose-form" id="discussion-thread-form">
    ${hidden}
    <label class="form-field">
      <span>${escapeHtml(t('discussion.titleLabel'))}</span>
      <input type="text" name="title" value="${escapeHtml(values.title)}" maxlength="200" required placeholder="${escapeHtml(
        t('discussion.titlePlaceholder')
      )}" />
    </label>
    <label class="form-field">
      <span>${escapeHtml(t('discussion.commentLabel'))}</span>
      <textarea id="discussion-thread-body" name="body" rows="5" required data-markdown-preview-field data-mention-suggest placeholder="${escapeHtml(
        t('discussion.commentPlaceholder')
      )}">${escapeHtml(values.body)}</textarea>
    </label>
    ${renderMarkdownPreviewPanel({
      formId: 'discussion-thread-form',
      previewId: 'discussion-thread-preview',
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
          selected: values.language,
          name: 'language',
          idPrefix: 'discussion-thread-language',
          label: t('forum.compose.language'),
          prefixLabel: t('language.selector'),
        })}
        <button type="submit" name="intent" value="post">${escapeHtml(t('discussion.post'))}</button>
      </div>
      <noscript>
        <button type="submit" name="intent" value="preview">${escapeHtml(t('common.actions.preview'))}</button>
      </noscript>
    </div>
  </form>
</section>`;
};

/** Why the reader cannot post here, or nothing when they can. */
export const renderPostingGate = (t: TFunction, { signedIn, canPost }: { signedIn: boolean; canPost: boolean }) =>
  !signedIn
    ? `<p class="discussion-gate">${escapeHtml(t('forum.signInToPost'))}</p>`
    : !canPost
      ? `<p class="discussion-gate">${escapeHtml(t('forum.verifyEmailToPost'))}</p>`
      : '';

export const discussionLinkHtml = (target: DiscussionTarget, label: string) =>
  `<a href="${escapeHtml(discussionPath(target))}">${escapeHtml(label)}</a>`;
