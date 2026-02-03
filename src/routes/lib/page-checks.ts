import type { TFunction } from 'i18next';
import { escapeHtml } from '../../render.js';

export type PageCheckMetricSummary = {
  issuesFound: { high: number; medium: number; low: number };
  issuesFixed: { high: number; medium: number; low: number };
};

export type PageCheckSummaryItem = {
  id: string;
  typeLabel: string;
  statusLabel: string;
  dateLabel: string;
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
  checkResults: string;
  notes?: string;
  revUser: string | null;
  revTags: string[] | null;
};

type PageChecksSummaryOptions = {
  checks: PageCheckSummaryItem[];
  userMap: Map<string, string>;
  slug: string;
  t: TFunction;
};

type PageChecksDetailOptions = {
  checks: PageCheckDetailItem[];
  userMap: Map<string, string>;
  slug: string;
  t: TFunction;
};

type PageCheckHistoryOptions = {
  revisions: PageCheckSummaryItem[];
  userMap: Map<string, string>;
  slug: string;
  checkId: string;
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

export const renderPageChecksSummary = ({ checks, userMap, slug, t }: PageChecksSummaryOptions) => {
  if (!checks.length) {
    return '';
  }

  const itemsHtml = checks
    .map(check => {
      const metaAttrs = buildCheckMetaAttrs(check.revUser, check.revTags, userMap, t);
      const metaParts = [check.typeLabel, check.statusLabel, check.dateLabel].filter(Boolean);
      return `<li>
  <div class="rev-meta"${metaAttrs}>
    <strong>${escapeHtml(metaParts.join(' · '))}</strong>
  </div>
  <div class="check-metrics">${escapeHtml(renderMetricsCompact(check.metrics, t))}</div>
  <div class="rev-actions">
    <a href="/${escapeHtml(slug)}/checks/${escapeHtml(check.id)}">${t('history.view')}</a>
  </div>
</li>`;
    })
    .join('\n');

  return `<details class="page-history page-checks">
  <summary>${t('checks.title')}</summary>
  <ol class="history-list">${itemsHtml}</ol>
</details>`;
};

export const renderPageChecksList = ({ checks, userMap, slug, t }: PageChecksDetailOptions) => {
  if (!checks.length) {
    return `<div class="page-checks-empty">${t('checks.empty')}</div>`;
  }

  return checks
    .map(check => {
      const metaAttrs = buildCheckMetaAttrs(check.revUser, check.revTags, userMap, t);
      const metaParts = [check.typeLabel, check.statusLabel, check.dateLabel].filter(Boolean);
      const notesHtml = check.notes
        ? `<div class="check-notes">${escapeHtml(check.notes)}</div>`
        : '';
      return `<article class="check-card">
  <div class="rev-meta"${metaAttrs}>
    <strong>${escapeHtml(metaParts.join(' · '))}</strong>
  </div>
  <div class="check-metrics">${escapeHtml(renderMetricsCompact(check.metrics, t))}</div>
  <div class="check-results">${escapeHtml(check.checkResults)}</div>
  ${notesHtml}
  <div class="rev-actions">
    <a href="/${escapeHtml(slug)}/checks/${escapeHtml(check.id)}">${t('history.view')}</a>
  </div>
</article>`;
    })
    .join('\n');
};

export const renderPageCheckHistory = ({
  revisions,
  userMap,
  slug,
  checkId,
  t,
}: PageCheckHistoryOptions) => {
  const itemsHtml = revisions
    .map(rev => {
      const metaAttrs = buildCheckMetaAttrs(rev.revUser, rev.revTags, userMap, t);
      const metaParts = [rev.typeLabel, rev.statusLabel, rev.dateLabel].filter(Boolean);
      return `<li>
  <div class="rev-meta"${metaAttrs}>
    <strong>${escapeHtml(metaParts.join(' · '))}</strong>
  </div>
  <div class="check-metrics">${escapeHtml(renderMetricsCompact(rev.metrics, t))}</div>
  <div class="rev-actions">
    <a href="/${escapeHtml(slug)}/checks/${escapeHtml(checkId)}?rev=${escapeHtml(
        rev.id
      )}">${t('history.view')}</a>
  </div>
</li>`;
    })
    .join('\n');

  return `<details class="page-history page-checks">
  <summary>${t('history.title')}</summary>
  <ol class="history-list">${itemsHtml}</ol>
</details>`;
};
