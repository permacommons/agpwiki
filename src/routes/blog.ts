import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { NotFoundError } from '../lib/errors.js';
import { resolveSafeText } from '../lib/safe-text.js';
import BlogPost from '../models/blog-post.js';
import {
  escapeHtml,
  formatDateUTC,
  renderLayout,
  renderMarkdown,
  renderText,
} from '../render.js';
import {
  diffBlogPostRevisions,
  listBlogPostRevisions,
  readBlogPost,
  readBlogPostRevision,
} from '../services/blog-post-service.js';
import {
  extractQueryParams,
  getAvailableLanguages,
  normalizeOverrideLang,
  renderContentLanguageRow,
  resolveContentLanguage,
} from './lib/content-language.js';
import { getDiffLabels, renderEntityDiff } from './lib/diff.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';

const { mlString } = dal;

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
      const summaries = posts.map(post => {
        const availableLangs = getAvailableLanguages(post.title ?? null, post.summary ?? null);
        const contentLang = resolveContentLanguage({
          uiLocale: res.locals.locale,
          override: undefined,
          availableLangs,
        });
        return mlString.resolve(contentLang, post.summary ?? null)?.str ?? '';
      });
      const citationEntries = await loadCitationEntriesForSources(dalInstance, summaries);
      const items = (
        await Promise.all(
          posts.map(async post => {
            const availableLangs = getAvailableLanguages(post.title ?? null, post.summary ?? null);
            const contentLang = resolveContentLanguage({
              uiLocale: res.locals.locale,
              override: undefined,
              availableLangs,
            });
            const title = resolveSafeText(mlString.resolve, contentLang, post.title, post.slug);
            const summary = mlString.resolve(contentLang, post.summary ?? null)?.str ?? '';
            const createdLabel = formatDateUTC(post.createdAt ?? post._revDate);
            const updatedLabel = formatDateUTC(post.updatedAt ?? post._revDate);
            const updatedHtml =
              updatedLabel && updatedLabel !== createdLabel
                ? `<span class="post-updated">${req.t('blog.updated', {
                    date: escapeHtml(updatedLabel),
                  })}</span>`
                : '';
            const summaryHtml = summary
              ? `<div class="post-summary">${(await renderMarkdown(summary, citationEntries)).html}</div>`
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
        )
      ).join('');

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
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const langOverride = normalizeOverrideLang(langParam);

    try {
      const dalInstance = await initializePostgreSQL();
      const post = await (async () => {
        try {
          return await readBlogPost(dalInstance, slug);
        } catch (error) {
          if (error instanceof NotFoundError) {
            res.status(404).type('text').send(req.t('page.notFound'));
            return null;
          }
          throw error;
        }
      })();
      if (!post) return;

      const revisionsResult = await listBlogPostRevisions(dalInstance, slug);
      const revisions = revisionsResult.revisions;
      if (revisions.length === 0) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const userIds = revisions
        .map(rev => rev.revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const selectedRevision = revIdParam
        ? await (async () => {
            try {
              return (await readBlogPostRevision(dalInstance, slug, revIdParam)).revision;
            } catch (error) {
              if (error instanceof NotFoundError) {
                res.status(404).type('text').send(req.t('page.revisionNotFound'));
                return null;
              }
              throw error;
            }
          })()
        : revisions[0];
      if (!selectedRevision) return;

      const availableLangs = getAvailableLanguages(
        selectedRevision.body,
        selectedRevision.title,
        selectedRevision.summary
      );
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });
      const resolvedBody = mlString.resolve(contentLang, selectedRevision.body ?? null);

      const title = resolveSafeText(
        mlString.resolve,
        contentLang,
        selectedRevision.title,
        post.slug
      );
      const summary = mlString.resolve(contentLang, selectedRevision.summary)?.str ?? '';
      const createdLabel = formatDateUTC(post.createdAt);
      const updatedLabel = formatDateUTC(selectedRevision.updatedAt ?? selectedRevision.revDate);
      const updatedHtml =
        updatedLabel && updatedLabel !== createdLabel
          ? `<span class="post-updated">${req.t('blog.updated', {
              date: escapeHtml(updatedLabel),
            })}</span>`
          : '';
      const bodySource = resolvedBody?.str ?? '';
      const citationEntries = await loadCitationEntriesForSources(dalInstance, [bodySource, summary]);

      const { html: bodyHtml } = await renderMarkdown(bodySource, citationEntries);

      let diffHtml = '';
      if (diffFrom && diffTo) {
        try {
          const diff = await diffBlogPostRevisions(dalInstance, {
            slug,
            fromRevId: diffFrom,
            toRevId: diffTo,
            lang: contentLang,
          });
          const fromLabel = formatDateUTC(diff.from.revDate)
            ? `${diff.fromRevId} (${formatDateUTC(diff.from.revDate)})`
            : diff.fromRevId;
          const toLabel = formatDateUTC(diff.to.revDate)
            ? `${diff.toRevId} (${formatDateUTC(diff.to.revDate)})`
            : diff.toRevId;
          const diffLabels = getDiffLabels(req.t);
          const baseHref = `/blog/${encodeURIComponent(slug)}`;
          const fromHref = langOverride
            ? `${baseHref}?rev=${diffFrom}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffFrom}`;
          const toHref = langOverride
            ? `${baseHref}?rev=${diffTo}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffTo}`;
          const fields = Object.entries(diff.fields).map(([key, fieldDiff]) => ({
            key,
            diff: fieldDiff,
          }));
          diffHtml = renderEntityDiff({
            fromLabel,
            toLabel,
            fromHref,
            toHref,
            fields,
            labels: diffLabels,
          });
        } catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw error;
          }
        }
      }

      const historyRevisions = revisions.map(rev => ({
        revId: rev.revId,
        dateLabel: formatDateUTC(rev.revDate),
        title: resolveSafeText(mlString.resolve, contentLang, rev.title, slug),
        summary: resolveSafeText(mlString.resolve, contentLang, rev.revSummary, ''),
        revUser: rev.revUser ?? null,
        revTags: rev.revTags ?? null,
      }));
      const queryParams = extractQueryParams(req.query);
      const historyAction = langOverride
        ? `/blog/${slug}?lang=${encodeURIComponent(langOverride)}`
        : `/blog/${slug}`;
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: historyAction,
        viewHref: revId =>
          langOverride
            ? `/blog/${slug}?rev=${revId}&lang=${encodeURIComponent(langOverride)}`
            : `/blog/${slug}?rev=${revId}`,
        userMap,
        t: req.t,
      });

      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const summaryHtml = summary
        ? `<div class="post-summary">${(await renderMarkdown(summary, citationEntries)).html}</div>`
        : '';
      const metaHtml = `<div class="post-meta post-meta--primary post-meta--bottom">
  <span class="post-created">${req.t('blog.created', {
    date: escapeHtml(createdLabel),
  })}</span>
  ${updatedHtml}
</div>`;
      const languageRow = renderContentLanguageRow({
        label: req.t('language.available'),
        currentLang: contentLang,
        availableLangs,
        languageOptions: res.locals.languageOptions,
        path: req.path,
        queryParams,
      });
      const labelHtml = `<div class="page-label">${req.t('label.blogPost')}</div>`;
      const signedIn = Boolean(await resolveSessionUser(req));
      const html = renderLayout({
        title,
        labelHtml,
        bodyHtml: `${summaryHtml}${bodyHtml}${metaHtml}${languageRow}`,
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
