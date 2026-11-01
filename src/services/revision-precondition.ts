import type { SaveOptions } from 'rev-dal/lib/model-types';
import { isRevisionConflictError, PreconditionFailedError } from '../lib/errors.js';

export type ExpectedRevisionField = 'expectedRevId' | 'baseRevId';

const toRevisionMismatchError = (
  currentRevId: string | null,
  expectedRevId: string,
  field: ExpectedRevisionField
) =>
  new PreconditionFailedError(
    `Revision mismatch: current is ${currentRevId ?? 'unknown'}, ${
      field === 'baseRevId' ? 'base' : 'expected'
    } was ${expectedRevId}.`,
    { currentRevId, [field]: expectedRevId }
  );

export const assertExpectedRevision = (
  currentRevId: string | null | undefined,
  expectedRevId: string | undefined,
  field: ExpectedRevisionField = 'expectedRevId'
) => {
  if (!expectedRevId || expectedRevId === currentRevId) return;
  throw toRevisionMismatchError(currentRevId ?? null, expectedRevId, field);
};

// A caller that named an expected revision gets the same precondition_failed
// outcome whether the mismatch is caught by assertExpectedRevision or, in a
// race after that check, by rev-dal's own revision check during save().
export const saveWithExpectedRevision = async (
  document: { save: (options?: SaveOptions) => Promise<unknown> },
  expectedRevId: string | undefined,
  field: ExpectedRevisionField = 'expectedRevId',
  options?: SaveOptions
) => {
  try {
    await document.save(options);
  } catch (error) {
    if (expectedRevId && isRevisionConflictError(error)) {
      throw toRevisionMismatchError(error.currentRevId ?? null, expectedRevId, field);
    }
    throw error;
  }
};
