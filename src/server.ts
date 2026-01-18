import path from 'node:path';
import config from 'config';
import express from 'express';

import debug from '../util/debug.js';
import { initializePostgreSQL } from './db.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBlogRoutes } from './routes/blog.js';
import { registerCitationRoutes } from './routes/citations.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerToolRoutes } from './routes/tools.js';

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.resolve(process.cwd(), 'public')));

registerSearchRoutes(app);
registerAuthRoutes(app);
registerOAuthRoutes(app);
registerToolRoutes(app);
registerBlogRoutes(app);
registerCitationRoutes(app);
registerPageRoutes(app);

const port = config.get<number>('server.port');

async function start(): Promise<void> {
  await initializePostgreSQL();

  app.listen(port, () => {
    debug.app(`AGP Wiki listening on port ${port}`);
  });
}

start().catch(error => {
  debug.error('Failed to start AGP Wiki', { error });
  process.exitCode = 1;
});
