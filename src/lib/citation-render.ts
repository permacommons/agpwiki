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
