import type { TFunction } from 'i18next';

import { escapeHtml, formatDateUTC } from '../../render.js';
import {
  type PageSignoffResult,
  SIGNOFF_STANCES,
  type SignoffStance,
} from '../../services/page-signoff-service.js';

type PageSignoffsParams = {
  slug: string;
  currentRevId: string;
  signoffs: PageSignoffResult[];
  userMap: Map<string, string>;
  viewerId: string | null;
  canSignOff: boolean;
  t: TFunction;
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
      const commentHtml = signoff.comment
        ? `<blockquote class="page-signoff-comment">${escapeHtml(signoff.comment)}</blockquote>`
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
    : `<p class="page-signoff-empty">${escapeHtml(t('signoff.empty'))}</p>`;

  const own = viewerId ? signoffs.find(signoff => signoff.userId === viewerId) : undefined;
  const action = escapeHtml(pageSignoffPath(slug));
  const stanceOptions = SIGNOFF_STANCES.map(
    stance => `<label class="page-signoff-option">
    <input type="radio" name="stance" value="${stance}" id="page-signoff-stance-${stance}"${
      (own?.stance ?? '') === stance ? ' checked' : ''
    } required> ${escapeHtml(stanceLabel(stance, t))}
  </label>`
  ).join('');
  const withdrawHtml = own
    ? `<form class="page-signoff-form page-signoff-form--withdraw" method="post" action="${action}">
  <input type="hidden" name="intent" value="withdraw">
  <button type="submit">${escapeHtml(t('signoff.withdraw'))}</button>
</form>`
    : '';
  const formHtml = !canSignOff
    ? ''
    : `<form class="page-signoff-form" method="post" action="${action}">
  <input type="hidden" name="intent" value="signoff">
  <fieldset class="page-signoff-stances">
    <legend>${escapeHtml(t(own ? 'signoff.changeLegend' : 'signoff.legend'))}</legend>
    ${stanceOptions}
  </fieldset>
  <label for="page-signoff-comment">${escapeHtml(t('signoff.commentLabel'))}</label>
  <textarea id="page-signoff-comment" name="comment" rows="3" maxlength="2000">${escapeHtml(
    own?.comment ?? ''
  )}</textarea>
  <button type="submit">${escapeHtml(t(own ? 'signoff.update' : 'signoff.submit'))}</button>
</form>
${withdrawHtml}`;

  return `<section class="page-signoffs" aria-labelledby="page-signoffs-title">
  <h2 id="page-signoffs-title">${escapeHtml(t('signoff.title'))}</h2>
  <p class="page-signoff-intro">${escapeHtml(t('signoff.intro'))}</p>
  ${summaryHtml}
  ${listHtml}
  ${formHtml}
</section>`;
};
