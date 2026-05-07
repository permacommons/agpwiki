import config from 'config';
import type Token from 'markdown-it/lib/token';
import Media from '../models/media.js';
import type { ContentValidator } from './content-validation.js';
import type { ValidationCollector } from './errors.js';
import { MEDIA_MAX_DISPLAY_WIDTH } from './media.js';
import { normalizeSlug } from './slug.js';

const toNonEmptyArray = <T>(values: T[]) => {
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  return [first, ...rest] as [T, ...T[]];
};

// Strict slug pattern for media: lowercase alnum + hyphens, optional
// path segments separated by `/`. Stricter than page slugs because
// media slugs become filesystem path components.
export const MEDIA_SLUG_REGEX =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export interface ValidatedMediaSlug {
  slug: string;
}

export const validateMediaSlugFormat = (
  raw: string,
  label: string,
  errors: ValidationCollector
): string | null => {
  const normalized = normalizeSlug(raw);
  if (!normalized) {
    errors.add(label, 'must be a non-empty slug.', 'required');
    return null;
  }
  if (!MEDIA_SLUG_REGEX.test(normalized)) {
    errors.add(
      label,
      'must contain only lowercase letters, digits, and hyphens, with optional `/` between segments.',
      'invalid'
    );
    return null;
  }
  // Reject `media/` prefix — redundant given the route lives at
  // `/media/<slug>`. Keeps the slug column clean.
  if (normalized === 'media' || normalized.startsWith('media/')) {
    errors.add(
      label,
      'must not start with `media/` — that prefix is redundant; the route already namespaces media slugs.',
      'invalid'
    );
    return null;
  }
  return normalized;
};

export const readStandardDisplayWidths = (): readonly number[] => {
  if (!config.has('media.recommendedDisplayWidths')) {
    // Fallback defaults if config is missing — mirrors the values we
    // ship in config/default.json5 so behavior is sane in tests that
    // don't load full config.
    return [250, 500, 800];
  }
  return config.get<number[]>('media.recommendedDisplayWidths');
};

// Display-width validation is now a soft policy: any positive integer
// up to MEDIA_MAX_DISPLAY_WIDTH is accepted. The standard set is
// surfaced via tool descriptions and error messages so it stays the
// path of least resistance.
export const isValidDisplayWidth = (width: unknown): width is number =>
  typeof width === 'number' &&
  Number.isFinite(width) &&
  Number.isInteger(width) &&
  width >= 1 &&
  width <= MEDIA_MAX_DISPLAY_WIDTH;

export const formatStandardDisplayWidthsList = (
  standardSet: readonly number[] = readStandardDisplayWidths()
): string => standardSet.slice().sort((a, b) => a - b).join(', ');

export const validateMediaRefs: ContentValidator = async ({ analysis, fieldLabel, errors }) => {
  if (analysis.mediaRefs.length === 0) return;

  const standardWidths = readStandardDisplayWidths();
  const requestedSlugs = new Set<string>();

  for (const ref of analysis.mediaRefs) {
    if (ref.invalidSlug !== undefined) {
      const display = ref.invalidSlug.length > 0 ? ref.invalidSlug : '(empty)';
      errors.add(
        fieldLabel,
        `invalid media slug \`${display}\`: must be lowercase letters, digits, and hyphens, with optional \`/\` between segments.`,
        'invalid'
      );
      continue;
    }
    if (ref.unknownTokens?.length) {
      errors.add(
        fieldLabel,
        `unknown attribute(s) on media ${ref.slug}: ${ref.unknownTokens.join(' ')}. Recognized keys inside \`{...}\`: \`size=N\`, \`caption="..."\`. Alt text goes in the standard image position: \`![Alt](/media/${ref.slug}){...}\`.`,
        'invalid'
      );
      continue;
    }

    const slug = ref.slug.trim();
    if (!slug) continue;
    requestedSlugs.add(slug);

    if (!isValidDisplayWidth(ref.size)) {
      errors.add(
        fieldLabel,
        `media size for ${slug} must be an integer from 1 to ${MEDIA_MAX_DISPLAY_WIDTH}. Standard sizes: ${formatStandardDisplayWidthsList(standardWidths)}.`,
        'invalid'
      );
    }
  }

  if (requestedSlugs.size === 0) return;

  const slugList = toNonEmptyArray(Array.from(requestedSlugs));
  if (!slugList) return;

  const { in: inOp } = Media.ops;
  const found = await Media.filterWhere({ slug: inOp(slugList) }).run();
  const foundSlugs = new Set(found.map(media => media.slug));
  const missing = Array.from(requestedSlugs).filter(slug => !foundSlugs.has(slug));

  for (const slug of missing) {
    errors.add(fieldLabel, `media not found: ${slug}`, 'invalid');
  }
};

interface StandardImageRef {
  src: string;
  alt: string;
}

const collectStandardImageTokens = (
  tokens: Token[],
  result: StandardImageRef[] = []
): StandardImageRef[] => {
  for (const token of tokens) {
    // markdown-it emits `image` tokens for `![alt](url)` standard syntax.
    // Our media plugin converts `![Alt](/media/<slug>)` images into
    // `media` tokens before this validator runs, so any `image` token
    // we still see here is an external URL we want to reject.
    if (token.type === 'image') {
      result.push({
        src: token.attrGet?.('src') ?? '',
        alt: token.content ?? '',
      });
    }
    if (token.children?.length) {
      collectStandardImageTokens(token.children, result);
    }
  }
  return result;
};

// External image URLs are reserved — every illustration must go
// through the media surface (media_create then `![Alt](/media/<slug>)`
// in the body) so that bytes, license metadata, and revision tracking
// all flow through the system. Reject any non-`/media/` image at write
// time with a hint at the correct embed form.
export const validateNoStandardMarkdownImages: ContentValidator = ({
  analysis,
  fieldLabel,
  errors,
}) => {
  const imageRefs = collectStandardImageTokens(analysis.tokens);
  for (const ref of imageRefs) {
    const detail = ref.src ? ` (found: \`![${ref.alt}](${ref.src})\`)` : '';
    errors.add(
      fieldLabel,
      `External image URLs are not supported in body content. To embed an image, register it via media_create, then use \`![Alt text](/media/<slug>){size=<width> caption="..."}\` in the body.${detail}`,
      'invalid'
    );
  }
};
