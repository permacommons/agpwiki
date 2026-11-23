import type MarkdownIt from 'markdown-it';

const PLUS = 0x2b;

type Delimiter = { marker: number; length: number; token: number; end: number; open: boolean; close: boolean };
type InlineToken = { type: string; tag: string; nesting: number; markup: string; content: string };
type StateInline = {
  src: string;
  pos: number;
  tokens: InlineToken[];
  delimiters: Delimiter[];
  tokens_meta: Array<{ delimiters?: Delimiter[] } | null>;
  push: (type: string, tag: string, nesting: number) => InlineToken;
  scanDelims: (start: number, canSplitWord: boolean) => { length: number; can_open: boolean; can_close: boolean };
};

const tokenize = (state: StateInline, silent: boolean) => {
  if (silent || state.src.charCodeAt(state.pos) !== PLUS) return false;

  const scanned = state.scanDelims(state.pos, true);
  let length = scanned.length;
  if (length < 2) return false;

  if (length % 2) {
    state.push('text', '', 0).content = '+';
    length -= 1;
  }

  for (let i = 0; i < length; i += 2) {
    state.push('text', '', 0).content = '++';
    state.delimiters.push({
      marker: PLUS,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }

  state.pos += scanned.length;
  return true;
};

const pairUp = (state: StateInline, delimiters: Delimiter[]) => {
  const loneMarkers: number[] = [];

  for (const start of delimiters) {
    if (start.marker !== PLUS || start.end === -1) continue;
    const end = delimiters[start.end];

    Object.assign(state.tokens[start.token], { type: 'ins_open', tag: 'ins', nesting: 1, markup: '++', content: '' });
    Object.assign(state.tokens[end.token], { type: 'ins_close', tag: 'ins', nesting: -1, markup: '++', content: '' });

    const before = state.tokens[end.token - 1];
    if (before.type === 'text' && before.content === '+') loneMarkers.push(end.token - 1);
  }

  // An odd run such as `+++` leaves one literal `+` ahead of the closing
  // marker; it belongs after the closing tag.
  for (const lone of loneMarkers.reverse()) {
    let last = lone + 1;
    while (last < state.tokens.length && state.tokens[last].type === 'ins_close') last += 1;
    last -= 1;
    if (last !== lone) {
      [state.tokens[lone], state.tokens[last]] = [state.tokens[last], state.tokens[lone]];
    }
  }
};

/**
 * `++text++` marks inserted text, the counterpart of `~~text~~`, so proposals
 * can show the exact words they add to and remove from a guideline.
 */
export const insertPlugin = () => (md: MarkdownIt) => {
  md.inline.ruler.before('emphasis', 'ins', (state, silent) => tokenize(state as unknown as StateInline, silent));
  md.inline.ruler2.before('emphasis', 'ins', rawState => {
    const state = rawState as unknown as StateInline;
    pairUp(state, state.delimiters);
    for (const meta of state.tokens_meta) {
      if (meta?.delimiters) pairUp(state, meta.delimiters);
    }
    return false;
  });
};
