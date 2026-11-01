import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

export interface FollowedPage {
  pageId: string;
  slug: string;
  title: Record<string, string> | null;
  subscribedAt: Date;
}

export const followPage = async (dalInstance: DataAccessLayer, pageId: string, userId: string) => {
  await dalInstance.query(
    `INSERT INTO page_subscriptions (page_id, user_id) VALUES ($1, $2)
     ON CONFLICT (page_id, user_id) DO NOTHING`,
    [pageId, userId]
  );
};

export const unfollowPage = async (dalInstance: DataAccessLayer, pageId: string, userId: string) => {
  await dalInstance.query('DELETE FROM page_subscriptions WHERE page_id = $1 AND user_id = $2', [pageId, userId]);
};

export const isFollowingPage = async (dalInstance: DataAccessLayer, pageId: string, userId: string) => {
  const result = await dalInstance.query(
    'SELECT 1 FROM page_subscriptions WHERE page_id = $1 AND user_id = $2',
    [pageId, userId]
  );
  return (result.rowCount ?? 0) > 0;
};

export const listPageFollowerUserIds = async (dalInstance: DataAccessLayer, pageId: string) => {
  const result = await dalInstance.query('SELECT user_id FROM page_subscriptions WHERE page_id = $1', [pageId]);
  return (result.rows as Array<{ user_id: string }>).map(row => row.user_id);
};

/** The pages someone follows, newest first, with their current address and title. */
export const listFollowedPages = async (dalInstance: DataAccessLayer, userId: string): Promise<FollowedPage[]> => {
  const result = await dalInstance.query(
    `SELECT s.page_id, p.slug, p.title, s.subscribed_at
       FROM page_subscriptions s
       JOIN pages p ON p.id = s.page_id AND p._old_rev_of IS NULL AND p._rev_deleted = false
      WHERE s.user_id = $1
      ORDER BY s.subscribed_at DESC`,
    [userId]
  );
  return (
    result.rows as Array<{ page_id: string; slug: string; title: Record<string, string> | null; subscribed_at: Date }>
  ).map(row => ({ pageId: row.page_id, slug: row.slug, title: row.title, subscribedAt: row.subscribed_at }));
};
