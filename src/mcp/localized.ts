export type LocalizedMap = Record<string, string>;
export type LocalizedMapInput = Record<string, string | null> | null | undefined;

export const sanitizeLocalizedMapInput = (
  value: LocalizedMapInput
): LocalizedMap | null | undefined => {
  if (value === undefined || value === null) return value;
  const result: LocalizedMap = {};
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text === 'string') {
      result[lang] = text;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
};

export const mergeLocalizedMap = (
  existing: LocalizedMap | null | undefined,
  incoming: LocalizedMapInput
): LocalizedMap | null | undefined => {
  if (incoming === undefined) return undefined;
  if (incoming === null) return null;
  const result: LocalizedMap = {};
  if (existing) {
    for (const [lang, text] of Object.entries(existing)) {
      if (typeof text === 'string') {
        result[lang] = text;
      }
    }
  }
  for (const [lang, text] of Object.entries(incoming)) {
    if (text === null) {
      delete result[lang];
      continue;
    }
    if (typeof text === 'string') {
      result[lang] = text;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
};
