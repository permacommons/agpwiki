import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { type ChangeCursor, cursorTimeSql, encodeChangeCursor } from '../lib/change-cursor.js';
import Citation from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';
import Media from '../models/media.js';
import PageCheck from '../models/page-check.js';
import WikiPage from '../models/wiki-page.js';

export const CHANGE_KINDS = ['page', 'check', 'citation', 'claim', 'media'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

// Only these kinds belong to a wiki page, so only they can match a page or
// address filter.
const PAGE_CHANGE_KINDS: readonly ChangeKind[] = ['page', 'check'];

type ChangeTarget =
  | { kind: 'page'; slug: string; title?: string | null }
  | { kind: 'check'; slug: string; title?: string | null; checkType: string; checkStatus: string }
  | { kind: 'citation'; key: string }
  | { kind: 'claim'; key: string; claimId: string }
  | { kind: 'media'; mediaSlug: string; commonsTitle: string };

interface RevisionFields {
  revId: string;
  prevRevId: string | null;
  revDate: Date;
  revSummary?: Record<string, string>;
  revTags: string[];
}

export type ChangeSince = ChangeTarget & RevisionFields & { user: string | null };
type ChangeRevision = ChangeTarget & RevisionFields & { revUser: string | null; cursor: ChangeCursor };

export interface ChangesSinceResult {
  changes: ChangeSince[];
  hasMore: boolean;
  cursor: string;
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

type Row = Record<string, unknown>;

const titleFields = (row: Row): { title?: string | null } => {
  const title = row.title as Record<string, string> | null;
  return title ? { title: title.en ?? Object.values(title)[0] ?? null } : {};
};

const toRevision = (row: Row): RevisionFields & { revUser: string | null; cursor: ChangeCursor } => ({
  revId: row._rev_id as string,
  prevRevId: (row.prev_rev_id as string | null) ?? null,
  revDate: row._rev_date as Date,
  revUser: (row._rev_user as string | null) ?? null,
  ...(row._rev_summary ? { revSummary: row._rev_summary as Record<string, string> } : {}),
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
): Promise<ChangesSinceResult> {
  const pageFilter = Boolean(slug || prefix);
  const wanted = new Set<ChangeKind>(
    (kinds?.length ? kinds : CHANGE_KINDS).filter(kind => !pageFilter || PAGE_CHANGE_KINDS.includes(kind))
  );
  const rowsOf = (result: { rows: unknown[] }) => result.rows as Row[];
  const pageParams = [after.time, after.id, limit + 1, slug, prefix ? `${escapeLike(prefix)}%` : null];
  const pageWhere = '($4::text IS NULL OR cur.slug = $4) AND ($5::text IS NULL OR cur.slug LIKE $5)';
  const otherParams = [after.time, after.id, limit + 1];

  const queries: Array<Promise<ChangeRevision[]>> = [];
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
          rowsOf(result).map(row => ({
            ...toRevision(row),
            kind: 'page' as const,
            slug: row.slug as string,
            ...titleFields(row),
          }))
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
          rowsOf(result).map(row => ({
            ...toRevision(row),
            kind: 'check' as const,
            slug: row.slug as string,
            ...titleFields(row),
            checkType: row.type as string,
            checkStatus: row.status as string,
          }))
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
        .then(result =>
          rowsOf(result).map(row => ({
            ...toRevision(row),
            kind: 'citation' as const,
            key: row.key as string,
          }))
        )
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
          rowsOf(result).map(row => ({
            ...toRevision(row),
            kind: 'claim' as const,
            key: row.key as string,
            claimId: row.claim_id as string,
          }))
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
          rowsOf(result).map(row => ({
            ...toRevision(row),
            kind: 'media' as const,
            mediaSlug: row.slug as string,
            commonsTitle: row.commons_title as string,
          }))
        )
    );
  }

  const merged = (await Promise.all(queries)).flat().sort((a, b) => compareCursors(a.cursor, b.cursor));
  const selected = merged.slice(0, limit);
  const userIds = [...new Set(selected.flatMap(change => (change.revUser ? [change.revUser] : [])))];
  const names = new Map<string, string>();
  if (userIds.length) {
    const result = await dal.query('SELECT id, display_name FROM users WHERE id = ANY($1)', [userIds]);
    for (const row of result.rows as Array<{ id: string; display_name: string }>) {
      names.set(row.id, row.display_name);
    }
  }
  return {
    changes: selected.map(change => {
      const { cursor: _cursor, revUser, ...rest } = change;
      return { ...rest, user: revUser ? (names.get(revUser) ?? null) : null };
    }),
    hasMore: merged.length > limit,
    cursor: encodeChangeCursor(selected.at(-1)?.cursor ?? after),
  };
}
