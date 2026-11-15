import type { ContentValidator } from '../lib/content-validation.js';
import { MEDIA_MAX_DISPLAY_WIDTH } from '../lib/media.js';
import { formatStandardDisplayWidthsList, isValidDisplayWidth, readStandardDisplayWidths } from '../lib/media-validation.js';
import Media from '../models/media.js';

const toNonEmptyArray = <T>(values: T[]) => {
  if (values.length === 0) return null;
  const [first, ...rest] = values;
  return [first, ...rest] as [T, ...T[]];
};

export const validateMediaRefs: ContentValidator = async ({ analysis, fieldLabel, errors }) => {
  if (analysis.mediaRefs.length === 0) return;

  const standardWidths = readStandardDisplayWidths();
  const standardList = formatStandardDisplayWidthsList(standardWidths);
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

    if (ref.missingSize) {
      errors.add(
        fieldLabel,
        `media ${slug} is missing \`size=N\`. Use \`![Alt](/media/${slug}){size=N caption="..."}\`. Standard sizes: ${standardList}; any integer 1–${MEDIA_MAX_DISPLAY_WIDTH} is allowed.`,
        'invalid'
      );
      continue;
    }
    if (ref.invalidSize !== undefined) {
      errors.add(
        fieldLabel,
        `media ${slug} has invalid \`size=${ref.invalidSize}\`: must be a positive integer 1–${MEDIA_MAX_DISPLAY_WIDTH}. Standard sizes: ${standardList}.`,
        'invalid'
      );
      continue;
    }
    if (!isValidDisplayWidth(ref.size)) {
      // Same wording as the unparseable-value branch above so agents
      // see a consistent error family for "size is wrong" regardless
      // of how it's wrong.
      errors.add(
        fieldLabel,
        `media ${slug} has invalid \`size=${ref.size}\`: must be a positive integer 1–${MEDIA_MAX_DISPLAY_WIDTH}. Standard sizes: ${standardList}.`,
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
    errors.add(
      fieldLabel,
      `media not found: ${slug}. Use \`media_query\` with a \`slugPrefix\` to find existing media, or \`media_create\` to register a new Wikimedia Commons file under this slug.`,
      'invalid'
    );
  }
};
