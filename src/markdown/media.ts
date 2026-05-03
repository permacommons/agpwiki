import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';

import {
  formatMediaFigureHtml,
  formatMediaInlineHtml,
  formatMediaInvalidSizeHtml,
  formatMediaMissingHtml,
  MEDIA_RECOMMENDED_DISPLAY_WIDTHS,
  type MediaFigureOptions,
} from '../lib/media.js';
import type { MediaRegistryEntry } from '../lib/media-render.js';
import { isValidDisplayWidth, MEDIA_SLUG_REGEX } from '../lib/media-validation.js';

const parseSize = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const numeric = Number.parseInt(trimmed.replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric;
};

export interface ParsedMediaRef {
  slug: string;
  // The size parsed from `size=N`, or null if missing/unparseable.
  // Validation against the recommended set happens at render time so
  // we can produce a human-readable inline error rather than failing
  // the parse.
  size: number | null;
  caption?: string;
  alt?: string;
  // Set when the bracket parsed structurally but `size=` was missing
  // entirely. Renderer surfaces an operator-readable message.
  missingSize?: boolean;
  // Set when `size=` was present but the value isn't allowed.
  invalidSize?: number | string;
}

export const parseMediaBracketContent = (raw: string): ParsedMediaRef | null => {
  if (!raw.startsWith('@')) return null;
  const segments = raw.slice(1).split('|').map(s => s.trim());
  const slugSegment = segments.shift();
  if (!slugSegment || !MEDIA_SLUG_REGEX.test(slugSegment)) return null;

  const ref: ParsedMediaRef = { slug: slugSegment, size: null };
  let sawSize = false;

  for (const seg of segments) {
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq > 0) {
      const name = seg.slice(0, eq).trim().toLowerCase();
      const value = seg.slice(eq + 1).trim();
      if (name === 'alt') {
        ref.alt = value;
      } else if (name === 'size') {
        sawSize = true;
        const parsed = parseSize(value);
        if (parsed !== undefined) {
          ref.size = parsed;
        } else {
          ref.invalidSize = value;
        }
      }
      continue;
    }
    if (ref.caption === undefined) {
      ref.caption = seg;
    }
  }

  if (!sawSize) {
    ref.missingSize = true;
  }

  return ref;
};

const resolveLocalized = (
  map: Record<string, string> | null | undefined,
  locale: string | undefined
): string | undefined => {
  if (!map) return undefined;
  if (locale && typeof map[locale] === 'string' && map[locale].length > 0) return map[locale];
  if (typeof map.en === 'string' && map.en.length > 0) return map.en;
  for (const value of Object.values(map)) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const isWhitespaceOnlyTextChild = (token: Token): boolean =>
  token.type === 'text' && token.content.trim().length === 0;

// When a paragraph contains exactly one media token (plus optional
// whitespace text), unwrap the paragraph so the figure renders as
// block-level HTML. `<figure>` is flow content and is invalid inside
// `<p>`; without this lift browsers auto-close the `<p>`, mangling the
// DOM and breaking `p > figure` selectors. Inline media (mid-paragraph)
// is left alone.
const liftBlockMediaParagraphs = (tokens: Token[]) => {
  for (let i = 0; i < tokens.length - 2; i += 1) {
    const open = tokens[i];
    const inline = tokens[i + 1];
    const close = tokens[i + 2];
    if (
      open.type !== 'paragraph_open' ||
      inline.type !== 'inline' ||
      close.type !== 'paragraph_close'
    ) {
      continue;
    }
    const children = inline.children ?? [];
    const meaningful = children.filter(child => !isWhitespaceOnlyTextChild(child));
    if (meaningful.length !== 1) continue;
    const only = meaningful[0];
    if (only.type !== 'media') continue;

    const lifted = only;
    lifted.block = true;
    lifted.level = open.level;
    tokens.splice(i, 3, lifted);
  }
};

const buildFigureOptions = (
  ref: ParsedMediaRef,
  entry: MediaRegistryEntry,
  locale: string | undefined,
  size: number
): MediaFigureOptions => {
  const caption = ref.caption ?? resolveLocalized(entry.caption, locale);
  const alt =
    ref.alt ?? resolveLocalized(entry.altText, locale) ?? resolveLocalized(entry.data.description, locale);
  return {
    caption,
    alt,
    size,
    revId: entry.revId,
  };
};

export const mediaPlugin = () => (md: MarkdownIt) => {
  md.inline.ruler.after('image', 'media', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false;
    if (state.src.charCodeAt(state.pos + 1) !== 0x5b /* [ */) return false;
    const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1);
    if (labelEnd <= 0) return false;
    if (state.src.charCodeAt(labelEnd + 1) === 0x28 /* ( */) return false;

    const inner = state.src.slice(state.pos + 2, labelEnd).trim();
    const ref = parseMediaBracketContent(inner);
    if (!ref) return false;

    if (!silent) {
      const token = state.push('media', '', 0) as Token;
      token.meta = ref;
      token.markup = state.src.slice(state.pos, labelEnd + 1);
    }
    state.pos = labelEnd + 1;
    return true;
  });

  md.core.ruler.after('inline', 'media_lift', state => {
    if (state.inlineMode) return false;
    liftBlockMediaParagraphs(state.tokens);
    return true;
  });

  md.renderer.rules.media = (tokens, idx, _opts, env) => {
    const token = tokens[idx];
    const ref = token.meta as ParsedMediaRef | undefined;
    if (!ref) return '';

    const standardWidths =
      (env?.recommendedDisplayWidths as readonly number[] | undefined) ??
      MEDIA_RECOMMENDED_DISPLAY_WIDTHS;

    if (ref.missingSize) {
      return formatMediaInvalidSizeHtml(ref.slug, '(missing)', standardWidths);
    }
    if (ref.invalidSize !== undefined) {
      return formatMediaInvalidSizeHtml(ref.slug, ref.invalidSize, standardWidths);
    }
    if (ref.size === null) {
      // Defensive: parser sets one of missingSize / invalidSize when
      // size is null, but cover the path explicitly.
      return formatMediaInvalidSizeHtml(ref.slug, '(missing)', standardWidths);
    }
    if (!isValidDisplayWidth(ref.size)) {
      return formatMediaInvalidSizeHtml(ref.slug, ref.size, standardWidths);
    }

    const registry = (env?.mediaRegistry ?? null) as Map<string, MediaRegistryEntry> | null;
    const locale = (env?.locale as string | undefined) ?? undefined;
    const entry = registry?.get(ref.slug);
    if (!entry) {
      return formatMediaMissingHtml(ref.slug);
    }
    const figureOptions = buildFigureOptions(ref, entry, locale, ref.size);
    if (token.block) {
      return formatMediaFigureHtml(
        { slug: entry.slug, data: entry.data },
        figureOptions
      );
    }
    return formatMediaInlineHtml(
      { slug: entry.slug, data: entry.data },
      figureOptions
    );
  };
};

export default mediaPlugin;
