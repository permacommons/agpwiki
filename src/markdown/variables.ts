import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';

const readVariableName = (src: string, start: number) => {
  let i = start;
  let name = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '}' && src[i + 1] === '}') {
      return { name: name.trim(), end: i + 2 };
    }
    name += ch;
    i += 1;
  }
  return null;
};

export const variablesPlugin = () => (md: MarkdownIt) => {
  md.inline.ruler.before('emphasis', 'variable', (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== '{{') return false;
    const match = readVariableName(state.src, state.pos + 2);
    if (!match) return false;
    if (!match.name) return false;

    if (!silent) {
      const token = state.push('variable', '', 0) as Token;
      token.meta = { name: match.name };
    }

    state.pos = match.end;
    return true;
  });

  md.renderer.rules.variable = (tokens, idx, _options, env) => {
    const name = tokens[idx].meta?.name as string | undefined;
    if (!name) return '';
    const vars = (env?.variables ?? {}) as Record<string, string>;
    return vars[name] ?? '';
  };
};
