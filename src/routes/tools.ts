import type { Express, Request, Response } from 'express';
import type { TFunction } from 'i18next';
import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { formatCitationLabel } from '../lib/citation.js';
import { NotFoundError } from '../lib/errors.js';
import { forumCategoryPagePath } from '../lib/forum-paths.js';
import { formatMediaLabel } from '../lib/media.js';
import { PAGE_CHECK_TYPES } from '../lib/page-checks.js';
import {
  getRecentCitationChanges,
  getRecentCitationClaimChanges,
  getRecentMediaChanges,
  getRecentWikiChanges,
  type MediaChange,
} from '../lib/recent-changes.js';
import { getRecentPageChecks } from '../lib/recent-checks.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import { WIKI_LINK_PREVIEW_ENDPOINT } from '../lib/wiki-link-preview.js';
import { createWikiLinkPreviewToken } from '../lib/wiki-link-preview-token.js';
import WikiPage from '../models/wiki-page.js';
import {
  concatSafeText,
  escapeHtml,
  formatDateUTC,
  prepareTitle,
  renderText,
  type SafeText,
} from '../render.js';
import {
  ADMIN_EVENT_TARGET_WIKI_PAGE,
  type AdminEventResult,
  listRecentAdminEvents,
} from '../services/admin-event-service.js';
import {
  ARTICLE_ISSUE_KINDS,
  type ArticleIssueKind,
  countArticlesWithIssues,
  isArticleIssueKind,
  isPageCheckType,
  listArticlesWithIssues,
} from '../services/article-issues-service.js';
import {
  ADMIN_EVENT_TARGET_USER,
  EXPERIENCED_MIN_EDITS,
  type ExperiencedStatus,
  getExperiencedStatuses,
  setExperiencedOverride,
} from '../services/experienced-editor-service.js';
import { getWikiPageEditability } from '../services/page-protection-service.js';
import { REVERT_TAG } from '../services/page-revert-service.js';
import { listProposalPages, PROPOSAL_LIST_ORDER } from '../services/proposal-status-service.js';
import {
  getUserRoles,
  hasRole,
  SITE_ADMIN_ROLE,
  type ValidRole,
  WIKI_ADMIN_ROLE,
} from '../services/roles.js';
import {
  EDITABLE_USER_RIGHTS,
  type EditableUserRight,
  searchVerifiedUsersWithRights,
  type UserRightsSummary,
  updateUserRightsBelowSiteAdmin,
} from '../services/user-rights-service.js';
import { readWikiPage } from '../services/wiki-page-service.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { fetchUserMap } from './lib/history.js';
import { HOW_TO_EDIT_PATH } from './lib/operator-edit-link.js';
import { formatCheckStatus, formatCheckType } from './lib/page-checks.js';

const { mlString } = dal;

const USER_RIGHTS_PATH = '/tool/user-rights';
export const ISSUES_PATH = '/tool/issues';

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

const parseIntegerQuery = (
  value: unknown,
  { fallback, min, max }: { fallback: number; min: number; max: number }
) => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max);
};

const parseRecentLimit = (limitQuery: unknown) =>
  parseIntegerQuery(limitQuery, { fallback: 50, min: 1, max: 100 });

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
  ${actionsHtml}
  <div class="change-meta">
    ${primaryHtml}
    <span${metaAttrs}>${escapeHtml(item.dateLabel)}</span>
    ${tags ? `<span>${tags}</span>` : ''}
  </div>
  ${summary}
</li>`;
    })
    .join('');

type RecentMediaView = 'grid' | 'list';

const RECENT_MEDIA_THUMB_WIDTH = 500;
const RECENT_MEDIA_DEFAULT_ASPECT_RATIO = 4 / 3;

const renderRecentMediaViewToggle = (current: RecentMediaView, t: TFunction) => {
  const buttonFor = (view: RecentMediaView, label: string) => {
    if (view === current) {
      return `<span class="view-toggle-link view-toggle-link--active" aria-current="page">${escapeHtml(label)}</span>`;
    }
    const href = view === 'grid' ? '/tool/recent-media' : '/tool/recent-media?view=list';
    return `<a class="view-toggle-link" href="${href}">${escapeHtml(label)}</a>`;
  };
  return `<div class="view-toggle" role="group" aria-label="${escapeHtml(t('tool.viewToggleLabel'))}">
  ${buttonFor('grid', t('tool.viewGrid'))}
  ${buttonFor('list', t('tool.viewList'))}
</div>`;
};

type RecentMediaChangeForGrid = Omit<MediaChange, 'revSummary'> & {
  revSummary: SafeText | string;
};

const renderRecentMediaGrid = (
  changes: RecentMediaChangeForGrid[],
  userMap: Map<string, string>,
  t: TFunction
) => {
  if (!changes.length) {
    return `<p class="recent-media-empty">${escapeHtml(t('tool.recentMediaEmpty'))}</p>`;
  }
  const tiles = changes
    .map(change => {
      const encodedSlug = encodeURIComponent(change.slug);
      const data = change.data ?? {};
      const origWidth = typeof data.width === 'number' ? data.width : null;
      const origHeight = typeof data.height === 'number' ? data.height : null;
      const aspectRatio =
        origWidth && origHeight && origHeight > 0
          ? origWidth / origHeight
          : RECENT_MEDIA_DEFAULT_ASPECT_RATIO;
      const isImage = change.mediaType === 'image';
      const thumbHtml = isImage
        ? `<img
            class="media-tile-image"
            src="/media-files/${encodedSlug}/${RECENT_MEDIA_THUMB_WIDTH}"
            alt=""
            loading="lazy"
          />`
        : `<span class="media-tile-placeholder" aria-hidden="true">${escapeHtml(change.mediaType)}</span>`;

      const displayName = change.revUser ? userMap.get(change.revUser) ?? change.revUser : '';
      const agentTag = change.revTags.find(tag => tag.startsWith('agent:')) ?? '';
      const agentVersion = change.revTags.find(tag => tag.startsWith('agent_version:')) ?? '';
      const dateLabel = formatDateUTC(change.revDate);
      const titleParts = [
        change.slug,
        dateLabel || null,
        displayName ? t('history.operator', { name: displayName }) : null,
        agentTag || null,
        agentVersion || null,
      ].filter((part): part is string => Boolean(part));
      const titleText = titleParts.join(' · ');

      return `<li class="media-tile" data-aspect-ratio="${aspectRatio.toFixed(4)}">
  <a class="media-tile-link" href="/media/${encodedSlug}" data-meta="true" data-user="${escapeHtml(displayName)}" data-agent="${escapeHtml(agentTag)}" data-agent-version="${escapeHtml(agentVersion)}" title="${escapeHtml(titleText)}">
    <span class="media-tile-thumb">${thumbHtml}</span>
  </a>
</li>`;
    })
    .join('');
  return `<ul class="media-grid media-grid--justified" data-justified-gallery="true">${tiles}</ul>`;
};

type RecentToolKey = 'changes' | 'citations' | 'claims' | 'checks' | 'media' | 'admin';

// The recent-changes pages are one page with a tab for each kind of
// change. Each tab keeps its own address.
const getRecentTabs = (t: TFunction, options: { includeAdminActions?: boolean } = {}) => {
  const tabs: Array<{ key: RecentToolKey; href: string; label: string }> = [
    { key: 'changes', href: '/tool/recent-changes', label: t('recentTabs.pages') },
    { key: 'checks', href: '/tool/recent-checks', label: t('recentTabs.checks') },
    { key: 'citations', href: '/tool/recent-citations', label: t('recentTabs.citations') },
    { key: 'claims', href: '/tool/recent-claims', label: t('recentTabs.claims') },
    { key: 'media', href: '/tool/recent-media', label: t('recentTabs.media') },
  ];
  if (options.includeAdminActions) {
    tabs.push({ key: 'admin', href: '/tool/recent-admin-actions', label: t('page.recentAdminActions') });
  }
  return tabs;
};

export const renderTabNav = (
  tabs: Array<{ key: string; href: string; label: string }>,
  current: string,
  label: string
) => `<nav class="tool-tabs" aria-label="${escapeHtml(label)}">${tabs
  .map(tab =>
    tab.key === current
      ? `<a class="tool-tab tool-tab--current" href="${escapeHtml(tab.href)}" aria-current="page">${escapeHtml(tab.label)}</a>`
      : `<a class="tool-tab" href="${escapeHtml(tab.href)}">${escapeHtml(tab.label)}</a>`
  )
  .join('')}</nav>`;

const canShowAdminActionsLink = async (req: Request, dalInstance: Awaited<ReturnType<typeof initializePostgreSQL>>) => {
  const session = await resolveSessionUser(req);
  if (!session) return false;
  const roles = await getUserRoles(dalInstance, session.userId);
  return hasRole(roles, WIKI_ADMIN_ROLE);
};

const renderRecentRelatedTools = async (
  current: RecentToolKey,
  req: Request,
  dalInstance: Awaited<ReturnType<typeof initializePostgreSQL>>
) =>
  renderTabNav(
    getRecentTabs(req.t, { includeAdminActions: await canShowAdminActionsLink(req, dalInstance) }),
    current,
    req.t('recentTabs.label')
  );

const renderToolLayout = (res: Response, title: string, bodyHtml: string) => {
  res.render('layout', {
    title: prepareTitle(title),
    labelHtml: `<div class="page-label">${res.req.t('label.tool')}</div>`,
    bodyHtml,
    topHtml: prependAccountBanner(res),
  });
};

const requireSiteAdmin = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || USER_RIGHTS_PATH)}`);
    return null;
  }

  const dalInstance = await initializePostgreSQL();
  const roles = await getUserRoles(dalInstance, session.userId);
  if (!hasRole(roles, SITE_ADMIN_ROLE)) {
    res.status(403);
    renderToolLayout(
      res,
      req.t('page.forbidden'),
      `<div class="tool-page"><p>${escapeHtml(req.t('page.accessDenied'))}</p></div>`
    );
    return null;
  }

  return { session, dalInstance };
};

const requireWikiAdmin = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(
      302,
      `/tool/login?redirect=${encodeURIComponent(req.originalUrl || '/tool/recent-admin-actions')}`
    );
    return null;
  }

  const dalInstance = await initializePostgreSQL();
  const roles = await getUserRoles(dalInstance, session.userId);
  if (!hasRole(roles, WIKI_ADMIN_ROLE)) {
    res.status(403);
    renderToolLayout(
      res,
      req.t('page.forbidden'),
      `<div class="tool-page"><p>${escapeHtml(req.t('page.accessDenied'))}</p></div>`
    );
    return null;
  }

  return { session, dalInstance };
};

type AdminEventPageTarget = {
  slug: string;
  title: Record<string, string> | null;
};

const loadAdminEventPageTargets = async (
  dalInstance: Awaited<ReturnType<typeof initializePostgreSQL>>,
  events: AdminEventResult[]
) => {
  const revIds = events
    .filter(event => event.targetType === ADMIN_EVENT_TARGET_WIKI_PAGE && event.targetRevId)
    .map(event => event.targetRevId as string);
  if (!revIds.length) return new Map<string, AdminEventPageTarget>();

  const result = await dalInstance.query(
    `SELECT _rev_id, slug, title
     FROM ${WikiPage.tableName}
     WHERE _rev_id = ANY($1::uuid[])`,
    [revIds]
  );

  return new Map(
    result.rows.map(
      (row: { _rev_id: string; slug: string; title: Record<string, string> | null }) => [
        row._rev_id,
        { slug: row.slug, title: row.title ?? null },
      ]
    )
  );
};

const formatAdminEventLabel = (eventType: string, t: TFunction) => {
  const key = `adminActions.events.${eventType}`;
  const translated = t(key);
  return translated === key ? eventType : translated;
};

const renderAdminEventList = (
  events: AdminEventResult[],
  pageTargets: Map<string, AdminEventPageTarget>,
  userMap: Map<string, string>,
  preferredLang: string,
  t: TFunction
) => {
  if (!events.length) {
    return `<p>${escapeHtml(t('adminActions.empty'))}</p>`;
  }

  const items: RecentListItem[] = events.map(event => {
    const target = event.targetRevId ? pageTargets.get(event.targetRevId) : undefined;
    const userName =
      event.targetType === ADMIN_EVENT_TARGET_USER && typeof event.details?.userName === 'string'
        ? event.details.userName
        : null;
    const targetTitle = target
      ? resolveSafeTextWithFallback(mlString.resolve, preferredLang, target.title, target.slug)
      : (userName ?? t('adminActions.unknownTarget'));
    const primaryLabel = concatSafeText(formatAdminEventLabel(event.eventType, t), ' · ', targetTitle);
    const actions =
      target && event.targetRevId
        ? [
            {
              label: t('tool.view'),
              href: `/${encodeURIComponent(target.slug)}?rev=${encodeURIComponent(event.targetRevId)}`,
            },
          ]
        : [];

    return {
      primaryLabel,
      primaryHref: target ? `/${encodeURIComponent(target.slug)}` : undefined,
      dateLabel: formatDateUTC(event.createdAt ?? new Date()),
      summary:
        event.details && typeof event.details.reason === 'string' && event.details.reason
          ? event.details.reason
          : undefined,
      revUser: event.actorUserId ?? null,
      revTags: [],
      actions,
    };
  });

  return `<ul class="change-list change-list--compact">${renderRecentList(items, userMap, t)}</ul>`;
};

const roleLabelKey = (role: ValidRole) => `userRights.roles.${role}.label`;
const roleDescriptionKey = (role: ValidRole) => `userRights.roles.${role}.description`;

const renderRightsBadges = (roles: ValidRole[], t: TFunction) => {
  if (!roles.length) {
    return `<span class="user-rights-empty">${escapeHtml(t('userRights.none'))}</span>`;
  }

  return `<div class="user-rights-badges">${roles
    .map(role => `<span class="user-rights-badge">${escapeHtml(t(roleLabelKey(role)))}</span>`)
    .join('')}</div>`;
};

const renderUserRightsStatus = (req: Request) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  if (status !== 'updated' && status !== 'unchanged' && status !== 'error' && status !== 'experienced') return '';

  const user = typeof req.query.user === 'string' ? req.query.user : '';
  if (status === 'experienced') {
    return `<div class="account-review-notice" role="status">${escapeHtml(req.t('experienced.form.saved', { user }))}</div>`;
  }
  if (status === 'unchanged') {
    return `<div class="account-review-notice" role="status">${escapeHtml(
      req.t('userRights.notice.unchanged', { user })
    )}</div>`;
  }

  if (status === 'error') {
    return `<div class="form-error" role="alert">${escapeHtml(req.t('userRights.notice.error'))}</div>`;
  }

  const granted = typeof req.query.granted === 'string' && req.query.granted
    ? req.query.granted.split(',').filter(Boolean)
    : [];
  const revoked = typeof req.query.revoked === 'string' && req.query.revoked
    ? req.query.revoked.split(',').filter(Boolean)
    : [];
  const rows = [
    ...granted.map(role => ({ role, before: false, after: true })),
    ...revoked.map(role => ({ role, before: true, after: false })),
  ].filter((change): change is { role: EditableUserRight; before: boolean; after: boolean } =>
    EDITABLE_USER_RIGHTS.includes(change.role as EditableUserRight)
  );

  if (!rows.length) return '';

  const yes = req.t('userRights.notice.yes');
  const no = req.t('userRights.notice.no');
  return `<div class="user-rights-change-overview" role="status">
    <div class="user-rights-notice">
    <div class="user-rights-notice-heading">${escapeHtml(
      req.t('userRights.notice.updated', { user })
    )}</div>
    </div>
    <table class="token-table user-rights-change-table">
      <thead>
        <tr>
          <th>${escapeHtml(req.t('userRights.notice.headers.right'))}</th>
          <th>${escapeHtml(req.t('userRights.notice.headers.before'))}</th>
          <th>${escapeHtml(req.t('userRights.notice.headers.after'))}</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            change => `<tr>
              <td>${escapeHtml(req.t(roleLabelKey(change.role)))}</td>
              <td>${escapeHtml(change.before ? yes : no)}</td>
              <td>${escapeHtml(change.after ? yes : no)}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
};

const renderUserRightsForm = (user: UserRightsSummary, req: Request) => {
  const editableRows = EDITABLE_USER_RIGHTS.map(role => {
    const checked = user.roles.includes(role) ? ' checked' : '';
    return `<label class="user-rights-checkbox">
      <input type="checkbox" name="rights" value="${escapeHtml(role)}"${checked} />
      <span>
        <strong>${escapeHtml(req.t(roleLabelKey(role)))}</strong>
        <small>${escapeHtml(req.t(roleDescriptionKey(role)))}</small>
      </span>
    </label>`;
  }).join('');
  const siteAdminChecked = user.roles.includes(SITE_ADMIN_ROLE) ? ' checked' : '';

  return `<form method="post" action="${USER_RIGHTS_PATH}/${encodeURIComponent(user.id)}" class="user-rights-form">
    <input type="hidden" name="redirectTo" value="${escapeHtml(req.originalUrl || USER_RIGHTS_PATH)}" />
    <div class="user-rights-checkboxes">
      ${editableRows}
      <label class="user-rights-checkbox user-rights-checkbox--locked">
        <input type="checkbox" disabled${siteAdminChecked} />
        <span>
          <strong>${escapeHtml(req.t(roleLabelKey(SITE_ADMIN_ROLE)))}</strong>
          <small>${escapeHtml(req.t('userRights.siteAdminLocked'))}</small>
        </span>
      </label>
    </div>
    <button class="account-review-action-button" type="submit">${escapeHtml(req.t('userRights.save'))}</button>
  </form>`;
};

const renderExperiencedStatus = (status: ExperiencedStatus, t: TFunction) => {
  if (status.override === 'revoked') {
    return `<div class="user-rights-experienced">${escapeHtml(t('experienced.status.revoked'))}</div>`;
  }
  if (status.isExperienced && status.since) {
    return `<div class="user-rights-experienced">${escapeHtml(
      t(status.override === 'granted' ? 'experienced.status.granted' : 'experienced.status.automatic', {
        date: formatDateUTC(status.since),
      })
    )}</div>`;
  }
  return `<div class="user-rights-experienced">${escapeHtml(
    t('experienced.status.notYet', { count: status.countedEdits, total: EXPERIENCED_MIN_EDITS })
  )}</div>`;
};

const renderExperiencedForm = (user: UserRightsSummary, status: ExperiencedStatus, req: Request) => {
  const option = (value: string, labelKey: string) =>
    `<option value="${value}"${(status.override ?? 'auto') === value ? ' selected' : ''}>${escapeHtml(req.t(labelKey))}</option>`;
  return `<form method="post" action="${USER_RIGHTS_PATH}/${encodeURIComponent(user.id)}/experienced" class="user-rights-experienced-form">
    <input type="hidden" name="redirectTo" value="${escapeHtml(req.originalUrl || USER_RIGHTS_PATH)}" />
    <label>
      <span>${escapeHtml(req.t('experienced.form.label'))}</span>
      <select name="override">
        ${option('auto', 'experienced.form.auto')}
        ${option('granted', 'experienced.form.granted')}
        ${option('revoked', 'experienced.form.revoked')}
      </select>
    </label>
    <label>
      <span>${escapeHtml(req.t('experienced.form.reason'))}</span>
      <input type="text" name="reason" required maxlength="300" />
    </label>
    <button type="submit">${escapeHtml(req.t('experienced.form.submit'))}</button>
  </form>`;
};

const renderUserRightsRows = (
  users: UserRightsSummary[],
  statuses: Map<string, ExperiencedStatus>,
  req: Request
) => {
  if (!users.length) {
    return `<tr><td colspan="4">${escapeHtml(req.t('userRights.empty'))}</td></tr>`;
  }

  return users
    .map(user => {
      const status = statuses.get(user.id);
      return `<tr>
        <td data-label="${escapeHtml(req.t('userRights.headers.user'))}">
          <div>${escapeHtml(user.displayName)}</div>
          <div class="form-hint">${escapeHtml(user.username)}</div>
        </td>
        <td data-label="${escapeHtml(req.t('userRights.headers.email'))}">${escapeHtml(user.email)}</td>
        <td data-label="${escapeHtml(req.t('userRights.headers.currentRights'))}">${renderRightsBadges(user.roles, req.t)}${
          status ? renderExperiencedStatus(status, req.t) : ''
        }</td>
        <td data-label="${escapeHtml(req.t('userRights.headers.edit'))}">${renderUserRightsForm(user, req)}${
          status ? renderExperiencedForm(user, status, req) : ''
        }</td>
      </tr>`;
    })
    .join('');
};

const appendUserRightsStatus = (
  redirectTo: string,
  result: {
    status: 'updated' | 'unchanged' | 'error' | 'experienced';
    user?: string;
    granted?: string[];
    revoked?: string[];
  }
) => {
  const url = new URL(redirectTo, 'http://local');
  url.searchParams.delete('status');
  url.searchParams.delete('user');
  url.searchParams.delete('granted');
  url.searchParams.delete('revoked');
  url.searchParams.set('status', result.status);
  if (result.user) url.searchParams.set('user', result.user);
  if (result.granted?.length) url.searchParams.set('granted', result.granted.join(','));
  if (result.revoked?.length) url.searchParams.set('revoked', result.revoked.join(','));
  return `${url.pathname}${url.search}`;
};

const getUserRightsRedirect = (value: unknown) => {
  if (typeof value !== 'string') return USER_RIGHTS_PATH;
  try {
    const url = new URL(value, 'http://local');
    return url.pathname === USER_RIGHTS_PATH ? `${url.pathname}${url.search}` : USER_RIGHTS_PATH;
  } catch {
    return USER_RIGHTS_PATH;
  }
};

const parseSubmittedRights = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(entry => String(entry));
  return value ? [String(value)] : [];
};

export const registerToolRoutes = (app: Express) => {
  app.get(USER_RIGHTS_PATH, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const includeBlocked = req.query.includeBlocked === '1';
    const users = await searchVerifiedUsersWithRights(adminContext.dalInstance, query, {
      includeBlocked,
    });
    const statuses = await getExperiencedStatuses(adminContext.dalInstance, users.map(user => user.id));
    const rows = renderUserRightsRows(users, statuses, req);
    const includeBlockedChecked = includeBlocked ? ' checked' : '';
    const hasActiveFilter = Boolean(query || includeBlocked);
    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">${escapeHtml(req.t('userRights.description'))}</p>
    ${renderUserRightsStatus(req)}
    <form method="get" action="${USER_RIGHTS_PATH}" class="form-inline user-rights-search">
      <label>
        <span>${escapeHtml(req.t('userRights.search.label'))}</span>
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="${escapeHtml(req.t('userRights.search.placeholder'))}" />
      </label>
      <label class="user-rights-filter-checkbox">
        <input type="checkbox" name="includeBlocked" value="1"${includeBlockedChecked} />
        <span>${escapeHtml(req.t('userRights.search.includeBlocked'))}</span>
      </label>
      <button type="submit">${escapeHtml(req.t('userRights.search.submit'))}</button>
      ${hasActiveFilter ? `<a href="${USER_RIGHTS_PATH}">${escapeHtml(req.t('userRights.search.clear'))}</a>` : ''}
    </form>
    <div class="table-stack-mobile">
      <table class="token-table user-rights-table">
        <thead>
          <tr>
            <th>${escapeHtml(req.t('userRights.headers.user'))}</th>
            <th>${escapeHtml(req.t('userRights.headers.email'))}</th>
            <th>${escapeHtml(req.t('userRights.headers.currentRights'))}</th>
            <th>${escapeHtml(req.t('userRights.headers.edit'))}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
</div>`;

    renderToolLayout(res, req.t('userRights.title'), bodyHtml);
  });

  app.post(`${USER_RIGHTS_PATH}/:userId`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const redirectTo = getUserRightsRedirect(req.body.redirectTo);
    try {
      const result = await updateUserRightsBelowSiteAdmin(
        adminContext.dalInstance,
        req.params.userId,
        parseSubmittedRights(req.body.rights)
      );
      const granted = result.changes.filter(change => change.after).map(change => change.role);
      const revoked = result.changes.filter(change => !change.after).map(change => change.role);
      res.redirect(
        302,
        appendUserRightsStatus(redirectTo, {
          status: result.changes.length ? 'updated' : 'unchanged',
          user: result.user.displayName || result.user.username || result.user.email,
          granted,
          revoked,
        })
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error('Failed to update user rights:', error.message);
      }
      res.redirect(302, appendUserRightsStatus(redirectTo, { status: 'error' }));
    }
  });

  app.post(`${USER_RIGHTS_PATH}/:userId/experienced`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const redirectTo = getUserRightsRedirect(req.body.redirectTo);
    const submitted = req.body.override;
    const override = submitted === 'granted' || submitted === 'revoked' ? submitted : null;
    const reason = typeof req.body.reason === 'string' ? req.body.reason : '';
    try {
      const { userName } = await setExperiencedOverride(
        adminContext.dalInstance,
        { userId: req.params.userId, override, reason },
        adminContext.session.userId
      );
      res.redirect(302, appendUserRightsStatus(redirectTo, { status: 'experienced', user: userName }));
    } catch (error) {
      if (error instanceof Error) {
        console.error('Failed to update experienced status:', error.message);
      }
      res.redirect(302, appendUserRightsStatus(redirectTo, { status: 'error' }));
    }
  });

  app.get('/tool/recent-admin-actions', async (req, res) => {
    const adminContext = await requireWikiAdmin(req, res);
    if (!adminContext) return;

    const limit = parseRecentLimit(req.query.limit);
    const preferredLang = res.locals.locale;
    const events = await listRecentAdminEvents(adminContext.dalInstance, limit);
    const pageTargets = await loadAdminEventPageTargets(adminContext.dalInstance, events);
    const userIds = events
      .map(event => event.actorUserId)
      .filter((id): id is string => Boolean(id));
    const userMap = await fetchUserMap(adminContext.dalInstance, userIds);
    const eventsHtml = renderAdminEventList(events, pageTargets, userMap, preferredLang, req.t);
    const relatedHtml = await renderRecentRelatedTools('admin', req, adminContext.dalInstance);
    const bodyHtml = `<div class="tool-page">
  <p>${escapeHtml(req.t('adminActions.description'))}</p>
  ${relatedHtml}
  ${eventsHtml}
</div>`;
    renderToolLayout(res, req.t('page.recentChanges'), bodyHtml);
  });

  app.get('/tool/recent-changes', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);
    const preferredLang = res.locals.locale;

    const dalInstance = await initializePostgreSQL();
    const onlyReverts = req.query.only === 'reverts';
    const rawChanges = await getRecentWikiChanges(dalInstance, limit, { tag: onlyReverts ? REVERT_TAG : null });
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

    const relatedHtml = await renderRecentRelatedTools('changes', req, dalInstance);
    const revertFilterHtml = `<p class="recent-filter">${
      onlyReverts
        ? `${escapeHtml(req.t('revert.recent.onlyReverts'))} · <a href="/tool/recent-changes">${escapeHtml(req.t('revert.recent.all'))}</a>`
        : `<a href="/tool/recent-changes?only=reverts">${escapeHtml(req.t('revert.recent.showReverts'))}</a>`
    }</p>`;
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentChangesDescription')}</p>
  ${relatedHtml}
  ${revertFilterHtml}
  <ul class="change-list change-list--compact">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.recentChanges')),
      labelHtml,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
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

    const relatedHtml = await renderRecentRelatedTools('citations', req, dalInstance);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentCitationsDescription')}</p>
  ${relatedHtml}
  <ul class="change-list change-list--compact">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.recentChanges')),
      labelHtml,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
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
    const relatedHtml = await renderRecentRelatedTools('claims', req, dalInstance);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentClaimsDescription')}</p>
  ${relatedHtml}
  <ul class="change-list change-list--compact">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.recentChanges')),
      labelHtml,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
  });

  app.get('/tool/recent-media', async (req, res) => {
    const limit = parseRecentLimit(req.query.limit);
    const view = req.query.view === 'list' ? 'list' : 'grid';
    const preferredLang = res.locals.locale;

    const dalInstance = await initializePostgreSQL();
    const rawChanges = await getRecentMediaChanges(dalInstance, limit);
    const changes = rawChanges.map(change => ({
      ...change,
      revSummary: resolvePreferredText(change.revSummary, preferredLang),
    }));
    const userIds = changes
      .map(change => change.revUser)
      .filter((id): id is string => Boolean(id));
    const userMap = await fetchUserMap(dalInstance, userIds);

    const viewToggleHtml = renderRecentMediaViewToggle(view, req.t);

    let listingHtml: string;
    if (view === 'grid') {
      listingHtml = renderRecentMediaGrid(changes, userMap, req.t);
    } else {
      const items: RecentListItem[] = changes.map(change => {
        const encodedSlug = encodeURIComponent(change.slug);
        const actions: RecentListAction[] = [
          { label: req.t('tool.view'), href: `/media/${encodedSlug}?rev=${change.revId}` },
        ];
        if (change.prevRevId) {
          actions.push({
            label: req.t('tool.diff'),
            href: `/media/${encodedSlug}?diffFrom=${change.prevRevId}&diffTo=${change.revId}`,
          });
        }
        return {
          primaryLabel: formatMediaLabel(change.slug, change.commonsTitle),
          primaryHref: `/media/${encodedSlug}`,
          dateLabel: formatDateUTC(change.revDate),
          summary: change.revSummary,
          revUser: change.revUser,
          revTags: change.revTags,
          actions,
        };
      });
      listingHtml = `<ul class="change-list change-list--compact">${renderRecentList(items, userMap, req.t)}</ul>`;
    }

    const relatedHtml = await renderRecentRelatedTools('media', req, dalInstance);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentMediaDescription')}</p>
  ${relatedHtml}
  ${viewToggleHtml}
  ${listingHtml}
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.recentChanges')),
      labelHtml,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
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

    const relatedHtml = await renderRecentRelatedTools('checks', req, dalInstance);
    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.recentChecksDescription')}</p>
  ${relatedHtml}
  <ul class="change-list change-list--compact">${itemsHtml}</ul>
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.recentChanges')),
      labelHtml,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
  });

  app.get('/tool/pages', async (req, res) => {
    const per = parseIntegerQuery(req.query.per, { fallback: 50, min: 1, max: 200 });
    // Keeps the offset a safe integer, which limit()/offset() require.
    const page = parseIntegerQuery(req.query.page, {
      fallback: 1,
      min: 1,
      max: Math.floor(Number.MAX_SAFE_INTEGER / per),
    });
    const offset = (page - 1) * per;
    // Newest first is where the home page's "See more new articles" leads.
    const sortNew = req.query.sort === 'new';
    const sortParam = sortNew ? '&sort=new' : '';

    const { notLike } = WikiPage.ops;

    const total = await WikiPage.filterWhere({ slug: notLike('meta/%') })
      .and({ slug: notLike('tool/%') })
      .count();

    const pageResults = await WikiPage.filterWhere({ slug: notLike('meta/%') })
      .and({ slug: notLike('tool/%') })
      .orderBy(sortNew ? 'createdAt' : 'slug', sortNew ? 'DESC' : 'ASC')
      .limit(per)
      .offset(offset)
      .run();

    const pages = pageResults.map(p => ({
      slug: p.slug,
      title: resolveSafeTextWithFallback(mlString.resolve, 'en', p.title, p.slug),
      createdAt: p.createdAt,
    }));

    const totalPages = Math.max(Math.ceil(total / per), 1);
    const prevLink =
      page > 1 ? `/tool/pages?page=${page - 1}&per=${per}${sortParam}` : '';
    const nextLink =
      page < totalPages ? `/tool/pages?page=${page + 1}&per=${per}${sortParam}` : '';

    const listItems = pages
      .map(
        item =>
          `<li><a href="/${escapeHtml(item.slug)}" data-wiki-link="true" data-wiki-link-slug="${escapeHtml(item.slug)}">${renderText(item.title)}</a>${
            sortNew && item.createdAt
              ? ` <span class="pages-created">${escapeHtml(
                  item.createdAt.toLocaleDateString(res.locals.locale ?? 'en', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })
                )}</span>`
              : ''
          }</li>`
      )
      .join('');

    const pagination = `<div class="history-actions">
  ${prevLink ? `<a href="${prevLink}">${req.t('tool.previous')}</a>` : ''}
  <span>${req.t('tool.pagination', { page, totalPages })}</span>
  ${nextLink ? `<a href="${nextLink}">${req.t('tool.next')}</a>` : ''}
</div>`;

    const bodyHtml = `<div class="tool-page">
  <p>${req.t('tool.pagesDescription', { total })}</p>
  <p class="pages-sort">${escapeHtml(req.t('tool.pagesSort'))} ${
    sortNew
      ? `<a href="/tool/pages?per=${per}">${escapeHtml(req.t('tool.pagesSortTitle'))}</a> · <strong aria-current="true">${escapeHtml(req.t('tool.pagesSortNew'))}</strong>`
      : `<strong aria-current="true">${escapeHtml(req.t('tool.pagesSortTitle'))}</strong> · <a href="/tool/pages?per=${per}&amp;sort=new">${escapeHtml(req.t('tool.pagesSortNew'))}</a>`
  }</p>
  ${pagination}
  <ul class="change-list">${listItems}</ul>
  ${pagination}
</div>`;
    const labelHtml = `<div class="page-label">${req.t('label.tool')}</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.pages')),
      labelHtml,
      bodyHtml,
      topHtml: prependAccountBanner(res),
      wikiLinkPreviewConfig: {
        endpoint: WIKI_LINK_PREVIEW_ENDPOINT,
        token: createWikiLinkPreviewToken({
          pagePath: req.path,
          locale: res.locals.locale,
        }),
      },
    });
  });

  app.get('/tool/proposals', async (req, res) => {
    const dalInstance = await initializePostgreSQL();
    const proposals = await listProposalPages(dalInstance);
    const lang = (res.locals.locale as string | undefined) ?? 'en';
    const sections = PROPOSAL_LIST_ORDER.map(status => {
      const items = proposals.filter(item => item.status === status);
      if (!items.length) return '';
      const label = status ? req.t(`proposalStatus.status.${status}`) : req.t('proposalStatus.noStatus');
      const badge = `proposal-status-badge proposal-status--${status ?? 'none'}`;
      const listItems = items
        .map(item => {
          const title = resolveSafeTextWithFallback(mlString.resolve, lang, item.title, item.slug);
          return `<li><a href="/${escapeHtml(item.slug)}">${renderText(title)}</a>${
            item.updatedAt ? ` <span class="proposal-list-date">${escapeHtml(formatDateUTC(item.updatedAt))}</span>` : ''
          }</li>`;
        })
        .join('');
      return `<section class="proposal-list-group">
  <h2><span class="${badge}">${escapeHtml(label)}</span> <span class="proposal-list-count">${items.length}</span></h2>
  <ul class="change-list">${listItems}</ul>
</section>`;
    }).join('');
    const bodyHtml = `<div class="tool-page">
  <p>${escapeHtml(req.t('tool.proposalsDescription', { count: proposals.length }))}</p>
  ${sections}
</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.proposals')),
      labelHtml: `<div class="page-label">${req.t('label.tool')}</div>`,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
  });

  // The Wikidata list became one kind of the Articles with issues page.
  app.get('/tool/missing-wikidata', (_req, res) => {
    res.redirect(301, `${ISSUES_PATH}?kind=no-wikidata`);
  });

  // Where the Edit tab leads people who cannot edit the page directly yet.
  app.get(HOW_TO_EDIT_PATH, async (req, res) => {
    const slug = typeof req.query.page === 'string' ? req.query.page : '';
    const dalInstance = await initializePostgreSQL();
    const page = slug
      ? await readWikiPage(dalInstance, slug).catch(error => {
          if (error instanceof NotFoundError) return null;
          throw error;
        })
      : null;
    if (!page) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }
    const session = await resolveSessionUser(req);
    const editability = await getWikiPageEditability(dalInstance, { id: page.id }, session?.userId ?? null);
    const pageHref = `/${encodeURIComponent(page.slug)}`;
    const editHref = `${pageHref}/operator-edit`;
    const title = resolveSafeTextWithFallback(mlString.resolve, res.locals.locale ?? 'en', page.title, page.slug);
    const titleLinkHtml = `<a href="${escapeHtml(pageHref)}">${renderText(title)}</a>`;
    const discussHref = page.slug.startsWith('meta/')
      ? forumCategoryPagePath('policy', page.slug)
      : page.slug.startsWith('tool/')
        ? ''
        : forumCategoryPagePath('articles', page.slug);
    const accountState = res.locals.accountState as { agentAccessStatus?: string } | null | undefined;

    const stepsHtml = (() => {
      if (editability.isProtected && !editability.isEditable) {
        const discussHtml = discussHref
          ? ` <a href="${escapeHtml(discussHref)}">${escapeHtml(req.t('pageTabs.discuss'))}</a>`
          : '';
        return `<p class="how-to-edit-protected">${escapeHtml(req.t('howToEdit.protected'))}${discussHtml}</p>`;
      }
      const loginHref = `/tool/login?redirect=${encodeURIComponent(editHref)}`;
      const steps = [
        session
          ? ''
          : req.t('howToEdit.account', {
              createLink: `<a href="/tool/create-account">${escapeHtml(req.t('howToEdit.createAccount'))}</a>`,
              loginLink: `<a href="${escapeHtml(loginHref)}">${escapeHtml(req.t('howToEdit.logIn'))}</a>`,
            }),
        accountState?.agentAccessStatus === 'approved' ? '' : escapeHtml(req.t('howToEdit.approval')),
        `${escapeHtml(req.t('howToEdit.agent'))} <a href="/meta/help">${escapeHtml(req.t('howToEdit.helpLink'))}</a>`,
        `${escapeHtml(req.t('howToEdit.quickFix'))} <a href="${escapeHtml(session ? editHref : loginHref)}">${escapeHtml(
          req.t('pageTabs.edit')
        )}</a>`,
      ].filter(Boolean);
      return `<ol class="how-to-edit-steps">${steps.map(step => `<li>${step}</li>`).join('')}</ol>`;
    })();

    res.render('layout', {
      title: prepareTitle(req.t('howToEdit.title')),
      labelHtml: `<div class="page-label">${req.t('label.tool')}</div>`,
      bodyHtml: `<div class="tool-page how-to-edit">
  <p>${req.t('howToEdit.intro', { title: titleLinkHtml })}</p>
  ${stepsHtml}
  <p><a href="${escapeHtml(pageHref)}">${escapeHtml(req.t('howToEdit.backToPage'))}</a></p>
</div>`,
      topHtml: prependAccountBanner(res),
    });
  });

  app.get(ISSUES_PATH, async (req, res) => {
    const dalInstance = await initializePostgreSQL();
    const kind: ArticleIssueKind = isArticleIssueKind(req.query.kind) ? req.query.kind : 'unchecked';
    const checkType = kind === 'check-issues' && isPageCheckType(req.query.check) ? req.query.check : null;
    const per = 100;
    const pageNumber = parseIntegerQuery(req.query.page, { fallback: 1, min: 1, max: 10_000 });
    const [counts, list] = await Promise.all([
      countArticlesWithIssues(dalInstance),
      listArticlesWithIssues(dalInstance, { kind, checkType, limit: per, offset: (pageNumber - 1) * per }),
    ]);
    const kindLabel = (k: ArticleIssueKind) => req.t(`issues.kind.${k}`);
    const kindHref = (k: ArticleIssueKind) => `${ISSUES_PATH}?kind=${k}`;
    const kindsHtml = `<nav class="issue-kinds" aria-label="${escapeHtml(req.t('issues.kindLabel'))}">${ARTICLE_ISSUE_KINDS.map(
      k =>
        `<a class="issue-kind${k === kind ? ' issue-kind--current' : ''}" href="${kindHref(k)}"${
          k === kind ? ' aria-current="page"' : ''
        }>${escapeHtml(kindLabel(k))} <span class="issue-kind-count">${counts[k]}</span></a>`
    ).join('')}</nav>`;
    const checkFilterHtml =
      kind === 'check-issues'
        ? `<p class="issue-check-filter">${escapeHtml(req.t('issues.checkFilter'))} ${[
            `<a href="${kindHref(kind)}"${checkType ? '' : ' aria-current="page"'}>${escapeHtml(req.t('issues.allChecks'))}</a>`,
            ...PAGE_CHECK_TYPES.map(
              type =>
                `<a href="${kindHref(kind)}&amp;check=${type}"${type === checkType ? ' aria-current="page"' : ''}>${escapeHtml(
                  formatCheckType(type, req.t)
                )}</a>`
            ),
          ].join(' · ')}</p>`
        : '';
    const itemsHtml = list.articles
      .map(article => {
        const title = resolveSafeTextWithFallback(mlString.resolve, res.locals.locale ?? 'en', article.title, article.slug);
        const checks = article.checks?.length
          ? ` <span class="issue-checks">${article.checks
              .map(
                check =>
                  `<a href="/${encodeURIComponent(article.slug)}/checks/${encodeURIComponent(check.id)}">${escapeHtml(
                    formatCheckType(check.type, req.t)
                  )}</a> (${escapeHtml(req.t('warning.unresolvedIssues', { count: check.unresolved }))})`
              )
              .join(', ')}</span>`
          : '';
        return `<li><a href="/${escapeHtml(article.slug)}" data-wiki-link="true" data-wiki-link-slug="${escapeHtml(article.slug)}">${renderText(title)}</a>${checks}</li>`;
      })
      .join('');
    const totalPages = Math.max(Math.ceil(list.total / per), 1);
    const pageHref = (n: number) =>
      `${kindHref(kind)}${checkType ? `&amp;check=${checkType}` : ''}&amp;page=${n}`;
    const paginationHtml =
      totalPages > 1
        ? `<div class="history-actions">
  ${pageNumber > 1 ? `<a href="${pageHref(pageNumber - 1)}">${req.t('tool.previous')}</a>` : ''}
  <span>${req.t('tool.pagination', { page: pageNumber, totalPages })}</span>
  ${pageNumber < totalPages ? `<a href="${pageHref(pageNumber + 1)}">${req.t('tool.next')}</a>` : ''}
</div>`
        : '';
    const bodyHtml = `<div class="tool-page">
  <p>${escapeHtml(req.t('issues.description'))}</p>
  ${kindsHtml}
  ${checkFilterHtml}
  <h2 class="issue-list-heading">${escapeHtml(kindLabel(kind))} <span class="issue-kind-count">(${list.total})</span></h2>
  ${itemsHtml ? `<ul class="change-list">${itemsHtml}</ul>` : `<p>${escapeHtml(req.t('issues.empty'))}</p>`}
  ${paginationHtml}
</div>`;
    res.render('layout', {
      title: prepareTitle(req.t('page.articlesWithIssues')),
      labelHtml: `<div class="page-label">${req.t('label.tool')}</div>`,
      bodyHtml,
      topHtml: prependAccountBanner(res),
    });
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
