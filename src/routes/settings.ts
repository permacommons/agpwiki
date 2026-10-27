import type { Express, Request, Response } from 'express';
import dal from 'rev-dal';

import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import {
  isNotificationChannel,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKind,
  readNotificationChannel,
} from '../lib/notification-preferences.js';
import { resolveSafeTextWithFallback } from '../lib/safe-text.js';
import User from '../models/user.js';
import { escapeHtml, prepareTitle, renderText } from '../render.js';
import { type FollowedPage, listFollowedPages } from '../services/page-subscription-service.js';
import { FOLLOW_PATH } from './follow.js';
import { prependAccountBanner } from './lib/account-banner.js';

const { mlString } = dal;

const SETTINGS_PATH = '/tool/settings';

const renderSettingsLayout = (res: Response, title: string, bodyHtml: string) => {
  res.render('layout', {
    title: prepareTitle(title),
    labelHtml: `<div class="page-label">${res.req.t('label.tool')}</div>`,
    bodyHtml,
    topHtml: prependAccountBanner(res),
  });
};

// Translation keys use the kind with dots replaced, e.g. forum.reply -> forumReply.
const kindKey = (kind: NotificationKind) => kind.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase());

const renderSettingsPage = (
  req: Request,
  res: Response,
  options: {
    saved?: boolean;
    channels: Record<NotificationKind, NotificationChannel>;
    emailVerified: boolean;
    followedPages: FollowedPage[];
  }
) => {
  const savedHtml = options.saved
    ? `<div class="form-help">${req.t('settings.saved')}</div>`
    : '';
  const kindsHtml = NOTIFICATION_KINDS.map(kind => {
    const key = kindKey(kind);
    const choices = NOTIFICATION_CHANNELS.map(
      channel => `<label class="settings-radio">
        <input type="radio" name="notify.${kind}" value="${channel}"${options.channels[kind] === channel ? ' checked' : ''} />
        <span>${escapeHtml(req.t(`settings.notifications.channel.${channel}`))}</span>
      </label>`
    ).join('');
    return `<fieldset class="settings-option settings-notification-kind">
      <legend>${escapeHtml(req.t(`settings.notifications.kind.${key}.label`))}</legend>
      <p class="form-help settings-option-help">${escapeHtml(req.t(`settings.notifications.kind.${key}.help`))}</p>
      <div class="settings-radio-group">${choices}</div>
    </fieldset>`;
  }).join('');
  const locale = (res.locals.locale as string | undefined) ?? 'en';
  const followedHtml = options.followedPages.length
    ? `<ul class="settings-followed">${options.followedPages
        .map(page => {
          const title = resolveSafeTextWithFallback(mlString.resolve, locale, page.title, page.slug);
          return `<li><a href="/${page.slug.split('/').map(encodeURIComponent).join('/')}">${renderText(title)}</a>
        <form method="post" action="${FOLLOW_PATH}">
          <input type="hidden" name="page" value="${escapeHtml(page.slug)}" />
          <input type="hidden" name="action" value="unfollow" />
          <input type="hidden" name="return" value="${SETTINGS_PATH}#following" />
          <button type="submit" class="settings-unfollow">${escapeHtml(req.t('following.unfollow'))}</button>
        </form></li>`;
        })
        .join('')}</ul>`
    : `<p class="form-help">${escapeHtml(req.t('following.empty'))}</p>`;
  const unverifiedHtml = options.emailVerified
    ? ''
    : `<p class="form-help">${escapeHtml(req.t('settings.notifications.emailUnverified'))}</p>`;
  const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${savedHtml}
    <h2 class="settings-heading">${escapeHtml(req.t('settings.notifications.heading'))}</h2>
    <p class="form-help">${escapeHtml(req.t('settings.notifications.intro'))}</p>
    ${unverifiedHtml}
    ${kindsHtml}
    <p class="settings-links"><a href="/tool/notifications">${escapeHtml(req.t('notifications.title'))}</a></p>
    <div class="form-actions">
      <button type="submit">${req.t('settings.save')}</button>
    </div>
  </form>
  <section class="form-card settings-following" id="following">
    <h2 class="settings-heading">${escapeHtml(req.t('following.heading'))}</h2>
    <p class="form-help">${escapeHtml(req.t('following.intro'))}</p>
    ${followedHtml}
  </section>
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
    const channels = Object.fromEntries(
      NOTIFICATION_KINDS.map(kind => [kind, readNotificationChannel(user.notificationPreferences, kind)])
    ) as Record<NotificationKind, NotificationChannel>;
    renderSettingsPage(req, res, {
      saved: req.query.saved === '1',
      channels,
      emailVerified: Boolean(user.emailVerifiedAt),
      followedPages: await listFollowedPages(await initializePostgreSQL(), user.id),
    });
  });

  app.post(SETTINGS_PATH, async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;
    const preferences = { ...((user.notificationPreferences as Record<string, unknown> | null) ?? {}) };
    for (const kind of NOTIFICATION_KINDS) {
      const value = req.body?.[`notify.${kind}`];
      if (isNotificationChannel(value)) preferences[kind] = value;
    }
    user.notificationPreferences = preferences;
    await user.save();
    res.redirect(302, `${SETTINGS_PATH}?saved=1`);
  });
};
