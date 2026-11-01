import { decodeHTML } from 'entities';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { loadMediaEntriesForSources } from '../lib/media-render.js';
import { renderMarkdown } from '../render.js';

export const EXCERPT_LENGTH = 280;

export const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

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

export const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Plain text of a localized title or body, in its original language when known. */
export const pickLocalizedText = (
  value: Record<string, string | null> | null | undefined,
  preferredLanguage?: string | null
) => {
  if (!value) return '';
  return (preferredLanguage ? value[preferredLanguage] : null) ?? value.en ?? Object.values(value).find(Boolean) ?? '';
};
