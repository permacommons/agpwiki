import type { TFunction } from 'i18next';

import {
  forumCategoryPagePath,
  forumCommentHistoryPath,
  forumThreadPath,
} from '../../lib/forum-paths.js';
import { escapeHtml, formatDateUTC } from '../../render.js';
import {
  type PageSignoffResult,
  SIGNOFF_STANCES,
  type SignoffStance,
} from '../../services/page-signoff-service.js';
import type { PositionReply } from '../../services/position-reply-service.js';
import { renderFormLanguageSelector } from './form-language-selector.js';
import { renderForumCommentEditLink, renderForumCommentEditor } from './forum-comment-editor.js';

type PageSignoffsParams = {
  slug: string;
  currentRevId: string;
  changedRevIds?: Set<string>;
  signoffs: PageSignoffResult[];
  userMap: Map<string, string>;
  viewerId: string | null;
  canSignOff: boolean;
  // Replies are forum posts: posting needs a confirmed email address.
  canReply?: boolean;
  t: TFunction;
  language: string;
  languageOptions: Array<{ code: string; label: string }>;
  replies?: Map<string, { threadId: string; replies: RenderedPositionReply[] }>;
};

/** A reply to a position, with its Markdown already rendered by the route. */
export type RenderedPositionReply = PositionReply & { bodyHtml: string };

export const pageSignoffPath = (slug: string) => `/${encodeURIComponent(slug)}/sign-off`;
export const positionReplyPath = (slug: string) => `/${encodeURIComponent(slug)}/position-reply`;

// Plain text with clickable web links. The text is escaped first, so the
// links can only come from http(s) URLs written in it.
export const renderPlainTextWithLinks = (text: string) =>
  escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, url => {
    const trailing = /(?:[.,;:!?)]|&quot;|&#39;|&#039;|&gt;)+$/.exec(url)?.[0] ?? '';
    const href = trailing ? url.slice(0, -trailing.length) : url;
    return `<a href="${href}" rel="nofollow ugc noopener">${href}</a>${trailing}`;
  });

const stanceLabel = (stance: SignoffStance, t: TFunction) => t(`signoff.stance.${stance}`);

export const renderPageSignoffs = ({
  slug,
  currentRevId,
  changedRevIds,
  signoffs,
  userMap,
  viewerId,
  canSignOff,
  canReply = canSignOff,
  t,
  language,
  languageOptions,
  replies,
}: PageSignoffsParams): string => {
  const pagePath = `/${encodeURIComponent(slug)}`;
  const replyAction = escapeHtml(positionReplyPath(slug));
  const languageLabelFor = (code: string | null) =>
    code ? (languageOptions.find(option => option.code === code)?.label ?? code) : null;
  const languageSelector = (selected: string, idPrefix: string) =>
    renderFormLanguageSelector({
      languageOptions,
      selected,
      name: 'language',
      idPrefix,
      label: t('signoff.language'),
      prefixLabel: t('language.selector'),
    });
  const renderReply = (reply: RenderedPositionReply) => {
    const name = (reply.authorId && userMap.get(reply.authorId)) || t('signoff.unknownUser');
    const own = Boolean(viewerId && viewerId === reply.authorId);
    const returnPath = `${pagePath}#reply-${reply.id}`;
    const editHtml = own
      ? renderForumCommentEditor({
          commentId: reply.id, body: reply.body, language: reply.bodyLanguage ?? language,
          languageOptions, returnPath, t, hidden: true,
        })
      : '';
    const editedHtml = reply.edited
      ? ` · <a href="${escapeHtml(forumCommentHistoryPath(reply.id))}">${escapeHtml(t('forum.comment.edited'))}</a>`
      : '';
    return `<li class="page-signoff-reply" id="reply-${escapeHtml(reply.id)}" data-comment-edit>
    <div class="page-signoff-reply-meta"><strong>${escapeHtml(name)}</strong> · ${escapeHtml(
      formatDateUTC(reply.createdAt)
    )}${editedHtml}</div>
    <div class="page-signoff-reply-body" data-comment-content${reply.bodyLanguage ? ` lang="${escapeHtml(reply.bodyLanguage)}"` : ''} dir="auto">${reply.bodyHtml}</div>
    ${own ? `<div class="page-signoff-reply-actions" data-comment-actions>${renderForumCommentEditLink(reply.id, returnPath, t)}</div>` : ''}
    ${editHtml}
  </li>`;
  };
  const renderReplies = (signoff: PageSignoffResult) => {
    if (!signoff.comment) return '';
    const thread = replies?.get(signoff.id);
    const listHtml = thread?.replies.length
      ? `<ul class="page-signoff-replies">${thread.replies.map(renderReply).join('')}</ul>
  <p class="page-signoff-thread-link"><a href="${escapeHtml(forumThreadPath(thread.threadId))}">${escapeHtml(
    t('signoff.reply.openInForum')
  )}</a></p>`
      : '';
    const formHtml = !canReply
      ? canSignOff
        ? `<p class="form-help page-signoff-reply-gate">${escapeHtml(t('forum.verifyEmailToPost'))}</p>`
        : ''
      : `<details class="page-signoff-reply-form">
    <summary>${escapeHtml(t('signoff.reply.open'))}</summary>
    <form method="post" action="${replyAction}">
      <input type="hidden" name="signoffId" value="${escapeHtml(signoff.id)}" />
      <textarea name="body" rows="2" dir="auto" required aria-label="${escapeHtml(t('signoff.reply.label'))}" placeholder="${escapeHtml(
        t('signoff.reply.placeholder')
      )}"></textarea>
      <div class="form-actions">
        ${languageSelector(language, `page-signoff-reply-language-${signoff.id}`)}
        <button type="submit">${escapeHtml(t('signoff.reply.submit'))}</button>
      </div>
    </form>
  </details>`;
    return listHtml || formHtml ? `<div class="page-signoff-thread">${listHtml}${formHtml}</div>` : '';
  };
  const items = signoffs
    .map(signoff => {
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
      const commentLanguage = signoff.commentLanguage;
      const languageLabel = languageLabelFor(commentLanguage);
      const commentHtml = signoff.comment
        ? `<blockquote class="page-signoff-comment" dir="auto"${commentLanguage ? ` lang="${escapeHtml(commentLanguage)}"` : ''}>${renderPlainTextWithLinks(signoff.comment)}</blockquote>${languageLabel ? `<p class="page-signoff-language">${escapeHtml(languageLabel)}</p>` : ''}`
        : '';
      return `<li class="page-signoff" id="position-${escapeHtml(signoff.id)}">
  <div class="page-signoff-meta"><span class="page-signoff-stance page-signoff-stance--${signoff.stance}">${escapeHtml(
    stanceLabel(signoff.stance, t)
  )}</span> <strong>${escapeHtml(name)}</strong> · ${escapeHtml(
    formatDateUTC(signoff.signedAt)
  )} · ${revisionLink}${changedHtml}</div>
  ${commentHtml}
  ${renderReplies(signoff)}
</li>`;
    })
    .join('');

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
    ? `<ul class="page-signoff-list">${items}</ul>`
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
  <textarea id="page-signoff-comment" name="comment" rows="2" dir="auto"
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
    <a href="${forumCategoryPagePath('policy', slug)}">${escapeHtml(t('signoff.discussion'))}</a>
  </div>
  ${summaryHtml}
  ${listHtml}
  ${formHtml}
</section>`;
};
