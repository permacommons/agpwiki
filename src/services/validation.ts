import dal from 'rev-dal';
import languages from '../../locales/languages.js';
import { type ValidationCollector, ValidationError } from '../lib/errors.js';
import { type LocalizedMapInput, sanitizeLocalizedMapInput } from '../lib/localized.js';
import { normalizeSlug } from '../lib/slug.js';

const { mlString } = dal;

export const ensureNonEmptyString = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    if (errors) {
      errors.add(label, 'must be a non-empty string.', 'required');
      return false;
    }
    throw new ValidationError(`${label} must be a non-empty string.`, [
      { field: label, message: 'must be a non-empty string.', code: 'required' },
    ]);
  }
  return true;
};

export const normalizeSlugInput = (value: string, label: string, errors?: ValidationCollector) => {
  if (!ensureNonEmptyString(value, label, errors)) return '';
  const normalized = normalizeSlug(value);
  if (!normalized) {
    if (errors) {
      errors.add(label, 'must be a non-empty string.', 'required');
      return '';
    }
    throw new ValidationError(`${label} must be a non-empty string.`, [
      { field: label, message: 'must be a non-empty string.', code: 'required' },
    ]);
  }
  return normalized;
};

export const normalizeOptionalSlug = (
  value: string | undefined | null,
  label: string,
  errors?: ValidationCollector
) => {
  ensureOptionalString(value, label, errors);
  if (!value) return undefined;
  const normalized = normalizeSlug(value);
  if (!normalized) {
    if (errors) {
      errors.add(label, 'must be a non-empty string.', 'required');
      return undefined;
    }
    throw new ValidationError(`${label} must be a non-empty string.`, [
      { field: label, message: 'must be a non-empty string.', code: 'required' },
    ]);
  }
  return normalized;
};

export const ensureOptionalString = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string') {
    if (errors) {
      errors.add(label, 'must be a string.', 'type');
      return;
    }
    throw new ValidationError(`${label} must be a string.`, [
      { field: label, message: 'must be a string.', code: 'type' },
    ]);
  }
};

export const ensureString = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) {
    if (errors) {
      errors.addMissing(label);
      return false;
    }
    throw new ValidationError(`${label} is required.`, [
      { field: label, message: 'is required.', code: 'required' },
    ]);
  }
  if (typeof value !== 'string') {
    if (errors) {
      errors.add(label, 'must be a string.', 'type');
      return false;
    }
    throw new ValidationError(`${label} must be a string.`, [
      { field: label, message: 'must be a string.', code: 'type' },
    ]);
  }
  return true;
};

export const ensureOptionalLanguage = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  ensureOptionalString(value, label, errors);
  if (!value) return;
  if (!languages.isValid(value)) {
    if (errors) {
      errors.add(label, 'must be a supported locale code.', 'invalid');
      return;
    }
    throw new ValidationError(`${label} must be a supported locale code.`, [
      { field: label, message: 'must be a supported locale code.', code: 'invalid' },
    ]);
  }
};

export const parseOptionalDate = (
  value: string | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    if (errors) {
      errors.add(label, 'must be an ISO date string.', 'type');
      return undefined;
    }
    throw new ValidationError(`${label} must be an ISO date string.`, [
      { field: label, message: 'must be an ISO date string.', code: 'type' },
    ]);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    if (errors) {
      errors.add(label, 'must be a valid ISO date string.', 'invalid');
      return undefined;
    }
    throw new ValidationError(`${label} must be a valid ISO date string.`, [
      { field: label, message: 'must be a valid ISO date string.', code: 'invalid' },
    ]);
  }
  return parsed;
};

export const hasDisallowedControlCharacters = (value: string) => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
    if (code >= 0x80 && code <= 0x9f) {
      return true;
    }
    if (code >= 0x2400 && code <= 0x241f) {
      return true;
    }
  }
  return false;
};

export const ensureNoControlCharacters = (
  value: Record<string, string | null> | null | undefined,
  label: string,
  errors?: ValidationCollector
) => {
  if (value === undefined || value === null) return;
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    if (!hasDisallowedControlCharacters(text)) continue;
    const message = `${label} contains disallowed control characters.`;
    const field = `${label}.${lang || 'unknown'}`;
    if (errors) {
      errors.add(field, message, 'invalid');
      continue;
    }
    throw new ValidationError(message, [{ field, message, code: 'invalid' }]);
  }
};

export const validateTitle = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 200, allowHTML: false });
    ensureNoControlCharacters(normalized, 'title', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid title value.';
    if (errors) {
      errors.add('title', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'title', message, code: 'invalid' }]);
  }
};

export const validateBody = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 20000, allowHTML: true });
    ensureNoControlCharacters(normalized, 'body', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid body value.';
    if (errors) {
      errors.add('body', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [{ field: 'body', message, code: 'invalid' }]);
  }
};

export const validateRevSummary = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  if (value === undefined) return;
  const normalized = sanitizeLocalizedMapInput(value);
  if (normalized === null) return;
  try {
    mlString.validate(normalized, { maxLength: 300, allowHTML: false });
    ensureNoControlCharacters(normalized, 'revSummary', errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid revSummary value.';
    if (errors) {
      errors.add('revSummary', message, 'invalid');
      return;
    }
    throw new ValidationError(message, [
      { field: 'revSummary', message, code: 'invalid' },
    ]);
  }
};

export const requireRevSummary = (value: LocalizedMapInput, errors?: ValidationCollector) => {
  const normalized = sanitizeLocalizedMapInput(value);
  if (!normalized) {
    if (errors) {
      errors.addMissing('revSummary');
      return;
    }
    throw new ValidationError('revSummary is required for updates.', [
      { field: 'revSummary', message: 'is required.', code: 'required' },
    ]);
  }
  validateRevSummary(value, errors);
  const entries = Object.entries(normalized);
  if (entries.length === 0) {
    if (errors) {
      errors.add('revSummary', 'must include at least one language entry.', 'invalid');
      return;
    }
    throw new ValidationError('revSummary must include at least one language entry.', [
      { field: 'revSummary', message: 'must include at least one language entry.', code: 'invalid' },
    ]);
  }
  for (const [lang, text] of entries) {
    if (!lang || !text || text.trim().length === 0) {
      if (errors) {
        errors.add(`revSummary.${lang || 'unknown'}`, 'must be a non-empty string.', 'invalid');
        continue;
      }
      throw new ValidationError('revSummary entries must be non-empty strings.', [
        {
          field: `revSummary.${lang || 'unknown'}`,
          message: 'must be a non-empty string.',
          code: 'invalid',
        },
      ]);
    }
  }
};

export const ensureObject = (
  value: Record<string, unknown> | null | undefined,
  label: string,
  { allowNull = false }: { allowNull?: boolean } = {},
  errors?: ValidationCollector
) => {
  if (value === undefined) return;
  if (value === null) {
    if (allowNull) return;
    if (errors) {
      errors.add(label, 'must be an object.', 'type');
      return;
    }
    throw new ValidationError(`${label} must be an object.`, [
      { field: label, message: 'must be an object.', code: 'type' },
    ]);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (errors) {
      errors.add(label, 'must be an object.', 'type');
      return;
    }
    throw new ValidationError(`${label} must be an object.`, [
      { field: label, message: 'must be an object.', code: 'type' },
    ]);
  }
};

export const ensureKeyLength = (
  value: string,
  label: string,
  maxLength: number,
  errors?: ValidationCollector
) => {
  if (value.length > maxLength) {
    if (errors) {
      errors.add(label, `must be at most ${maxLength} characters.`, 'max_length');
      return;
    }
    throw new ValidationError(`${label} must be at most ${maxLength} characters.`, [
      { field: label, message: `must be at most ${maxLength} characters.`, code: 'max_length' },
    ]);
  }
};

export const toRevisionMeta = (rev: {
  _revID?: string | null;
  _revDate?: Date | null;
  _revUser?: string | null;
  _revTags?: string[] | null;
}) => ({
  revId: rev._revID ?? '',
  revDate: rev._revDate ?? new Date(0),
  revUser: rev._revUser ?? null,
  revTags: rev._revTags ?? null,
});
