import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import Citation from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';
import Media from '../models/media.js';
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

export interface MediaChange {
  slug: string;
  commonsTitle: string;
  mediaType: string;
  data: Record<string, unknown> | null;
  revId: string;
  revDate: string;
  revUser: string | null;
  revSummary: Record<string, string> | null;
  revTags: string[];
  prevRevId: string | null;
}

export interface CitationClaimChange {
  key: string;
  claimId: string;
  assertion: Record<string, string> | null;
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

/**
 * Fetch recent citation claim changes with window function to find previous revision.
 */
export async function getRecentCitationClaimChanges(
  dal: DataAccessLayer,
  limit: number
): Promise<CitationClaimChange[]> {
  const result = await dal.query(
    `SELECT citations.key,
            ${CitationClaim.tableName}.claim_id,
            ${CitationClaim.tableName}.assertion,
            ${CitationClaim.tableName}._rev_id,
            ${CitationClaim.tableName}._rev_date,
            ${CitationClaim.tableName}._rev_user,
            ${CitationClaim.tableName}._rev_summary,
            ${CitationClaim.tableName}._rev_tags,
            LEAD(${CitationClaim.tableName}._rev_id) OVER (
              PARTITION BY COALESCE(${CitationClaim.tableName}._old_rev_of, ${CitationClaim.tableName}.id)
              ORDER BY ${CitationClaim.tableName}._rev_date DESC, ${CitationClaim.tableName}._rev_id DESC
            ) AS prev_rev_id
     FROM ${CitationClaim.tableName}
     JOIN ${Citation.tableName}
       ON ${Citation.tableName}.id = ${CitationClaim.tableName}.citation_id
     WHERE ${CitationClaim.tableName}._rev_deleted = false
     ORDER BY ${CitationClaim.tableName}._rev_date DESC, ${CitationClaim.tableName}._rev_id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(
    (row: {
      key: string;
      claim_id: string;
      assertion: Record<string, string> | null;
      _rev_id: string;
      _rev_date: string;
      _rev_user: string | null;
      _rev_summary: Record<string, string> | null;
      _rev_tags: string[] | null;
      prev_rev_id: string | null;
    }) => ({
      key: row.key,
      claimId: row.claim_id,
      assertion: row.assertion ?? null,
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
 * Fetch recent media changes with window function to find previous revision.
 *
 * Uses LEAD() window function to compute prev_rev_id within each media
 * entry's revision history, enabling diff links without additional queries.
 */
export async function getRecentMediaChanges(
  dal: DataAccessLayer,
  limit: number
): Promise<MediaChange[]> {
  const result = await dal.query(
    `SELECT current_media.slug,
            media_rev.commons_title,
            media_rev.media_type,
            media_rev.data,
            media_rev._rev_id,
            media_rev._rev_date,
            media_rev._rev_user,
            media_rev._rev_summary,
            media_rev._rev_tags,
            LEAD(media_rev._rev_id) OVER (
              PARTITION BY COALESCE(media_rev._old_rev_of, media_rev.id)
              ORDER BY media_rev._rev_date DESC, media_rev._rev_id DESC
            ) AS prev_rev_id
     FROM ${Media.tableName} media_rev
     JOIN ${Media.tableName} current_media
       ON current_media.id = COALESCE(media_rev._old_rev_of, media_rev.id)
      AND current_media._old_rev_of IS NULL
      AND current_media._rev_deleted = false
     WHERE media_rev._rev_deleted = false
     ORDER BY media_rev._rev_date DESC, media_rev._rev_id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(
    (row: {
      slug: string;
      commons_title: string;
      media_type: string;
      data: Record<string, unknown> | null;
      _rev_id: string;
      _rev_date: string;
      _rev_user: string | null;
      _rev_summary: Record<string, string> | null;
      _rev_tags: string[] | null;
      prev_rev_id: string | null;
    }) => ({
      slug: row.slug,
      commonsTitle: row.commons_title,
      mediaType: row.media_type,
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
