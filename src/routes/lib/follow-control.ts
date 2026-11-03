import type { TFunction } from 'i18next';
import { escapeHtml } from '../../render.js';

interface FollowControlParams {
  action: string;
  following: boolean;
  fields: Record<string, string>;
  tab?: boolean;
  help?: string;
  t: TFunction;
}

export const renderFollowControl = ({ action, following, fields, tab = false, help, t }: FollowControlParams) => {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" fill="${following ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>`;
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join('');
  return `<form class="follow-control-form" method="post" action="${escapeHtml(action)}">
  ${inputs}
  <button type="submit" class="follow-control${tab ? ' page-tab' : ''}" aria-pressed="${following}"${help ? ` title="${escapeHtml(help)}"` : ''}>
    <span class="follow-control-icon" aria-hidden="true">${icon}</span>
    <span class="follow-control-label">${escapeHtml(t(following ? 'followControl.unfollow' : 'followControl.follow'))}</span>
  </button>
</form>`;
};
