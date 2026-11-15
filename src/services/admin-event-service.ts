import type { PoolClient } from 'pg';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import AdminEvent from '../models/admin-event.js';

export const ADMIN_EVENT_TARGET_WIKI_PAGE = 'wiki_page';

export const ADMIN_EVENT_WIKI_PAGE_PROTECTED = 'wiki_page_protected';
export const ADMIN_EVENT_WIKI_PAGE_UNPROTECTED = 'wiki_page_unprotected';
export const ADMIN_EVENT_PROTECTED_WIKI_PAGE_EDITED = 'protected_wiki_page_edited';
export const ADMIN_EVENT_WIKI_PAGE_SIGNED_OFF = 'wiki_page_signed_off';
export const ADMIN_EVENT_WIKI_PAGE_SIGNOFF_WITHDRAWN = 'wiki_page_signoff_withdrawn';

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
  input: AdminEventInput,
  transaction?: PoolClient
): Promise<AdminEventResult> => {
  const event = await AdminEvent.create({
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    targetRevId: input.targetRevId ?? null,
    details: input.details ?? null,
    createdAt: new Date(),
  }, { transaction });

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
  _dalInstance: DataAccessLayer,
  limit: number
): Promise<AdminEventResult[]> => {
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  return AdminEvent.filterWhere({})
    .orderBy('createdAt', 'DESC')
    .orderBy('id', 'DESC')
    .limit(normalizedLimit)
    .select('id', 'eventType', 'actorUserId', 'targetType', 'targetId', 'targetRevId', 'details', 'createdAt')
    .run();
};
