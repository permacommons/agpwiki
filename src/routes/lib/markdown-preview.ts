import type { Request, RequestHandler } from 'express';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { loadCitationEntriesForSources } from '../../lib/citation-render.js';
import { escapeHtml, renderMarkdown } from '../../render.js';

export interface MarkdownPreviewTexts {
  title: string;
  empty: string;
  error: string;
}

export interface MarkdownPreviewOptions {
  formId: string;
  previewId: string;
  endpoint: string;
  texts: MarkdownPreviewTexts;
  previewHtml?: string;
}

export const renderMarkdownPreviewPanel = ({
  formId,
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
  data-markdown-preview-form="${escapeHtml(formId)}"
  data-markdown-preview-output="${previewId}"
  data-markdown-preview-empty="${escapeHtml(texts.empty)}"
  data-markdown-preview-error="${escapeHtml(texts.error)}"
>
  <div class="markdown-preview-heading">${escapeHtml(texts.title)}</div>
  <div class="markdown-preview-body" id="${previewId}" aria-live="polite">${bodyHtml}</div>
</section>`;
};

export const createPreviewHandler =
  <Payload>(
    parsePayload: (body: unknown) => Payload,
    renderPreview: (payload: Payload, req: Request) => Promise<string>
  ): RequestHandler =>
  async (req, res) => {
    const payload = parsePayload(req.body);
    const html = await renderPreview(payload, req);
    res.json({ html });
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
