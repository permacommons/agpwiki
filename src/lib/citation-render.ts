import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

import Citation from '../models/citation.js';

const citationKeyRegex = /@([\w][\w:.#$%&\-+?<>~/]*)/g;

const normalizeCitationKey = (value: string) => {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) return value;
  return value.slice(0, separatorIndex);
};

const collectCitationKeys = (value: string, keys: Set<string>) => {
  if (!value) return;
  for (const match of value.matchAll(citationKeyRegex)) {
    keys.add(normalizeCitationKey(match[1]));
  }
};

export const extractCitationKeysFromSources = (sources: Iterable<string>) => {
  const keys = new Set<string>();
  for (const source of sources) {
    collectCitationKeys(source, keys);
  }
  return keys;
};

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
