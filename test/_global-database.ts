import config, { type PostgresConfig } from 'config';

import { dropDatabases, FILE_DATABASE_PREFIX, prepareTemplate } from './_database.ts';

const base = () => config.get<PostgresConfig>('postgres');

export async function globalSetup() {
  // Test processes inherit this, which names their databases after the run.
  process.env.AGPWIKI_TEST_RUN = Date.now().toString(36);
  // Databases from interrupted runs; ones still in use belong to a run in progress.
  await dropDatabases(base(), FILE_DATABASE_PREFIX, { onlyIdle: true });
  await prepareTemplate(base());
}

export async function globalTeardown() {
  await dropDatabases(base(), `${FILE_DATABASE_PREFIX}${process.env.AGPWIKI_TEST_RUN}_`);
}
