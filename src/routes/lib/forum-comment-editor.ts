import type { TFunction } from 'i18next';
import { forumCommentEditPath } from '../../lib/forum-paths.js';
import { escapeHtml, type LanguageOption } from '../../render.js';
import { renderFormLanguageSelector } from './form-language-selector.js';

export const renderForumCommentEditLink = (commentId: string, returnPath: string, t: TFunction) =>
  `<a href="${escapeHtml(`${forumCommentEditPath(commentId)}?return=${encodeURIComponent(returnPath)}`)}" data-comment-edit-link>${escapeHtml(t('forum.comment.edit'))}</a>`;

export const renderForumCommentEditor = ({
  commentId, body, language, languageOptions, returnPath, t, hidden = false,
}: {
  commentId: string;
  body: string;
  language: string;
  languageOptions: LanguageOption[];
  returnPath: string;
  t: TFunction;
  hidden?: boolean;
}) => `<form method="post" action="${escapeHtml(forumCommentEditPath(commentId))}" class="forum-comment-editor" data-comment-editor${hidden ? ' hidden' : ''}>
  <input type="hidden" name="return" value="${escapeHtml(returnPath)}" />
  <textarea name="body" rows="6" dir="auto" required aria-label="${escapeHtml(t('forum.compose.body'))}">${escapeHtml(body)}</textarea>
  <div class="form-actions">
    ${renderFormLanguageSelector({
      languageOptions, selected: language, name: 'language', idPrefix: `comment-edit-language-${commentId}`,
      label: t('forum.compose.language'), prefixLabel: t('language.selector'),
    })}
    <button type="submit">${escapeHtml(t('forum.comment.save'))}</button>
    <a href="${escapeHtml(returnPath)}" data-comment-edit-cancel>${escapeHtml(t('common.actions.cancel'))}</a>
  </div>
</form>`;
