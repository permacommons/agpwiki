import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';
import { mediaPlugin, type ParsedMediaRef } from '../markdown/media.js';
import type { MediaData, MediaType } from './media.js';

const mediaSlugParser = new MarkdownIt({ html: false, linkify: true }).use(mediaPlugin());

const collectMediaSlugsFromTokens = (tokens: Token[], slugs: Set<string>) => {
  for (const token of tokens) {
    if (token.type === 'media') {
      const ref = token.meta as ParsedMediaRef | undefined;
      if (ref && ref.invalidSlug === undefined) {
        slugs.add(ref.slug);
      }
    }
    if (token.children) {
      collectMediaSlugsFromTokens(token.children, slugs);
    }
  }
};

export const extractMediaSlugsFromSources = (sources: Iterable<string>) => {
  const slugs = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    collectMediaSlugsFromTokens(mediaSlugParser.parse(source, {}), slugs);
  }
  return slugs;
};

export interface MediaRegistryEntry {
  slug: string;
  title: Record<string, string> | null;
  commonsTitle: string;
  mediaType: MediaType;
  data: MediaData;
  caption: Record<string, string> | null;
  altText: Record<string, string> | null;
  // Current revision ID — included so the renderer can cache-bust
  // local thumbnail URLs after a refresh.
  revId: string;
}
