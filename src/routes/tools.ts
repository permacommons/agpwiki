import type { Express } from 'express';
import type { TFunction } from 'i18next';

import dal from '../../dal/index.js';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { formatCitationLabel } from '../lib/citation.js';
import Citation from '../models/citation.js';
import WikiPage from '../models/wiki-page.js';
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';
import { fetchUserMap } from './lib/history.js';

const { mlString } = dal;

type RecentListAction = {
  label: string;
  href: string;
};

type RecentListItem = {
  primaryLabel: string;
  primaryHref?: string;
  dateLabel: string;
  summary?: string;
  revUser: string | null;
  revTags: string[];
  actions?: RecentListAction[];
};

const parseRecentLimit = (limitQuery: unknown) => {
  const limitParam = typeof limitQuery === 'string' ? Number(limitQuery) : 50;
  return Number.isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 100);
};

const resolveRevSummary = (value: Record<string, string> | null) =>
  mlString.resolve('en', value ?? null)?.str ?? '';

const renderRecentList = (
  items: RecentListItem[],
  userMap: Map<string, string>,
  t: TFunction
) =>
  items
    .map(item => {
      const displayName = item.revUser ? userMap.get(item.revUser) ?? item.revUser : '';
      const agentTag = item.revTags.find(tag => tag.startsWith('agent:')) ?? '';
      const agentVersion = item.revTags.find(tag => tag.startsWith('agent_version:')) ?? '';
      const metaLabelParts = [
        displayName ? t('history.operator', { name: displayName }) : null,
        agentTag || null,
        agentVersion || null,
      ].filter(Boolean);
      const metaLabel = metaLabelParts.join(' · ');
      const metaAttrs = metaLabel
        ? ` data-meta="true" data-user="${escapeHtml(displayName)}" data-agent="${escapeHtml(
            agentTag
          )}" data-agent-version="${escapeHtml(agentVersion)}" title="${escapeHtml(metaLabel)}"`
        : '';
      const visibleTags = item.revTags.filter(
        tag => !tag.startsWith('agent:') && !tag.startsWith('agent_version:')
      );
      const tags = visibleTags.length ? `· ${escapeHtml(visibleTags.join(', '))}` : '';
      const summary = item.summary
        ? `<div class="change-summary">${escapeHtml(item.summary)}</div>`
        : '';
      const primaryLabel = escapeHtml(item.primaryLabel);
      const primaryHtml = item.primaryHref
        ? `<a href="${escapeHtml(item.primaryHref)}">${primaryLabel}</a>`
        : `<span>${primaryLabel}</span>`;
      const actionsHtml =
        item.actions?.length
          ? `<div class="change-actions">${item.actions
              .map(action => `<a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`)
              .join(' ')}</div>`
          : '';
      return `<li>
  <div class="change-meta"${metaAttrs}>
    ${primaryHtml}
    <span>${escapeHtml(item.dateLabel)}</span>
    ${tags ? `<span>${tags}</span>` : ''}
  </div>
  ${summary}
  ${actionsHtml}
</li>`;
    })
    .join('');

export const registerToolRoutes = (app: Express) => {
  app.get('/tool/recent-changes', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);

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
        revSummary: resolveRevSummary(row._rev_summary ?? null),
        revTags: row._rev_tags ?? [],
        prevRevId: row.prev_rev_id,
      })
    );
    const userIds = changes
      .map(change => change.revUser)
      .filter((id): id is string => Boolean(id));
    const userMap = await fetchUserMap(dalInstance, userIds);
    const items: RecentListItem[] = changes.map(change => {
      const actions: RecentListAction[] = [
        { label: req.t('tool.view'), href: `/${change.slug}?rev=${change.revId}` },
      ];
      if (change.prevRevId) {
        actions.push({
          label: req.t('tool.diff'),
          href: `/${change.slug}?diffFrom=${change.prevRevId}&diffTo=${change.revId}`,
        });
      }
      return {
        primaryLabel: change.slug,
        primaryHref: `/${change.slug}`,
        dateLabel: formatDateUTC(change.revDate),
        summary: change.revSummary,
        revUser: change.revUser,
        revTags: change.revTags,
        actions,
      };
    });
    const itemsHtml = renderRecentList(items, userMap, req.t);

    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentChangesDescription')}</p>
  <p>${req.t('tool.seeAlso', {
    url: '/tool/recent-citations',
    label: req.t('page.recentCitations'),
  })}</p>
  <ul class="change-list">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: req.t('page.recentChanges'),
      labelHtml,
      bodyHtml,
      signedIn,
      locale: res.locals.locale,
      languageOptions: res.locals.languageOptions,
    });
    res.type('html').send(html);
  });

  app.get('/tool/recent-citations', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);

    const dalInstance = await initializePostgreSQL();
    const result = await dalInstance.query(
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

    const changes = result.rows.map(
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
        revSummary: resolveRevSummary(row._rev_summary ?? null),
        revTags: row._rev_tags ?? [],
        prevRevId: row.prev_rev_id,
      })
    );

    const userIds = changes
      .map(change => change.revUser)
      .filter((id): id is string => Boolean(id));
    const userMap = await fetchUserMap(dalInstance, userIds);
    const items: RecentListItem[] = changes.map(change => {
      const encodedKey = encodeURIComponent(change.key);
      const actions: RecentListAction[] = [
        { label: req.t('tool.view'), href: `/cite/${encodedKey}?rev=${change.revId}` },
      ];
      if (change.prevRevId) {
        actions.push({
          label: req.t('tool.diff'),
          href: `/cite/${encodedKey}?diffFrom=${change.prevRevId}&diffTo=${change.revId}`,
        });
      }
      return {
        primaryLabel: formatCitationLabel(change.key, change.data),
        primaryHref: `/cite/${encodedKey}`,
        dateLabel: formatDateUTC(change.revDate),
        summary: change.revSummary,
        revUser: change.revUser,
        revTags: change.revTags,
        actions,
      };
    });
    const itemsHtml = renderRecentList(items, userMap, req.t);

    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentCitationsDescription')}</p>
  <p>${req.t('tool.seeAlso', {
    url: '/tool/recent-changes',
    label: req.t('page.recentChanges'),
  })}</p>
  <ul class="change-list">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: req.t('page.recentCitations'),
      labelHtml,
      bodyHtml,
      signedIn,
      locale: res.locals.locale,
      languageOptions: res.locals.languageOptions,
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
  ${prevLink ? `<a href="${prevLink}">${req.t('tool.previous')}</a>` : ''}
  <span>${req.t('tool.pagination', { page, totalPages })}</span>
  ${nextLink ? `<a href="${nextLink}">${req.t('tool.next')}</a>` : ''}
</div>`;

    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.pagesDescription', { total })}</p>
  ${pagination}
  <ul class="change-list">${listItems}</ul>
  ${pagination}
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: req.t('page.pages'),
      labelHtml,
      bodyHtml,
      signedIn,
      locale: res.locals.locale,
      languageOptions: res.locals.languageOptions,
    });
    res.type('html').send(html);
  });

  app.get('/api/recent-changes', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);

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
