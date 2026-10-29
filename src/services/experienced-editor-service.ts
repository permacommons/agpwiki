import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { NotFoundError, ValidationCollector } from '../lib/errors.js';
import { forgetInRequest, memoizeInRequest } from '../lib/request-scope.js';
import User from '../models/user.js';
import { getAccountLifecycleState, userCanUseAgentFeatures } from './account-lifecycle.js';
import { recordAdminEvent } from './admin-event-service.js';
import { assertCanManageExperiencedStatus } from './authorization.js';
import { ensureNonEmptyString } from './validation.js';

export const EXPERIENCED_MIN_EDITS = 5;
export const EXPERIENCED_EDIT_AGE_DAYS = 7;

export const ADMIN_EVENT_TARGET_USER = 'user';
export const ADMIN_EVENT_EXPERIENCED_STATUS_CHANGED = 'experienced_status_changed';

export type ExperiencedOverride = 'granted' | 'revoked';

export interface ExperiencedStatus {
  isExperienced: boolean;
  // When the status started: from the edits, or from an admin's decision.
  since: Date | null;
  override: ExperiencedOverride | null;
  // Edits counted towards the automatic status (capped at the minimum).
  countedEdits: number;
}

const readOverride = async (dalInstance: DataAccessLayer, userId: string) => {
  const result = await dalInstance.query(
    'SELECT status, reason, decided_by, decided_at FROM experienced_editor_overrides WHERE user_id = $1',
    [userId]
  );
  return (
    (result.rows[0] as
      | { status: ExperiencedOverride; reason: string | null; decided_by: string | null; decided_at: Date }
      | undefined) ?? null
  );
};

/**
 * Dates of the user's oldest lasting edits, oldest first. An edit lasts if it
 * is old enough and, for pages, no later revert brought back a version from
 * before it.
 *
 * Each part takes its own oldest few in (author, date) index order, so the
 * work stops after a handful of rows. The revert check only looks at
 * revisions of the edited page: a restore always brings back a version of
 * the same page.
 */
const listLastingEditDates = async (dalInstance: DataAccessLayer, userId: string): Promise<Date[]> => {
  const result = await dalInstance.query(
    `SELECT rev_date FROM (
       (SELECT e._rev_date AS rev_date
          FROM pages e
         WHERE e._rev_user = $1 AND e._rev_deleted = false
           AND e._rev_date <= NOW() - make_interval(days => $2)
           AND NOT EXISTS (
             SELECT 1
               FROM pages x
               JOIN pages restored
                 ON (restored._old_rev_of = COALESCE(e._old_rev_of, e.id) OR restored.id = COALESCE(e._old_rev_of, e.id))
                AND restored._rev_date < e._rev_date
                AND ('restored:' || restored._rev_id::text) = ANY(x._rev_tags)
              WHERE (x._old_rev_of = COALESCE(e._old_rev_of, e.id) OR x.id = COALESCE(e._old_rev_of, e.id))
                AND 'revert' = ANY(x._rev_tags)
                AND x._rev_date > e._rev_date
           )
         ORDER BY e._rev_date LIMIT $3)
       UNION ALL
       (SELECT _rev_date FROM citations
         WHERE _rev_user = $1 AND _rev_deleted = false AND _rev_date <= NOW() - make_interval(days => $2)
         ORDER BY _rev_date LIMIT $3)
       UNION ALL
       (SELECT _rev_date FROM citation_claims
         WHERE _rev_user = $1 AND _rev_deleted = false AND _rev_date <= NOW() - make_interval(days => $2)
         ORDER BY _rev_date LIMIT $3)
       UNION ALL
       (SELECT _rev_date FROM page_checks
         WHERE _rev_user = $1 AND _rev_deleted = false AND _rev_date <= NOW() - make_interval(days => $2)
         ORDER BY _rev_date LIMIT $3)
     ) edits
     ORDER BY rev_date ASC LIMIT $3`,
    [userId, EXPERIENCED_EDIT_AGE_DAYS, EXPERIENCED_MIN_EDITS]
  );
  return (result.rows as Array<{ rev_date: Date }>).map(row => new Date(row.rev_date));
};

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const statusKey = (userId: string) => `experienced:${userId}`;

// A page view can ask more than once (page protection, the Roll back
// button), so the answer is worked out once per request.
export const getExperiencedStatus = async (
  dalInstance: DataAccessLayer,
  userId: string | null | undefined
): Promise<ExperiencedStatus> => {
  if (!userId) return { isExperienced: false, since: null, override: null, countedEdits: 0 };
  return memoizeInRequest(statusKey(userId), () => computeExperiencedStatus(dalInstance, userId));
};

const computeExperiencedStatus = async (dalInstance: DataAccessLayer, userId: string): Promise<ExperiencedStatus> => {
  const none: ExperiencedStatus = { isExperienced: false, since: null, override: null, countedEdits: 0 };
  const [state, override] = await Promise.all([getAccountLifecycleState(userId), readOverride(dalInstance, userId)]);
  if (!state || state.isBlocked) return { ...none, override: override?.status ?? null };
  if (override?.status === 'revoked') return { ...none, override: 'revoked' };

  const dates = userCanUseAgentFeatures(state) ? await listLastingEditDates(dalInstance, userId) : [];
  const automatic = dates.length >= EXPERIENCED_MIN_EDITS;
  if (override?.status === 'granted') {
    return {
      isExperienced: true,
      since: new Date(override.decided_at),
      override: 'granted',
      countedEdits: dates.length,
    };
  }
  if (!automatic) return { ...none, countedEdits: dates.length };
  // The last of the counted edits reached its age on this day.
  const reachedAge = addDays(dates[EXPERIENCED_MIN_EDITS - 1], EXPERIENCED_EDIT_AGE_DAYS);
  const approvedAt = state.agentAccessRequest?.approvedAt ? new Date(state.agentAccessRequest.approvedAt) : null;
  const since = approvedAt && approvedAt > reachedAge ? approvedAt : reachedAge;
  return { isExperienced: true, since, override: null, countedEdits: dates.length };
};

export const isExperiencedEditor = async (dalInstance: DataAccessLayer, userId: string | null | undefined) =>
  (await getExperiencedStatus(dalInstance, userId)).isExperienced;

/**
 * An admin gives the status early ("granted"), takes it away ("revoked"), or
 * goes back to the automatic rule (null). Recorded in the admin log.
 */
export const setExperiencedOverride = async (
  dalInstance: DataAccessLayer,
  { userId, override, reason }: { userId: string; override: ExperiencedOverride | null; reason: string },
  actorUserId: string
) => {
  const errors = new ValidationCollector('Invalid experienced editor input.');
  ensureNonEmptyString(userId, 'userId', errors);
  ensureNonEmptyString(reason, 'reason', errors);
  if (override !== null && override !== 'granted' && override !== 'revoked') {
    errors.add('override', 'must be "granted", "revoked" or null.', 'invalid');
  }
  errors.throwIfAny();
  await assertCanManageExperiencedStatus(dalInstance, actorUserId);

  const user = await User.filterWhere({ id: userId }).first();
  if (!user) throw new NotFoundError(`User not found: ${userId}`, { userId });
  const previous = await readOverride(dalInstance, userId);
  const trimmedReason = reason.trim();
  const userName = user.displayName ?? user.username;

  if (override === null) {
    await dalInstance.query('DELETE FROM experienced_editor_overrides WHERE user_id = $1', [userId]);
  } else {
    await dalInstance.query(
      `INSERT INTO experienced_editor_overrides (user_id, status, reason, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET status = EXCLUDED.status, reason = EXCLUDED.reason,
             decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at`,
      [userId, override, trimmedReason, actorUserId]
    );
  }
  await recordAdminEvent(dalInstance, {
    eventType: ADMIN_EVENT_EXPERIENCED_STATUS_CHANGED,
    actorUserId,
    targetType: ADMIN_EVENT_TARGET_USER,
    targetId: userId,
    details: {
      reason: trimmedReason,
      userName,
      previousOverride: previous?.status ?? null,
      nextOverride: override,
    },
  });
  forgetInRequest(statusKey(userId));
  return { userName, status: await getExperiencedStatus(dalInstance, userId) };
};
