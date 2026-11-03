export const EXCERPT_LENGTH = 280;

export const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

export const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

/** Plain text of a localized title or body, in its original language when known. */
export const pickLocalizedText = (
  value: Record<string, string | null> | null | undefined,
  preferredLanguage?: string | null
) => {
  if (!value) return '';
  return (preferredLanguage ? value[preferredLanguage] : null) ?? value.en ?? Object.values(value).find(Boolean) ?? '';
};
