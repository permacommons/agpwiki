import type { Express } from 'express';

import dal from '../../dal/index.js';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import WikiPage from '../models/wiki-page.js';
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';

const { mlString } = dal;

export const registerToolRoutes = (app: Express) => {
  app.get('/recent-changes', (_req, res) => {
    res.redirect(302, '/tool/recent-changes');
  });

  app.get('/tool/recent-changes', async (req, res) => {
    const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit = Number.isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 100);

    const dalInstance = await initializePostgreSQL();
    const result = await dalInstance.query(
      `SELECT slug,
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

    const changes = result.rows.map(
      (row: {
        slug: string;
        _rev_id: string;
        _rev_date: string;
        _rev_user: string | null;
        _rev_summary: Record<string, string> | null;
        _rev_tags: string[] | null;
        prev_rev_id: string | null;
      }) => ({
        slug: row.slug,
        revId: row._rev_id,
        revDate: row._rev_date,
        revUser: row._rev_user,
        revSummary: mlString.resolve('en', row._rev_summary ?? null)?.str ?? '',
        revTags: row._rev_tags ?? [],
        prevRevId: row.prev_rev_id,
      })
    );
    const userIds = changes
      .map(change => change.revUser)
      .filter((id): id is string => Boolean(id));
    const userMap = new Map<string, string>();
    if (userIds.length) {
      const userResult = await dalInstance.query(
        'SELECT id, display_name FROM users WHERE id = ANY($1)',
        [userIds]
      );
      for (const row of userResult.rows as Array<{ id: string; display_name: string }>) {
        userMap.set(row.id, row.display_name);
      }
    }

    const itemsHtml = changes
      .map(change => {
        const dateLabel = formatDateUTC(change.revDate);
        const displayName = change.revUser ? userMap.get(change.revUser) ?? change.revUser : '';
        const agentTag = change.revTags.find(tag => tag.startsWith('agent:')) ?? '';
        const agentVersion =
          change.revTags.find(tag => tag.startsWith('agent_version:')) ?? '';
        const metaLabelParts = [
          displayName ? `operator: ${displayName}` : null,
          agentTag || null,
          agentVersion || null,
        ].filter(Boolean);
        const metaLabel = metaLabelParts.join(' · ');
        const metaAttrs = metaLabel
          ? ` data-meta="true" data-user="${escapeHtml(displayName)}" data-agent="${escapeHtml(
              agentTag
            )}" data-agent-version="${escapeHtml(
              agentVersion
            )}" title="${escapeHtml(metaLabel)}"`
          : '';
        const visibleTags = change.revTags.filter(
          tag => !tag.startsWith('agent:') && !tag.startsWith('agent_version:')
        );
        const tags = visibleTags.length ? `· ${escapeHtml(visibleTags.join(', '))}` : '';
        const summary = change.revSummary
          ? `<div class="change-summary">${escapeHtml(change.revSummary)}</div>`
          : '';
        const diffLink = change.prevRevId
          ? `<a href="/${escapeHtml(change.slug)}?diffFrom=${change.prevRevId}&diffTo=${change.revId}">Diff</a>`
          : '';
        return `<li>
  <div class="change-meta"${metaAttrs}>
    <a href="/${escapeHtml(change.slug)}">${escapeHtml(change.slug)}</a>
    <span>${escapeHtml(dateLabel)}</span>
    ${tags ? `<span>${tags}</span>` : ''}
  </div>
  ${summary}
  <div class="change-actions">
    <a href="/${escapeHtml(change.slug)}?rev=${change.revId}">View</a>
    ${diffLink}
  </div>
</li>`;
      })
      .join('');

    const bodyHtml = `<div class="tool-page">
  <p>Latest edits across the wiki.</p>
  <ul class="change-list">${itemsHtml}</ul>
</div>`;
    const labelHtml = '<div class="page-label">TOOL — BUILT-IN SOFTWARE FEATURE</div>';
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: 'Recent Changes',
      labelHtml,
      bodyHtml,
      signedIn,
    });
    res.type('html').send(html);
  });

  app.get('/tool/pages', async (req, res) => {
    const pageParam = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
    const page = Number.isNaN(pageParam) ? 1 : Math.max(pageParam, 1);
    const perParam = typeof req.query.per === 'string' ? Number(req.query.per) : 50;
    const per = Number.isNaN(perParam) ? 50 : Math.min(Math.max(perParam, 1), 200);
    const offset = (page - 1) * per;

    const dalInstance = await initializePostgreSQL();
    const countResult = await dalInstance.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM ${WikiPage.tableName}
       WHERE _old_rev_of IS NULL
         AND _rev_deleted = false
         AND slug NOT LIKE 'meta/%'
         AND slug NOT LIKE 'tool/%'`
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    const result = await dalInstance.query(
      `SELECT slug, title
       FROM ${WikiPage.tableName}
       WHERE _old_rev_of IS NULL
         AND _rev_deleted = false
         AND slug NOT LIKE 'meta/%'
         AND slug NOT LIKE 'tool/%'
       ORDER BY slug
       LIMIT $1 OFFSET $2`,
      [per, offset]
    );
    const pages = result.rows.map(
      (row: { slug: string; title: Record<string, string> | null }) => ({
        slug: row.slug,
        title: mlString.resolve('en', row.title ?? null)?.str ?? row.slug,
      })
    );

    const totalPages = Math.max(Math.ceil(total / per), 1);
    const prevLink =
      page > 1 ? `/tool/pages?page=${page - 1}&per=${per}` : '';
    const nextLink =
      page < totalPages ? `/tool/pages?page=${page + 1}&per=${per}` : '';

    const listItems = pages
      .map(
        item =>
          `<li><a href="/${escapeHtml(item.slug)}">${escapeHtml(item.title)}</a></li>`
      )
      .join('');

    const pagination = `<div class="history-actions">
  ${prevLink ? `<a href="${prevLink}">Previous</a>` : ''}
  <span>Page ${page} of ${totalPages}</span>
  ${nextLink ? `<a href="${nextLink}">Next</a>` : ''}
</div>`;

    const bodyHtml = `<div class="tool-page">
  <p>Encyclopedia pages (${total} total).</p>
  ${pagination}
  <ul class="change-list">${listItems}</ul>
  ${pagination}
</div>`;
    const labelHtml = '<div class="page-label">TOOL — BUILT-IN SOFTWARE FEATURE</div>';
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: 'Pages',
      labelHtml,
      bodyHtml,
      signedIn,
    });
    res.type('html').send(html);
  });

  app.get('/api/recent-changes', async (req, res) => {
    const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit = Number.isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 100);

    const dalInstance = await initializePostgreSQL();
    const result = await dalInstance.query(
      `SELECT slug, _rev_id, _rev_date, _rev_user, _rev_summary, _rev_tags, _old_rev_of
       FROM ${WikiPage.tableName}
       WHERE _rev_deleted = false
       ORDER BY _rev_date DESC, _rev_id DESC
       LIMIT $1`,
      [limit]
    );

    const changes = result.rows.map(
      (row: {
        slug: string;
        _rev_id: string;
        _rev_date: string;
        _rev_user: string | null;
        _rev_summary: Record<string, string> | null;
        _rev_tags: string[] | null;
        _old_rev_of: string | null;
      }) => ({
        slug: row.slug,
        revId: row._rev_id,
        revDate: row._rev_date,
        revUser: row._rev_user,
        revSummary: row._rev_summary ?? null,
        revTags: row._rev_tags ?? [],
      })
    );

    res.json({ changes });
  });
};
