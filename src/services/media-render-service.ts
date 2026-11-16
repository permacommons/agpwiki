import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import type { MediaData, MediaType } from '../lib/media.js';
import { extractMediaSlugsFromSources, type MediaRegistryEntry } from '../lib/media-render.js';
import type { MediaInstance } from '../models/manifests/media.js';
import Media from '../models/media.js';

type MediaRegistryFields = Pick<MediaInstance,
  'slug' | 'title' | 'commonsTitle' | 'mediaType' | 'data' | 'caption' | 'altText' | '_revID'
>;

const toMediaRegistryEntry = (instance: MediaRegistryFields): MediaRegistryEntry => ({
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
  _dalInstance: DataAccessLayer,
  sources: Iterable<string>
): Promise<Map<string, MediaRegistryEntry>> => {
  const slugs = Array.from(extractMediaSlugsFromSources(sources));
  if (slugs.length === 0) {
    return new Map();
  }

  const entries = await Media.filterWhere({})
    .whereIn('slug', slugs)
    .select('slug', 'title', 'commonsTitle', 'mediaType', 'data', 'caption', 'altText', '_revID');

  const map = new Map<string, MediaRegistryEntry>();
  for (const row of entries) {
    const entry = toMediaRegistryEntry(row);
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
