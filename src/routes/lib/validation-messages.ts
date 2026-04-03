import type { Request } from 'express';

import { ConflictError, type FieldError, type ValidationError } from '../../lib/errors.js';
import type { ForumCategorySlug } from '../../services/forum-service.js';

const fieldHasPrefix = (field: string, prefix: string) =>
  field === prefix || field.startsWith(`${prefix}.`);

const resolveOperatorEditFieldMessage = (t: Request['t'], fieldError: FieldError) => {
  if (fieldHasPrefix(fieldError.field, 'revSummary')) {
    if (fieldError.code === 'required') {
      return t('operatorEdit.validation.summaryRequired');
    }
    return t('operatorEdit.validation.summaryInvalid');
  }

  if (fieldHasPrefix(fieldError.field, 'title')) {
    return t('operatorEdit.validation.titleInvalid');
  }

  if (fieldHasPrefix(fieldError.field, 'body')) {
    return t('operatorEdit.validation.bodyInvalid');
  }

  return null;
};

const resolveForumFieldMessage = (t: Request['t'], fieldError: FieldError) => {
  if (fieldError.field === 'title' && fieldError.code === 'required') {
    return t('forum.validation.titleRequired');
  }
  if (fieldError.field === 'body' && fieldError.code === 'required') {
    return t('forum.validation.bodyRequired');
  }
  return null;
};

export const resolveForumValidationMessage = (
  t: Request['t'],
  error: ValidationError,
  options: { category?: ForumCategorySlug } = {}
) => {
  const firstFieldError = error.fieldErrors?.[0];
  if (!firstFieldError) {
    return error.message;
  }

  if (firstFieldError.field === 'pageSlug') {
    if (firstFieldError.code === 'required') {
      return t('forum.validation.pageRequired');
    }
    if (firstFieldError.code === 'not_found') {
      return t(
        options.category === 'policy'
          ? 'forum.validation.pageNotFoundOptional'
          : 'forum.validation.pageNotFound'
      );
    }
    if (firstFieldError.code === 'invalid') {
      return t('forum.validation.pageInvalid');
    }
  }

  return resolveForumFieldMessage(t, firstFieldError) ?? error.message;
};

export const resolveOperatorEditValidationMessage = (
  t: Request['t'],
  error: ValidationError | ConflictError
) => {
  if (error instanceof ConflictError) {
    return t('operatorEdit.validation.conflict');
  }

  const firstFieldError = error.fieldErrors?.[0];
  if (!firstFieldError) {
    return t('operatorEdit.validation.generic');
  }

  return resolveOperatorEditFieldMessage(t, firstFieldError) ?? t('operatorEdit.validation.generic');
};
