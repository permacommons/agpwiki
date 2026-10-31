import type { Express, Request, Response } from 'express';

import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { NotFoundError } from '../lib/errors.js';
import { prepareTitle } from '../render.js';
import {
  countSiteNotifications,
  countUnreadNotifications,
  listSiteNotifications,
  markSiteNotificationsRead,
  openSiteNotification,
} from '../services/site-notification-service.js';
import { prependAccountBanner } from './lib/account-banner.js';
import {
  NOTIFICATIONS_PANEL_LIMIT,
  NOTIFICATIONS_PANEL_PATH,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_PATH,
  renderNotificationList,
  safeReturnPath,
  toNotificationPanelData,
} from './lib/notifications.js';

const requireSession = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || NOTIFICATIONS_PATH)}`);
    return null;
  }
  return session;
};

const wantsJson = (req: Request) => (req.get('accept') ?? '').includes('application/json');

export const registerNotificationRoutes = (app: Express) => {
  // The bell's panel loads its contents from here when it is opened.
  app.get(NOTIFICATIONS_PANEL_PATH, async (req, res) => {
    const session = await resolveSessionUser(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const dal = await initializePostgreSQL();
    const [unreadCount, notifications] = await Promise.all([
      countUnreadNotifications(dal, session.userId),
      listSiteNotifications(dal, session.userId, { limit: NOTIFICATIONS_PANEL_LIMIT }),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json(toNotificationPanelData(notifications, unreadCount, req.t));
  });

  app.get(NOTIFICATIONS_PATH, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const dal = await initializePostgreSQL();
    const perPage = 100;
    const [total, unreadCount] = await Promise.all([
      countSiteNotifications(dal, session.userId),
      countUnreadNotifications(dal, session.userId),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const requestedPage = typeof req.query.page === 'string' ? Number.parseInt(req.query.page, 10) : Number.NaN;
    const page = Number.isNaN(requestedPage) ? 1 : Math.min(Math.max(requestedPage, 1), totalPages);
    const notifications = await listSiteNotifications(dal, session.userId, {
      limit: perPage,
      offset: (page - 1) * perPage,
    });
    res.render('layout', {
      title: prepareTitle(req.t('notifications.title')),
      labelHtml: `<div class="page-label">${req.t('label.tool')}</div>`,
      bodyHtml: renderNotificationList({ notifications, unreadCount, page, totalPages, t: req.t }),
      topHtml: prependAccountBanner(res),
    });
  });

  // Opening a notification marks it as read and goes to what it is about.
  app.get(`${NOTIFICATIONS_PATH}/:id/open`, async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    try {
      const dal = await initializePostgreSQL();
      const url = await openSiteNotification(dal, session.userId, req.params.id);
      res.redirect(303, safeReturnPath(url));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }
      console.error('Failed to open notification:', error);
      res.status(500).type('text').send(req.t('page.serverError'));
    }
  });

  app.post(NOTIFICATIONS_READ_PATH, async (req, res) => {
    if (wantsJson(req) && !(await resolveSessionUser(req))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const session = await requireSession(req, res);
    if (!session) return;
    const id = typeof req.body?.id === 'string' && req.body.id ? req.body.id : undefined;
    const dal = await initializePostgreSQL();
    await markSiteNotificationsRead(dal, session.userId, id);
    if (wantsJson(req)) {
      res.json({ unreadCount: await countUnreadNotifications(dal, session.userId) });
      return;
    }
    res.redirect(303, safeReturnPath(req.body?.return));
  });
};
