import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { extractCitationKeysFromSources } from '../lib/citation-render.js';
import Citation from '../models/citation.js';

export const loadCitationEntriesForSources = async (
  _dalInstance: DataAccessLayer,
  sources: Iterable<string>
) => {
  const keys = Array.from(extractCitationKeysFromSources(sources));
  if (keys.length === 0) {
    return [] as Array<Record<string, unknown>>;
  }

  const entries = await Citation.filterWhere({})
    .whereIn('key', keys)
    .select('key', 'data');

  return entries.map(row => {
    const item = (row.data ?? {}) as Record<string, unknown>;
    const id = row.key;
    return { ...item, id };
  });
};
