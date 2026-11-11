import type { TFunction } from 'i18next';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { discussionPath } from '../../lib/discussion-paths.js';
import { profilePath, profileSlug } from '../../lib/profile-paths.js';
import { escapeHtml } from '../../render.js';
import { countPageDiscussionComments } from '../../services/discussion-service.js';
import {
  type AccountSummary,
  canEditProfile,
  loadAccountSummary,
  type ProfileOwner,
} from '../../services/profile-service.js';
import { VALID_ROLES } from '../../services/roles.js';
import { HISTORY_ANCHOR } from './history.js';
import { renderPageTabs } from './page-tabs.js';

export const renderProfileLabel = (t: TFunction) =>
  `<div class="page-label-row"><div class="page-label">${escapeHtml(t('profile.label'))}</div></div>`;

export const profileTalkPath = (username: string) => discussionPath({ kind: 'page', slug: profileSlug(username) });

const formatMonth = (date: Date | null, locale: string) => {
  if (!date) return '';
  try {
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
  } catch {
    return date.toLocaleDateString('en', { year: 'numeric', month: 'long', timeZone: 'UTC' });
  }
};

const formatCount = (value: number, locale: string) => {
  try {
    return value.toLocaleString(locale);
  } catch {
    return String(value);
  }
};

/** The box beside a profile: the account and what it has done, computed from the site's own records. */
export const renderAccountBox = (
  owner: ProfileOwner,
  summary: AccountSummary,
  { t, locale }: { t: TFunction; locale: string }
) => {
  const row = (label: string, valueHtml: string) =>
    `<div class="profile-account-row"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
  const roles = VALID_ROLES.filter(role => summary.roles.includes(role)).map(role =>
    t(`userRights.roles.${role}.label`)
  );
  const rows = [
    row(t('profile.account.username'), escapeHtml(owner.username)),
    owner.displayName !== owner.username ? row(t('profile.account.displayName'), escapeHtml(owner.displayName)) : '',
    owner.createdAt ? row(t('profile.account.activeSince'), escapeHtml(formatMonth(owner.createdAt, locale))) : '',
    row(t('profile.account.edits'), escapeHtml(formatCount(summary.edits.total, locale))),
    row(t('profile.account.pagesCreated'), escapeHtml(formatCount(summary.pagesCreated, locale))),
    row(t('profile.account.comments'), escapeHtml(formatCount(summary.comments, locale))),
    roles.length ? row(t('profile.account.roles'), escapeHtml(roles.join(', '))) : '',
  ].join('');
  const breakdown = [
    [t('recentTabs.pages'), summary.edits.pages],
    [t('recentTabs.citations'), summary.edits.citations],
    [t('recentTabs.claims'), summary.edits.claims],
    [t('recentTabs.checks'), summary.edits.checks],
  ]
    .map(([label, count]) => `${escapeHtml(String(label))}: ${escapeHtml(formatCount(Number(count), locale))}`)
    .join(' · ');
  return `<section class="profile-account" aria-labelledby="profile-account-title">
  <h2 id="profile-account-title">${escapeHtml(t('profile.account.title'))}</h2>
  <dl class="profile-account-list">${rows}</dl>
  <p class="profile-account-breakdown">${escapeHtml(t('profile.account.editsBreakdown'))} ${breakdown}</p>
</section>`;
};

export interface ProfileContext {
  owner: ProfileOwner;
  canEdit: boolean;
  talkCount: number;
  accountBoxHtml: string;
}

export const loadProfileContext = async (
  dalInstance: DataAccessLayer,
  owner: ProfileOwner,
  { viewerId, t, locale }: { viewerId: string | null; t: TFunction; locale: string }
): Promise<ProfileContext> => {
  const [summary, canEdit, talkCount] = await Promise.all([
    loadAccountSummary(dalInstance, owner.id),
    canEditProfile(dalInstance, owner, viewerId),
    countPageDiscussionComments(dalInstance, [profileSlug(owner.username)]),
  ]);
  return { owner, canEdit, talkCount, accountBoxHtml: renderAccountBox(owner, summary, { t, locale }) };
};

/** Profile and Talk on the left; Edit and History for the contributor's own text on the right. */
export const renderProfileTabs = (
  ctx: ProfileContext,
  {
    current,
    hasText,
    isCurrentView = true,
    t,
  }: { current: 'profile' | 'talk'; hasText: boolean; isCurrentView?: boolean; t: TFunction }
) => {
  const href = profilePath(ctx.owner.username);
  return renderPageTabs({
    isArticle: false,
    pageHref: href,
    pageLabel: t('profile.tabProfile'),
    isCurrentView,
    discussHref: profileTalkPath(ctx.owner.username),
    discussLabel: t('profile.tabTalk'),
    discussCount: ctx.talkCount,
    discussCurrent: current === 'talk',
    editHref: ctx.canEdit ? `${href}/operator-edit` : null,
    historyHref: hasText ? (current === 'profile' ? `#${HISTORY_ANCHOR}` : `${href}#${HISTORY_ANCHOR}`) : null,
    t,
  });
};

/** The profile of a contributor who has not written its text yet: the account box and the tabs. */
export const renderProfileWithoutText = (ctx: ProfileContext, { t, viewerId }: { t: TFunction; viewerId: string | null }) => {
  const own = viewerId === ctx.owner.id;
  const writeHtml = ctx.canEdit
    ? ` <a href="${escapeHtml(`${profilePath(ctx.owner.username)}/operator-edit`)}">${escapeHtml(t('profile.write'))}</a>`
    : '';
  return `<p class="profile-empty">${escapeHtml(
    own ? t('profile.emptyOwn') : t('profile.empty', { name: ctx.owner.displayName })
  )}${writeHtml}</p>`;
};
