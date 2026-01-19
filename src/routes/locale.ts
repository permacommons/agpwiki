import type { Express } from 'express';
import languages from '../../locales/languages.js';

export const registerLocaleRoutes = (app: Express) => {
  app.post('/set-locale', (req, res) => {
    const locale = req.body?.locale;

    if (typeof locale === 'string' && languages.isValid(locale)) {
      res.cookie('locale', locale, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
      });
    }

    const referer = req.get('Referer');
    res.redirect(referer ?? '/');
  });
};
