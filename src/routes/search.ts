import type { Express } from 'express';

import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { escapeHtml, renderLayout } from '../render.js';
import { searchWikiPages } from '../services/wiki-page-service.js';

export const registerSearchRoutes = (app: Express) => {
  app.get('/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const dalInstance = await initializePostgreSQL();
    let results: Array<{ slug: string; title: string }> = [];

    if (query) {
      results = await searchWikiPages(dalInstance, { query, limit: 20 });
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
    const results = await searchWikiPages(dalInstance, { query, limit: 10 });

    res.json({ results });
  });
};
