import type { TFunction } from 'i18next';
import type { initializePostgreSQL } from '../../db.js';
import { escapeHtml, renderText, type SafeText } from '../../render.js';

type DalInstance = Awaited<ReturnType<typeof initializePostgreSQL>>;

export type HistoryRevision = {
  revId: string;
  dateLabel: string;
  title: SafeText | string;
  summary: SafeText | string;
  revUser: string | null;
  revTags: string[] | null;
};

type HistoryOptions = {
  revisions: HistoryRevision[];
  diffFrom?: string;
  diffTo?: string;
  action: string;
  viewHref: (revId: string) => string;
  userMap: Map<string, string>;
  t: TFunction;
};

export const fetchUserMap = async (dalInstance: DalInstance, userIds: string[]) => {
  const userMap = new Map<string, string>();
  if (!userIds.length) return userMap;

  const userResult = await dalInstance.query(
    'SELECT id, display_name FROM users WHERE id = ANY($1)',
    [userIds]
  );
  for (const row of userResult.rows as Array<{ id: string; display_name: string }>) {
    userMap.set(row.id, row.display_name);
  }
  return userMap;
};

export const renderRevisionHistory = ({
  revisions,
  diffFrom,
  diffTo,
  action,
  viewHref,
  userMap,
  t,
}: HistoryOptions) => {
  const historyItems = revisions
    .map((rev, index) => {
      const summaryHtml = rev.summary
        ? `<div class="rev-summary">${renderText(rev.summary)}</div>`
        : '';
      const fromChecked = diffFrom ? diffFrom === rev.revId : index === 1;
      const toChecked = diffTo ? diffTo === rev.revId : index === 0;
      const displayName = rev.revUser ? userMap.get(rev.revUser) ?? rev.revUser : null;
      const agentTag = (rev.revTags ?? []).find(tag => tag.startsWith('agent:')) ?? null;
      const agentVersion =
        (rev.revTags ?? []).find(tag => tag.startsWith('agent_version:')) ?? null;
      const metaLabelParts = [
        displayName ? t('history.operator', { name: displayName }) : null,
        agentTag,
        agentVersion,
      ].filter(Boolean);
      const metaLabel = metaLabelParts.join(' · ');
      const metaAttrs = metaLabel
        ? ` data-meta="true" data-user="${escapeHtml(displayName ?? '')}" data-agent="${escapeHtml(
            agentTag ?? ''
          )}" data-agent-version="${escapeHtml(
            agentVersion ?? ''
          )}" title="${escapeHtml(metaLabel)}"`
        : '';
      return `<li>
  <div class="rev-meta"${metaAttrs}>
    <span class="rev-radio"><input type="radio" name="diffFrom" value="${rev.revId}" ${
      fromChecked ? 'checked' : ''
    } /></span>
    <span class="rev-radio"><input type="radio" name="diffTo" value="${rev.revId}" ${
      toChecked ? 'checked' : ''
    } /></span>
    <strong>${renderText(rev.title)}</strong>
    <span>${escapeHtml(rev.dateLabel)}</span>
  </div>
  ${summaryHtml}
  <div class="rev-actions">
    <a href="${escapeHtml(viewHref(rev.revId))}">${t('history.view')}</a>
  </div>
</li>`;
    })
    .join('\n');

  return `<details class="page-history">
  <summary>${t('history.title')}</summary>
  <form class="history-form" method="get" action="${escapeHtml(action)}">
    <div class="history-actions">
      <button type="submit">${t('history.compare')}</button>
    </div>
    <ol class="history-list">${historyItems}</ol>
  </form>
</details>`;
};
