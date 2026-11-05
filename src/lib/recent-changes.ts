import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import Citation from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';
import Media from '../models/media.js';
import PageCheck from '../models/page-check.js';
import WikiPage from '../models/wiki-page.js';
import { type ChangeCursor, cursorTimeSql } from './change-cursor.js';

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
  limit: number,
  { tag = null }: { tag?: string | null } = {}
): Promise<WikiPageChange[]> {
  // The tag filter applies after the window, so prev_rev_id still points at
  // the revision just before, whatever its tags.
  const result = await dal.query(
    `SELECT * FROM (
       SELECT slug,
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
     ) changes
     WHERE $2::text IS NULL OR $2::text = ANY(_rev_tags)
     ORDER BY _rev_date DESC, _rev_id DESC
     LIMIT $1`,
    [limit, tag]
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

export const CHANGE_KINDS = ['page', 'check', 'citation', 'claim', 'media'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

// Only these kinds belong to a wiki page, so only they can match a page or
// address filter.
const PAGE_CHANGE_KINDS: readonly ChangeKind[] = ['page', 'check'];

export interface ChangeSince {
  kind: ChangeKind;
  slug: string | null;
  title: Record<string, string> | null;
  key: string | null;
  claimId: string | null;
  mediaSlug: string | null;
  commonsTitle: string | null;
  checkType: string | null;
  checkStatus: string | null;
  revId: string;
  prevRevId: string | null;
  revDate: Date;
  revUser: string | null;
  revSummary: Record<string, string> | null;
  revTags: string[];
  cursor: ChangeCursor;
}

export interface ChangesSinceOptions {
  after: ChangeCursor;
  limit: number;
  slug?: string | null;
  prefix?: string | null;
  kinds?: readonly ChangeKind[] | null;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);

// The same previous revision the Recent changes queries find with LEAD(),
// looked up only for the rows returned instead of over the whole table.
const previousRevisionSql = (table: string, alias: string) => `(
  SELECT prev._rev_id FROM ${table} prev
   WHERE COALESCE(prev._old_rev_of, prev.id) = COALESCE(${alias}._old_rev_of, ${alias}.id)
     AND prev._rev_deleted = false
     AND (prev._rev_date, prev._rev_id) < (${alias}._rev_date, ${alias}._rev_id)
   ORDER BY prev._rev_date DESC, prev._rev_id DESC
   LIMIT 1
)`;

const revisionColumnsSql = (table: string, alias: string) => `${alias}._rev_id,
  ${alias}._rev_date,
  ${cursorTimeSql(`${alias}._rev_date`)} AS rev_time,
  ${alias}._rev_user,
  ${alias}._rev_summary,
  ${alias}._rev_tags,
  ${previousRevisionSql(table, alias)} AS prev_rev_id`;

const afterCursorSql = (alias: string) =>
  `(${alias}._rev_date, ${alias}._rev_id) > ($1::timestamptz, $2::uuid)`;

const NO_TARGET = {
  slug: null,
  title: null,
  key: null,
  claimId: null,
  mediaSlug: null,
  commonsTitle: null,
  checkType: null,
  checkStatus: null,
};

type Row = Record<string, unknown>;

const toChange = (kind: ChangeKind, row: Row, target: Partial<ChangeSince>): ChangeSince => ({
  kind,
  ...NO_TARGET,
  ...target,
  revId: row._rev_id as string,
  prevRevId: (row.prev_rev_id as string | null) ?? null,
  revDate: row._rev_date as Date,
  revUser: (row._rev_user as string | null) ?? null,
  revSummary: (row._rev_summary as Record<string, string> | null) ?? null,
  revTags: (row._rev_tags as string[] | null) ?? [],
  cursor: { time: row.rev_time as string, id: row._rev_id as string },
});

const compareCursors = (a: ChangeCursor, b: ChangeCursor) => {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

/**
 * What changed after a cursor, oldest first: the revisions the Recent changes
 * tabs show (pages, page checks, citations, claims and media) in one list.
 *
 * Each kind is read up to one row past the limit and the lists are merged;
 * a row left over means more follow. Cursor times sort as text, and
 * lowercase UUIDs sort as text the way Postgres sorts them, so the merge
 * keeps the database's order.
 */
export async function getChangesSince(
  dal: DataAccessLayer,
  { after, limit, slug = null, prefix = null, kinds = null }: ChangesSinceOptions
): Promise<{ changes: ChangeSince[]; hasMore: boolean }> {
  const pageFilter = Boolean(slug || prefix);
  const wanted = new Set<ChangeKind>(
    (kinds?.length ? kinds : CHANGE_KINDS).filter(kind => !pageFilter || PAGE_CHANGE_KINDS.includes(kind))
  );
  const rowsOf = (result: { rows: unknown[] }) => result.rows as Row[];
  const pageParams = [after.time, after.id, limit + 1, slug, prefix ? `${escapeLike(prefix)}%` : null];
  const pageWhere = '($4::text IS NULL OR cur.slug = $4) AND ($5::text IS NULL OR cur.slug LIKE $5)';
  const otherParams = [after.time, after.id, limit + 1];

  const queries: Array<Promise<ChangeSince[]>> = [];
  if (wanted.has('page')) {
    queries.push(
      dal
        .query(
          `SELECT cur.slug, r.title, ${revisionColumnsSql(WikiPage.tableName, 'r')}
             FROM ${WikiPage.tableName} r
             JOIN ${WikiPage.tableName} cur
               ON cur.id = COALESCE(r._old_rev_of, r.id) AND cur._old_rev_of IS NULL
            WHERE r._rev_deleted = false AND ${afterCursorSql('r')} AND ${pageWhere}
            ORDER BY r._rev_date, r._rev_id
            LIMIT $3`,
          pageParams
        )
        .then(result =>
          rowsOf(result).map(row =>
            toChange('page', row, {
              slug: row.slug as string,
              title: (row.title as Record<string, string> | null) ?? null,
            })
          )
        )
    );
  }
  if (wanted.has('check')) {
    queries.push(
      dal
        .query(
          `SELECT cur.slug, cur.title, r.type, r.status, ${revisionColumnsSql(PageCheck.tableName, 'r')}
             FROM ${PageCheck.tableName} r
             JOIN ${WikiPage.tableName} cur ON cur.id = r.page_id AND cur._old_rev_of IS NULL
            WHERE r._rev_deleted = false AND ${afterCursorSql('r')} AND ${pageWhere}
            ORDER BY r._rev_date, r._rev_id
            LIMIT $3`,
          pageParams
        )
        .then(result =>
          rowsOf(result).map(row =>
            toChange('check', row, {
              slug: row.slug as string,
              title: (row.title as Record<string, string> | null) ?? null,
              checkType: row.type as string,
              checkStatus: row.status as string,
            })
          )
        )
    );
  }
  if (wanted.has('citation')) {
    queries.push(
      dal
        .query(
          `SELECT r.key, ${revisionColumnsSql(Citation.tableName, 'r')}
             FROM ${Citation.tableName} r
            WHERE r._rev_deleted = false AND ${afterCursorSql('r')}
            ORDER BY r._rev_date, r._rev_id
            LIMIT $3`,
          otherParams
        )
        .then(result => rowsOf(result).map(row => toChange('citation', row, { key: row.key as string })))
    );
  }
  if (wanted.has('claim')) {
    queries.push(
      dal
        .query(
          `SELECT c.key, r.claim_id, ${revisionColumnsSql(CitationClaim.tableName, 'r')}
             FROM ${CitationClaim.tableName} r
             JOIN ${Citation.tableName} c ON c.id = r.citation_id
            WHERE r._rev_deleted = false AND ${afterCursorSql('r')}
            ORDER BY r._rev_date, r._rev_id
            LIMIT $3`,
          otherParams
        )
        .then(result =>
          rowsOf(result).map(row =>
            toChange('claim', row, { key: row.key as string, claimId: row.claim_id as string })
          )
        )
    );
  }
  if (wanted.has('media')) {
    queries.push(
      dal
        .query(
          `SELECT cur.slug, r.commons_title, ${revisionColumnsSql(Media.tableName, 'r')}
             FROM ${Media.tableName} r
             JOIN ${Media.tableName} cur
               ON cur.id = COALESCE(r._old_rev_of, r.id)
              AND cur._old_rev_of IS NULL
              AND cur._rev_deleted = false
            WHERE r._rev_deleted = false AND ${afterCursorSql('r')}
            ORDER BY r._rev_date, r._rev_id
            LIMIT $3`,
          otherParams
        )
        .then(result =>
          rowsOf(result).map(row =>
            toChange('media', row, {
              mediaSlug: row.slug as string,
              commonsTitle: row.commons_title as string,
            })
          )
        )
    );
  }

  const merged = (await Promise.all(queries)).flat().sort((a, b) => compareCursors(a.cursor, b.cursor));
  return { changes: merged.slice(0, limit), hasMore: merged.length > limit };
}
