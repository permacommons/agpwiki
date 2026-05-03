export const MEDIA_SLUG_MAX_LENGTH = 200;
export const MEDIA_TITLE_MAX_LENGTH = 300;
export const MEDIA_COMMONS_TITLE_MAX_LENGTH = 255;
export const MEDIA_CAPTION_MAX_LENGTH = 1000;
export const MEDIA_ALT_TEXT_MAX_LENGTH = 500;

// MediaType is left as a union for forward compatibility — the
// commons.ts metadata fetcher categorizes upstream files into these
// buckets — but at the service layer this rework only accepts
// 'image'. The DB CHECK constraint enforces the same. Audio/video
// land in a follow-up with their own validation pipeline.
export const MEDIA_TYPES = ['image', 'audio', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

// Wikimedia thumbnail infrastructure only renders thumbnails at a fixed
// list of "thumbnail steps" (see $wgThumbnailSteps). Off-list widths
// are rejected with HTTP 400. Canonical list as of 2026-05:
//   20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840
//   https://www.mediawiki.org/wiki/Common_thumbnail_sizes
//
// The set below is the useful subset for article media. Keep these
// inside the canonical list and in sync with config/default.json5.
export const MEDIA_WIKIMEDIA_THUMBNAIL_STEPS = [250, 500, 960, 1280, 1920] as const;

// Standard CSS display widths recommended for `![@slug|size=N]`.
// These are *suggestions*, not an allowlist — agents and operators
// may choose other integer widths in [1, MEDIA_MAX_DISPLAY_WIDTH] if
// there's a reason to depart from the standard set. The validator
// only enforces the integer range; the standard set is surfaced via
// tool descriptions and inline error messages so users land on it
// most of the time without being boxed in.
//
// Two slots: a small thumbnail (Wikipedia-style; floats right with
// text wrapping around it) and a column-wide hero (centered block).
// The middle slot was removed because it was too wide to flow text
// alongside but too narrow to fill the column, leaving an awkward
// banded layout.
//
// 800 is the practical sweet spot for the hero slot at the current
// layout (article column is ~768 CSS px wide); sizes much beyond
// that get downscaled by the browser and don't render meaningfully
// larger.
export const MEDIA_RECOMMENDED_DISPLAY_WIDTHS = [250, 800] as const;

// Inclusive upper bound on display widths. Set to the largest
// canonical Wikimedia thumbnail step so every accepted width has a
// fetchable rendition.
export const MEDIA_MAX_DISPLAY_WIDTH = 1920;

// Approximate CSS pixel width of the article column at the current
// layout. Surfaced in operator-readable hints so people picking
// non-standard sizes know why bigger isn't always better.
export const MEDIA_ARTICLE_COLUMN_CSS_PX = 768;

// Boundary between "small floating thumbnail" and "column-wide hero
// figure" rendering. Figures rendered at ≤ this width get the
// `media-image-flow` class (floats right, text wraps); figures
// rendered at > this width get `media-image-hero` (centered block).
// Set above the small standard (250) and well below the hero
// standard (800), so non-standard sizes land in the obviously-right
// bucket.
export const MEDIA_HERO_THRESHOLD_PX = 400;

// Map a requested CSS display width to the smallest Wikimedia step
// that is ≥ it. Returns null if width is larger than all canonical
// steps (unreachable for the recommended set, but safe).
export const resolveWikimediaStepForWidth = (
  displayWidth: number,
  steps: readonly number[] = MEDIA_WIKIMEDIA_THUMBNAIL_STEPS
): number | null => {
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) return null;
  const sorted = [...steps].sort((a, b) => a - b);
  for (const step of sorted) {
    if (step >= displayWidth) return step;
  }
  return null;
};

export interface MediaData {
  commonsPageUrl: string;
  mime: string;
  // Original Commons file dimensions — used by the renderer to
  // derive height attribute from a chosen display width.
  width?: number;
  height?: number;
  // A Wikimedia thumbnail URL containing `/<step>px-`. The storage
  // layer / route handler uses `buildThumbnailUrlForWidth` from
  // commons.ts to substitute any canonical step before fetching.
  thumbnailUrlTemplate: string | null;
  originalUrl: string;
  license?: string;
  licenseUrl?: string;
  author?: string;
  attributionHtml?: string;
  credit?: string;
  description?: Record<string, string>;
  fetchedAt: string;
}

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const formatMediaLabel = (slug: string, commonsTitle: string) => {
  const title = normalizeString(commonsTitle);
  return title ? `${slug} - ${title}` : slug;
};

export const formatMediaPageTitle = (slug: string, commonsTitle: string) => {
  const title = normalizeString(commonsTitle);
  return title || slug;
};

export const formatMediaJson = (data: MediaData | Record<string, unknown> | null) =>
  JSON.stringify(data ?? {}, null, 2);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const escapeAttr = escapeHtml;

export interface MediaFigureOptions {
  caption?: string;
  alt?: string;
  size: number;
  revId?: string | null;
}

export interface MediaFigureSource {
  slug: string;
  data: MediaData;
}

const formatAttributionHtml = (data: MediaData): string => {
  const parts: string[] = [];
  if (data.attributionHtml) {
    parts.push(data.attributionHtml);
  } else if (data.author) {
    parts.push(escapeHtml(data.author));
  }
  if (data.license) {
    const licenseHtml = data.licenseUrl
      ? `<a href="${escapeAttr(data.licenseUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(data.license)}</a>`
      : escapeHtml(data.license);
    parts.push(licenseHtml);
  }
  if (data.commonsPageUrl) {
    parts.push(
      `<a href="${escapeAttr(data.commonsPageUrl)}" target="_blank" rel="noreferrer noopener">Wikimedia Commons</a>`
    );
  }
  if (parts.length === 0) return '';
  return `<span class="media-attribution">${parts.join(' · ')}</span>`;
};

const formatFigcaptionContents = (
  caption: string | undefined,
  attributionHtml: string
): string => {
  const safeCaption = caption ? escapeHtml(caption) : '';
  if (safeCaption && attributionHtml) {
    return `<span class="media-caption-text">${safeCaption}</span> ${attributionHtml}`;
  }
  if (safeCaption) return `<span class="media-caption-text">${safeCaption}</span>`;
  return attributionHtml;
};

const buildLocalMediaUrl = (slug: string, size: number, revId?: string | null): string => {
  const segments = slug.split('/').map(encodeURIComponent).join('/');
  const base = `/media-files/${segments}/${size}`;
  return revId ? `${base}?v=${encodeURIComponent(revId)}` : base;
};

const computeRenderedHeight = (
  size: number,
  data: MediaData
): number | null => {
  if (!data.width || !data.height) return null;
  return Math.round((size * data.height) / data.width);
};

export const formatMediaFigureHtml = (
  source: MediaFigureSource,
  options: MediaFigureOptions
): string => {
  const { slug, data } = source;
  const caption = options.caption?.trim() || undefined;
  const alt = options.alt?.trim() ?? '';
  const size = options.size;
  const attributionHtml = formatAttributionHtml(data);
  const figcaption = formatFigcaptionContents(caption, attributionHtml);
  const figcaptionTag = figcaption ? `<figcaption>${figcaption}</figcaption>` : '';

  const srcUrl = buildLocalMediaUrl(slug, size, options.revId);
  const widthAttr = ` width="${size}"`;
  const renderedHeight = computeRenderedHeight(size, data);
  const heightAttr = renderedHeight ? ` height="${renderedHeight}"` : '';
  const linkAttr = data.commonsPageUrl
    ? ` data-commons-page="${escapeAttr(data.commonsPageUrl)}"`
    : '';
  // Small figures float right with text wrapping (Wikipedia-style);
  // larger figures render as centered hero blocks. Threshold is in
  // CSS pixels and mirrors the recommended pair (250 → flow, 800 →
  // hero); custom sizes fall into whichever bucket the threshold
  // implies.
  const layoutClass = size <= MEDIA_HERO_THRESHOLD_PX ? 'media-image-flow' : 'media-image-hero';
  return `<figure class="media media-image ${layoutClass}"${linkAttr}><img src="${escapeAttr(srcUrl)}" alt="${escapeAttr(alt)}"${widthAttr}${heightAttr} loading="lazy">${figcaptionTag}</figure>`;
};

export const formatMediaInlineHtml = (
  source: MediaFigureSource,
  options: MediaFigureOptions
): string => {
  const { slug, data } = source;
  const alt = options.alt?.trim() ?? '';
  const size = options.size;
  const srcUrl = buildLocalMediaUrl(slug, size, options.revId);
  const widthAttr = ` width="${size}"`;
  const renderedHeight = computeRenderedHeight(size, data);
  const heightAttr = renderedHeight ? ` height="${renderedHeight}"` : '';
  return `<img class="media-inline" src="${escapeAttr(srcUrl)}" alt="${escapeAttr(alt)}"${widthAttr}${heightAttr} loading="lazy">`;
};

export const formatMediaMissingHtml = (slug: string, reason?: string): string => {
  const detail = reason ? `: ${reason}` : '';
  return `<span class="media-missing" data-slug="${escapeAttr(slug)}">Missing media: ${escapeHtml(slug)}${escapeHtml(detail)}</span>`;
};

export const formatMediaInvalidSizeHtml = (
  slug: string,
  size: unknown,
  standardWidths: readonly number[],
  maxWidth: number = MEDIA_MAX_DISPLAY_WIDTH,
  columnCssPx: number = MEDIA_ARTICLE_COLUMN_CSS_PX
): string => {
  const standardList = standardWidths.slice().sort((a, b) => a - b).join(', ');
  return `<span class="media-invalid-size" data-slug="${escapeAttr(slug)}">[invalid media size: ${escapeHtml(String(size))} for ${escapeHtml(slug)}. Use an integer 1–${maxWidth}; standard sizes: ${escapeHtml(standardList)}. Article column is ~${columnCssPx} CSS px so larger sizes render no bigger.]</span>`;
};
