import path from 'node:path';
import config from 'config';
import cookieParser from 'cookie-parser';
import express from 'express';

import debug from '../util/debug.js';
import { initializePostgreSQL } from './db.js';
import { getLanguageOptions, i18next, middleware as i18nMiddleware, initializeI18n } from './i18n.js';
import { registerAccountRequestRoutes } from './routes/account-requests.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBlogRoutes } from './routes/blog.js';
import { registerCitationRoutes } from './routes/citations.js';
import { registerLocaleRoutes } from './routes/locale.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerToolRoutes } from './routes/tools.js';
import { getStaticCacheControl } from './static-cache.js';

const app = express();

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  '/static',
  (req, res, next) => {
    const version = req.query.v;
    const hasVersionQuery = typeof version === 'string' && version.length > 0;
    res.setHeader('Cache-Control', getStaticCacheControl(req.path, hasVersionQuery));
    next();
  },
  express.static(path.resolve(process.cwd(), 'public')),
);
app.use(i18nMiddleware.handle(i18next));
app.use((req, res, next) => {
  const locale = (req.language ?? 'en') as AgpWiki.LocaleCode;
  res.locals.locale = locale;
  res.locals.languageOptions = getLanguageOptions(locale);
  next();
});

registerLocaleRoutes(app);
registerSearchRoutes(app);
registerAuthRoutes(app);
registerOAuthRoutes(app);
registerToolRoutes(app);
registerBlogRoutes(app);
registerCitationRoutes(app);
registerAccountRequestRoutes(app);
registerPageRoutes(app);

const port = config.get<number>('server.port');

async function start(): Promise<void> {
  await initializeI18n();
  await initializePostgreSQL();

  app.listen(port, () => {
    debug.app(`AGP Wiki listening on port ${port}`);
  });
}

start().catch(error => {
  debug.error('Failed to start AGP Wiki', { error });
  process.exitCode = 1;
});
