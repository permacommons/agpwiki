import type { Express } from 'express';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { suggestMentionUsernames } from '../services/mention-service.js';

export const MENTION_SUGGEST_PATH = '/tool/mentions/suggest';

export const registerMentionRoutes = (app: Express) => {
  // Usernames for the suggestions shown after typing @ in a comment box.
  // Signed-in people only: only they can post.
  app.get(MENTION_SUGGEST_PATH, async (req, res) => {
    const session = await resolveSessionUser(req);
    if (!session) {
      res.status(401).json({ users: [] });
      return;
    }
    const typed = typeof req.query.q === 'string' ? req.query.q.slice(0, 128) : '';
    const users = await suggestMentionUsernames(await initializePostgreSQL(), typed);
    res.set('Cache-Control', 'private, no-store').json({ users });
  });
};
