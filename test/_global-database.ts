import config, { type PostgresConfig } from 'config';

import { dropAbandonedDatabases, dropDatabases, FILE_DATABASE_PREFIX, prepareTemplate } from './_database.ts';

const base = () => config.get<PostgresConfig>('postgres');

export async function globalSetup() {
  // Test processes inherit this, which names their databases after the run.
  process.env.AGPWIKI_TEST_RUN = Date.now().toString(36);
  // Databases left by interrupted runs. Each test process claims its database
  // for as long as it runs, so databases of overlapping runs are kept.
  await dropAbandonedDatabases(base(), FILE_DATABASE_PREFIX);
  await prepareTemplate(base());
}

export async function globalTeardown() {
  await dropDatabases(base(), `${FILE_DATABASE_PREFIX}${process.env.AGPWIKI_TEST_RUN}_`);
}
