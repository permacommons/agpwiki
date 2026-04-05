import MarkdownIt from 'markdown-it';
import { isBlockedSlug, normalizeSlug } from './slug.js';

const INTERNAL_ORIGIN = 'https://agpedia.local';
const linkParser = new MarkdownIt({ html: false, linkify: true });

const titleCaseWord = (word: string) => {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

export const parseWikiLinkSlug = (href: string): string | null => {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(trimmed, INTERNAL_ORIGIN);
  } catch {
    return null;
  }

  if (url.origin !== INTERNAL_ORIGIN) return null;
  if (!url.pathname.startsWith('/')) return null;

  const slug = normalizeSlug(decodeURIComponent(url.pathname));
  if (!slug || isBlockedSlug(slug)) return null;
  return slug;
};

export const extractCandidateWikiLinkSlugs = (source: string): string[] => {
  const tokens = linkParser.parse(source, {});
  const slugs = new Set<string>();

  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    for (const child of token.children) {
      if (child.type !== 'link_open') continue;
      const href = child.attrGet('href');
      if (!href) continue;
      const slug = parseWikiLinkSlug(href);
      if (slug) slugs.add(slug);
    }
  }

  return [...slugs];
};

const toSentenceCase = (value: string) => {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
};

const toTitleCase = (value: string) =>
  value
    .split(/(\s+|\/)/)
    .map(part => (/^\s+$/.test(part) || part === '/' ? part : titleCaseWord(part)))
    .join('');

export const buildWikipediaTitleVariants = (slug: string): string[] => {
  const baseTitle = normalizeSlug(slug)
    .split('/')
    .map(segment => segment.replace(/-/g, ' '))
    .join('/');

  const variants = [
    toSentenceCase(baseTitle),
    toTitleCase(baseTitle),
    baseTitle,
    baseTitle.toLowerCase(),
  ];

  return variants.filter((variant, index) => variant && variants.indexOf(variant) === index);
};
