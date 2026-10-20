import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { NotFoundError } from '../lib/errors.js';

export interface SiteNotification {
  id: string;
  kind: string;
  actorUserId: string | null;
  actorName: string | null;
  url: string;
  subject: string;
  excerpt: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface SiteNotificationInput {
  userId: string;
  kind: string;
  actorUserId?: string | null;
  url: string;
  subject: string;
  excerpt?: string | null;
  jobId?: string | null;
}

const toSiteNotification = (row: Record<string, unknown>): SiteNotification => ({
  id: row.id as string,
  kind: row.kind as string,
  actorUserId: (row.actor_user_id as string | null) ?? null,
  actorName: (row.actor_name as string | null) ?? null,
  url: row.url as string,
  subject: row.subject as string,
  excerpt: (row.excerpt as string | null) ?? null,
  createdAt: row.created_at as Date,
  readAt: (row.read_at as Date | null) ?? null,
});

const SELECT_WITH_ACTOR = `SELECT n.id, n.kind, n.actor_user_id, u.display_name AS actor_name, n.url, n.subject,
       n.excerpt, n.created_at, n.read_at
  FROM notifications n
  LEFT JOIN users u ON u.id = n.actor_user_id`;

/** Notification links stay on the site: only local paths are stored. */
const ensureLocalPath = (url: string) => (url.startsWith('/') && !url.startsWith('//') ? url : '/');

export const createSiteNotification = async (
  dal: DataAccessLayer,
  input: SiteNotificationInput
): Promise<string> => {
  const result = await dal.query(
    `INSERT INTO notifications (user_id, kind, actor_user_id, url, subject, excerpt, job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.userId,
      input.kind,
      input.actorUserId ?? null,
      ensureLocalPath(input.url),
      input.subject,
      input.excerpt ?? null,
      input.jobId ?? null,
    ]
  );
  return (result.rows[0] as { id: string }).id;
};

export const countUnreadNotifications = async (dal: DataAccessLayer, userId: string) => {
  const result = await dal.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return (result.rows[0] as { count: number }).count;
};

export const findLatestUnreadNotification = async (dal: DataAccessLayer, userId: string) => {
  const result = await dal.query(
    `${SELECT_WITH_ACTOR} WHERE n.user_id = $1 AND n.read_at IS NULL ORDER BY n.created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] ? toSiteNotification(result.rows[0] as Record<string, unknown>) : null;
};

export const listSiteNotifications = async (
  dal: DataAccessLayer,
  userId: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
) => {
  const result = await dal.query(
    `${SELECT_WITH_ACTOR} WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT $2 OFFSET $3`,
    [userId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)]
  );
  return (result.rows as Array<Record<string, unknown>>).map(toSiteNotification);
};

/** Mark one notification as read and return where it points. */
export const openSiteNotification = async (dal: DataAccessLayer, userId: string, id: string) => {
  const result = await dal.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2
      RETURNING url`,
    [id, userId]
  );
  const row = result.rows[0] as { url: string } | undefined;
  if (!row) throw new NotFoundError('Notification not found.', { id });
  return row.url;
};

export const markSiteNotificationsRead = async (
  dal: DataAccessLayer,
  userId: string,
  id?: string
) => {
  const result = id
    ? await dal.query(
        'UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
        [id, userId]
      )
    : await dal.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [
        userId,
      ]);
  return result.rowCount ?? 0;
};
