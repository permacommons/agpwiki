import type { Express } from 'express';

import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { normalizeSlug } from '../lib/slug.js';
import { findCurrentPageIdBySlug, followPage, unfollowPage } from '../services/page-subscription-service.js';
import { safeReturnPath } from './lib/notifications.js';

export const FOLLOW_PATH = '/tool/follow';

export const registerFollowRoutes = (app: Express) => {
  // Follow or stop following the comments on a page. A plain form post, so
  // it works without JavaScript; it returns to where the button was.
  app.post(FOLLOW_PATH, async (req, res) => {
    const returnTo = safeReturnPath(req.body?.return);
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(returnTo)}`);
      return;
    }
    const slug = typeof req.body?.page === 'string' ? normalizeSlug(req.body.page) : '';
    const dal = await initializePostgreSQL();
    const pageId = slug ? await findCurrentPageIdBySlug(dal, slug) : null;
    if (!pageId) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }
    if (req.body?.action === 'unfollow') {
      await unfollowPage(dal, pageId, session.userId);
    } else {
      await followPage(dal, pageId, session.userId);
    }
    res.redirect(303, returnTo);
  });
};
