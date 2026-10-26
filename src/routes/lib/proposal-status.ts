import type { TFunction } from 'i18next';
import dal from 'rev-dal';

import {
  DECISION_STATUSES,
  PROPOSAL_STATUSES,
  type ProposalStatus,
  type ProposalStatusInfo,
} from '../../lib/proposal-status.js';
import { encodeSlugPath } from '../../lib/slug.js';
import { escapeHtml, renderText, type SafeText } from '../../render.js';
import type { PullRequestInfo } from '../../services/pull-request-state.js';

const { mlString } = dal;

type RelatedProposal = { slug: string; title: string | SafeText };

export const proposalStatusPath = (slug: string) => `/${encodeSlugPath(slug)}/proposal-status`;
export const proposalLinksPath = (slug: string) => `/${encodeSlugPath(slug)}/proposal-links`;

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

export const renderProposalHeader = ({
  info, userMap, locale, contentLang, linksHtml, statusFormHtml, linksFormHtml, t,
}: {
  info: ProposalStatusInfo | null;
  userMap: Map<string, string>;
  locale: string;
  contentLang: string;
  linksHtml: string;
  statusFormHtml: string;
  linksFormHtml: string;
  t: TFunction;
}): string => {
  const status = info?.status ?? 'none';
  const by = (id: string | undefined) => (id ? (userMap.get(id) ?? '') : '');
  const details: string[] = [];
  if (info?.decidedAt && DECISION_STATUSES.includes(info.status)) {
    details.push(escapeHtml(t('proposalStatus.decided', {
      date: formatDay(info.decidedAt, locale), name: by(info.decidedBy),
    })));
  }
  if (info?.status === 'applied') {
    details.push(`${escapeHtml(t('proposalStatus.appliedTo', { date: formatDay(info.appliedAt, locale) }))} ${(info.appliedTo ?? []).map(linkFor).join(', ')}`);
  }
  if (info?.status === 'superseded' && info.supersededBy) {
    details.push(`${escapeHtml(t('proposalStatus.supersededBy'))} ${linkFor(info.supersededBy)}`);
  }
  if (info && !DECISION_STATUSES.includes(info.status)) {
    details.push(escapeHtml(t('proposalStatus.since', { date: formatDay(info.changedAt, locale) })));
  }
  const note = info?.decisionNote ? mlString.resolve(contentLang, info.decisionNote)?.str : null;
  const management = statusFormHtml || linksFormHtml
    ? `<details class="proposal-manage">
  <summary>${escapeHtml(t('proposalStatus.manage'))}</summary>
  <div class="proposal-management-forms">${statusFormHtml}${linksFormHtml}</div>
</details>`
    : '';
  return `<section class="proposal-header${management ? ' proposal-header--manageable' : ''}" aria-label="${escapeHtml(t('proposalStatus.overview'))}">
  <div class="proposal-status-summary">
    <span class="proposal-status-badge proposal-status--${status}">${escapeHtml(info ? t(`proposalStatus.status.${status}`) : t('proposalStatus.noStatus'))}</span>
    ${details.length ? `<span class="proposal-status-detail">${details.join(' · ')}</span>` : ''}
  </div>
  ${linksHtml}
  ${note ? `<p class="proposal-decision-note" dir="auto">${escapeHtml(note)}</p>` : ''}
  ${management}
</section>`;
};

export const renderProposalStatusForm = ({
  slug, info, isAdmin, contentLang, t,
}: {
  slug: string;
  info: ProposalStatusInfo | null;
  isAdmin: boolean;
  contentLang: string;
  t: TFunction;
}): string => {
  const allowed = PROPOSAL_STATUSES.filter(status => isAdmin || !DECISION_STATUSES.includes(status));
  const options = allowed.map((status: ProposalStatus) =>
    `<option value="${status}"${info?.status === status ? ' selected' : ''}>${escapeHtml(t(`proposalStatus.status.${status}`))}</option>`
  ).join('');
  const decisionFields = isAdmin
    ? `<label class="form-field" data-proposal-statuses="${DECISION_STATUSES.join(' ')}">
      <span>${escapeHtml(t('proposalStatus.form.decisionNote'))}</span>
      <textarea name="decisionNote" rows="3" maxlength="2000"></textarea>
    </label>
    <label class="form-field" data-proposal-statuses="applied">
      <span>${escapeHtml(t('proposalStatus.form.appliedTo'))}</span>
      <textarea name="appliedTo" rows="2" placeholder="meta/values&#10;https://github.com/permacommons/agpwiki/pull/84"></textarea>
    </label>
    <label class="form-field" data-proposal-statuses="superseded">
      <span>${escapeHtml(t('proposalStatus.form.supersededBy'))}</span>
      <input type="text" name="supersededBy" maxlength="200" placeholder="meta/proposals/…" />
    </label>`
    : '';
  return `<form class="proposal-status-form" data-proposal-status-form method="post" action="${escapeHtml(proposalStatusPath(slug))}">
  <h2 class="proposal-form-title">${escapeHtml(t('proposalStatus.form.title'))}</h2>
  <input type="hidden" name="lang" value="${escapeHtml(contentLang)}" />
  <label class="form-field">
    <span>${escapeHtml(t('proposalStatus.form.status'))}</span>
    <select name="status">${options}</select>
  </label>
  ${decisionFields}
  <p class="form-help">${escapeHtml(t(isAdmin ? 'proposalStatus.form.helpAdmin' : 'proposalStatus.form.helpAuthor'))}</p>
  <button type="submit">${escapeHtml(t('proposalStatus.form.save'))}</button>
</form>`;
};

export const renderProposalLinks = ({ pullRequests, parent, t }: {
  pullRequests: PullRequestInfo[];
  parent: RelatedProposal | null;
  t: TFunction;
}): string => {
  const rows: string[] = [];
  if (parent) {
    rows.push(`<div><dt>${escapeHtml(t('proposalLinks.partOf'))}</dt><dd><a href="/${escapeHtml(parent.slug)}">${renderText(parent.title)}</a></dd></div>`);
  }
  if (pullRequests.length) {
    const items = pullRequests.map(pr =>
      `<li><a class="proposal-pr" href="${escapeHtml(pr.url)}" rel="noopener"${pr.title ? ` title="${escapeHtml(pr.title)}"` : ''}>#${pr.number} <span class="pr-state pr-state--${pr.state}">${escapeHtml(t(`proposalLinks.state.${pr.state}`))}</span></a></li>`
    ).join('');
    rows.push(`<div><dt>${escapeHtml(t('proposalLinks.pullRequests'))}</dt><dd><ul class="proposal-pr-list">${items}</ul></dd></div>`);
  }
  return rows.length ? `<dl class="proposal-links" aria-label="${escapeHtml(t('proposalLinks.label'))}">${rows.join('')}</dl>` : '';
};

export const renderProposalLinksForm = ({ slug, pullRequests, parent, contentLang, t }: {
  slug: string;
  pullRequests: PullRequestInfo[];
  parent: RelatedProposal | null;
  contentLang: string;
  t: TFunction;
}): string => `<form class="proposal-links-form" method="post" action="${escapeHtml(proposalLinksPath(slug))}">
  <h2 class="proposal-form-title">${escapeHtml(t('proposalLinks.form.title'))}</h2>
  <input type="hidden" name="lang" value="${escapeHtml(contentLang)}" />
  <label class="form-field">
    <span>${escapeHtml(t('proposalLinks.form.pullRequests'))}</span>
    <textarea name="pullRequests" rows="3" placeholder="https://github.com/permacommons/agpwiki/pull/87">${escapeHtml(pullRequests.map(pr => pr.url).join('\n'))}</textarea>
  </label>
  <label class="form-field">
    <span>${escapeHtml(t('proposalLinks.form.parent'))}</span>
    <input type="text" name="parent" maxlength="200" placeholder="meta/proposals/…" value="${escapeHtml(parent?.slug ?? '')}" />
  </label>
  <button type="submit">${escapeHtml(t('proposalLinks.form.save'))}</button>
</form>`;

export const renderProposalParts = ({ parts, t }: {
  parts: Array<RelatedProposal & { status: ProposalStatus | null }>;
  t: TFunction;
}): string => {
  if (!parts.length) return '';
  const items = parts.map(part => `<li>
    <a href="/${escapeHtml(part.slug)}">${renderText(part.title)}</a>
    <span class="proposal-part-status">${escapeHtml(part.status ? t(`proposalStatus.status.${part.status}`) : t('proposalStatus.noStatus'))}</span>
  </li>`).join('');
  return `<section class="proposal-parts" aria-labelledby="proposal-related-parts">
  <h2 id="proposal-related-parts">${escapeHtml(t('proposalLinks.parts'))}</h2>
  <ul class="proposal-parts-list">${items}</ul>
</section>`;
};
