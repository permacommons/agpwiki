import type { TFunction } from 'i18next';
import dal from 'rev-dal';

import { renderUserLink } from '../../lib/profile-paths.js';
import type { ProposalStatus } from '../../lib/proposal-status.js';
import { resolveSafeTextWithFallback } from '../../lib/safe-text.js';
import { encodeSlugPath } from '../../lib/slug.js';
import { escapeHtml, renderText } from '../../render.js';
import { SIGNOFF_STANCES } from '../../services/page-signoff-service.js';
import type { ProposalListItem } from '../../services/proposal-status-service.js';

const { mlString } = dal;

type Author = { name: string; username: string };

const formatDay = (date: Date | null, locale: string) =>
  date
    ? date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';

const renderDateCell = (date: Date | null, locale: string, label: string, className: string) =>
  `<td class="${className}" data-label="${escapeHtml(label)}">${
    date ? `<time datetime="${date.toISOString()}">${escapeHtml(formatDay(date, locale))}</time>` : ''
  }</td>`;

/**
 * The proposals list: one table per status, in the given order, newest
 * change first. Each row says who started the proposal, when, what it is
 * part of, the positions stated on it and when it last changed.
 */
export const renderProposalList = ({
  items,
  order,
  authors,
  lang,
  locale,
  t,
}: {
  items: ProposalListItem[];
  order: Array<ProposalStatus | null>;
  authors: Map<string, Author>;
  lang: string;
  locale: string;
  t: TFunction;
}): string => {
  const byId = new Map(items.map(item => [item.id, item]));
  const titleOf = (item: ProposalListItem) => resolveSafeTextWithFallback(mlString.resolve, lang, item.title, item.slug);
  const pageLink = (item: ProposalListItem) => `<a href="/${escapeHtml(encodeSlugPath(item.slug))}">${renderText(titleOf(item))}</a>`;

  const columns = {
    author: t('tool.proposalsColumnAuthor'),
    positions: t('tool.proposalsColumnPositions'),
    started: t('tool.proposalsColumnStarted'),
    updated: t('tool.proposalsColumnUpdated'),
  };

  const renderRow = (item: ProposalListItem) => {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    const author = item.creatorId ? authors.get(item.creatorId) : undefined;
    const counts = SIGNOFF_STANCES.filter(stance => item.positions[stance] > 0);
    const positionsHtml = counts.length
      ? counts
          .map(
            stance =>
              `<span class="page-signoff-stance page-signoff-stance--${stance}">${escapeHtml(
                t(`signoff.count.${stance}`, { count: item.positions[stance] })
              )}</span>`
          )
          .join(' ')
      : `<span class="proposal-table-none">${escapeHtml(t('tool.proposalsNoPositions'))}</span>`;
    return `<tr>
  <td class="proposal-table-title">${pageLink(item)}${
    parent ? `<div class="proposal-table-parent">${escapeHtml(t('proposalLinks.partOf'))} ${pageLink(parent)}</div>` : ''
  }</td>
  <td class="proposal-table-author" data-label="${escapeHtml(columns.author)}">${
    author ? renderUserLink(author.name, author.username) : escapeHtml(t('signoff.unknownUser'))
  }</td>
  <td class="proposal-table-positions" data-label="${escapeHtml(columns.positions)}">${positionsHtml}</td>
  ${renderDateCell(item.createdAt, locale, columns.started, 'proposal-table-date proposal-table-started')}
  ${renderDateCell(item.updatedAt, locale, columns.updated, 'proposal-table-date')}
</tr>`;
  };

  return order
    .map(status => {
      const group = items
        .filter(item => item.status === status)
        .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
      if (!group.length) return '';
      const label = status ? t(`proposalStatus.status.${status}`) : t('proposalStatus.noStatus');
      const headingId = `proposals-${status ?? 'none'}`;
      return `<section class="proposal-list-group" aria-labelledby="${headingId}">
  <h2 id="${headingId}"><span class="proposal-status-badge proposal-status--${status ?? 'none'}">${escapeHtml(
    label
  )}</span> <span class="proposal-list-count">${group.length}</span></h2>
  <table class="proposal-table">
    <thead><tr>
      <th scope="col">${escapeHtml(t('tool.proposalsColumnProposal'))}</th>
      <th scope="col">${escapeHtml(columns.author)}</th>
      <th scope="col">${escapeHtml(columns.positions)}</th>
      <th scope="col">${escapeHtml(columns.started)}</th>
      <th scope="col">${escapeHtml(columns.updated)}</th>
    </tr></thead>
    <tbody>${group.map(renderRow).join('')}</tbody>
  </table>
</section>`;
    })
    .join('');
};
