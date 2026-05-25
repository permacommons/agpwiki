import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import AdminEvent from '../models/admin-event.js';

export const ADMIN_EVENT_TARGET_WIKI_PAGE = 'wiki_page';

export const ADMIN_EVENT_WIKI_PAGE_PROTECTED = 'wiki_page_protected';
export const ADMIN_EVENT_WIKI_PAGE_UNPROTECTED = 'wiki_page_unprotected';
export const ADMIN_EVENT_PROTECTED_WIKI_PAGE_EDITED = 'protected_wiki_page_edited';

export interface AdminEventInput {
  eventType: string;
  actorUserId: string;
  targetType: string;
  targetId?: string | null;
  targetRevId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AdminEventResult {
  id: string;
  eventType: string;
  actorUserId: string | null | undefined;
  targetType: string;
  targetId: string | null | undefined;
  targetRevId: string | null | undefined;
  details: Record<string, unknown> | null | undefined;
  createdAt: Date | null | undefined;
}

export const recordAdminEvent = async (
  _dalInstance: DataAccessLayer,
  input: AdminEventInput
): Promise<AdminEventResult> => {
  const event = await AdminEvent.create({
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    targetRevId: input.targetRevId ?? null,
    details: input.details ?? null,
    createdAt: new Date(),
  });

  return {
    id: event.id,
    eventType: event.eventType,
    actorUserId: event.actorUserId ?? null,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    targetRevId: event.targetRevId ?? null,
    details: event.details ?? null,
    createdAt: event.createdAt ?? null,
  };
};

export const listRecentAdminEvents = async (
  dalInstance: DataAccessLayer,
  limit: number
): Promise<AdminEventResult[]> => {
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  const result = await dalInstance.query(
    `SELECT id,
            event_type,
            actor_user_id,
            target_type,
            target_id,
            target_rev_id,
            details,
            created_at
     FROM ${AdminEvent.tableName}
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [normalizedLimit]
  );

  return result.rows.map(
    (row: {
      id: string;
      event_type: string;
      actor_user_id: string | null;
      target_type: string;
      target_id: string | null;
      target_rev_id: string | null;
      details: Record<string, unknown> | null;
      created_at: Date;
    }) => ({
      id: row.id,
      eventType: row.event_type,
      actorUserId: row.actor_user_id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetRevId: row.target_rev_id,
      details: row.details,
      createdAt: row.created_at,
    })
  );
};
