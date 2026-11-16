import { decodeHTML } from 'entities';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { collapseWhitespace } from '../lib/notification-text.js';
import { renderMarkdown } from '../render.js';
import { loadCitationEntriesForSources } from './citation-render-service.js';
import { loadMediaEntriesForSources } from './media-render-service.js';

export const markdownToPlainText = async (dal: DataAccessLayer, markdown: string) => {
  const [citationEntries, mediaRegistry] = await Promise.all([
    loadCitationEntriesForSources(dal, [markdown]),
    loadMediaEntriesForSources(dal, [markdown]),
  ]);
  const rendered = await renderMarkdown(markdown, citationEntries, {
    backToCitationLabel: 'Back to citation',
    mediaRegistry,
  });
  return collapseWhitespace(decodeHTML(striptags(rendered.html)));
};
