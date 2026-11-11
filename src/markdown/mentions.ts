import type MarkdownIt from 'markdown-it';
import { type MentionMap, profilePath, readMentionAt } from '../lib/mentions.js';

type MentionEnv = { mentions?: MentionMap; mentionNames?: string[] };

export const mentionsPlugin = () => (md: MarkdownIt) => {
  md.inline.ruler.push('mention', (state, silent) => {
    const env = state.env as MentionEnv;
    if (silent || (!env.mentions && !env.mentionNames)) return false;
    if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */ || state.linkLevel > 0) return false;
    const mention = readMentionAt(state.src, state.pos);
    if (!mention) return false;
    const username = env.mentionNames ? mention.name : env.mentions?.get(mention.name);
    if (!username) return false;
    const open = state.push('link_open', 'a', 1);
    open.attrs = [
      ['href', profilePath(username)],
      ['class', 'mention'],
    ];
    open.markup = 'mention';
    open.meta = { mentionName: mention.name };
    const text = state.push('text', '', 0);
    text.content = `@${mention.written}`;
    const close = state.push('link_close', 'a', -1);
    close.markup = 'mention';
    state.pos = mention.end;
    return true;
  });

  md.core.ruler.after('inline', 'collect_mentions', state => {
    const names = (state.env as MentionEnv).mentionNames;
    if (!names) return;
    for (const block of state.tokens) {
      if (block.type !== 'inline') continue;
      // Image alt text is parsed into nested children, not visible mentions.
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open' || token.markup !== 'mention') continue;
        const name = token.meta.mentionName as string;
        if (!names.includes(name)) names.push(name);
      }
    }
  });
};
