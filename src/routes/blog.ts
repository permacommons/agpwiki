import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { resolveSafeText } from '../lib/safe-text.js';
import BlogPost from '../models/blog-post.js';
import Citation from '../models/citation.js';
import {
  escapeHtml,
  formatDateUTC,
  renderLayout,
  renderMarkdown,
  renderText,
} from '../render.js';
import { renderRevisionDiff } from './lib/diff.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';

const { mlString } = dal;
const citationKeyRegex = /@([\w][\w:.#$%&\-+?<>~/]*)/g;

const extractCitationKeys = (value: string) => {
  const keys = new Set<string>();
  if (!value) return keys;
  for (const match of value.matchAll(citationKeyRegex)) {
    keys.add(match[1]);
  }
  return keys;
};

export const registerBlogRoutes = (app: Express) => {
  app.get('/blog', async (req, res) => {
    try {
      const dalInstance = await initializePostgreSQL();
      const signedIn = Boolean(await resolveSessionUser(req));
      const result = await dalInstance.query(
        `SELECT * FROM ${BlogPost.tableName}
         WHERE _old_rev_of IS NULL AND _rev_deleted = false
         ORDER BY created_at DESC, _rev_date DESC`
      );
      const posts = result.rows.map(row => BlogPost.createFromRow(row));
      const items = posts
        .map(post => {
          const title = resolveSafeText(mlString.resolve, 'en', post.title, post.slug);
          const summary = resolveSafeText(mlString.resolve, 'en', post.summary, '');
          const createdLabel = formatDateUTC(post.createdAt ?? post._revDate);
          const updatedLabel = formatDateUTC(post.updatedAt ?? post._revDate);
          const updatedHtml =
            updatedLabel && updatedLabel !== createdLabel
              ? `<span class="post-updated">${req.t('blog.updated', {
                  date: escapeHtml(updatedLabel),
                })}</span>`
              : '';
          const summaryHtml = summary
            ? `<div class="post-summary">${renderText(summary)}</div>`
            : '';
          return `<li>
  <h2><a href="/blog/${escapeHtml(post.slug)}">${renderText(title)}</a></h2>
  <div class="post-meta">
    <span class="post-created">${req.t('blog.created', {
      date: escapeHtml(createdLabel),
    })}</span>
    ${updatedHtml}
  </div>
  ${summaryHtml}
</li>`;
        })
        .join('');

      const bodyHtml = `<div class="blog-list">
  <p>${req.t('blog.description')}</p>
  <ol class="post-list">${items}</ol>
</div>`;

      const labelHtml = `<div class="page-label">${req.t('label.blogPost')}</div>`;
      const html = renderLayout({
        title: req.t('page.blog'),
        labelHtml,
        bodyHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render blog list:', message);
    }
  });

  app.get('/blog/:slug', async (req, res) => {
    const slug = req.params.slug;
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;

    try {
      const dalInstance = await initializePostgreSQL();
      const post = await BlogPost.filterWhere({
        slug,
        _oldRevOf: null,
        _revDeleted: false,
      } as Record<string, unknown>).first();

      if (!post) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const fetchRevisionByRevId = async (revId: string) => {
        return BlogPost.filterWhere({}).getRevisionByRevId(revId, post.id).first();
      };

      const revisions = await BlogPost.filterWhere({})
        .getAllRevisions(post.id)
        .orderBy('_revDate', 'DESC')
        .run();
      const userIds = revisions
        .map(rev => rev._revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : post;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send(req.t('page.revisionNotFound'));
        return;
      }

      const resolvedBody = mlString.resolve('en', selectedRevision.body ?? null);

      const title = resolveSafeText(mlString.resolve, 'en', selectedRevision.title, post.slug);
      const summary = resolveSafeText(mlString.resolve, 'en', selectedRevision.summary, '');
      const createdLabel = formatDateUTC(post.createdAt ?? post._revDate);
      const updatedLabel = formatDateUTC(selectedRevision.updatedAt ?? selectedRevision._revDate);
      const updatedHtml =
        updatedLabel && updatedLabel !== createdLabel
          ? `<span class="post-updated">${req.t('blog.updated', {
              date: escapeHtml(updatedLabel),
            })}</span>`
          : '';
      const bodySource = resolvedBody?.str ?? '';
      const citationKeys = extractCitationKeys(bodySource);
      const citationEntries: Array<Record<string, unknown>> = [];

      if (citationKeys.size > 0) {
        const keys = Array.from(citationKeys);
        const result = await dalInstance.query(
          `SELECT * FROM ${Citation.tableName} WHERE key = ANY($1) AND _old_rev_of IS NULL AND _rev_deleted = false`,
          [keys]
        );
        for (const row of result.rows) {
          const item = (row.data ?? {}) as Record<string, unknown>;
          const id = row.key;
          citationEntries.push({ ...item, id });
        }
      }

      const { html: bodyHtml } = await renderMarkdown(bodySource, citationEntries);

      let diffHtml = '';
      if (diffFrom && diffTo) {
        const fromRev = await fetchRevisionByRevId(diffFrom);
        const toRev = await fetchRevisionByRevId(diffTo);
        if (fromRev && toRev) {
          const fromText = mlString.resolve('en', fromRev.body ?? null)?.str ?? '';
          const toText = mlString.resolve('en', toRev.body ?? null)?.str ?? '';
          const fromLabel = formatDateUTC(fromRev._revDate)
            ? `${diffFrom} (${formatDateUTC(fromRev._revDate)})`
            : diffFrom;
          const toLabel = formatDateUTC(toRev._revDate)
            ? `${diffTo} (${formatDateUTC(toRev._revDate)})`
            : diffTo;
          diffHtml = renderRevisionDiff({
            fromLabel,
            toLabel,
            fromText,
            toText,
          });
        }
      }

      const historyRevisions = revisions.map(rev => ({
        revId: rev._revID,
        dateLabel: formatDateUTC(rev._revDate),
        title: resolveSafeText(mlString.resolve, 'en', rev.title, slug),
        summary: resolveSafeText(mlString.resolve, 'en', rev._revSummary, ''),
        revUser: rev._revUser ?? null,
        revTags: rev._revTags ?? null,
      }));
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: `/blog/${slug}`,
        viewHref: revId => `/blog/${slug}?rev=${revId}`,
        userMap,
        t: req.t,
      });

      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const summaryHtml = summary
        ? `<div class="post-summary">${renderText(summary)}</div>`
        : '';
      const metaHtml = `<div class="post-meta post-meta--primary post-meta--bottom">
  <span class="post-created">${req.t('blog.created', {
    date: escapeHtml(createdLabel),
  })}</span>
  ${updatedHtml}
</div>`;
      const labelHtml = `<div class="page-label">${req.t('label.blogPost')}</div>`;
      const signedIn = Boolean(await resolveSessionUser(req));
      const html = renderLayout({
        title,
        labelHtml,
        bodyHtml: `${summaryHtml}${bodyHtml}${metaHtml}`,
        topHtml,
        sidebarHtml: historyHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render blog post:', message);
    }
  });
};
