import type { Express, Request, Response } from 'express';

import { resolveSessionUser } from '../auth/session.js';
import User from '../models/user.js';
import { prepareTitle } from '../render.js';
import { prependAccountBanner } from './lib/account-banner.js';

const SETTINGS_PATH = '/tool/settings';

const renderSettingsLayout = (res: Response, title: string, bodyHtml: string) => {
  res.render('layout', {
    title: prepareTitle(title),
    labelHtml: `<div class="page-label">${res.req.t('label.tool')}</div>`,
    bodyHtml,
    topHtml: prependAccountBanner(res),
  });
};

const renderSettingsPage = (
  req: Request,
  res: Response,
  options: { saved?: boolean; enabled?: boolean } = {}
) => {
  const checked = options.enabled === false ? '' : ' checked';
  const savedHtml = options.saved
    ? `<div class="form-help">${req.t('settings.saved')}</div>`
    : '';
  const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${savedHtml}
    <div class="settings-option">
      <label class="settings-checkbox">
        <input type="checkbox" name="emailNotificationsEnabled" value="1"${checked} />
        <span>${req.t('settings.emailNotifications')}</span>
      </label>
      <p class="form-help settings-option-help">${req.t('settings.description')}</p>
    </div>
    <div class="form-actions">
      <button type="submit">${req.t('settings.save')}</button>
    </div>
  </form>
</div>`;
  renderSettingsLayout(res, req.t('settings.title'), bodyHtml);
};

const requireSignedInUser = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, `/tool/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`);
    return null;
  }

  const user = await User.filterWhere({ id: session.userId }).first();
  if (!user) {
    res.redirect(302, `/tool/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`);
    return null;
  }

  return user;
};

export const registerSettingsRoutes = (app: Express) => {
  app.get(SETTINGS_PATH, async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;
    renderSettingsPage(req, res, {
      saved: req.query.saved === '1',
      enabled: user.emailNotificationsEnabled !== false,
    });
  });

  app.post(SETTINGS_PATH, async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;
    user.emailNotificationsEnabled = req.body?.emailNotificationsEnabled === '1';
    await user.save();
    res.redirect(302, `${SETTINGS_PATH}?saved=1`);
  });
};
