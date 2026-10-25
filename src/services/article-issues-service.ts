import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { PAGE_CHECK_TYPES, type PageCheckType } from '../lib/page-checks.js';

// Kinds of issue that show a notice on articles. The lists use the same
// rules as the notices, so an article is listed exactly when it shows the
// notice.
export const ARTICLE_ISSUE_KINDS = ['unchecked', 'check-issues', 'no-wikidata'] as const;
export type ArticleIssueKind = (typeof ARTICLE_ISSUE_KINDS)[number];

export const isArticleIssueKind = (value: unknown): value is ArticleIssueKind =>
  typeof value === 'string' && (ARTICLE_ISSUE_KINDS as readonly string[]).includes(value);

export const isPageCheckType = (value: unknown): value is PageCheckType =>
  typeof value === 'string' && (PAGE_CHECK_TYPES as readonly string[]).includes(value);

export interface ArticleIssueCheck {
  id: string;
  type: string;
  unresolved: number;
}

export interface ArticleWithIssue {
  slug: string;
  title: Record<string, string> | null;
  // For issues found by page checks: the checks with unresolved issues.
  checks?: ArticleIssueCheck[];
}

export interface ArticleIssueList {
  kind: ArticleIssueKind;
  checkType: PageCheckType | null;
  total: number;
  articles: ArticleWithIssue[];
}

// Articles are pages outside meta/ and tool/.
const ARTICLE_FILTER = `p._old_rev_of IS NULL AND p._rev_deleted = false
  AND p.slug NOT LIKE 'meta/%' AND p.slug NOT LIKE 'tool/%'`;

const CURRENT_CHECK = `c.page_id = p.id AND c._old_rev_of IS NULL AND c._rev_deleted = false`;

// Same rule as the notice on an article: a completed check with
// high-severity issues not fixed, made within 30 days of the article's
// latest edit.
const UNRESOLVED_HIGH = `c.status = 'completed'
  AND COALESCE((c.metrics->'issues_found'->>'high')::int, 0) - COALESCE((c.metrics->'issues_fixed'->>'high')::int, 0) > 0
  AND p._rev_date - COALESCE(c.completed_at, c._rev_date, c.created_at) <= INTERVAL '30 days'`;

// The WHERE clause of each kind, with the parameters it uses.
const whereFor = (kind: ArticleIssueKind, checkType: string | null): { sql: string; params: unknown[] } => {
  switch (kind) {
    case 'unchecked':
      return {
        sql: `${ARTICLE_FILTER}
          AND NOT EXISTS (SELECT 1 FROM page_checks c WHERE ${CURRENT_CHECK} AND c.status = 'completed')`,
        params: [],
      };
    case 'check-issues':
      return {
        sql: `${ARTICLE_FILTER}
          AND EXISTS (SELECT 1 FROM page_checks c WHERE ${CURRENT_CHECK} AND ${UNRESOLVED_HIGH}
                      AND ($1::text IS NULL OR c.type = $1::text))`,
        params: [checkType],
      };
    case 'no-wikidata':
      return { sql: `${ARTICLE_FILTER} AND (p.properties->>'wikidata') IS NULL`, params: [] };
  }
};

/** One kind of issue, a page at a time, sorted by address. */
export async function listArticlesWithIssues(
  dalInstance: DataAccessLayer,
  {
    kind,
    checkType = null,
    limit = 100,
    offset = 0,
  }: { kind: ArticleIssueKind; checkType?: PageCheckType | null; limit?: number; offset?: number }
): Promise<ArticleIssueList> {
  const type = kind === 'check-issues' ? checkType : null;
  const where = whereFor(kind, type);
  const next = where.params.length;
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0);
  const [countResult, rowsResult] = await Promise.all([
    dalInstance.query(`SELECT COUNT(*)::int AS total FROM pages p WHERE ${where.sql}`, where.params),
    dalInstance.query(
      `SELECT p.id, p.slug, p.title FROM pages p WHERE ${where.sql}
        ORDER BY p.slug LIMIT $${next + 1} OFFSET $${next + 2}`,
      [...where.params, safeLimit, safeOffset]
    ),
  ]);
  const rows = rowsResult.rows as Array<{ id: string; slug: string; title: Record<string, string> | null }>;
  const articles: ArticleWithIssue[] = rows.map(row => ({ slug: row.slug, title: row.title }));

  if (kind === 'check-issues' && rows.length) {
    const checks = await dalInstance.query(
      `SELECT p.id AS page_id, c.id, c.type,
              COALESCE((c.metrics->'issues_found'->>'high')::int, 0) - COALESCE((c.metrics->'issues_fixed'->>'high')::int, 0) AS unresolved
         FROM pages p JOIN page_checks c ON ${CURRENT_CHECK}
        WHERE p.id = ANY($1) AND ${UNRESOLVED_HIGH} AND ($2::text IS NULL OR c.type = $2::text)
        ORDER BY c.type`,
      [rows.map(row => row.id), type]
    );
    const byPage = new Map<string, ArticleIssueCheck[]>();
    for (const row of checks.rows as Array<{ page_id: string; id: string; type: string; unresolved: number }>) {
      const list = byPage.get(row.page_id) ?? [];
      list.push({ id: row.id, type: row.type, unresolved: row.unresolved });
      byPage.set(row.page_id, list);
    }
    rows.forEach((row, index) => {
      articles[index].checks = byPage.get(row.id) ?? [];
    });
  }

  return { kind, checkType: type, total: (countResult.rows[0] as { total: number }).total, articles };
}

/** How many articles each kind of issue has, for the choice of kind. */
export async function countArticlesWithIssues(
  dalInstance: DataAccessLayer
): Promise<Record<ArticleIssueKind, number>> {
  const counts = await Promise.all(
    ARTICLE_ISSUE_KINDS.map(async kind => {
      const where = whereFor(kind, null);
      const result = await dalInstance.query(`SELECT COUNT(*)::int AS total FROM pages p WHERE ${where.sql}`, where.params);
      return [kind, (result.rows[0] as { total: number }).total] as const;
    })
  );
  return Object.fromEntries(counts) as Record<ArticleIssueKind, number>;
}
