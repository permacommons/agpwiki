import path from 'node:path';
import config from 'config';
import cookieParser from 'cookie-parser';
import express from 'express';
import debug from '../util/debug.js';
import { layoutAssets } from './asset-urls.js';
import { resolveSessionUser } from './auth/session.js';
import { initializePostgreSQL } from './db.js';
import { getLanguageOptions, i18next, middleware as i18nMiddleware, initializeI18n } from './i18n.js';
import User from './models/user.js';
import { registerAccountRequestRoutes } from './routes/account-requests.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBlogRoutes } from './routes/blog.js';
import { registerCitationRoutes } from './routes/citations.js';
import { registerForumRoutes } from './routes/forum.js';
import { renderAccountBanner } from './routes/lib/account-banner.js';
import { registerLocaleRoutes } from './routes/locale.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerToolRoutes } from './routes/tools.js';
import { getAccountLifecycleState } from './services/account-lifecycle.js';
import { getUserRoles, hasRole, SITE_ADMIN_ROLE } from './services/roles.js';
import { getStaticCacheControl } from './static-cache.js';

const app = express();
app.set('trust proxy', config.get<boolean | string | number | string[]>('server.trustProxy'));
app.set('view engine', 'hbs');
app.set('views', path.resolve(process.cwd(), 'views'));

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
app.use(async (req, res, next) => {
  const session = await resolveSessionUser(req);
  res.locals.signedIn = Boolean(session);
  res.locals.currentUserId = null;
  res.locals.currentUserName = null;
  res.locals.currentPath = req.originalUrl || '/';
  res.locals.accountState = null;
  res.locals.accountBannerHtml = '';
  res.locals.assets = layoutAssets;
  res.locals.isSiteAdmin = false;

  if (session) {
    const dal = await initializePostgreSQL();
    const [user, roles] = await Promise.all([
      User.filterWhere({ id: session.userId }).first(),
      getUserRoles(dal, session.userId),
    ]);
    res.locals.currentUserId = session.userId;
    res.locals.currentUserName = user?.displayName ?? null;
    res.locals.accountState = await getAccountLifecycleState(session.userId);
    res.locals.isSiteAdmin = hasRole(roles, SITE_ADMIN_ROLE);
  }

  res.locals.accountBannerHtml = renderAccountBanner(req, res);

  next();
});

registerLocaleRoutes(app);
registerSearchRoutes(app);
registerSettingsRoutes(app);
registerAuthRoutes(app);
registerOAuthRoutes(app);
registerToolRoutes(app);
registerBlogRoutes(app);
registerCitationRoutes(app);
registerMediaRoutes(app);
registerForumRoutes(app);
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
