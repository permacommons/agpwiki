import type { TFunction } from 'i18next';
import { escapeHtml } from '../../render.js';

export type PageCheckViewItem = {
  typeLabel: string;
  statusLabel: string;
  dateLabel: string;
  checkResults: string;
  notes?: string;
  metrics: {
    issuesFound: { high: number; medium: number; low: number };
    issuesFixed: { high: number; medium: number; low: number };
  };
};

type PageChecksOptions = {
  checks: PageCheckViewItem[];
  t: TFunction;
};

export const renderPageChecks = ({ checks, t }: PageChecksOptions) => {
  if (!checks.length) {
    return `<details class="page-checks">
  <summary>${t('checks.title')}</summary>
  <div class="page-checks-empty">${t('checks.empty')}</div>
</details>`;
  }

  const itemsHtml = checks
    .map(check => {
      const metaParts = [check.typeLabel, check.statusLabel, check.dateLabel].filter(Boolean);
      const metaHtml = metaParts.length
        ? `<div class="check-meta">${escapeHtml(metaParts.join(' · '))}</div>`
        : '';
      const resultsHtml = check.checkResults
        ? `<div class="check-results">${escapeHtml(check.checkResults)}</div>`
        : '';
      const notesHtml = check.notes
        ? `<div class="check-notes">${escapeHtml(check.notes)}</div>`
        : '';
      const metrics = check.metrics;
      const metricsHtml = `<div class="check-metrics">${escapeHtml(
        `${t('checks.metrics.found')} H:${metrics.issuesFound.high} M:${metrics.issuesFound.medium} L:${metrics.issuesFound.low} · ${t('checks.metrics.fixed')} H:${metrics.issuesFixed.high} M:${metrics.issuesFixed.medium} L:${metrics.issuesFixed.low}`
      )}</div>`;

      return `<li>
  ${metaHtml}
  ${resultsHtml}
  ${metricsHtml}
  ${notesHtml}
</li>`;
    })
    .join('\n');

  return `<details class="page-checks">
  <summary>${t('checks.title')}</summary>
  <ol class="page-checks-list">${itemsHtml}</ol>
</details>`;
};
