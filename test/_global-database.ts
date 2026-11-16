import config, { type PostgresConfig } from 'config';

import {
  dropAbandonedDatabases,
  dropDatabases,
  FILE_DATABASE_PREFIX,
  NO_DATABASE,
  prepareTemplate,
  setDatabaseOverride,
} from './_database.ts';

const base = () => config.get<PostgresConfig>('postgres');

export async function globalSetup() {
  // Test processes inherit both: the run names their databases, and files
  // that don't import test/_use-database.ts are left pointing at no database.
  // This process loaded config already, so the override only affects them.
  process.env.AGPWIKI_TEST_RUN = Date.now().toString(36);
  setDatabaseOverride(NO_DATABASE);
  // Databases left by interrupted runs. Each test process claims its database
  // for as long as it runs, so databases of overlapping runs are kept.
  await dropAbandonedDatabases(base(), FILE_DATABASE_PREFIX);
  await prepareTemplate(base());
}

export async function globalTeardown() {
  await dropDatabases(base(), `${FILE_DATABASE_PREFIX}${process.env.AGPWIKI_TEST_RUN}_`);
}
