import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  ValidationCollector,
} from '../lib/errors.js';
import { getAccountLifecycleState, userCanUseAgentFeatures } from './account-lifecycle.js';
import { enqueueNotificationJob } from './notification-queue.js';
import { assertCanEditWikiPage } from './page-protection-service.js';
import { assertExpectedRevision } from './revision-precondition.js';
import { userHasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { requireRevSummary } from './validation.js';
import {
  findCurrentPageById,
  listWikiPageRevisions,
  updateWikiPage,
  type WikiPageResult,
  type WikiPageRevisionResult,
} from './wiki-page-service.js';

export const REVERT_TAG = 'revert';
export const ROLLBACK_TAG = 'rollback';
// A revert records the revision it brought back, so later code can tell
// which edits it undid: every revision between that one and the revert.
const RESTORED_TAG_PREFIX = 'restored:';
export const PAGE_REVERTED_NOTIFICATION = 'page.reverted';

export type RevertAction = 'restore' | 'rollback';

export interface PageRevertInput {
  slug: string;
  revSummary: Record<string, string | null>;
  expectedRevId?: string;
}

export interface PageRestoreInput extends PageRevertInput {
  revId: string;
}

export interface PageRevertResult {
  page: WikiPageResult;
  restoredRevId: string;
  revertedRevIds: string[];
  revertedUserIds: string[];
}

export interface RevertOptions {
  enqueueJob?: (type: string, payload: PageRevertedPayload) => Promise<unknown>;
}

export type PageRevertedPayload = {
  pageId: string;
  slug: string;
  revId: string;
  restoredRevId: string;
  actorUserId: string;
  recipientUserIds: string[];
  reason: string;
};

export const restoredRevIdOf = (tags: readonly string[] | null | undefined) => {
  const tag = tags?.find(item => item.startsWith(RESTORED_TAG_PREFIX));
  return tag ? tag.slice(RESTORED_TAG_PREFIX.length) : null;
};

export const isRevertRevision = (tags: readonly string[] | null | undefined) =>
  Boolean(tags?.includes(REVERT_TAG));

/**
 * Revisions (newest first) that a revert undid: those after the version it
 * brought back and before the revert itself.
 */
export const revisionsUndoneBy = (
  revisions: WikiPageRevisionResult[],
  revertIndex: number
): WikiPageRevisionResult[] => {
  const restored = restoredRevIdOf(revisions[revertIndex]?.revTags);
  if (!restored) return [];
  const restoredIndex = revisions.findIndex(item => item.revId === restored);
  if (restoredIndex <= revertIndex) return [];
  return revisions.slice(revertIndex + 1, restoredIndex);
};

/** Can this user use the button or tool for this action, before page protection? */
export const canUseRevertAction = async (
  dalInstance: DataAccessLayer,
  userId: string | null | undefined,
  action: RevertAction
): Promise<boolean> => {
  if (!userId) return false;
  const state = await getAccountLifecycleState(userId);
  if (!state || !userCanUseAgentFeatures(state)) return false;
  if (action === 'restore') return true;
  return userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE);
};

const assertCanUseRevertAction = async (
  dalInstance: DataAccessLayer,
  userId: string,
  action: RevertAction
) => {
  if (await canUseRevertAction(dalInstance, userId, action)) return;
  throw new ForbiddenError(
    action === 'restore'
      ? 'Restoring a version needs an account approved for editing.'
      : 'Rolling back edits is limited to wiki admins.'
  );
};

/**
 * Operator Conduct: once your revert has been undone, stop and discuss.
 * Refuses a revert that would undo a revert of your own revert.
 */
const assertNotReRevert = (
  revisions: WikiPageRevisionResult[],
  undoneCount: number,
  userId: string,
  slug: string
) => {
  for (let index = 0; index < undoneCount; index += 1) {
    const candidate = revisions[index];
    if (!isRevertRevision(candidate.revTags) || candidate.revUser === userId) continue;
    const undoneByCandidate = revisionsUndoneBy(revisions, index);
    const undidOwnRevert = undoneByCandidate.some(
      item => item.revUser === userId && isRevertRevision(item.revTags)
    );
    if (undidOwnRevert) {
      throw new ConflictError(
        'Your revert of this page was itself reverted. Under Operator Conduct, do not revert again: discuss the change on the page discussion instead.',
        { slug, reason: 'edit_war_guard', revertRevId: candidate.revId }
      );
    }
  }
};

const reasonText = (revSummary: Record<string, string | null>) =>
  Object.values(revSummary).find((value): value is string => typeof value === 'string' && value.trim() !== '') ??
  '';

// mergeLocalizedMap only adds and replaces, so languages the restored version
// lacks are removed explicitly.
const exactLocalizedMap = (
  target: Record<string, string> | null | undefined,
  current: Record<string, string> | null | undefined
): Record<string, string | null> => {
  const map: Record<string, string | null> = { ...(target ?? {}) };
  for (const lang of Object.keys(current ?? {})) {
    if (!(lang in map)) map[lang] = null;
  }
  return map;
};

export interface RevertPlan {
  action: RevertAction;
  pageId: string;
  current: WikiPageRevisionResult;
  target: WikiPageRevisionResult;
  // Newest first.
  undone: WikiPageRevisionResult[];
  revertedUserIds: string[];
}

const pickRestoreTarget = (slug: string, revId: string) => (revisions: WikiPageRevisionResult[]) => {
  const index = revisions.findIndex(item => item.revId === revId);
  if (index < 0) {
    throw new NotFoundError(`Revision not found: ${revId}`, { slug, revId });
  }
  if (index === 0) {
    throw new InvalidRequestError('This version is already the current one.', { slug, revId });
  }
  return index;
};

const pickRollbackTarget = (slug: string, userId: string) => (revisions: WikiPageRevisionResult[]) => {
  const lastUser = revisions[0]?.revUser ?? null;
  if (lastUser === userId) {
    throw new InvalidRequestError('Roll back undoes edits by someone else. Restore a version to undo your own.', {
      slug,
    });
  }
  const index = revisions.findIndex(item => item.revUser !== lastUser);
  if (index < 0) {
    throw new InvalidRequestError(
      'Every version of this page is by the same contributor, so there is nothing to roll back to.',
      { slug }
    );
  }
  return index;
};

/**
 * Works out what a revert would do, with every check the revert itself makes:
 * rights, page protection, the target and the edit-war guard.
 */
export const planRevert = async (
  dalInstance: DataAccessLayer,
  { slug, action, revId }: { slug: string; action: RevertAction; revId?: string },
  userId: string
): Promise<RevertPlan> => {
  await assertCanUseRevertAction(dalInstance, userId, action);
  const { pageId, revisions } = await listWikiPageRevisions(dalInstance, slug);
  const current = revisions[0];
  if (!current) throw new NotFoundError(`Wiki page not found: ${slug}`, { slug });
  const page = await findCurrentPageById(pageId);
  if (!page) throw new NotFoundError(`Wiki page not found: ${slug}`, { slug });
  await assertCanEditWikiPage(dalInstance, page, userId);

  const pickTarget =
    action === 'restore'
      ? pickRestoreTarget(current.slug, revId ?? '')
      : pickRollbackTarget(current.slug, userId);
  const targetIndex = pickTarget(revisions);
  assertNotReRevert(revisions, targetIndex, userId, current.slug);
  const undone = revisions.slice(0, targetIndex);
  return {
    action,
    pageId,
    current,
    target: revisions[targetIndex],
    undone,
    revertedUserIds: [
      ...new Set(undone.map(item => item.revUser).filter((id): id is string => Boolean(id) && id !== userId)),
    ],
  };
};

const performRevert = async (
  dalInstance: DataAccessLayer,
  {
    slug,
    revSummary,
    expectedRevId,
    action,
    revId,
  }: PageRevertInput & { action: RevertAction; revId?: string },
  userId: string,
  { enqueueJob = enqueueNotificationJob }: RevertOptions = {}
): Promise<PageRevertResult> => {
  const errors = new ValidationCollector('Invalid revert input.');
  requireRevSummary(revSummary, errors);
  errors.throwIfAny();

  const { pageId, current, target, undone, revertedUserIds } = await planRevert(
    dalInstance,
    { slug, action, revId },
    userId
  );
  assertExpectedRevision(current.revId, expectedRevId);

  const page = await updateWikiPage(
    dalInstance,
    {
      slug: current.slug,
      title: exactLocalizedMap(target.title, current.title),
      body: exactLocalizedMap(target.body, current.body),
      originalLanguage: target.originalLanguage ?? null,
      wikidata: target.wikidata ?? null,
      expectedRevId: current.revId,
      tags: [REVERT_TAG, ...(action === 'rollback' ? [ROLLBACK_TAG] : []), `${RESTORED_TAG_PREFIX}${target.revId}`],
      revSummary,
    },
    userId
  );

  if (revertedUserIds.length) {
    await enqueueJob(PAGE_REVERTED_NOTIFICATION, {
      pageId,
      slug: page.slug,
      revId: page.currentRevId,
      restoredRevId: target.revId,
      actorUserId: userId,
      recipientUserIds: revertedUserIds,
      reason: reasonText(revSummary),
    });
  }

  return {
    page,
    restoredRevId: target.revId,
    revertedRevIds: undone.map(item => item.revId),
    revertedUserIds,
  };
};

/** Brings a page back to exactly the text of an earlier version. */
export const restoreWikiPageRevision = (
  dalInstance: DataAccessLayer,
  input: PageRestoreInput,
  userId: string,
  options?: RevertOptions
) => performRevert(dalInstance, { ...input, action: 'restore' }, userId, options);

/** Undoes the latest run of edits by the same contributor. */
export const rollbackWikiPage = (
  dalInstance: DataAccessLayer,
  input: PageRevertInput,
  userId: string,
  options?: RevertOptions
) => performRevert(dalInstance, { ...input, action: 'rollback' }, userId, options);
