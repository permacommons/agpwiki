import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';

export type TocItem = {
  level: number;
  text: string;
  slug: string;
};

const slugify = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

const makeUniqueSlug = (slug: string, usedSlugs: Set<string>): string => {
  let candidate = slug || 'section';
  let counter = 1;
  while (usedSlugs.has(candidate)) {
    counter += 1;
    candidate = `${slug || 'section'}-${counter}`;
  }
  usedSlugs.add(candidate);
  return candidate;
};

export const tocPlugin = () => (md: MarkdownIt) => {
  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    ((tokens: Token[], idx: number, options: MarkdownIt.Options, _env: unknown, self: MarkdownIt['renderer']) =>
      self.renderToken(tokens, idx, options));

  md.core.ruler.push('toc_extract', (state) => {
    const env = state.env as { toc?: TocItem[]; tocSlugs?: Set<string> };
    if (!env.toc) {
      env.toc = [];
    }
    if (!env.tocSlugs) {
      env.tocSlugs = new Set();
    }

    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type !== 'heading_open') continue;

      const level = parseInt(token.tag.slice(1), 10);
      const inlineToken = tokens[i + 1];
      if (!inlineToken || inlineToken.type !== 'inline') continue;

      const text = inlineToken.content;
      const baseSlug = slugify(text);
      const slug = makeUniqueSlug(baseSlug, env.tocSlugs);

      token.attrSet('id', slug);

      env.toc.push({ level, text, slug });
    }
    return true;
  });

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    return defaultHeadingOpen(tokens, idx, options, env, self);
  };
};

export const renderToc = (
  items: TocItem[],
  options: { expanded: boolean; label: string }
): string => {
  if (items.length === 0) return '';

  const { expanded, label } = options;
  const openAttr = expanded ? ' open' : '';

  const listItems = items
    .map(item => {
      const indent = item.level - 1;
      const paddingClass = indent > 0 ? ` style="padding-left: ${indent}rem"` : '';
      return `<li${paddingClass}><a href="#${item.slug}">${escapeHtml(item.text)}</a></li>`;
    })
    .join('\n');

  return `<details class="page-toc"${openAttr}>
  <summary>${escapeHtml(label)}</summary>
  <nav>
    <ol class="toc-list">${listItems}</ol>
  </nav>
</details>`;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
