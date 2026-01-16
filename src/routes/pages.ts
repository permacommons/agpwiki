import { createTwoFilesPatch } from 'diff';
import type { Express } from 'express';

import dal from '../../dal/index.js';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { isBlockedSlug } from '../lib/slug.js';
import Citation from '../models/citation.js';
import WikiPage from '../models/wiki-page.js';
import {
  escapeHtml,
  formatDateUTC,
  normalizeForDiff,
  renderLayout,
  renderMarkdown,
  renderUnifiedDiff,
} from '../render.js';

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

export const registerPageRoutes = (app: Express) => {
  app.get('/', (_req, res) => {
    res.redirect(302, '/meta/welcome');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(/^\/(.+)$/, async (req, res) => {
    const slug = req.params[0];
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;

    if (isBlockedSlug(slug)) {
      res.status(404).type('text').send('Not found');
      return;
    }

    try {
      await initializePostgreSQL();

      const page = await WikiPage.filterWhere({
        slug,
        _oldRevOf: null,
        _revDeleted: false,
      } as Record<string, unknown>).first();

      if (!page) {
        res.status(404).type('text').send('Not found');
        return;
      }

      const dalInstance = await initializePostgreSQL();

      const fetchRevisionByRevId = async (revId: string) => {
        const result = await dalInstance.query(
          `SELECT * FROM ${WikiPage.tableName} WHERE _rev_id = $1 AND (id = $2 OR _old_rev_of = $2) LIMIT 1`,
          [revId, page.id]
        );
        const [row] = result.rows;
        return row ? WikiPage.createFromRow(row) : null;
      };

      const revisionsResult = await dalInstance.query(
        `SELECT * FROM ${WikiPage.tableName} WHERE id = $1 OR _old_rev_of = $1 ORDER BY _rev_date DESC`,
        [page.id]
      );
      const revisions = revisionsResult.rows.map(row => WikiPage.createFromRow(row));
      const userIds = revisions
        .map(rev => rev._revUser)
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

      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : page;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send('Revision not found');
        return;
      }

      const resolvedTitle = mlString.resolve('en', selectedRevision.title ?? null);
      const resolvedBody = mlString.resolve('en', selectedRevision.body ?? null);

      const title = resolvedTitle?.str ?? page.slug;
      const metaLabel = slug.startsWith('meta/')
        ? '<div class="page-label">META — PAGE ABOUT AGPEDIA</div>'
        : slug.startsWith('tool/')
          ? '<div class="page-label">TOOL — BUILT-IN SOFTWARE FEATURE</div>'
          : '<div class="page-label">FROM AGPEDIA — AGENCY THROUGH KNOWLEDGE</div>';
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
          citationEntries.push({ id, ...item });
        }
      }

      const bodyHtml = await renderMarkdown(bodySource, citationEntries);

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
          const diff = createTwoFilesPatch(
            `rev:${fromLabel}`,
            `rev:${toLabel}`,
            normalizeForDiff(fromText),
            normalizeForDiff(toText),
            '',
            '',
            { context: 2 }
          );
          const diffRendered = renderUnifiedDiff(diff);
          diffHtml = `<details class="page-diff" open>
  <summary>Revision diff</summary>
  <pre class="diff">${diffRendered}</pre>
</details>`;
        }
      }

      const historyItems = revisions
        .map((rev, index) => {
          const revTitle = mlString.resolve('en', rev.title ?? null)?.str ?? slug;
          const revSummary = mlString.resolve('en', rev._revSummary ?? null)?.str ?? '';
          const summaryHtml = revSummary
            ? `<div class="rev-summary">${escapeHtml(revSummary)}</div>`
            : '';
          const dateLabel = formatDateUTC(rev._revDate);
          const fromChecked = diffFrom ? diffFrom === rev._revID : index === 1;
          const toChecked = diffTo ? diffTo === rev._revID : index === 0;
          const revUser = rev._revUser ?? null;
          const displayName = revUser ? userMap.get(revUser) ?? revUser : null;
          const agentTag = (rev._revTags ?? []).find(tag => tag.startsWith('agent:')) ?? null;
          const agentVersion =
            (rev._revTags ?? []).find(tag => tag.startsWith('agent_version:')) ?? null;
          const metaLabelParts = [
            displayName ? `operator: ${displayName}` : null,
            agentTag,
            agentVersion,
          ].filter(Boolean);
          const metaLabel = metaLabelParts.join(' · ');
          const metaAttrs = metaLabel
            ? ` data-meta="true" data-user="${escapeHtml(displayName ?? '')}" data-agent="${escapeHtml(
                agentTag ?? ''
              )}" data-agent-version="${escapeHtml(
                agentVersion ?? ''
              )}" title="${escapeHtml(metaLabel)}"`
            : '';
          return `<li>
  <div class="rev-meta"${metaAttrs}>
    <span class="rev-radio"><input type="radio" name="diffFrom" value="${rev._revID}" ${
      fromChecked ? 'checked' : ''
    } /></span>
    <span class="rev-radio"><input type="radio" name="diffTo" value="${rev._revID}" ${
      toChecked ? 'checked' : ''
    } /></span>
    <strong>${escapeHtml(revTitle)}</strong>
    <span>${escapeHtml(dateLabel)}</span>
  </div>
  ${summaryHtml}
  <div class="rev-actions">
    <a href="/${slug}?rev=${rev._revID}">View</a>
  </div>
</li>`;
        })
        .join('\n');

      const historyHtml = `<details class="page-history">
  <summary>Version history</summary>
  <form class="history-form" method="get" action="/${slug}">
    <div class="history-actions">
      <button type="submit">Compare selected revisions</button>
    </div>
    <ol class="history-list">${historyItems}</ol>
  </form>
</details>`;

      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const signedIn = Boolean(await resolveSessionUser(req));
      const html = renderLayout({
        title,
        labelHtml: metaLabel,
        bodyHtml,
        topHtml,
        sidebarHtml: historyHtml,
        signedIn,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send('Server error');
      console.error('Failed to render wiki page:', message);
    }
  });
};
