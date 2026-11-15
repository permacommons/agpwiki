import {
  claimDatabase,
  createDatabaseFromTemplate,
  dropDatabase,
  FILE_DATABASE_PREFIX,
  prepareTemplate,
} from './_database.ts';

// Preloaded into every test process. NODE_TEST_CONTEXT marks the processes the
// runner starts for test files, as opposed to the runner itself.
if (process.env.NODE_TEST_CONTEXT) {
  const usesDatabase = process.argv[1]?.endsWith('.integration.test.ts') ?? false;
  const run = process.env.AGPWIKI_TEST_RUN ?? 'solo';
  // Only integration tests get a database; any other test that connects fails
  // on this missing name instead of sharing a database with other files.
  const database = usesDatabase
    ? `${FILE_DATABASE_PREFIX}${run}_${process.pid}`
    : `${FILE_DATABASE_PREFIX}none_for_unit_tests`;
  // config reads NODE_CONFIG once, when it is first loaded, so this must
  // happen before anything imports it.
  process.env.NODE_CONFIG = JSON.stringify({ postgres: { database } });

  if (usesDatabase) {
    const { default: config } = await import('config');
    const base = config.get<import('config').PostgresConfig>('postgres');

    // Without the global setup (e.g. running one file directly), prepare the template here.
    if (!process.env.AGPWIKI_TEST_RUN) await prepareTemplate(base);
    // Claim before creating, so other runs' cleanup never finds this database
    // unowned. A database already under this name was left by an exited
    // process that had the same pid, so it is safe to replace.
    const claim = await claimDatabase(base, database);
    try {
      await dropDatabase(base, database);
      await createDatabaseFromTemplate(base, database);
    } catch (error) {
      await claim.release();
      throw error;
    }

    let dropped = false;
    process.on('beforeExit', async () => {
      if (dropped) return;
      dropped = true;
      try {
        await dropDatabase(base, database);
      } finally {
        await claim.release();
      }
    });
  }
}
