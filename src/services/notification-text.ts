import { decodeHTML } from 'entities';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { loadMediaEntriesForSources } from '../lib/media-render.js';
import { collapseWhitespace } from '../lib/notification-text.js';
import { renderMarkdown } from '../render.js';

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
