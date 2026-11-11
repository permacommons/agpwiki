import type { TFunction } from 'i18next';

import { commentAnchor, discussionPath, positionAnchor } from '../../lib/discussion-paths.js';
import { forumCommentDeletePath, forumCommentHistoryPath } from '../../lib/forum-paths.js';
import { linkMentionsInEscapedText, type MentionMap } from '../../lib/mentions.js';
import { encodeSlugPath } from '../../lib/slug.js';
import { escapeHtml, formatDateUTC } from '../../render.js';
import {
  type PageSignoffResult,
  SIGNOFF_STANCES,
  type SignoffStance,
} from '../../services/page-signoff-service.js';
import type { PositionReply } from '../../services/position-reply-service.js';
import { renderCommentMeta, renderFollowThread, renderReplyForm } from './discussion.js';
import { renderFormLanguageSelector } from './form-language-selector.js';
import { renderForumCommentEditLink, renderForumCommentEditor } from './forum-comment-editor.js';

type PageSignoffsParams = {
  slug: string;
  currentRevId: string;
  changedRevIds?: Set<string>;
  signoffs: PageSignoffResult[];
  userMap: Map<string, string>;
  viewerId: string | null;
  followedThreadIds?: Set<string>;
  canSignOff: boolean;
  // Replies are forum posts: posting needs a confirmed email address.
  canReply?: boolean;
  t: TFunction;
  language: string;
  languageOptions: Array<{ code: string; label: string }>;
  replies?: Map<string, { threadId: string; replies: RenderedPositionReply[] }>;
  // Withdrawn positions that people had replied to: shown with their replies,
  // without a reply form.
  withdrawn?: PageSignoffResult[];
  // Usernames, so a reply to a reply can start with @username.
  usernames?: Map<string, string>;
  // Usernames mentioned in position comments, linked to their profiles.
  mentions?: MentionMap;
  isModerator?: boolean;
  // The position whose reply form is open without JavaScript, or after an error.
  openReply?: { signoffId: string; body?: string; language?: string; errorMessage?: string };
  // Off on the discussion page itself, where the link would lead to itself.
  showDiscussionLink?: boolean;
  locale?: string;
};

/** A reply to a position, with its Markdown already rendered by the route. */
export type RenderedPositionReply = PositionReply & { bodyHtml: string };

export const pageSignoffPath = (slug: string) => `/${encodeSlugPath(slug)}/sign-off`;
export const positionReplyPath = (slug: string) => `/${encodeSlugPath(slug)}/position-reply`;

// Plain text with clickable web links and @mentions. The text is escaped
// first, so the links can only come from http(s) URLs and usernames in it.
export const renderPlainTextWithLinks = (text: string, mentions?: MentionMap) =>
  linkMentionsInEscapedText(
    escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, url => {
      const trailing = /(?:[.,;:!?)]|&quot;|&#39;|&#039;|&gt;)+$/.exec(url)?.[0] ?? '';
      const href = trailing ? url.slice(0, -trailing.length) : url;
      return `<a href="${href}" rel="nofollow ugc noopener">${href}</a>${trailing}`;
    }),
    mentions
  );

const stanceLabel = (stance: SignoffStance, t: TFunction) => t(`signoff.stance.${stance}`);

export const renderPageSignoffs = ({
  slug,
  currentRevId,
  changedRevIds,
  signoffs,
  userMap,
  viewerId,
  followedThreadIds = new Set(),
  canSignOff,
  canReply = canSignOff,
  t,
  language,
  languageOptions,
  replies,
  withdrawn = [],
  usernames = new Map(),
  mentions,
  isModerator = false,
  openReply,
  showDiscussionLink = true,
  locale = 'en',
}: PageSignoffsParams): string => {
  const pagePath = `/${encodeSlugPath(slug)}`;
  const discussion = discussionPath({ kind: 'page', slug });
  const replyAction = positionReplyPath(slug);
  const languageLabelFor = (code: string | null) =>
    code ? (languageOptions.find(option => option.code === code)?.label ?? code) : null;
  // Positions and their replies are on the first page of the discussion, so
  // their links need no thread in the address.
  const commentLink = (id: string) => `${discussion}#${commentAnchor(id)}`;
  const replyTrigger = (signoff: PageSignoffResult, mention?: string) => {
    if (!canReply || !signoff.comment || signoff.withdrawnAt) return '';
    const href = `${discussion}?reply=${encodeURIComponent(signoff.id)}#reply-form-${encodeURIComponent(signoff.id)}`;
    return `<a href="${escapeHtml(href)}" data-reply-to="${escapeHtml(positionAnchor(signoff.id))}" data-reply-action="${escapeHtml(
      replyAction
    )}" data-reply-fields="${escapeHtml(JSON.stringify({ signoffId: signoff.id }))}"${
      mention ? ` data-reply-mention="${escapeHtml(mention)}"` : ''
    } data-plain-click>${escapeHtml(t('discussion.reply'))}</a>`;
  };
  const renderReply = (reply: RenderedPositionReply, signoff: PageSignoffResult) => {
    const name = (reply.authorId && userMap.get(reply.authorId)) || t('signoff.unknownUser');
    const own = Boolean(viewerId && viewerId === reply.authorId);
    const permalink = commentLink(reply.id);
    const editHtml = own
      ? renderForumCommentEditor({
          commentId: reply.id, body: reply.body, language: reply.bodyLanguage ?? language,
          languageOptions, returnPath: permalink, t, hidden: true,
        })
      : '';
    const editedHtml = reply.edited
      ? ` <span class="discussion-edited">· <a href="${escapeHtml(forumCommentHistoryPath(reply.id))}">${escapeHtml(t('forum.comment.edited'))}</a></span>`
      : '';
    const deleteHtml = isModerator
      ? `<form method="post" action="${escapeHtml(forumCommentDeletePath(reply.id))}" class="forum-inline-form"><button type="submit">${escapeHtml(
          t('forum.comment.delete')
        )}</button></form>`
      : '';
    return `<article class="discussion-comment discussion-comment--reply page-signoff-reply" id="${commentAnchor(reply.id)}" data-comment-edit>
  ${renderCommentMeta(name, reply.createdAt, editedHtml, locale)}
  <div class="discussion-comment-body" data-comment-content${reply.bodyLanguage ? ` lang="${escapeHtml(reply.bodyLanguage)}"` : ''} dir="auto">${reply.bodyHtml}</div>
  <div class="discussion-comment-actions" data-comment-actions>
    ${replyTrigger(signoff, reply.authorId ? usernames.get(reply.authorId) : undefined)}
    <a href="${escapeHtml(permalink)}" data-permalink data-plain-click>${escapeHtml(t('discussion.commentLink'))}</a>
    ${own ? renderForumCommentEditLink(reply.id, permalink, t) : ''}
    ${deleteHtml}
  </div>
  ${editHtml}
</article>`;
  };
  const renderReplies = (signoff: PageSignoffResult) => {
    const thread = replies?.get(signoff.id);
    const formHtml =
      openReply?.signoffId === signoff.id && canReply && signoff.comment && !signoff.withdrawnAt
        ? `<div id="reply-form-${escapeHtml(signoff.id)}">${renderReplyForm({
            action: replyAction,
            fields: { signoffId: signoff.id },
            idPrefix: `page-signoff-reply-language-${signoff.id}`,
            language: openReply.language ?? language,
            languageOptions,
            t,
            body: openReply.body,
            errorMessage: openReply.errorMessage,
            cancelHref: `${discussion}#${positionAnchor(signoff.id)}`,
          })}</div>`
        : '';
    return `<div class="discussion-replies" data-replies="${escapeHtml(positionAnchor(signoff.id))}">${(thread?.replies ?? [])
      .map(reply => renderReply(reply, signoff))
      .join('')}${formHtml}</div>`;
  };
  const renderPosition = (signoff: PageSignoffResult) => {
    const name = userMap.get(signoff.userId) ?? t('signoff.unknownUser');
    const revisionLink = `<a href="${pagePath}?rev=${encodeURIComponent(signoff.revId)}">${escapeHtml(
      t('signoff.signedRevision')
    )}</a>`;
    const changedHtml =
      !(changedRevIds ? changedRevIds.has(signoff.revId) : signoff.revId !== currentRevId)
        ? ''
        : ` · <span class="page-signoff-changed">${escapeHtml(t('signoff.changedSince'))}</span> <a href="${pagePath}?diffFrom=${encodeURIComponent(
            signoff.revId
          )}&diffTo=${encodeURIComponent(currentRevId)}">${escapeHtml(t('signoff.viewChanges'))}</a>`;
    const withdrawnHtml = signoff.withdrawnAt
      ? ` · <span class="page-signoff-changed">${escapeHtml(t('forum.position.withdrawn'))}</span>`
      : '';
    const commentLanguage = signoff.commentLanguage;
    const languageLabel = languageLabelFor(commentLanguage);
    const commentHtml = signoff.comment
      ? `<div class="discussion-comment-body page-signoff-comment" dir="auto"${commentLanguage ? ` lang="${escapeHtml(commentLanguage)}"` : ''}>${renderPlainTextWithLinks(signoff.comment, mentions)}</div>${languageLabel ? `<p class="page-signoff-language">${escapeHtml(languageLabel)}</p>` : ''}`
      : '';
    const positionLink = `${discussion}#${positionAnchor(signoff.id)}`;
    const actionsHtml = signoff.comment
      ? `<div class="discussion-comment-actions">${replyTrigger(signoff)}<a href="${escapeHtml(
          positionLink
        )}" data-permalink data-plain-click>${escapeHtml(t('discussion.commentLink'))}</a></div>`
      : '';
    const thread = replies?.get(signoff.id);
    const subscriptionHtml = thread ? renderFollowThread({ id: thread.threadId }, {
      viewer: { userId: viewerId, followedThreadIds }, t,
    }) : '';
    const metaHtml = `<span class="page-signoff-stance page-signoff-stance--${signoff.stance}">${escapeHtml(
      stanceLabel(signoff.stance, t)
    )}</span> <strong class="discussion-author">${escapeHtml(name)}</strong> <span class="discussion-date" title="${escapeHtml(
      formatDateUTC(signoff.signedAt)
    )}">· ${escapeHtml(
      signoff.signedAt
        ? signoff.signedAt.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
        : ''
    )} · ${revisionLink}${changedHtml}${withdrawnHtml}</span>${subscriptionHtml}`;
    return `<article class="discussion-comment page-signoff${signoff.withdrawnAt ? ' page-signoff--withdrawn' : ''}" id="${positionAnchor(signoff.id)}">
  <div class="discussion-comment-meta page-signoff-meta">${metaHtml}</div>
  ${commentHtml}
  ${actionsHtml}
</article>${renderReplies(signoff)}`;
  };
  const items = [...signoffs, ...withdrawn].map(renderPosition).join('');

  const counts = SIGNOFF_STANCES.map(stance => ({
    stance,
    count: signoffs.filter(signoff => signoff.stance === stance).length,
  }));
  const summaryHtml = signoffs.length
    ? `<p class="page-signoff-summary">${counts
        .map(
          ({ stance, count }) =>
            `<span class="page-signoff-stance page-signoff-stance--${stance}">${escapeHtml(
              t(`signoff.count.${stance}`, { count })
            )}</span>`
        )
        .join(' ')}</p>`
    : '';

  const listHtml = items
    ? `<div class="page-signoff-list">${items}</div>`
    : canSignOff ? '' : `<p class="page-signoff-empty">${escapeHtml(t('signoff.empty'))}</p>`;

  const own = viewerId ? signoffs.find(signoff => signoff.userId === viewerId) : undefined;
  const action = escapeHtml(pageSignoffPath(slug));
  const selectedLanguage = own?.commentLanguage ?? language;
  const stanceOptions = SIGNOFF_STANCES.map(
    stance => `<label class="page-signoff-option">
    <input type="radio" name="stance" value="${stance}" id="page-signoff-stance-${stance}"${
      (own?.stance ?? '') === stance ? ' checked' : ''
    } required> ${escapeHtml(stanceLabel(stance, t))}
  </label>`
  ).join('');
  const withdrawHtml = own
    ? `<button class="page-signoff-withdraw" type="submit" name="intent" value="withdraw" formnovalidate>${escapeHtml(t('signoff.withdraw'))}</button>`
    : '';
  const formHtml = !canSignOff
    ? ''
    : `<form class="page-signoff-form" method="post" action="${action}">
  <textarea id="page-signoff-comment" name="comment" rows="2" dir="auto" data-mention-suggest
    aria-label="${escapeHtml(t('signoff.commentLabel'))}"
    placeholder="${escapeHtml(t('signoff.commentLabel'))}">${escapeHtml(own?.comment ?? '')}</textarea>
  <div class="form-actions page-signoff-actions">
    <fieldset class="page-signoff-stances" aria-label="${escapeHtml(t('signoff.legend'))}">
      ${stanceOptions}
    </fieldset>
    ${renderFormLanguageSelector({
      languageOptions,
      selected: selectedLanguage,
      name: 'commentLanguage',
      idPrefix: 'page-signoff-language',
      label: t('signoff.language'),
      prefixLabel: t('language.selector'),
    })}
    <button type="submit" name="intent" value="signoff">${escapeHtml(t(own ? 'signoff.update' : 'signoff.submit'))}</button>
    ${withdrawHtml}
  </div>
</form>`;

  return `<section class="page-signoffs" aria-labelledby="page-signoffs-title">
  <div class="page-signoff-header">
    <h2 id="page-signoffs-title">${escapeHtml(t('signoff.title'))}</h2>
    ${showDiscussionLink ? `<a href="${escapeHtml(discussion)}">${escapeHtml(t('signoff.discussion'))}</a>` : ''}
  </div>
  ${summaryHtml}
  ${listHtml}
  ${canSignOff && !canReply && items ? `<p class="form-help page-signoff-reply-gate">${escapeHtml(t('forum.verifyEmailToPost'))}</p>` : ''}
  ${formHtml}
</section>`;
};
