import config from 'config';
import { McpToolError, NotFoundError } from './errors.js';
import type { MediaData, MediaType } from './media.js';

export interface CommonsFetchResult {
  mediaType: MediaType;
  data: MediaData;
}

interface CommonsApiImageInfo {
  url?: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  width?: number;
  height?: number;
  size?: number;
  duration?: number;
  mime?: string;
  mediatype?: string;
  extmetadata?: Record<string, { value?: unknown; source?: string }>;
}

interface CommonsApiPage {
  pageid?: number;
  ns?: number;
  title?: string;
  missing?: boolean;
  imageinfo?: CommonsApiImageInfo[];
}

interface CommonsApiResponse {
  query?: {
    pages?: CommonsApiPage[];
  };
  error?: { code?: string; info?: string };
}

export interface FetchCommonsOptions {
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  // Width to fetch a sample thumbnail URL at. The returned
  // `thumbnailUrlTemplate` contains `/<width>px-` and the storage
  // layer substitutes a width into it on demand.
  thumbnailSampleWidth?: number;
}

// Wikimedia thumbnail URLs follow the pattern
// `.../thumb/X/Y/Filename.ext/<step>px-Filename.ext`. Given any one
// such URL we can derive a URL at any other canonical step via
// regex substitution. Returns null if the input doesn't look like
// a Wikimedia thumbnail URL.
export const buildThumbnailUrlForWidth = (
  template: string | null | undefined,
  width: number
): string | null => {
  if (!template) return null;
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!/\/\d+px-/.test(template)) return null;
  return template.replace(/\/\d+px-/, `/${width}px-`);
};

const ALLOWED_INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'p']);

const escapeHtmlAttribute = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const normalizeOutboundHref = (href: string): string | null => {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

export const sanitizeCommonsHtml = (html: string): string => {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const withoutBlocks = withoutComments.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '');
  const openCounts = new Map<string, number>();
  return withoutBlocks.replace(/<\/?([a-z0-9:-]+)([^>]*)>/gi, (full, rawTagName, rawAttrs) => {
    const tagName = String(rawTagName).toLowerCase();
    const isClosing = full.startsWith('</');
    if (isClosing) {
      const open = openCounts.get(tagName) ?? 0;
      if ((tagName === 'a' || ALLOWED_INLINE_TAGS.has(tagName)) && open > 0) {
        openCounts.set(tagName, open - 1);
        return `</${tagName}>`;
      }
      return '';
    }
    if (tagName === 'a') {
      const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(rawAttrs));
      const hrefValue = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
      const normalizedHref = normalizeOutboundHref(hrefValue);
      if (!normalizedHref) return '';
      openCounts.set(tagName, (openCounts.get(tagName) ?? 0) + 1);
      return `<a href="${escapeHtmlAttribute(normalizedHref)}" target="_blank" rel="noreferrer noopener">`;
    }
    if (ALLOWED_INLINE_TAGS.has(tagName)) {
      openCounts.set(tagName, (openCounts.get(tagName) ?? 0) + 1);
      return `<${tagName}>`;
    }
    return '';
  });
};

const stripHtml = (value: string): string => value.replace(/<[^>]*>/g, '').trim();

const readExtmetadataValue = (
  ext: Record<string, { value?: unknown; source?: string }> | undefined,
  key: string
): string => {
  const entry = ext?.[key];
  if (!entry) return '';
  const value = entry.value;
  return typeof value === 'string' ? value : '';
};

const parseDescriptionField = (raw: string): Record<string, string> | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const langMatches = [
    ...trimmed.matchAll(/<div\s+class="description\s+([a-z]{2,3}(?:-[A-Za-z0-9]+)*)"[^>]*>([\s\S]*?)<\/div>/gi),
  ];
  if (langMatches.length > 0) {
    const out: Record<string, string> = {};
    for (const match of langMatches) {
      const lang = match[1].toLowerCase();
      const text = stripHtml(match[2]);
      if (text) out[lang] = text;
    }
    if (Object.keys(out).length > 0) return out;
  }
  const fallback = stripHtml(trimmed);
  return fallback ? { en: fallback } : undefined;
};

const normalizeMediaType = (raw: string | undefined): MediaType | null => {
  if (!raw) return null;
  const normalized = raw.toUpperCase();
  if (normalized === 'BITMAP' || normalized === 'DRAWING') return 'image';
  if (normalized === 'AUDIO') return 'audio';
  if (normalized === 'VIDEO') return 'video';
  return null;
};

export const normalizeCommonsTitle = (title: string): string => {
  const trimmed = title.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const withPrefix = /^file:/i.test(trimmed) ? trimmed : `File:${trimmed}`;
  return withPrefix.replace(/_/g, ' ');
};

export const fetchCommonsMetadata = async (
  commonsTitle: string,
  options: FetchCommonsOptions = {}
): Promise<CommonsFetchResult> => {
  const normalized = normalizeCommonsTitle(commonsTitle);
  if (!normalized) {
    throw new McpToolError('validation_error', 'commonsTitle is required.');
  }

  const apiBaseUrl =
    options.apiBaseUrl ?? config.get<string>('media.commonsApiBaseUrl');
  const userAgent = options.userAgent ?? config.get<string>('media.userAgent');
  const timeoutMs = options.timeoutMs ?? config.get<number>('media.fetchTimeoutMs');
  // Fetch one thumbnail URL at any canonical step; storage substitutes
  // widths into it on demand. The default 960 is a middle-of-set
  // canonical step that produces a URL whose substitution pattern is
  // identical regardless of which step we asked for.
  const sampleWidth = options.thumbnailSampleWidth ?? 960;
  const fetchImpl = options.fetchImpl ?? fetch;

  const params = new URLSearchParams({
    action: 'query',
    prop: 'imageinfo',
    titles: normalized,
    iiprop: 'url|size|mime|mediatype|extmetadata',
    iiurlwidth: String(sampleWidth),
    format: 'json',
    formatversion: '2',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let payload: CommonsApiResponse;
  try {
    const response = await fetchImpl(`${apiBaseUrl}?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new McpToolError(
        'internal_error',
        `Commons API returned status ${response.status}.`,
        {
          details: { commonsTitle: normalized, status: response.status },
          // Only 5xx (and the network-failure path below) are worth
          // retrying; 4xx means the request itself is malformed.
          retryable: response.status >= 500,
        }
      );
    }
    payload = (await response.json()) as CommonsApiResponse;
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    const message =
      error instanceof Error ? error.message : 'Failed to reach Commons API.';
    throw new McpToolError('internal_error', `Commons fetch failed: ${message}`, {
      details: { commonsTitle: normalized },
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (payload.error) {
    throw new McpToolError(
      'internal_error',
      `Commons API error: ${payload.error.info ?? payload.error.code ?? 'unknown'}`,
      { details: { commonsTitle: normalized }, retryable: false }
    );
  }

  const page = payload.query?.pages?.[0];
  if (!page || page.missing) {
    throw new NotFoundError(`Commons file not found: ${normalized}`, {
      commonsTitle: normalized,
    });
  }

  const info = page.imageinfo?.[0];
  if (!info) {
    throw new NotFoundError(`Commons file has no imageinfo: ${normalized}`, {
      commonsTitle: normalized,
    });
  }

  const mediaType = normalizeMediaType(info.mediatype);
  if (!mediaType) {
    throw new McpToolError(
      'unsupported',
      `Unsupported Commons mediatype: ${info.mediatype ?? 'unknown'}`,
      { details: { commonsTitle: normalized, mediatype: info.mediatype } }
    );
  }

  const ext = info.extmetadata;
  const license = readExtmetadataValue(ext, 'LicenseShortName').trim();
  const licenseUrl = readExtmetadataValue(ext, 'LicenseUrl').trim();
  const artist = readExtmetadataValue(ext, 'Artist');
  const credit = readExtmetadataValue(ext, 'Credit');
  const attribution = readExtmetadataValue(ext, 'Attribution');
  const descriptionRaw = readExtmetadataValue(ext, 'ImageDescription');

  const author = stripHtml(artist) || undefined;
  const sanitizedAttribution = attribution
    ? sanitizeCommonsHtml(attribution)
    : artist
    ? sanitizeCommonsHtml(artist)
    : undefined;

  const titleForUrl = page.title ?? normalized;
  const commonsPageUrl = `https://commons.wikimedia.org/wiki/${encodeURI(
    titleForUrl.replace(/\s+/g, '_')
  )}`;

  const thumbnailUrlTemplate =
    mediaType === 'image' && info.thumburl ? info.thumburl : null;

  const data: MediaData = {
    commonsPageUrl,
    mime: info.mime ?? 'application/octet-stream',
    width: info.width,
    height: info.height,
    thumbnailUrlTemplate,
    originalUrl: info.url ?? '',
    license: license || undefined,
    licenseUrl: licenseUrl || undefined,
    author,
    attributionHtml: sanitizedAttribution,
    credit: credit ? stripHtml(credit) : undefined,
    description: parseDescriptionField(descriptionRaw),
    fetchedAt: new Date().toISOString(),
  };

  return { mediaType, data };
};
