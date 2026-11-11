import type MarkdownIt from 'markdown-it';
import { type MentionMap, profilePath, readMentionAt } from '../lib/mentions.js';

/**
 * @username in comments. With `env.mentions` (the usernames that exist), a
 * mention becomes a link to the person's profile; other text after @ stays
 * plain. With `env.mentionNames`, the names written are collected instead,
 * so a post can be checked for mentions without rendering it. Code spans and
 * links are parsed by earlier rules, so mentions inside them are left alone.
 */
export const mentionsPlugin = () => (md: MarkdownIt) => {
  md.inline.ruler.push('mention', (state, silent) => {
    const env = state.env as { mentions?: MentionMap; mentionNames?: string[] };
    if (!env.mentions && !env.mentionNames) return false;
    if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */ || state.linkLevel > 0) return false;
    const mention = readMentionAt(state.src, state.pos);
    if (!mention) return false;
    if (env.mentionNames) {
      if (!env.mentionNames.includes(mention.name)) env.mentionNames.push(mention.name);
      return false;
    }
    const username = env.mentions?.get(mention.name);
    if (!username) return false;
    if (!silent) {
      const open = state.push('link_open', 'a', 1);
      open.attrs = [
        ['href', profilePath(username)],
        ['class', 'mention'],
      ];
      open.markup = 'mention';
      const text = state.push('text', '', 0);
      text.content = `@${mention.written}`;
      const close = state.push('link_close', 'a', -1);
      close.markup = 'mention';
    }
    state.pos = mention.end;
    return true;
  });
};
