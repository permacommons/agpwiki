import type { FieldDiff, LocalizedDiff, StructuredDiff, TextFieldDiff } from '../../lib/diff-engine.js';
import { escapeHtml, renderUnifiedDiff } from '../../render.js';

export type DiffLabels = {
  heading: string;
  from: string;
  to: string;
  addedLanguages: string;
  removedLanguages: string;
  modifiedLanguages: string;
};

export const getDiffLabels = (t: (key: string) => string): DiffLabels => ({
  heading: t('diff.revision'),
  from: t('diff.from'),
  to: t('diff.to'),
  addedLanguages: t('diff.addedLanguages'),
  removedLanguages: t('diff.removedLanguages'),
  modifiedLanguages: t('diff.modifiedLanguages'),
});

type DiffOptions = {
  fromLabel: string;
  toLabel: string;
  fromHref?: string;
  toHref?: string;
  fields: Array<{ key: string; label?: string; diff: FieldDiff }>;
  labels: DiffLabels;
};

const renderTextDiff = (field: TextFieldDiff) => {
  const diffRendered = renderUnifiedDiff(field.diff.unifiedDiff);
  return `<pre class="diff">${diffRendered}</pre>`;
};

const renderScalarDiff = (labels: DiffOptions['labels'], from: string | null, to: string | null) => {
  const fromText = escapeHtml(from ?? '');
  const toText = escapeHtml(to ?? '');
  return `<div class="diff-scalar">
  <div><strong>${escapeHtml(labels.from)}:</strong> <span class="diff-scalar-value">${fromText}</span></div>
  <div><strong>${escapeHtml(labels.to)}:</strong> <span class="diff-scalar-value">${toText}</span></div>
</div>`;
};

const renderLocalizedDiff = (labels: DiffOptions['labels'], field: LocalizedDiff) => {
  const addedHtml = field.added.length
    ? `<div class="diff-language">
  <strong>${escapeHtml(labels.addedLanguages)}</strong>
  ${field.added
    .map(item => `<details class="diff-language-item" open>
  <summary>${escapeHtml(item.lang)}</summary>
  <pre class="diff diff-language-value">${escapeHtml(item.value)}</pre>
</details>`)
    .join('')}
</div>`
    : '';
  const removedHtml = field.removed.length
    ? `<div class="diff-language">
  <strong>${escapeHtml(labels.removedLanguages)}</strong>
  ${field.removed
    .map(item => `<details class="diff-language-item" open>
  <summary>${escapeHtml(item.lang)}</summary>
  <pre class="diff diff-language-value">${escapeHtml(item.value)}</pre>
</details>`)
    .join('')}
</div>`
    : '';
  const modifiedHtml = Object.keys(field.modified).length
    ? `<div class="diff-language">
  <strong>${escapeHtml(labels.modifiedLanguages)}</strong>
  ${Object.entries(field.modified)
    .map(([lang, diff]) => `<details class="diff-language-item" open>
  <summary>${escapeHtml(lang)}</summary>
  <pre class="diff">${renderUnifiedDiff(diff.unifiedDiff)}</pre>
</details>`)
    .join('')}
</div>`
    : '';
  return `${addedHtml}${removedHtml}${modifiedHtml}`;
};

const renderStructuredDiff = (field: StructuredDiff) => {
  const changeHtml = field.changes
    .map(change => {
      const fromBlock = change.from
        ? `<pre class="diff diff-structured">${escapeHtml(change.from)}</pre>`
        : '';
      const toBlock = change.to
        ? `<pre class="diff diff-structured">${escapeHtml(change.to)}</pre>`
        : '';
      return `<div class="diff-structured-change">
  <div class="diff-structured-meta"><strong>${escapeHtml(change.type)}</strong> ${escapeHtml(
        change.path
      )}</div>
  ${fromBlock}
  ${toBlock}
</div>`;
    })
    .join('');
  return `<div class="diff-structured">${changeHtml}</div>`;
};

const renderFieldDiff = (labels: DiffOptions['labels'], diff: FieldDiff) => {
  switch (diff.kind) {
    case 'text':
      return renderTextDiff(diff);
    case 'localized':
      return renderLocalizedDiff(labels, diff);
    case 'structured':
      return renderStructuredDiff(diff);
    case 'scalar':
      return renderScalarDiff(labels, diff.from, diff.to);
    default:
      return '';
  }
};

export const renderEntityDiff = ({
  fromLabel,
  toLabel,
  fromHref,
  toHref,
  fields,
  labels,
}: DiffOptions) => {
  if (!fields.length) return '';
  const renderLabel = (label: string, href?: string) => {
    if (!href) return escapeHtml(label);
    const match = label.match(/^(\S+)(.*)$/);
    if (!match) return escapeHtml(label);
    const [, idPart, rest] = match;
    const idHtml = `<a href="${escapeHtml(href)}">${escapeHtml(idPart)}</a>`;
    return `${idHtml}${escapeHtml(rest)}`;
  };
  const fromLabelHtml = renderLabel(fromLabel, fromHref);
  const toLabelHtml = renderLabel(toLabel, toHref);
  const fieldHtml = fields
    .map(field => {
      const label = escapeHtml(field.label ?? field.key);
      return `<details class="diff-field" open>
  <summary>${label}</summary>
  ${renderFieldDiff(labels, field.diff)}
</details>`;
    })
    .join('');
  return `<section class="page-diff">
  <div class="diff-heading"><strong>${escapeHtml(labels.heading)}:</strong> ${fromLabelHtml} → ${toLabelHtml}</div>
  ${fieldHtml}
</section>`;
};
