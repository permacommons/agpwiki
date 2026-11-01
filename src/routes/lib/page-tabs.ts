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
  t: TFunction;
}

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
  t,
}: PageTabsParams): string => {
  const left = [
    tab(pageHref, t(isArticle ? 'pageTabs.article' : 'pageTabs.page'), { current: isCurrentView }),
    discussHref
      ? tab(discussHref, t('pageTabs.discuss'), {
          countHtml: discussCount > 0 ? ` <span class="page-tab-count">${discussCount}</span>` : '',
        })
      : '',
  ];
  const right = [
    isCurrentView ? tab(editHref, t('pageTabs.edit'), { className: 'page-tab--edit' }) : '',
    tab(`#${HISTORY_ANCHOR}`, t('pageTabs.history')),
  ];
  return `<nav class="page-tabs" aria-label="${escapeHtml(t('pageTabs.label'))}">${left.join('')}<span class="page-tabs-spacer"></span>${right.join('')}</nav>`;
};
