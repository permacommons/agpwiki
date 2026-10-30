import type { TFunction } from 'i18next';
import { escapeHtml } from '../../render.js';
import { HISTORY_ANCHOR } from './history.js';

export interface PageTabsParams {
  isArticle: boolean;
  pageHref: string;
  // False when an old revision or a diff is shown: the page tab then
  // leads back to the current version and Edit is left out.
  isCurrentView: boolean;
  discussHref: string | null;
  discussCount: number;
  editHref: string;
  // Shown to signed-in readers: whether they follow the comments on the page.
  follow?: { slug: string; following: boolean; returnTo: string; action: string };
  t: TFunction;
}

// A form, not a link: following changes something, and it must work
// without JavaScript.
const followButton = ({ slug, following, returnTo, action }: NonNullable<PageTabsParams['follow']>, t: TFunction) =>
  `<form class="page-follow-form" method="post" action="${escapeHtml(action)}">
  <input type="hidden" name="page" value="${escapeHtml(slug)}" />
  <input type="hidden" name="return" value="${escapeHtml(returnTo)}" />
  <input type="hidden" name="action" value="${following ? 'unfollow' : 'follow'}" />
  <button type="submit" class="page-follow${following ? ' page-follow--on' : ''}" aria-pressed="${following ? 'true' : 'false'}" title="${escapeHtml(
    t(following ? 'pageTabs.followingHelp' : 'pageTabs.followHelp')
  )}"><span class="page-follow-label">${escapeHtml(t(following ? 'pageTabs.following' : 'pageTabs.follow'))}</span></button>
</form>`;

const tab = (href: string, label: string, options: { current?: boolean; className?: string; countHtml?: string } = {}) => {
  const classes = ['page-tab', options.className, options.current ? 'page-tab--current' : '']
    .filter(Boolean)
    .join(' ');
  const current = options.current ? ' aria-current="page"' : '';
  return `<a class="${classes}" href="${escapeHtml(href)}"${current}>${escapeHtml(label)}${options.countHtml ?? ''}</a>`;
};

export const renderPageTabs = ({
  isArticle,
  pageHref,
  isCurrentView,
  discussHref,
  discussCount,
  editHref,
  follow,
  t,
}: PageTabsParams): string => {
  const left = [
    tab(pageHref, t(isArticle ? 'pageTabs.article' : 'pageTabs.page'), { current: isCurrentView }),
    discussHref
      ? tab(discussHref, t('pageTabs.discuss'), {
          countHtml: discussCount > 0 ? ` <span class="page-tab-count">${discussCount}</span>` : '',
        })
      : '',
    follow ? followButton(follow, t) : '',
  ];
  const right = [
    isCurrentView ? tab(editHref, t('pageTabs.edit'), { className: 'page-tab--edit' }) : '',
    tab(`#${HISTORY_ANCHOR}`, t('pageTabs.history')),
  ];
  return `<nav class="page-tabs" aria-label="${escapeHtml(t('pageTabs.label'))}">${left.join('')}<span class="page-tabs-spacer"></span>${right.join('')}</nav>`;
};
