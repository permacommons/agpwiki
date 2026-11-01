import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';
import citationsPlugin from '../markdown/citations.js';
import { mediaPlugin } from '../markdown/media.js';

const plainTextParser = new MarkdownIt({ html: false, linkify: true })
  .use(citationsPlugin)
  .use(mediaPlugin());

const textOf = (tokens: Token[]): string => {
  let text = '';
  let inCitation = false;
  for (const token of tokens) {
    if (token.type === 'cite_open') inCitation = true;
    else if (token.type === 'cite_close') inCitation = false;
    else if (inCitation || token.type === 'image' || token.type === 'media') continue;
    else if (token.children) text += textOf(token.children);
    else if (['text', 'code_inline', 'code_block', 'fence'].includes(token.type)) text += token.content;
    else if (token.block || token.type === 'softbreak' || token.type === 'hardbreak') text += ' ';
  }
  return text;
};

export const markdownToPlainText = (markdown: string): string =>
  textOf(plainTextParser.parse(markdown, {}))
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

