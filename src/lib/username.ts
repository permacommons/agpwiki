import { profileSlug } from './profile-paths.js';
import { isBlockedSlug } from './slug.js';

export const trimDisplayName = (value: string) => value.trim();

export const normalizeUsername = (value: string) =>
  value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

export const isValidUsername = (value: string) => {
  const username = normalizeUsername(value);
  return Boolean(username) &&
    !username.includes('@') &&
    !username.includes('/') &&
    !isBlockedSlug(profileSlug(username));
};
