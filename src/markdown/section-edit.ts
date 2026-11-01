import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';

export type SectionEditLinkRenderer = (sectionIndex: number) => string;

// Numbers headings that come from the source text (generated ones have no
// map) the same way listEditableSections does, and appends the caller's
// edit link inside each one.
export const sectionEditPlugin = () => (md: MarkdownIt) => {
  md.core.ruler.push('section_index', state => {
    let index = 0;
    for (const token of state.tokens) {
      if (token.type !== 'heading_open' || !token.map) continue;
      index += 1;
      token.meta = { ...(token.meta ?? {}), sectionIndex: index };
    }
    return true;
  });

  const defaultHeadingClose =
    md.renderer.rules.heading_close ||
    ((tokens: Token[], idx: number, options: MarkdownIt.Options, _env: unknown, self: MarkdownIt['renderer']) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const renderLink = (env as { sectionEditLink?: SectionEditLinkRenderer }).sectionEditLink;
    const open = tokens[idx - 2];
    const sectionIndex = open?.type === 'heading_open' ? (open.meta?.sectionIndex as number | undefined) : undefined;
    const link = renderLink && sectionIndex ? renderLink(sectionIndex) : '';
    return `${link}${defaultHeadingClose(tokens, idx, options, env, self)}`;
  };
};
