import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { isBlockedSlug, normalizeSlug } from '../lib/slug.js';
import { buildWikipediaTitleVariants } from '../lib/wiki-links.js';
import PageAlias from '../models/page-alias.js';
import WikiPage from '../models/wiki-page.js';
import { renderMarkdown } from '../render.js';
import { readWikiPage } from './wiki-page-service.js';

export interface WikipediaPreview {
  title: string;
  html: string;
  url: string;
}

export interface LocalWikiPreview {
  title: string;
  html: string;
  url: string;
}

type WikipediaParseResponse = {
  parse?: {
    title?: string;
    text?: {
      '*': string;
    };
  };
};

type WikipediaFetchResult =
  | { kind: 'hit'; value: WikipediaPreview }
  | { kind: 'miss' }
  | { kind: 'error' };

type TtlCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WIKIPEDIA_ERROR_CACHE_TTL_MS = 30 * 1000;
const WIKIPEDIA_CACHE_MAX_ENTRIES = 512;
const WIKIPEDIA_TIMEOUT_MS = 4000;
const WIKIPEDIA_MAX_PARAGRAPHS = 1;
const LOCAL_PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCAL_PREVIEW_CACHE_MAX_ENTRIES = 512;
const WIKIPEDIA_USER_AGENT =
  'AgpWiki/1.0 (wiki link preview; https://github.com/permacommons/agpwiki/issues)';
const wikipediaInflight = new Map<string, Promise<WikipediaPreview | null>>();
const ALLOWED_WIKIPEDIA_INLINE_TAGS = new Set(['b', 'strong', 'i', 'em']);
const { mlString } = dal;

const createTtlCache = <T>(maxEntries: number) => {
  const store = new Map<string, TtlCacheEntry<T>>();

  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }

    while (store.size > maxEntries) {
      const firstKey = store.keys().next().value;
      if (!firstKey) break;
      store.delete(firstKey);
    }
  };

  const get = (key: string): T | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  };

  const set = (key: string, value: T, ttlMs: number) => {
    prune();
    store.set(key, {
      expiresAt: Date.now() + ttlMs,
      value,
    });
  };

  return { get, set };
};

const wikipediaCache = createTtlCache<WikipediaPreview | null>(WIKIPEDIA_CACHE_MAX_ENTRIES);
const localPreviewCache = createTtlCache<LocalWikiPreview>(LOCAL_PREVIEW_CACHE_MAX_ENTRIES);

export const findExistingWikiLinkSlugs = async (
  dal: DataAccessLayer,
  slugs: string[]
): Promise<Set<string>> => {
  if (slugs.length === 0) {
    return new Set();
  }

  const normalized = [...new Set(slugs.map(slug => normalizeSlug(slug)).filter(Boolean))];
  if (normalized.length === 0) {
    return new Set();
  }

  const result = await dal.query(
    `SELECT slug
     FROM ${WikiPage.tableName}
     WHERE slug = ANY($1::text[])
       AND _old_rev_of IS NULL
       AND _rev_deleted = false
     UNION
     SELECT slug
     FROM ${PageAlias.tableName}
     WHERE slug = ANY($1::text[])`,
    [normalized]
  );

  return new Set(
    result.rows
      .map(row => row.slug)
      .filter((slug): slug is string => typeof slug === 'string')
  );
};

const normalizeWikipediaHref = (href: string): string | null => {
  const trimmed = href.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, 'https://en.wikipedia.org');
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'en.wikipedia.org') return null;
    if (!url.pathname.startsWith('/wiki/')) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const escapeHtmlAttribute = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const sanitizeWikipediaParagraphHtml = (html: string): string => {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const withoutRefs = withoutComments.replace(/<sup\b[\s\S]*?<\/sup>/gi, '');
  const openTagCount = new Map<string, number>();

  return withoutRefs.replace(/<\/?([a-z0-9:-]+)([^>]*)>/gi, (full, rawTagName, rawAttrs) => {
    const tagName = String(rawTagName).toLowerCase();
    const isClosing = full.startsWith('</');

    if (isClosing) {
      const openCount = openTagCount.get(tagName) ?? 0;
      if ((tagName === 'a' || ALLOWED_WIKIPEDIA_INLINE_TAGS.has(tagName)) && openCount > 0) {
        openTagCount.set(tagName, openCount - 1);
        return `</${tagName}>`;
      }
      return '';
    }

    if (tagName === 'a') {
      const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(rawAttrs));
      const hrefValue = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
      const normalizedHref = normalizeWikipediaHref(hrefValue);
      if (!normalizedHref) return '';
      openTagCount.set(tagName, (openTagCount.get(tagName) ?? 0) + 1);
      return `<a href="${escapeHtmlAttribute(normalizedHref)}" target="_blank" rel="noreferrer noopener">`;
    }

    if (ALLOWED_WIKIPEDIA_INLINE_TAGS.has(tagName)) {
      openTagCount.set(tagName, (openTagCount.get(tagName) ?? 0) + 1);
      return `<${tagName}>`;
    }

    return '';
  });
};

export const extractWikipediaPreviewHtml = (html: string): string => {
  const paragraphs: string[] = [];
  const matches = html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi);

  for (const match of matches) {
    const innerHtml = match[1]?.trim() ?? '';
    if (!innerHtml) continue;

    const sanitized = sanitizeWikipediaParagraphHtml(innerHtml).trim();
    const text = striptags(sanitized).replace(/\s+/g, ' ').trim();
    if (!sanitized || !text) continue;

    paragraphs.push(`<p>${sanitized}</p>`);
    if (paragraphs.length >= WIKIPEDIA_MAX_PARAGRAPHS) {
      break;
    }
  }

  return paragraphs.join('');
};

const resolveLocalizedString = (
  preferredLocale: string,
  value: Record<string, string> | null | undefined,
  fallback: string
) => {
  const resolved = mlString.resolve([preferredLocale, 'en'], value ?? null);
  return resolved?.str?.trim() ? resolved.str : fallback;
};

export const extractLeadMarkdownSource = (source: string): string => {
  const trimmed = source.trim();
  if (!trimmed) return '';

  const headingMatch = /^ {0,3}#{1,6}\s+/m.exec(trimmed);
  if (!headingMatch || typeof headingMatch.index !== 'number' || headingMatch.index <= 0) {
    return trimmed;
  }

  const lead = trimmed.slice(0, headingMatch.index).trim();
  return lead || trimmed;
};

export const extractLocalPreviewHtml = (html: string): string => {
  const paragraphMatch = /<p\b[^>]*>[\s\S]*?<\/p>/i.exec(html);
  if (!paragraphMatch) return '';

  return paragraphMatch[0]
    .replace(/<span class="citation-group">[\s\S]*?<\/span>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

export const buildLocalWikiPreview = async (
  dalInstance: DataAccessLayer,
  slug: string,
  locale: string
): Promise<LocalWikiPreview | null> => {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug || isBlockedSlug(normalizedSlug)) {
    return null;
  }

  const page = await readWikiPage(dalInstance, normalizedSlug).catch(() => null);
  if (!page) {
    return null;
  }

  const cacheKey = `${page.slug}:${locale}:${page.contentHash}`;
  const cached = localPreviewCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const title = resolveLocalizedString(locale, page.title, page.slug);
  const bodySource = resolveLocalizedString(locale, page.body, '');
  const leadSource = extractLeadMarkdownSource(bodySource);
  const citationEntries = await loadCitationEntriesForSources(dalInstance, [leadSource]);
  const rendered = leadSource ? (await renderMarkdown(leadSource, citationEntries)).html : '';
  const html = extractLocalPreviewHtml(rendered);

  const preview: LocalWikiPreview = {
    title,
    html,
    url: `/${encodeURIComponent(page.slug)}`,
  };

  localPreviewCache.set(cacheKey, preview, LOCAL_PREVIEW_CACHE_TTL_MS);
  return preview;
};

const fetchWikipediaVariant = async (title: string): Promise<WikipediaFetchResult> => {
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'text',
    redirects: '1',
    section: '0',
    format: 'json',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WIKIPEDIA_TIMEOUT_MS);

  try {
    const response = await fetch(`${WIKIPEDIA_API_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': WIKIPEDIA_USER_AGENT,
      },
    });

    if (!response.ok) {
      return { kind: 'error' };
    }

    const payload = (await response.json()) as WikipediaParseResponse;
    const resolvedTitle = payload.parse?.title?.trim();
    const sourceHtml = payload.parse?.text?.['*']?.trim();
    const previewHtml = sourceHtml ? extractWikipediaPreviewHtml(sourceHtml) : '';

    if (!resolvedTitle || !previewHtml) {
      return { kind: 'miss' };
    }

    return {
      kind: 'hit',
      value: {
        title: resolvedTitle,
        html: previewHtml,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/\s+/g, '_'))}`,
      },
    };
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timeout);
  }
};

export const fetchWikipediaPreviewForSlug = async (
  slug: string
): Promise<WikipediaPreview | null> => {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug || isBlockedSlug(normalizedSlug)) {
    return null;
  }

  const cached = wikipediaCache.get(normalizedSlug);
  if (cached !== undefined) {
    return cached;
  }

  const existingRequest = wikipediaInflight.get(normalizedSlug);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    let sawError = false;

    for (const title of buildWikipediaTitleVariants(normalizedSlug)) {
      const result = await fetchWikipediaVariant(title);
      if (result.kind === 'hit') {
        wikipediaCache.set(normalizedSlug, result.value, WIKIPEDIA_CACHE_TTL_MS);
        return result.value;
      }
      if (result.kind === 'error') {
        sawError = true;
      }
    }

    if (sawError) {
      wikipediaCache.set(normalizedSlug, null, WIKIPEDIA_ERROR_CACHE_TTL_MS);
      return null;
    }

    wikipediaCache.set(normalizedSlug, null, WIKIPEDIA_CACHE_TTL_MS);
    return null;
  })();

  wikipediaInflight.set(normalizedSlug, request);

  try {
    return await request;
  } finally {
    wikipediaInflight.delete(normalizedSlug);
  }
};
