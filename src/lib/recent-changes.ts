import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import Citation from '../models/citation.js';
import WikiPage from '../models/wiki-page.js';

export interface WikiPageChange {
  slug: string;
  title: Record<string, string> | null;
  revId: string;
  revDate: string;
  revUser: string | null;
  revSummary: Record<string, string> | null;
  revTags: string[];
  prevRevId: string | null;
}

export interface CitationChange {
  key: string;
  data: Record<string, unknown> | null;
  revId: string;
  revDate: string;
  revUser: string | null;
  revSummary: Record<string, string> | null;
  revTags: string[];
  prevRevId: string | null;
}

/**
 * Fetch recent wiki page changes with window function to find previous revision.
 *
 * Uses LEAD() window function to compute prev_rev_id within each document's
 * revision history, enabling diff links without additional queries.
 */
export async function getRecentWikiChanges(
  dal: DataAccessLayer,
  limit: number
): Promise<WikiPageChange[]> {
  const result = await dal.query(
    `SELECT slug,
            title,
            _rev_id,
            _rev_date,
            _rev_user,
            _rev_summary,
            _rev_tags,
            LEAD(_rev_id) OVER (
              PARTITION BY COALESCE(_old_rev_of, id)
              ORDER BY _rev_date DESC, _rev_id DESC
            ) AS prev_rev_id
     FROM ${WikiPage.tableName}
     WHERE _rev_deleted = false
     ORDER BY _rev_date DESC, _rev_id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(
    (row: {
      slug: string;
      title: Record<string, string> | null;
      _rev_id: string;
      _rev_date: string;
      _rev_user: string | null;
      _rev_summary: Record<string, string> | null;
      _rev_tags: string[] | null;
      prev_rev_id: string | null;
    }) => ({
      slug: row.slug,
      title: row.title ?? null,
      revId: row._rev_id,
      revDate: row._rev_date,
      revUser: row._rev_user,
      revSummary: row._rev_summary,
      revTags: row._rev_tags ?? [],
      prevRevId: row.prev_rev_id,
    })
  );
}

/**
 * Fetch recent citation changes with window function to find previous revision.
 *
 * Uses LEAD() window function to compute prev_rev_id within each citation's
 * revision history, enabling diff links without additional queries.
 */
export async function getRecentCitationChanges(
  dal: DataAccessLayer,
  limit: number
): Promise<CitationChange[]> {
  const result = await dal.query(
    `SELECT key,
            data,
            _rev_id,
            _rev_date,
            _rev_user,
            _rev_summary,
            _rev_tags,
            LEAD(_rev_id) OVER (
              PARTITION BY COALESCE(_old_rev_of, id)
              ORDER BY _rev_date DESC, _rev_id DESC
            ) AS prev_rev_id
     FROM ${Citation.tableName}
     WHERE _rev_deleted = false
     ORDER BY _rev_date DESC, _rev_id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(
    (row: {
      key: string;
      data: Record<string, unknown> | null;
      _rev_id: string;
      _rev_date: string;
      _rev_user: string | null;
      _rev_summary: Record<string, string> | null;
      _rev_tags: string[] | null;
      prev_rev_id: string | null;
    }) => ({
      key: row.key,
      data: row.data ?? null,
      revId: row._rev_id,
      revDate: row._rev_date,
      revUser: row._rev_user,
      revSummary: row._rev_summary,
      revTags: row._rev_tags ?? [],
      prevRevId: row.prev_rev_id,
    })
  );
}
