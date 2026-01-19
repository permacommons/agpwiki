import type { Express } from 'express';

import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import WikiPage from '../models/wiki-page.js';
import { escapeHtml, renderLayout } from '../render.js';

export const registerSearchRoutes = (app: Express) => {
  app.get('/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const dalInstance = await initializePostgreSQL();
    let results: Array<{ slug: string; title: string }> = [];

    if (query) {
      const result = await dalInstance.query(
        `SELECT slug, title->>'en' as title
         FROM ${WikiPage.tableName}
         WHERE _old_rev_of IS NULL AND _rev_deleted = false
           AND (slug ILIKE $1 OR (title->>'en') ILIKE $1)
         ORDER BY slug
         LIMIT 20`,
        [`%${query}%`]
      );
      results = result.rows.map((row: { slug: string; title: string | null }) => ({
        slug: row.slug,
        title: row.title ?? row.slug,
      }));
    }

    const resultsHtml = results
      .map(
        item => `<li><a href="/${escapeHtml(item.slug)}">${escapeHtml(item.title)}</a></li>`
      )
      .join('');

    const bodyHtml = `<div class="tool-page">
  <p>${req.t('search.description')}</p>
  <form method="get" action="/search">
    <input class="search-input" type="search" name="q" value="${escapeHtml(
      query
    )}" placeholder="${req.t('search.placeholder')}" />
  </form>
  <ul class="change-list">${resultsHtml}</ul>
</div>`;

    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: req.t('search.title'),
      bodyHtml,
      signedIn,
      locale: res.locals.locale,
      languageOptions: res.locals.languageOptions,
    });
    res.type('html').send(html);
  });

  app.get('/api/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.json({ results: [] });
      return;
    }

    const dalInstance = await initializePostgreSQL();
    const result = await dalInstance.query(
      `SELECT slug, title->>'en' as title
       FROM ${WikiPage.tableName}
       WHERE _old_rev_of IS NULL AND _rev_deleted = false
         AND (slug ILIKE $1 OR (title->>'en') ILIKE $1)
       ORDER BY slug
       LIMIT 10`,
      [`%${query}%`]
    );

    const results = result.rows.map((row: { slug: string; title: string | null }) => ({
      slug: row.slug,
      title: row.title ?? row.slug,
    }));

    res.json({ results });
  });
};
