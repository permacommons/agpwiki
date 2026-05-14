import { buildThumbnailUrlForWidth } from '../lib/commons.js';
import { McpToolError, NotFoundError } from '../lib/errors.js';
import type { MediaData } from '../lib/media.js';
import type { StoredThumbnail } from '../lib/media-storage.js';
import { findCurrentMediaBySlug } from './media-service.js';
import { getMediaStorage } from './media-storage-backend.js';

// Per-(slug, step) lock — when multiple requests for the same
// uncached thumbnail arrive simultaneously, they share a single
// upstream fetch. Process-local; multi-process deployments may
// occasionally do duplicate fetches, an inefficiency rather than a
// correctness issue.
const inflightFetches = new Map<string, Promise<StoredThumbnail>>();

/**
 * Return the stored thumbnail for (slug, wikimediaStep), fetching from
 * Commons on the first request and atomically caching to disk.
 *
 * Throws:
 * - NotFoundError when no media row exists for the slug.
 * - McpToolError(code='internal_error') when the row has no recorded
 *   thumbnailUrlTemplate (refresh required) or storage I/O fails.
 * - McpToolError(code='validation_error') from storage when the
 *   fetched bytes fail size / MIME / extension validation.
 */
export async function getOrFetchThumbnail(
  slug: string,
  wikimediaStep: number
): Promise<StoredThumbnail> {
  const storage = getMediaStorage();

  const cached = await storage.findStored(slug, wikimediaStep);
  if (cached) return cached;

  const media = await findCurrentMediaBySlug(slug);
  if (!media) {
    throw new NotFoundError(`Media not found: ${slug}`, { slug });
  }

  const data = (media.data ?? {}) as unknown as MediaData;
  const sourceUrl = buildThumbnailUrlForWidth(data.thumbnailUrlTemplate, wikimediaStep);
  if (!sourceUrl) {
    throw new McpToolError(
      'internal_error',
      'No upstream thumbnail template recorded for this media; refresh it to populate.',
      { details: { slug, kind: 'upstream' } }
    );
  }

  const lockKey = `${slug}:${wikimediaStep}`;
  let pending = inflightFetches.get(lockKey);
  if (!pending) {
    pending = (async () => {
      try {
        return await storage.storeThumbnail(slug, wikimediaStep, sourceUrl);
      } finally {
        inflightFetches.delete(lockKey);
      }
    })();
    inflightFetches.set(lockKey, pending);
  }
  return pending;
}
