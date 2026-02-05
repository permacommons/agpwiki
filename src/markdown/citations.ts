// Adapted from markdown-it-citations. See vendor/markdown-it-citations/NOTICE.md.
import type { PluginWithOptions, Renderer } from 'markdown-it';
import type Token from 'markdown-it/lib/token';

type CitationMode = 'AuthorInText' | 'SuppressAuthor' | 'NormalCitation';

export interface Citation {
  citationId: string;
  claimId?: string;
  citationPrefix: Token[];
  citationSuffix: Token[];
  citationMode: CitationMode;
  citationNoteNum: number;
  citationHash: number;
}

interface CiteProc<T> {
  appendCluster(cluster: Citation[]): T;
  renderCluster(id: T, renderer: Renderer): string;
  renderBibliography(): string;
}

interface CitationOptions {
  citeproc: (env: object) => CiteProc<unknown>;
  'suppress-bibliography'?: boolean;
  'reference-section-title'?: string;
}

const Citations: PluginWithOptions<CitationOptions> = (md, options) => {
  const regexes = {
    citation: /^([^^-]|[^^].+?)?(-)?@([\w][\w:.#$%&+?<>~/-]*)(.+)?$/,
    inText: /^@([\w][\w:.#$%&+?<>~/-]*)(\s*)(\[)?/,
    allowedBefore: /^[^a-zA-Z.0-9]$/,
  };

  const splitCitationKey = (value: string) => {
    const separatorIndex = value.indexOf(':');
    if (separatorIndex <= 0) {
      return { citationId: value };
    }
    return {
      citationId: value.slice(0, separatorIndex),
      claimId: value.slice(separatorIndex + 1),
    };
  };

  md.inline.ruler.after('emphasis', 'citation', (state, silent) => {
    const char = state.src.charCodeAt(state.pos);
    if (
      char === 0x40 /* @ */ &&
      (state.pos === 0 || regexes.allowedBefore.test(state.src.slice(state.pos - 1, state.pos)))
    ) {
      const match = state.src.slice(state.pos).match(regexes.inText);
      if (match) {
        let citeproc: CiteProc<unknown> | undefined;
        if (options?.citeproc) {
          citeproc = state.env.citeproc;
          if (!citeproc) {
            citeproc = options.citeproc(state.env);
            state.env.citeproc = citeproc;
          }
        }
        const nextNoteNum = (state.env.noteNum ?? 0) + 1;
        state.env.noteNum = nextNoteNum;
        const { citationId, claimId } = splitCitationKey(match[1]);
        const citation: Citation = {
          citationId,
          claimId,
          citationPrefix: [],
          citationSuffix: [],
          citationMode: 'AuthorInText',
          citationNoteNum: nextNoteNum,
          citationHash: 0,
        };
        let token: Token | undefined;
        if (!silent) {
          token = state.push('cite_open', 'span', 1);
          token.attrSet('class', 'citation');
          token.attrSet('data-cites', citationId);
        }
        if (match[3]) {
          const suffixStart = state.pos + match[0].length;
          const suffixEnd = state.md.helpers.parseLinkLabel(state, suffixStart);
          const charAfter = state.src.codePointAt(suffixEnd + 1);
          if (suffixEnd > 0 && charAfter !== 0x28 && charAfter !== 0x5b /* ( or [ */) {
            const suffix = state.src.slice(suffixStart, suffixEnd);
            citation.citationSuffix = state.md.parseInline(suffix, state.env);
            state.pending += `${match[0]}${suffix}]`;
            state.pos += match[0].length + suffixEnd - suffixStart + 1;
          } else {
            state.pending += `@${match[1]}`;
            state.pos += match[0].length - match[2].length - match[3].length;
          }
        } else {
          state.pos += match[0].length - match[2].length;
        }
        if (token) {
          token.meta = citeproc?.appendCluster([citation]);
          state.pushPending();
          state.push('cite_close', 'span', -1);
        }
        return true;
      }
    } else if (char === 0x5b /* [ */) {
      const end = state.md.helpers.parseLinkLabel(state, state.pos);
      const charAfter = state.src.codePointAt(end + 1);
      if (end > 0 && charAfter !== 0x28) {
        const str = state.src.slice(state.pos + 1, end);
        const parts = str.split(';').map(x => x.match(regexes.citation));
        if (parts.indexOf(null) >= 0) {
          return false;
        }
        let citeproc: CiteProc<unknown> | undefined;
        if (options?.citeproc) {
          citeproc = state.env.citeproc;
          if (!citeproc) {
            citeproc = options.citeproc(state.env);
            state.env.citeproc = citeproc;
          }
        }
        const nextNoteNum = (state.env.noteNum ?? 0) + 1;
        state.env.noteNum = nextNoteNum;
        const cites: Citation[] = (parts as RegExpMatchArray[]).map(x => {
          const { citationId, claimId } = splitCitationKey(x[3]);
          return {
            citationId,
            claimId,
            citationPrefix: x[1] ? state.md.parseInline(x[1], state.env) : [],
            citationSuffix: x[4] ? state.md.parseInline(x[4], state.env) : [],
            citationMode: x[2] ? 'SuppressAuthor' : 'NormalCitation',
            citationNoteNum: nextNoteNum,
            citationHash: 0,
          };
        });
        if (!silent) {
          const token = state.push('cite_open', 'span', 1);
          token.meta = citeproc?.appendCluster(cites);
          token.attrSet('class', 'citation');
          token.attrSet('data-cites', cites.map(x => x.citationId).join(' '));
          state.pending = state.src.slice(state.pos, end + 1);
          state.push('cite_close', 'span', -1);
        }
        state.pos = end + 1;
        return true;
      }
      return false;
    }
    return false;
  });

  if (options?.citeproc) {
    md.renderer.rules.cite_open = (tkns, idx, _opts, env, slf) => {
      const citeproc = env.citeproc || options.citeproc(env);
      tkns[idx + 1].content = '';
      return citeproc.renderCluster(tkns[idx].meta, slf);
    };
    md.renderer.rules.cite_close = () => '';

    if (!options?.['suppress-bibliography']) {
      md.core.ruler.push('bibliography', state => {
        if (!state.inlineMode) {
          const i = state.tokens.findIndex(tk => tk.attrGet('id') === 'refs');
          if (i >= 0) {
            const refsOpen = state.tokens[i];
            if (refsOpen.nesting !== 1) {
              return false;
            }
            let j = i + 1;
            while (j < state.tokens.length) {
              if (
                state.tokens[j].tag === refsOpen.tag &&
                state.tokens[j].level === refsOpen.level &&
                state.tokens[j].nesting === -1
              ) {
                state.tokens.splice(j, 0, new state.Token('bibliography', '', 0));
                return true;
              }
              j += 1;
            }
            return false;
          }
          const refsOpen = new state.Token('refs_container', 'div', 1);
          refsOpen.attrSet('id', 'refs');
          state.tokens.push(refsOpen);
          state.tokens.push(new state.Token('bibliography', '', 0));
          state.tokens.push(new state.Token('refs_container', 'div', -1));
          return true;
        }
        return false;
      });

      md.renderer.rules.bibliography = (_tks, _idx, _opts, env) => {
        let citeproc: CiteProc<unknown> | undefined;
        if (options?.citeproc) {
          citeproc = env.citeproc;
          if (!citeproc) {
            citeproc = options.citeproc(env);
            env.citeproc = citeproc;
          }
        }
        return citeproc?.renderBibliography() || '<NO CITEPROC CONFIGURED>';
      };
    }
  }
};

export default Citations;
