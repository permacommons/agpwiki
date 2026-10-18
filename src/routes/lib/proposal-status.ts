import type { TFunction } from 'i18next';
import dal from 'rev-dal';

import {
  DECISION_STATUSES,
  PROPOSAL_STATUSES,
  type ProposalStatus,
  type ProposalStatusInfo,
} from '../../lib/proposal-status.js';
import { escapeHtml, renderText, type SafeText } from '../../render.js';
import type { PullRequestInfo } from '../../services/pull-request-state.js';

const { mlString } = dal;

export const proposalStatusPath = (slug: string) => `/${encodeURIComponent(slug)}/proposal-status`;

const formatDay = (iso: string | undefined, locale: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

const linkFor = (target: string) =>
  /^https?:\/\//.test(target)
    ? `<a href="${escapeHtml(target)}" rel="noopener">${escapeHtml(target.replace(/^https?:\/\/(www\.)?github\.com\//, ''))}</a>`
    : `<a href="/${escapeHtml(target)}">${escapeHtml(target)}</a>`;

export const renderProposalBanner = ({
  info,
  userMap,
  locale,
  contentLang,
  t,
}: {
  info: ProposalStatusInfo | null;
  userMap: Map<string, string>;
  locale: string;
  contentLang: string;
  t: TFunction;
}): string => {
  if (!info) {
    return `<aside class="proposal-banner proposal-banner--none" role="note"><strong>${escapeHtml(
      t('proposalStatus.noStatus')
    )}</strong></aside>`;
  }
  const status = info.status;
  const by = (id: string | undefined) => (id ? (userMap.get(id) ?? '') : '');
  const parts: string[] = [];
  if (info.decidedAt && DECISION_STATUSES.includes(status) && status !== 'applied') {
    parts.push(escapeHtml(t('proposalStatus.decided', { date: formatDay(info.decidedAt, locale), name: by(info.decidedBy) })));
  }
  if (status === 'applied') {
    parts.push(
      `${escapeHtml(t('proposalStatus.appliedTo', { date: formatDay(info.appliedAt, locale) }))} ${(info.appliedTo ?? []).map(linkFor).join(', ')}`
    );
    if (info.decidedAt) {
      parts.push(escapeHtml(t('proposalStatus.decided', { date: formatDay(info.decidedAt, locale), name: by(info.decidedBy) })));
    }
  }
  if (status === 'superseded' && info.supersededBy) {
    parts.push(`${escapeHtml(t('proposalStatus.supersededBy'))} ${linkFor(info.supersededBy)}`);
  }
  if (!DECISION_STATUSES.includes(status)) {
    parts.push(escapeHtml(t('proposalStatus.since', { date: formatDay(info.changedAt, locale) })));
  }
  const note = info.decisionNote ? mlString.resolve(contentLang, info.decisionNote)?.str : null;
  return `<aside class="proposal-banner proposal-banner--${status}" role="note">
  <div><strong>${escapeHtml(t(`proposalStatus.status.${status}`))}</strong>${parts.length ? ` · ${parts.join(' · ')}` : ''}</div>
  ${note ? `<p class="proposal-banner-note">${escapeHtml(note)}</p>` : ''}
</aside>`;
};

export const renderProposalStatusForm = ({
  slug,
  info,
  isAdmin,
  contentLang,
  t,
}: {
  slug: string;
  info: ProposalStatusInfo | null;
  isAdmin: boolean;
  contentLang: string;
  t: TFunction;
}): string => {
  const allowed = PROPOSAL_STATUSES.filter(status => isAdmin || !DECISION_STATUSES.includes(status));
  const options = allowed
    .map(
      (status: ProposalStatus) =>
        `<option value="${status}"${info?.status === status ? ' selected' : ''}>${escapeHtml(
          t(`proposalStatus.status.${status}`)
        )}</option>`
    )
    .join('');
  const decisionFields = isAdmin
    ? `<label class="form-field">
      <span>${escapeHtml(t('proposalStatus.form.decisionNote'))}</span>
      <textarea name="decisionNote" rows="2" maxlength="2000"></textarea>
    </label>
    <label class="form-field">
      <span>${escapeHtml(t('proposalStatus.form.appliedTo'))}</span>
      <textarea name="appliedTo" rows="2" placeholder="meta/values&#10;https://github.com/permacommons/agpwiki/pull/84"></textarea>
    </label>
    <label class="form-field">
      <span>${escapeHtml(t('proposalStatus.form.supersededBy'))}</span>
      <input type="text" name="supersededBy" maxlength="200" placeholder="meta/proposals/…" />
    </label>`
    : '';
  return `<details class="proposal-status-form">
  <summary>${escapeHtml(t('proposalStatus.form.title'))}</summary>
  <form method="post" action="${escapeHtml(proposalStatusPath(slug))}">
    <input type="hidden" name="lang" value="${escapeHtml(contentLang)}" />
    <label class="form-field">
      <span>${escapeHtml(t('proposalStatus.form.status'))}</span>
      <select name="status">${options}</select>
    </label>
    ${decisionFields}
    <p class="form-help">${escapeHtml(t(isAdmin ? 'proposalStatus.form.helpAdmin' : 'proposalStatus.form.helpAuthor'))}</p>
    <button type="submit">${escapeHtml(t('proposalStatus.form.save'))}</button>
  </form>
</details>`;
};

export const proposalLinksPath = (slug: string) => `/${encodeURIComponent(slug)}/proposal-links`;

export const renderProposalLinks = ({
  slug,
  pullRequests,
  parent,
  parts,
  canEdit,
  contentLang,
  t,
}: {
  slug: string;
  pullRequests: PullRequestInfo[];
  parent: { slug: string; title: string | SafeText } | null;
  parts: Array<{ slug: string; title: string | SafeText; status: ProposalStatus | null }>;
  canEdit: boolean;
  contentLang: string;
  t: TFunction;
}): string => {
  const rows: string[] = [];
  if (pullRequests.length) {
    const items = pullRequests
      .map(
        pr =>
          `<li><a href="${escapeHtml(pr.url)}" rel="noopener"${pr.title ? ` title="${escapeHtml(pr.title)}"` : ''}>#${pr.number}</a> <span class="pr-state pr-state--${pr.state}">${escapeHtml(t(`proposalLinks.state.${pr.state}`))}</span></li>`
      )
      .join('');
    rows.push(`<div><dt>${escapeHtml(t('proposalLinks.pullRequests'))}</dt><dd><ul class="proposal-pr-list">${items}</ul></dd></div>`);
  }
  if (parent) {
    rows.push(
      `<div><dt>${escapeHtml(t('proposalLinks.partOf'))}</dt><dd><a href="/${escapeHtml(parent.slug)}">${renderText(parent.title)}</a></dd></div>`
    );
  }
  if (parts.length) {
    const items = parts
      .map(
        part =>
          `<li><a href="/${escapeHtml(part.slug)}">${renderText(part.title)}</a> <span class="proposal-part-status">${escapeHtml(
            part.status ? t(`proposalStatus.status.${part.status}`) : t('proposalStatus.noStatus')
          )}</span></li>`
      )
      .join('');
    rows.push(`<div><dt>${escapeHtml(t('proposalLinks.parts'))}</dt><dd><ul class="proposal-parts-list">${items}</ul></dd></div>`);
  }
  const form = canEdit
    ? `<details class="proposal-links-form">
  <summary>${escapeHtml(t('proposalLinks.form.title'))}</summary>
  <form method="post" action="${escapeHtml(proposalLinksPath(slug))}">
    <input type="hidden" name="lang" value="${escapeHtml(contentLang)}" />
    <label class="form-field">
      <span>${escapeHtml(t('proposalLinks.form.pullRequests'))}</span>
      <textarea name="pullRequests" rows="3" placeholder="https://github.com/permacommons/agpwiki/pull/87">${escapeHtml(
        pullRequests.map(pr => pr.url).join('\n')
      )}</textarea>
    </label>
    <label class="form-field">
      <span>${escapeHtml(t('proposalLinks.form.parent'))}</span>
      <input type="text" name="parent" maxlength="200" placeholder="meta/proposals/…" value="${escapeHtml(parent?.slug ?? '')}" />
    </label>
    <button type="submit">${escapeHtml(t('proposalLinks.form.save'))}</button>
  </form>
</details>`
    : '';
  if (!rows.length && !form) return '';
  return `<section class="proposal-links" aria-label="${escapeHtml(t('proposalLinks.label'))}">${
    rows.length ? `<dl>${rows.join('')}</dl>` : ''
  }${form}</section>`;
};
