import type { Request, Response } from 'express';

import { escapeHtml } from '../../render.js';

const DISMISS_BANNER_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export const renderDismissableBanner = ({
  req,
  cookieName,
  unsafeBodyHtml,
  dismissPath,
  dismissLabel,
  className = 'dismissable-banner',
}: {
  req: Request;
  cookieName: string;
  unsafeBodyHtml: string;
  dismissPath: string;
  dismissLabel: string;
  className?: string;
}) => {
  if (req.cookies?.[cookieName] === '1') {
    return '';
  }

  return `<div class="${escapeHtml(className)}">
  <div class="dismissable-banner-body">${unsafeBodyHtml}</div>
  <form method="post" action="${escapeHtml(dismissPath)}" class="dismissable-banner-form">
    <button type="submit">${escapeHtml(dismissLabel)}</button>
  </form>
</div>`;
};

export const dismissBanner = ({
  res,
  cookieName,
  redirectTo,
}: {
  res: Response;
  cookieName: string;
  redirectTo: string;
}) => {
  res.cookie(cookieName, '1', {
    maxAge: DISMISS_BANNER_MAX_AGE_MS,
    httpOnly: true,
    sameSite: 'lax',
  });
  res.redirect(redirectTo);
};
