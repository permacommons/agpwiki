import type { TFunction } from 'i18next';

import { forumCategoryPagePath } from '../../lib/forum-paths.js';
import { escapeHtml, formatDateUTC } from '../../render.js';
import {
  type PageSignoffResult,
  SIGNOFF_STANCES,
  type SignoffStance,
} from '../../services/page-signoff-service.js';
import { renderFormLanguageSelector } from './form-language-selector.js';

type PageSignoffsParams = {
  slug: string;
  currentRevId: string;
  signoffs: PageSignoffResult[];
  userMap: Map<string, string>;
  viewerId: string | null;
  canSignOff: boolean;
  t: TFunction;
  language: string;
  languageOptions: Array<{ code: string; label: string }>;
};

export const pageSignoffPath = (slug: string) => `/${encodeURIComponent(slug)}/sign-off`;

const stanceLabel = (stance: SignoffStance, t: TFunction) => t(`signoff.stance.${stance}`);

export const renderPageSignoffs = ({
  slug,
  currentRevId,
  signoffs,
  userMap,
  viewerId,
  canSignOff,
  t,
  language,
  languageOptions,
}: PageSignoffsParams): string => {
  const pagePath = `/${encodeURIComponent(slug)}`;
  const items = signoffs
    .map(signoff => {
      const name = userMap.get(signoff.userId) ?? t('signoff.unknownUser');
      const revisionLink = `<a href="${pagePath}?rev=${encodeURIComponent(signoff.revId)}">${escapeHtml(
        t('signoff.signedRevision')
      )}</a>`;
      const changedHtml =
        signoff.revId === currentRevId
          ? ''
          : ` · <span class="page-signoff-changed">${escapeHtml(t('signoff.changedSince'))}</span> <a href="${pagePath}?diffFrom=${encodeURIComponent(
              signoff.revId
            )}&diffTo=${encodeURIComponent(currentRevId)}">${escapeHtml(t('signoff.viewChanges'))}</a>`;
      const commentLanguage = signoff.commentLanguage;
      const languageLabel = commentLanguage
        ? languageOptions.find(option => option.code === commentLanguage)?.label ?? commentLanguage
        : null;
      const commentHtml = signoff.comment
        ? `<blockquote class="page-signoff-comment" dir="auto"${commentLanguage ? ` lang="${escapeHtml(commentLanguage)}"` : ''}>${escapeHtml(signoff.comment)}</blockquote>${languageLabel ? `<p class="page-signoff-language">${escapeHtml(languageLabel)}</p>` : ''}`
        : '';
      return `<li class="page-signoff">
  <div class="page-signoff-meta"><span class="page-signoff-stance page-signoff-stance--${signoff.stance}">${escapeHtml(
    stanceLabel(signoff.stance, t)
  )}</span> <strong>${escapeHtml(name)}</strong> · ${escapeHtml(
    formatDateUTC(signoff.signedAt)
  )} · ${revisionLink}${changedHtml}</div>
  ${commentHtml}
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
  <textarea id="page-signoff-comment" name="comment" rows="2" maxlength="2000" dir="auto"
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
