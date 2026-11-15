import type { initializePostgreSQL } from '../db.js';
import PageCheck from '../models/page-check.js';
import WikiPage from '../models/wiki-page.js';

type DalInstance = Awaited<ReturnType<typeof initializePostgreSQL>>;

export type RecentPageCheck = {
  id: string;
  pageId: string;
  slug: string;
  title: Record<string, string> | null;
  type: string;
  status: string;
  revId: string;
  prevRevId: string | null;
  revDate: Date;
  revUser: string | null;
  revTags: string[] | null;
  revSummary: Record<string, string> | null;
};

export const getRecentPageChecks = async (dalInstance: DalInstance, limit: number) => {
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  const sql = `WITH revisions AS (
    SELECT pc.*,
      COALESCE(pc._old_rev_of, pc.id) AS root_id
    FROM ${PageCheck.tableName} pc
    WHERE pc._rev_deleted = false
  ),
  ranked AS (
    SELECT revisions.*,
      ROW_NUMBER() OVER (
        PARTITION BY root_id
        ORDER BY _rev_date DESC, _rev_id DESC
      ) AS rn,
      LEAD(_rev_id) OVER (
        PARTITION BY root_id
        ORDER BY _rev_date DESC, _rev_id DESC
      ) AS prev_rev_id
    FROM revisions
  )
  SELECT ranked.id,
    ranked.page_id,
    ranked.type,
    ranked.status,
    ranked._rev_id,
    ranked._rev_date,
    ranked._rev_user,
    ranked._rev_tags,
    ranked._rev_summary,
    ranked.prev_rev_id,
    p.slug,
    p.title
  FROM ranked
  JOIN ${WikiPage.tableName} p ON p.id = ranked.page_id
  WHERE ranked.rn = 1
  ORDER BY ranked._rev_date DESC, ranked._rev_id DESC
  LIMIT $1`;
  const result = await dalInstance.query(sql, [normalizedLimit]);
  return result.rows.map(row => ({
    id: row.id as string,
    pageId: row.page_id as string,
    slug: row.slug as string,
    title: (row.title ?? null) as Record<string, string> | null,
    type: row.type as string,
    status: row.status as string,
    revId: row._rev_id as string,
    prevRevId: (row.prev_rev_id ?? null) as string | null,
    revDate: row._rev_date as Date,
    revUser: (row._rev_user ?? null) as string | null,
    revTags: (row._rev_tags ?? null) as string[] | null,
    revSummary: (row._rev_summary ?? null) as Record<string, string> | null,
  })) as RecentPageCheck[];
};
