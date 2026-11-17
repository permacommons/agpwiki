import type { Express } from 'express';
import languages from '../../locales/languages.js';
import { HOME_PAGE_SLUG } from '../services/home-service.js';

export const registerLocaleRoutes = (app: Express) => {
  app.post('/set-locale', (req, res) => {
    const locale = req.body?.locale;
    const referer = req.get('Referer');

    if (typeof locale === 'string' && languages.isValid(locale)) {
      res.cookie('locale', locale, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
      });
      const returnUrl = referer ? URL.parse(referer, 'http://localhost') : null;
      if (
        returnUrl?.pathname === `/${HOME_PAGE_SLUG}` &&
        !['rev', 'diffFrom', 'diffTo', 'format'].some(key => returnUrl.searchParams.has(key)) &&
        returnUrl.searchParams.has('lang')
      ) {
        returnUrl.searchParams.delete('lang');
        res.redirect(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`);
        return;
      }
    }

    res.redirect(referer ?? '/');
  });
};
