import assert from 'node:assert/strict';
import test from 'node:test';

import { ConflictError, ValidationError } from '../src/lib/errors.js';
import { resolveOperatorEditValidationMessage } from '../src/routes/lib/validation-messages.js';

const t = (key: string) =>
  ({
    'operatorEdit.validation.generic': 'generic',
    'operatorEdit.validation.titleInvalid': 'title',
    'operatorEdit.validation.bodyInvalid': 'body',
    'operatorEdit.validation.summaryRequired': 'summary required',
    'operatorEdit.validation.summaryInvalid': 'summary invalid',
    'operatorEdit.validation.conflict': 'conflict',
  })[key] ?? key;

test('resolveOperatorEditValidationMessage maps summary required errors', () => {
  const error = new ValidationError('revSummary is required for updates.', [
    { field: 'revSummary', message: 'is required.', code: 'required' },
  ]);

  assert.equal(resolveOperatorEditValidationMessage(t as never, error), 'summary required');
});

test('resolveOperatorEditValidationMessage maps localized summary field errors', () => {
  const error = new ValidationError('revSummary entries must be non-empty strings.', [
    { field: 'revSummary.en', message: 'must be a non-empty string.', code: 'invalid' },
  ]);

  assert.equal(resolveOperatorEditValidationMessage(t as never, error), 'summary invalid');
});

test('resolveOperatorEditValidationMessage maps body errors', () => {
  const error = new ValidationError('Invalid wiki page update input.', [
    { field: 'body.en', message: 'contains disallowed control characters.', code: 'invalid' },
  ]);

  assert.equal(resolveOperatorEditValidationMessage(t as never, error), 'body');
});

test('resolveOperatorEditValidationMessage maps conflicts', () => {
  const error = new ConflictError('Wiki page already exists.');

  assert.equal(resolveOperatorEditValidationMessage(t as never, error), 'conflict');
});
