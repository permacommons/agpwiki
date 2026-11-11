import { escapeHtml } from './html.js';
import { normalizeUsername } from './username.js';

// At most this many people are notified per post, so mentions cannot be
// used to spam.
export const MAX_MENTIONS_PER_POST = 10;

// A mention is @ and a run of letters, digits, marks, dots, hyphens or
// underscores. It must not follow a word character, so e-mail addresses
// (name@example.org) are not mentions, nor `[@key]` citations.
const NAME_CHARS = /[\p{L}\p{N}\p{M}._-]/u;
const BLOCKED_BEFORE = /[\p{L}\p{N}\p{M}_@./[-]/u;
const MENTION_PATTERN = /@([\p{L}\p{N}\p{M}._-]+)/gu;

/** Profile pages live under user/, named after the username. */
export const profilePath = (username: string) => `/user/${encodeURIComponent(username)}`;

/**
 * Read a mention starting at `start`, the position of the @. Returns the
 * name as written and where it ends, or null when the @ starts no mention.
 */
export const readMentionAt = (text: string, start: number) => {
  if (text[start] !== '@') return null;
  const before = start > 0 ? text.slice(0, start).at(-1) : undefined;
  if (before && BLOCKED_BEFORE.test(before)) return null;
  let end = start + 1;
  while (end < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(end) as number);
    if (!NAME_CHARS.test(ch)) break;
    end += ch.length;
  }
  // A full stop or dash after a name ends the sentence, not the name.
  while (end > start + 1 && /[._-]/.test(text[end - 1])) end -= 1;
  if (end === start + 1) return null;
  const written = text.slice(start + 1, end);
  const name = normalizeUsername(written);
  return name ? { written, name, end } : null;
};

/** The usernames mentioned in plain text, normalized, in order, once each. */
export const findMentionNames = (text: string) => {
  const names: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const mention = readMentionAt(text, match.index);
    if (mention && !names.includes(mention.name)) names.push(mention.name);
  }
  return names;
};

/** Mentioned usernames that exist: normalized name -> username. */
export type MentionMap = Map<string, string>;

export const renderMentionLink = (written: string, username: string) =>
  `<a class="mention" href="${escapeHtml(profilePath(username))}">@${escapeHtml(written)}</a>`;

/**
 * Turn mentions of real usernames in already-escaped plain text into
 * profile links. Text inside links made earlier is left alone.
 */
export const linkMentionsInEscapedText = (html: string, mentions: MentionMap | undefined) => {
  if (!mentions?.size) return html;
  return html
    .split(/(<a\b[^>]*>.*?<\/a>)/s)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(MENTION_PATTERN, (match, _written: string, offset: number) => {
            const mention = readMentionAt(part, offset);
            const username = mention ? mentions.get(mention.name) : undefined;
            if (!mention || !username) return match;
            return `${renderMentionLink(mention.written, username)}${part.slice(mention.end, offset + match.length)}`;
          })
    )
    .join('');
};
