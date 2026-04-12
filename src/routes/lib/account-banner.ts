import type { Request, Response } from 'express';

import { escapeHtml } from '../../render.js';
import {
  AGENT_ACCESS_GRANTED_NOTICE,
  AGENT_ACCESS_REJECTED_NOTICE,
} from '../../services/account-lifecycle.js';

const renderPersistentDismissableBanner = ({
  bodyHtml,
  noticeKey,
  dismissLabel,
  className = 'dismissable-banner',
}: {
  bodyHtml: string;
  noticeKey: string;
  dismissLabel: string;
  className?: string;
}) => `<div class="${escapeHtml(className)}">
  <div class="dismissable-banner-body">${bodyHtml}</div>
  <form method="post" action="/tool/account/dismiss-notice" class="dismissable-banner-form">
    <input type="hidden" name="noticeKey" value="${escapeHtml(noticeKey)}" />
    <button type="submit">${escapeHtml(dismissLabel)}</button>
  </form>
</div>`;

export const renderAccountBanner = (req: Request, res: Response) => {
  const currentPath =
    typeof res.locals.currentPath === 'string' ? res.locals.currentPath : req.originalUrl || '';
  const currentUrl = new URL(`http://local${currentPath || '/'}`);
  const emailUnavailable =
    currentUrl.searchParams.get('email') === 'unavailable';
  if (currentPath.startsWith('/tool/complete-profile')) {
    return '';
  }

  const accountState = res.locals.accountState as
    | {
        isEmailVerified: boolean;
        agentAccessStatus: 'none' | 'pending' | 'approved' | 'rejected';
        dismissedNoticeKeys: Set<string>;
        agentAccessRequest?: { rejectionReason?: string | null } | null;
      }
    | null
    | undefined;

  if (!accountState) return '';

  if (!accountState.isEmailVerified) {
    const redirectTo = escapeHtml(currentPath || '/');
    const warningHtml = emailUnavailable
      ? `<div class="form-error">${escapeHtml(req.t('account.create.emailWarning'))}</div>`
      : '';
    return `<div class="dismissable-banner account-banner account-banner-warning">
  <div class="dismissable-banner-body">
    <div class="account-banner-stack">
      <div class="account-banner-copy">
        <div>${req.t('account.banner.verifyEmail')}</div>
        ${warningHtml}
      </div>
      <form method="post" action="/tool/resend-confirmation-email" class="dismissable-banner-form">
        <input type="hidden" name="redirectTo" value="${redirectTo}" />
        <button type="submit">${escapeHtml(req.t('account.banner.resendEmail'))}</button>
      </form>
    </div>
  </div>
</div>`;
  }

  if (accountState.agentAccessStatus === 'none') {
    return `<div class="dismissable-banner account-banner">
  <div class="dismissable-banner-body">${req.t('account.banner.completeProfile', {
    completeProfileHref: '/tool/complete-profile',
  })}</div>
</div>`;
  }

  if (accountState.agentAccessStatus === 'pending') {
    return `<div class="dismissable-banner account-banner">
  <div class="dismissable-banner-body">${req.t('account.banner.pendingApproval')}</div>
</div>`;
  }

  if (
    accountState.agentAccessStatus === 'approved'
    && !accountState.dismissedNoticeKeys.has(AGENT_ACCESS_GRANTED_NOTICE)
  ) {
    return renderPersistentDismissableBanner({
      bodyHtml: req.t('account.banner.approved', {
        helpHref: '/meta/help',
      }),
      noticeKey: AGENT_ACCESS_GRANTED_NOTICE,
      dismissLabel: req.t('common.dismiss'),
      className: 'dismissable-banner account-banner account-banner-success',
    });
  }

  if (
    accountState.agentAccessStatus === 'rejected'
    && !accountState.dismissedNoticeKeys.has(AGENT_ACCESS_REJECTED_NOTICE)
  ) {
    const rejectionReason = accountState.agentAccessRequest?.rejectionReason
      ? `<div class="form-hint">${escapeHtml(accountState.agentAccessRequest.rejectionReason)}</div>`
      : '';
    return renderPersistentDismissableBanner({
      bodyHtml: `${req.t('account.banner.rejected')}${rejectionReason}`,
      noticeKey: AGENT_ACCESS_REJECTED_NOTICE,
      dismissLabel: req.t('common.dismiss'),
      className: 'dismissable-banner account-banner account-banner-warning',
    });
  }

  return '';
};

export const prependAccountBanner = (res: Response, topHtml = '') => {
  const accountBannerHtml =
    typeof res.locals.accountBannerHtml === 'string' ? res.locals.accountBannerHtml : '';
  return `${accountBannerHtml}${topHtml}`;
};
