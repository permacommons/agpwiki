import { sanitizeLocalizedMapInput } from '../lib/localized.js';

type RevisionWithSummary = {
  _revSummary?: Record<string, string> | null;
  save: () => Promise<unknown>;
};

export const applyDeletionRevisionSummary = async (
  revision: RevisionWithSummary,
  revSummary: Record<string, string | null> | null | undefined
) => {
  const normalizedRevSummary = sanitizeLocalizedMapInput(revSummary);
  if (normalizedRevSummary === undefined) return;
  revision._revSummary = normalizedRevSummary;
  await revision.save();
};
