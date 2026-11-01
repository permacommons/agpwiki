import { markdownToPlainText } from './markdown-to-text.js';

const MAX_EXCERPT_LENGTH = 280;

// The lead is the text before the first heading.
const leadOf = (markdown: string) => {
  const lines = markdown.split('\n');
  const headingAt = lines.findIndex(line => /^#{1,6}\s/.test(line));
  return (headingAt === -1 ? lines : lines.slice(0, headingAt)).join('\n');
};

// A sentence ends at . ! or ? followed by a space and a capital letter,
// quote or bracket, or at a full-width stop as used in Chinese and Japanese.
const SENTENCE_END = /^(.+?(?:[.!?](?=\s+["“(\p{Lu}])|[。！？]))/u;

/** The first sentence of an article's lead, as plain text, for cards and previews. */
export const firstSentence = (markdown: string | null | undefined): string => {
  if (!markdown) return '';
  const text = markdownToPlainText(leadOf(markdown));
  if (!text) return '';
  const sentence = SENTENCE_END.exec(text)?.[1] ?? text;
  return sentence.length > MAX_EXCERPT_LENGTH
    ? `${sentence.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`
    : sentence;
};
