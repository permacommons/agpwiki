export const trimDisplayName = (value: string) => value.trim();

export const normalizeUsername = (value: string) =>
  value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

export const isValidUsername = (value: string) => !normalizeUsername(value).includes('@');
