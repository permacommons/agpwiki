import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { loadCitationEntriesForSources } from '../../lib/citation-render.js';
import { renderMarkdown } from '../../render.js';

export interface MarkdownPreviewTexts {
  title: string;
  empty: string;
  loading: string;
  error: string;
}

export interface MarkdownPreviewOptions {
  textareaId: string;
  previewId: string;
  endpoint: string;
  texts: MarkdownPreviewTexts;
  previewHtml?: string;
}

export const renderMarkdownPreviewPanel = ({
  textareaId,
  previewId,
  endpoint,
  texts,
  previewHtml = '',
}: MarkdownPreviewOptions) => {
  const hasPreview = previewHtml.trim().length > 0;
  const bodyHtml = hasPreview
    ? previewHtml
    : `<p class="markdown-preview-empty">${texts.empty}</p>`;

  return `<section
  class="markdown-preview"
  data-markdown-preview-root
  data-markdown-preview-endpoint="${endpoint}"
  data-markdown-preview-input="${textareaId}"
  data-markdown-preview-output="${previewId}"
  data-markdown-preview-empty="${texts.empty}"
  data-markdown-preview-loading="${texts.loading}"
  data-markdown-preview-error="${texts.error}"
>
  <div class="markdown-preview-heading">${texts.title}</div>
  <div class="markdown-preview-body" id="${previewId}" aria-live="polite">${bodyHtml}</div>
</section>`;
};

export const renderMarkdownPreviewHtml = async (
  dalInstance: DataAccessLayer,
  source: string,
  backToCitationLabel: string
) => {
  const citationEntries = await loadCitationEntriesForSources(dalInstance, [source]);
  return (
    await renderMarkdown(source, citationEntries, {
      backToCitationLabel,
    })
  ).html;
};
