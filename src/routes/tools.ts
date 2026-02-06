import type { Express } from 'express';
import type { TFunction } from 'i18next';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { formatCitationLabel } from '../lib/citation.js';
import {
  getRecentCitationChanges,
  getRecentCitationClaimChanges,
  getRecentWikiChanges,
} from '../lib/recent-changes.js';
import { getRecentPageChecks } from '../lib/recent-checks.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import WikiPage from '../models/wiki-page.js';
import {
  concatSafeText,
  escapeHtml,
  formatDateUTC,
  renderLayout,
  renderText,
  type SafeText,
} from '../render.js';
import { fetchUserMap } from './lib/history.js';
import { formatCheckStatus, formatCheckType } from './lib/page-checks.js';

const { mlString } = dal;

type RecentListAction = {
  label: string;
  href: string;
};

type RecentListItem = {
  primaryLabel: SafeText | string;
  primaryHref?: string;
  dateLabel: string;
  summary?: SafeText | string;
  revUser: string | null;
  revTags: string[];
  actions?: RecentListAction[];
};

const parseRecentLimit = (limitQuery: unknown) => {
  const limitParam = typeof limitQuery === 'string' ? Number(limitQuery) : 50;
  return Number.isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 100);
};

const resolvePreferredText = (
  value: Record<string, string> | null,
  preferredLang: string
) => resolveSafeTextWithFallback(mlString.resolve, preferredLang, value, '');

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
        ? `<div class="change-summary">${renderText(item.summary)}</div>`
        : '';
      const primaryLabel = renderText(item.primaryLabel);
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
  <div class="change-meta">
    ${primaryHtml}
    <span${metaAttrs}>${escapeHtml(item.dateLabel)}</span>
    ${tags ? `<span>${tags}</span>` : ''}
  </div>
  ${summary}
  ${actionsHtml}
</li>`;
    })
    .join('');

const renderRelatedTools = (
  links: Array<{ href: string; label: string }>,
  t: TFunction
) => {
  if (!links.length) return '';
  const items = links
    .map(
      (link, index) =>
        `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>${
          index < links.length - 1 ? ' · ' : ''
        }`
    )
    .join('');
  return `<div class="tool-related">
  <span class="tool-related-label">${escapeHtml(t('tool.relatedLabel'))}</span>
  <span class="tool-related-links">${items}</span>
</div>`;
};

type RecentToolKey = 'changes' | 'citations' | 'claims' | 'checks';

const getRecentRelatedLinks = (current: RecentToolKey, t: TFunction) => {
  const links = [
    { key: 'changes', href: '/tool/recent-changes', label: t('page.recentChanges') },
    { key: 'citations', href: '/tool/recent-citations', label: t('page.recentCitations') },
    { key: 'claims', href: '/tool/recent-claims', label: t('page.recentClaims') },
    { key: 'checks', href: '/tool/recent-checks', label: t('page.recentChecks') },
  ];

  return links.filter(link => link.key !== current);
};

export const registerToolRoutes = (app: Express) => {
  app.get('/tool/recent-changes', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);
    const preferredLang = res.locals.locale;

    const dalInstance = await initializePostgreSQL();
    const rawChanges = await getRecentWikiChanges(dalInstance, limit);
    const changes = rawChanges.map(change => ({
      ...change,
      revSummary: resolvePreferredText(change.revSummary, preferredLang),
    }));
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
      const pageTitle = resolveSafeTextWithFallback(
        mlString.resolve,
        preferredLang,
        change.title,
        change.slug
      );
      return {
        primaryLabel: concatSafeText(pageTitle, ` · /${change.slug}`),
        primaryHref: `/${change.slug}`,
        dateLabel: formatDateUTC(change.revDate),
        summary: change.revSummary,
        revUser: change.revUser,
        revTags: change.revTags,
        actions,
      };
    });
    const itemsHtml = renderRecentList(items, userMap, req.t);

    const relatedHtml = renderRelatedTools(getRecentRelatedLinks('changes', req.t), req.t);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentChangesDescription')}</p>
  ${relatedHtml}
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
    const preferredLang = res.locals.locale;

    const dalInstance = await initializePostgreSQL();
    const rawChanges = await getRecentCitationChanges(dalInstance, limit);
    const changes = rawChanges.map(change => ({
      ...change,
      revSummary: resolvePreferredText(change.revSummary, preferredLang),
    }));

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
      const citationTitle = formatCitationLabel(change.key, change.data);
      return {
        primaryLabel: `${citationTitle} · ${change.key}`,
        primaryHref: `/cite/${encodedKey}`,
        dateLabel: formatDateUTC(change.revDate),
        summary: change.revSummary,
        revUser: change.revUser,
        revTags: change.revTags,
        actions,
      };
    });
    const itemsHtml = renderRecentList(items, userMap, req.t);

    const relatedHtml = renderRelatedTools(getRecentRelatedLinks('citations', req.t), req.t);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentCitationsDescription')}</p>
  ${relatedHtml}
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

  app.get('/tool/recent-claims', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);
    const preferredLang = res.locals.locale;

    const dalInstance = await initializePostgreSQL();
    const rawChanges = await getRecentCitationClaimChanges(dalInstance, limit);
    const changes = rawChanges.map(change => ({
      ...change,
      revSummary: resolvePreferredText(change.revSummary, preferredLang),
      assertion: resolveSafeTextWithFallback(
        mlString.resolve,
        preferredLang,
        change.assertion,
        ''
      ),
    }));

    const userIds = changes
      .map(change => change.revUser)
      .filter((id): id is string => Boolean(id));
    const userMap = await fetchUserMap(dalInstance, userIds);
    const items: RecentListItem[] = changes.map(change => {
      const encodedKey = encodeURIComponent(change.key);
      const encodedClaim = encodeURIComponent(change.claimId);
      const actions: RecentListAction[] = [
        {
          label: req.t('tool.view'),
          href: `/cite/${encodedKey}/claims/${encodedClaim}?rev=${change.revId}`,
        },
      ];
      if (change.prevRevId) {
        actions.push({
          label: req.t('tool.diff'),
          href: `/cite/${encodedKey}/claims/${encodedClaim}?diffFrom=${change.prevRevId}&diffTo=${change.revId}`,
        });
      }
      return {
        primaryLabel: `${change.claimId} · ${change.key}`,
        primaryHref: `/cite/${encodedKey}/claims/${encodedClaim}`,
        dateLabel: formatDateUTC(change.revDate),
        summary: change.revSummary || change.assertion,
        revUser: change.revUser,
        revTags: change.revTags,
        actions,
      };
    });

    const itemsHtml = renderRecentList(items, userMap, req.t);
    const relatedHtml = renderRelatedTools(getRecentRelatedLinks('claims', req.t), req.t);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentClaimsDescription')}</p>
  ${relatedHtml}
  <ul class="change-list">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: req.t('page.recentClaims'),
      labelHtml,
      bodyHtml,
      signedIn,
      locale: res.locals.locale,
      languageOptions: res.locals.languageOptions,
    });
    res.type('html').send(html);
  });

  app.get('/tool/recent-checks', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);
    const preferredLang = res.locals.locale;

    const dalInstance = await initializePostgreSQL();
    const checks = await getRecentPageChecks(dalInstance, limit);
    const userIds = checks
      .map(check => check.revUser)
      .filter((id): id is string => Boolean(id));
    const userMap = await fetchUserMap(dalInstance, userIds);

    const items: RecentListItem[] = checks.map(check => {
      const pageTitle = resolveSafeTextWithFallback(
        mlString.resolve,
        preferredLang,
        check.title,
        check.slug
      );
      const primaryLabel = concatSafeText(pageTitle, ` · /${check.slug}`);
      const revSummary = resolvePreferredText(check.revSummary, preferredLang);
      const summary =
        revSummary ||
        `${formatCheckType(check.type, req.t)} · ${formatCheckStatus(check.status, req.t)}`;
      return {
        primaryLabel,
        primaryHref: `/${check.slug}`,
        dateLabel: formatDateUTC(check.revDate),
        summary,
        revUser: check.revUser,
        revTags: check.revTags ?? [],
        actions: [
          {
            label: req.t('tool.view'),
            href: `/${check.slug}/checks/${check.id}?rev=${check.revId}`,
          },
          ...(check.prevRevId
            ? [
                {
                  label: req.t('tool.diff'),
                  href: `/${check.slug}/checks/${check.id}?diffFrom=${check.prevRevId}&diffTo=${check.revId}`,
                },
              ]
            : []),
        ],
      };
    });

    const itemsHtml = renderRecentList(items, userMap, req.t);

    const relatedHtml = renderRelatedTools(getRecentRelatedLinks('checks', req.t), req.t);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentChecksDescription')}</p>
  ${relatedHtml}
  <ul class="change-list">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    const signedIn = Boolean(await resolveSessionUser(req));
    const html = renderLayout({
      title: req.t('page.recentChecks'),
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

    const { notLike } = WikiPage.ops;

    const total = await WikiPage.filterWhere({ slug: notLike('meta/%') })
      .and({ slug: notLike('tool/%') })
      .count();

    const pageResults = await WikiPage.filterWhere({ slug: notLike('meta/%') })
      .and({ slug: notLike('tool/%') })
      .orderBy('slug', 'ASC')
      .limit(per)
      .offset(offset)
      .run();

    const pages = pageResults.map(p => ({
      slug: p.slug,
      title: resolveSafeTextWithFallback(mlString.resolve, 'en', p.title, p.slug),
    }));

    const totalPages = Math.max(Math.ceil(total / per), 1);
    const prevLink =
      page > 1 ? `/tool/pages?page=${page - 1}&per=${per}` : '';
    const nextLink =
      page < totalPages ? `/tool/pages?page=${page + 1}&per=${per}` : '';

    const listItems = pages
      .map(
        item =>
          `<li><a href="/${escapeHtml(item.slug)}">${renderText(item.title)}</a></li>`
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
