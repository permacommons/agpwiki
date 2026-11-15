import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import type { MediaData, MediaType } from '../lib/media.js';
import { extractMediaSlugsFromSources, type MediaRegistryEntry } from '../lib/media-render.js';
import type { MediaInstance } from '../models/manifests/media.js';
import Media from '../models/media.js';

const toMediaRegistryEntry = (instance: MediaInstance): MediaRegistryEntry => ({
  slug: instance.slug,
  title: (instance.title ?? null) as Record<string, string> | null,
  commonsTitle: instance.commonsTitle,
  mediaType: instance.mediaType as MediaType,
  data: (instance.data ?? {}) as unknown as MediaData,
  caption: (instance.caption ?? null) as Record<string, string> | null,
  altText: (instance.altText ?? null) as Record<string, string> | null,
  revId: instance._revID,
});

export const loadMediaEntriesForSources = async (
  dalInstance: DataAccessLayer,
  sources: Iterable<string>
): Promise<Map<string, MediaRegistryEntry>> => {
  const slugs = Array.from(extractMediaSlugsFromSources(sources));
  if (slugs.length === 0) {
    return new Map();
  }

  const result = await dalInstance.query(
    `SELECT *
     FROM ${Media.tableName}
     WHERE slug = ANY($1)
       AND _old_rev_of IS NULL
       AND _rev_deleted = false`,
    [slugs]
  );

  const map = new Map<string, MediaRegistryEntry>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const entry: MediaRegistryEntry = {
      slug: row.slug as string,
      title: (row.title ?? null) as Record<string, string> | null,
      commonsTitle: row.commons_title as string,
      mediaType: row.media_type as MediaType,
      data: (row.data ?? {}) as unknown as MediaData,
      caption: (row.caption ?? null) as Record<string, string> | null,
      altText: (row.alt_text ?? null) as Record<string, string> | null,
      revId: row._rev_id as string,
    };
    map.set(entry.slug, entry);
  }
  return map;
};

export const buildMediaRegistryFromInstances = (
  instances: Iterable<MediaInstance>
): Map<string, MediaRegistryEntry> => {
  const map = new Map<string, MediaRegistryEntry>();
  for (const instance of instances) {
    const entry = toMediaRegistryEntry(instance);
    map.set(entry.slug, entry);
  }
  return map;
};
