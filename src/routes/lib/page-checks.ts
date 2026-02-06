import type { TFunction } from 'i18next';
import { escapeHtml, renderSafeText, renderText, type SafeText } from '../../render.js';

export type PageCheckMetricSummary = {
  issuesFound: { high: number; medium: number; low: number };
  issuesFixed: { high: number; medium: number; low: number };
};

export type PageCheckSummaryItem = {
  id: string;
  typeLabel: string;
  statusLabel: string;
  dateLabel: string;
  summary?: SafeText | string;
  metrics: PageCheckMetricSummary;
  revUser: string | null;
  revTags: string[] | null;
};

export type PageCheckDetailItem = {
  id: string;
  typeLabel: string;
  statusLabel: string;
  dateLabel: string;
  metrics: PageCheckMetricSummary;
  checkResults: SafeText;
  notes?: SafeText;
  revUser: string | null;
  revTags: string[] | null;
};

type PageChecksSummaryOptions = {
  checks: PageCheckSummaryItem[];
  userMap: Map<string, string>;
  slug: string;
  langOverride?: string;
  t: TFunction;
};

type PageChecksDetailOptions = {
  checks: PageCheckDetailItem[];
  userMap: Map<string, string>;
  slug: string;
  langOverride?: string;
  t: TFunction;
};

type PageCheckHistoryOptions = {
  revisions: PageCheckSummaryItem[];
  userMap: Map<string, string>;
  slug: string;
  checkId: string;
  langOverride?: string;
  diffFrom?: string;
  diffTo?: string;
  t: TFunction;
};

const normalizeCheckLabel = (value: string) => {
  if (!value) return '';
  return value.replace(/_/g, ' ');
};

export const formatCheckType = (value: string, t: TFunction) => {
  if (!value) return '';
  const translated = t(`checks.type.${value}`);
  if (translated && translated !== `checks.type.${value}`) {
    return translated;
  }
  return normalizeCheckLabel(value);
};

export const formatCheckStatus = (value: string, t: TFunction) => {
  if (!value) return '';
  const translated = t(`checks.status.${value}`);
  if (translated && translated !== `checks.status.${value}`) {
    return translated;
  }
  return normalizeCheckLabel(value);
};

export const getCheckMetaParts = (
  revUser: string | null,
  revTags: string[] | null,
  userMap: Map<string, string>,
  t: TFunction
) => {
  const displayName = revUser ? userMap.get(revUser) ?? revUser : null;
  const agentTag = (revTags ?? []).find(tag => tag.startsWith('agent:')) ?? null;
  const agentVersion =
    (revTags ?? []).find(tag => tag.startsWith('agent_version:')) ?? null;
  const operatorLabel = t('checks.fields.operator');
  const operatorText = displayName ? `${operatorLabel}: ${displayName}` : null;
  const metaLabelParts = [operatorText, agentTag, agentVersion].filter(Boolean);
  return {
    displayName,
    agentTag,
    agentVersion,
    label: metaLabelParts.join(' · '),
  };
};

export const buildCheckMetaAttrs = (
  revUser: string | null,
  revTags: string[] | null,
  userMap: Map<string, string>,
  t: TFunction
) => {
  const meta = getCheckMetaParts(revUser, revTags, userMap, t);
  if (!meta.label) return '';
  return ` data-meta="true" data-user="${escapeHtml(
    meta.displayName ?? ''
  )}" data-agent="${escapeHtml(meta.agentTag ?? '')}" data-agent-version="${escapeHtml(
    meta.agentVersion ?? ''
  )}" title="${escapeHtml(meta.label)}"`;
};

const renderMetricsCompact = (metrics: PageCheckMetricSummary, t: TFunction) =>
  `${t('checks.metrics.found')}: ${metrics.issuesFound.high + metrics.issuesFound.medium + metrics.issuesFound.low} · ${t('checks.metrics.fixed')}: ${metrics.issuesFixed.high + metrics.issuesFixed.medium + metrics.issuesFixed.low}`;

const appendLangParam = (href: string, langOverride?: string) => {
  if (!langOverride) return href;
  const joiner = href.includes('?') ? '&' : '?';
  return `${href}${joiner}lang=${encodeURIComponent(langOverride)}`;
};

export const renderPageChecksSummary = ({
  checks,
  userMap,
  slug,
  langOverride,
  t,
}: PageChecksSummaryOptions) => {
  if (!checks.length) {
    return '';
  }

  const itemsHtml = checks
    .map(check => {
      const metaAttrs = buildCheckMetaAttrs(check.revUser, check.revTags, userMap, t);
      const metaParts = [check.typeLabel, check.statusLabel, check.dateLabel].filter(Boolean);
      const viewHref = appendLangParam(
        `/${escapeHtml(slug)}/checks/${escapeHtml(check.id)}`,
        langOverride
      );
      return `<li>
  <div class="rev-meta"${metaAttrs}>
    <strong>${escapeHtml(metaParts.join(' · '))}</strong>
  </div>
  <div class="check-metrics">${escapeHtml(renderMetricsCompact(check.metrics, t))}</div>
  <div class="rev-actions">
    <a href="${viewHref}">${t('history.view')}</a>
  </div>
</li>`;
    })
    .join('\n');

  const viewAllHref = appendLangParam(`/${escapeHtml(slug)}/checks`, langOverride);

  return `<details class="page-history page-checks">
  <summary>${t('checks.title')}</summary>
  <ol class="history-list">${itemsHtml}</ol>
  <div class="history-actions">
    <a href="${viewAllHref}">${t('checks.viewAll')}</a>
  </div>
</details>`;
};

export const renderPageChecksList = ({
  checks,
  userMap,
  slug,
  langOverride,
  t,
}: PageChecksDetailOptions) => {
  if (!checks.length) {
    return `<div class="page-checks-empty">${t('checks.empty')}</div>`;
  }

  return checks
    .map(check => {
      const meta = getCheckMetaParts(check.revUser, check.revTags, userMap, t);
      const metaParts = [check.typeLabel, check.statusLabel, check.dateLabel].filter(Boolean);
      const agentLabel = [meta.agentTag, meta.agentVersion].filter(Boolean).join(' · ');
      const operatorValue = meta.displayName ?? agentLabel;
      const operatorMeta = meta.displayName && agentLabel ? agentLabel : '';
      const operatorHtml = operatorValue
        ? `<div class="check-operator">
  <div class="check-operator-label">${escapeHtml(t('checks.fields.operator'))}</div>
  <div class="check-operator-value">
    ${escapeHtml(operatorValue)}
    ${operatorMeta ? `<div class="check-operator-meta">${escapeHtml(operatorMeta)}</div>` : ''}
  </div>
</div>`
        : '';
      const notes = check.notes ? renderSafeText(check.notes).trim() : '';
      const notesHtml = notes ? `<div class="check-notes">${notes}</div>` : '';
      const viewHref = appendLangParam(
        `/${escapeHtml(slug)}/checks/${escapeHtml(check.id)}`,
        langOverride
      );
      return `<article class="check-card">
  <div class="check-header">
    <div class="check-title">${escapeHtml(metaParts.join(' · '))}</div>
    <div class="rev-actions">
      <a href="${viewHref}">${t('history.view')}</a>
    </div>
  </div>
  <div class="check-meta">
    <div class="check-metrics">${escapeHtml(renderMetricsCompact(check.metrics, t))}</div>
    ${operatorHtml}
  </div>
  <div class="check-results">${renderSafeText(check.checkResults).trim()}</div>
  ${notesHtml}
</article>`;
    })
    .join('\n');
};

export const renderPageCheckHistory = ({
  revisions,
  userMap,
  slug,
  checkId,
  langOverride,
  diffFrom,
  diffTo,
  t,
}: PageCheckHistoryOptions) => {
  const itemsHtml = revisions
    .map((rev, index) => {
      const metaAttrs = buildCheckMetaAttrs(rev.revUser, rev.revTags, userMap, t);
      const metaParts = [rev.typeLabel, rev.statusLabel, rev.dateLabel].filter(Boolean);
      const fromChecked = diffFrom ? diffFrom === rev.id : index === 1;
      const toChecked = diffTo ? diffTo === rev.id : index === 0;
      const summaryHtml = rev.summary
        ? `<div class="rev-summary">${renderText(rev.summary)}</div>`
        : '';
      const viewHref = appendLangParam(
        `/${escapeHtml(slug)}/checks/${escapeHtml(checkId)}?rev=${escapeHtml(rev.id)}`,
        langOverride
      );
      return `<li>
  <div class="rev-meta"${metaAttrs}>
    <span class="rev-radio"><input type="radio" name="diffFrom" value="${escapeHtml(rev.id)}" ${
      fromChecked ? 'checked' : ''
    } /></span>
    <span class="rev-radio"><input type="radio" name="diffTo" value="${escapeHtml(rev.id)}" ${
      toChecked ? 'checked' : ''
    } /></span>
    <strong>${escapeHtml(metaParts.join(' · '))}</strong>
  </div>
  ${summaryHtml}
  <div class="check-metrics">${escapeHtml(renderMetricsCompact(rev.metrics, t))}</div>
  <div class="rev-actions">
    <a href="${viewHref}">${t('history.view')}</a>
  </div>
</li>`;
    })
    .join('\n');

  const actionHref = appendLangParam(
    `/${escapeHtml(slug)}/checks/${escapeHtml(checkId)}`,
    langOverride
  );

  return `<details class="page-history page-checks">
  <summary>${t('history.title')}</summary>
  <form class="history-form" method="get" action="${actionHref}">
    <div class="history-actions">
      <button type="submit">${t('history.compare')}</button>
    </div>
    <ol class="history-list">${itemsHtml}</ol>
  </form>
</details>`;
};
