import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { extractCitationKeysFromSources } from '../lib/citation-render.js';
import Citation from '../models/citation.js';

export const loadCitationEntriesForSources = async (
  dalInstance: DataAccessLayer,
  sources: Iterable<string>
) => {
  const keys = Array.from(extractCitationKeysFromSources(sources));
  if (keys.length === 0) {
    return [] as Array<Record<string, unknown>>;
  }

  const result = await dalInstance.query(
    `SELECT * FROM ${Citation.tableName} WHERE key = ANY($1) AND _old_rev_of IS NULL AND _rev_deleted = false`,
    [keys]
  );

  return result.rows.map(row => {
    const item = (row.data ?? {}) as Record<string, unknown>;
    const id = row.key;
    return { ...item, id };
  });
};
