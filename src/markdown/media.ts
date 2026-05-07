import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';

import {
  formatMediaFigureHtml,
  formatMediaInlineHtml,
  formatMediaInvalidAttrsHtml,
  formatMediaInvalidSizeHtml,
  formatMediaInvalidSlugHtml,
  formatMediaMissingHtml,
  MEDIA_RECOMMENDED_DISPLAY_WIDTHS,
  type MediaFigureOptions,
} from '../lib/media.js';
import type { MediaRegistryEntry } from '../lib/media-render.js';
import { isValidDisplayWidth, MEDIA_SLUG_REGEX } from '../lib/media-validation.js';

const MEDIA_URL_PREFIX = '/media/';

export interface ParsedMediaRef {
  slug: string;
  // The size parsed from `size=N`, or null if missing/unparseable.
  // Validation against the recommended set happens at render time so
  // we can produce a human-readable inline error rather than failing
  // the parse.
  size: number | null;
  caption?: string;
  alt?: string;
  // Set when the attribute block was missing or omitted `size=`.
  missingSize?: boolean;
  // Set when `size=` was present but the value isn't allowed.
  invalidSize?: number | string;
  // Set when the URL was `/media/<slug>` but the slug part is malformed
  // (e.g. uppercase, underscore, contains `?` or `#`). Renderer surfaces
  // an operator-readable message; validator rejects the write.
  invalidSlug?: string;
  // Tokens in the `{...}` attribute block we don't recognize (other
  // keys, `#id`, `.class`, etc.). Reported verbatim so agents see the
  // exact text they wrote.
  unknownTokens?: string[];
}

const parseSize = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const numeric = Number.parseInt(trimmed.replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric;
};

// Locate the index of the closing `}` for a `{...}` attribute block
// starting at index 0 of `text`. Quoted strings (`"..."` / `'...'`)
// are skipped opaquely so a caption containing `}` doesn't terminate
// the block early. Backslash escapes one character inside a quoted
// run. Returns -1 if no matching `}` is found.
const findAttributeBlockEnd = (text: string): number => {
  if (text.charCodeAt(0) !== 0x7b /* { */) return -1;
  let i = 1;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x7d /* } */) return i;
    if (ch === 0x22 /* " */ || ch === 0x27 /* ' */) {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text.charCodeAt(i) === 0x5c /* \ */ && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (text.charCodeAt(i) === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return -1;
};

// Tokenize the inside of a `{...}` attribute block. Tokens are
// whitespace-separated; quoted runs (`"..."` / `'...'`) survive
// whitespace and `=` boundaries. Quotes are kept in the token text so
// the value side of `key=value` can detect and unquote them.
const tokenizeAttributeBlock = (raw: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;
    let buf = '';
    while (i < raw.length && !/\s/.test(raw[i])) {
      const ch = raw[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        buf += ch;
        i++;
        while (i < raw.length) {
          if (raw[i] === '\\' && i + 1 < raw.length) {
            buf += raw[i] + raw[i + 1];
            i += 2;
            continue;
          }
          buf += raw[i];
          if (raw[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      buf += ch;
      i++;
    }
    if (buf.length) tokens.push(buf);
  }
  return tokens;
};

// Strip surrounding quotes from a value and unescape `\<x>` to `<x>`.
// Pandoc convention: `"text"` and `'text'` are equivalent quoted forms.
const unquote = (value: string): string => {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(.)/g, (_, c) => c);
    }
  }
  return value;
};

interface ParsedAttributeBlock {
  size?: number;
  invalidSize?: string;
  sawSize: boolean;
  caption?: string;
  unknownTokens: string[];
}

// Parse the inside of a `{...}` attribute block. Recognized keys:
// `size` (positive integer) and `caption` (string, optionally quoted).
// Anything else — `#id`, `.class`, unknown `key=value`, bare words —
// goes into `unknownTokens` for downstream reporting. We deliberately
// do NOT silently accept unknown tokens: agents get clear feedback so
// typos surface immediately.
const parseAttributeBlock = (raw: string): ParsedAttributeBlock => {
  const tokens = tokenizeAttributeBlock(raw);
  let size: number | undefined;
  let invalidSize: string | undefined;
  let sawSize = false;
  let caption: string | undefined;
  const unknownTokens: string[] = [];

  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) {
      unknownTokens.push(tok);
      continue;
    }
    const name = tok.slice(0, eq).toLowerCase();
    const value = unquote(tok.slice(eq + 1));
    if (name === 'size') {
      sawSize = true;
      const parsed = parseSize(value);
      if (parsed !== undefined) {
        size = parsed;
      } else {
        invalidSize = value;
      }
    } else if (name === 'caption') {
      caption = value;
    } else {
      unknownTokens.push(tok);
    }
  }

  return { size, invalidSize, sawSize, caption, unknownTokens };
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

// Dedicated markdown-it for caption rendering. We deliberately do
// NOT load the citations or media plugins here — captions are leaf
// content; nesting `[@key]` or `![](/media/foo)` inside a caption
// would be a layering violation and surprise the agent. `html: false`
// keeps raw `<script>` etc. escaped.
const captionRenderer = new MarkdownIt({ html: false, linkify: false });

// Render a caption string to inline HTML, so `*Foo*` becomes
// `<em>Foo</em>` while `<` and `>` remain escaped. Returns undefined
// for empty / whitespace-only captions so the formatter can fall
// through to attribution-only.
const renderCaptionInline = (caption: string | undefined): string | undefined => {
  const trimmed = caption?.trim();
  if (!trimmed) return undefined;
  return captionRenderer.renderInline(trimmed);
};

const buildFigureOptions = (
  ref: ParsedMediaRef,
  entry: MediaRegistryEntry,
  locale: string | undefined,
  size: number
): MediaFigureOptions => {
  const captionRaw = ref.caption ?? resolveLocalized(entry.caption, locale);
  const captionHtml = renderCaptionInline(captionRaw);
  const alt =
    ref.alt ?? resolveLocalized(entry.altText, locale) ?? resolveLocalized(entry.data.description, locale);
  return {
    captionHtml,
    alt,
    size,
    revId: entry.revId,
  };
};

const isAsciiWhitespace = (ch: number): boolean =>
  ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;

const skipWhitespace = (src: string, pos: number, max: number): number => {
  while (pos < max && isAsciiWhitespace(src.charCodeAt(pos))) pos++;
  return pos;
};

export const mediaPlugin = () => (md: MarkdownIt) => {
  // Inline ruler that handles `![Alt](/media/<slug>){size=N caption="..."}`
  // end-to-end, reading from `state.src` directly. Crucially this
  // means markdown-it's emphasis / escape rules never touch the
  // attribute block — captions can contain literal `*` and `_` and
  // `\"` without the parser misinterpreting them. Non-`/media/` URLs
  // fall through to the standard `image` rule (which the standard-
  // image validator then rejects at write time).
  md.inline.ruler.before('image', 'media_image', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x21 /* ! */) return false;
    if (state.src.charCodeAt(start + 1) !== 0x5b /* [ */) return false;

    const labelEnd = state.md.helpers.parseLinkLabel(state, start + 1, false);
    if (labelEnd < 0) return false;
    const labelStart = start + 2;

    let pos = labelEnd + 1;
    if (pos >= state.posMax || state.src.charCodeAt(pos) !== 0x28 /* ( */) return false;
    pos++;
    pos = skipWhitespace(state.src, pos, state.posMax);

    const dest = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
    if (!dest.ok) return false;
    const url = dest.str;
    pos = dest.pos;

    // Only claim `/media/` URLs. Anything else is left for the
    // standard image rule (and ultimately rejected by
    // validateNoStandardMarkdownImages at write time).
    if (!url.startsWith(MEDIA_URL_PREFIX)) return false;

    pos = skipWhitespace(state.src, pos, state.posMax);

    // Optional link title — parse and discard, mirroring standard image.
    if (pos < state.posMax) {
      const ch = state.src.charCodeAt(pos);
      if (ch === 0x22 /* " */ || ch === 0x27 /* ' */ || ch === 0x28 /* ( */) {
        const title = state.md.helpers.parseLinkTitle(state.src, pos, state.posMax);
        if (title.ok) {
          pos = title.pos;
          pos = skipWhitespace(state.src, pos, state.posMax);
        }
      }
    }

    if (pos >= state.posMax || state.src.charCodeAt(pos) !== 0x29 /* ) */) return false;
    pos++;

    // Optional `{...}` attribute block, immediately adjacent (no
    // whitespace between `)` and `{`). Read directly from state.src so
    // emphasis/escape rules can't mangle the contents.
    let attrInner: string | null = null;
    if (pos < state.posMax && state.src.charCodeAt(pos) === 0x7b /* { */) {
      const blockSrc = state.src.slice(pos, state.posMax);
      const blockEnd = findAttributeBlockEnd(blockSrc);
      if (blockEnd >= 0) {
        attrInner = blockSrc.slice(1, blockEnd);
        pos = pos + blockEnd + 1;
      }
      // If no matching `}`, leave the `{` in place — the size will be
      // flagged as missing and the `{...` text will render literally.
    }

    if (silent) return true;

    const slug = url.slice(MEDIA_URL_PREFIX.length);
    const altRaw = state.src.slice(labelStart, labelEnd).trim();

    const ref: ParsedMediaRef = { slug, size: null };
    if (!slug || !MEDIA_SLUG_REGEX.test(slug)) {
      ref.invalidSlug = slug;
    }
    if (altRaw) ref.alt = altRaw;

    if (attrInner !== null) {
      const parsed = parseAttributeBlock(attrInner);
      if (parsed.size !== undefined) ref.size = parsed.size;
      if (parsed.invalidSize !== undefined) ref.invalidSize = parsed.invalidSize;
      if (parsed.caption !== undefined) ref.caption = parsed.caption;
      if (parsed.unknownTokens.length) ref.unknownTokens = parsed.unknownTokens;
      if (!parsed.sawSize) ref.missingSize = true;
    } else {
      ref.missingSize = true;
    }

    const token = state.push('media', '', 0);
    token.meta = ref;
    token.markup = state.src.slice(start, pos);

    state.pos = pos;
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

    if (ref.invalidSlug !== undefined) {
      return formatMediaInvalidSlugHtml(ref.invalidSlug);
    }
    if (ref.unknownTokens?.length) {
      return formatMediaInvalidAttrsHtml(ref.slug, ref.unknownTokens);
    }
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
