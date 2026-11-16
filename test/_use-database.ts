// Import first in a test file that uses PostgreSQL:
//
//   import './_use-database.js';
//
// The file then gets its own database, cloned from the migrated template and
// dropped when the file's process exits. Files without this import get no
// database, and connecting from them fails.
import { createRequire } from 'node:module';

import {
  claimDatabase,
  createDatabaseFromTemplate,
  dropDatabase,
  FILE_DATABASE_PREFIX,
  prepareTemplate,
  setDatabaseOverride,
} from './_database.ts';

// config reads NODE_CONFIG once, when it is first loaded, so the database name
// must be set before anything loads it. Node registers CommonJS modules that
// an ES module imports before running them, so check whether config has run,
// not whether it is in the cache.
const require = createRequire(import.meta.url);
if (require.cache[require.resolve('config')]?.loaded) {
  throw new Error(
    "config was loaded before test/_use-database.ts; import './_use-database.js' first in this test file."
  );
}

const run = process.env.AGPWIKI_TEST_RUN ?? 'solo';
const database = `${FILE_DATABASE_PREFIX}${run}_${process.pid}`;
setDatabaseOverride(database);

const { default: config } = await import('config');
const base = config.get<import('config').PostgresConfig>('postgres');

// Without the global setup (e.g. running one file directly), prepare the template here.
if (!process.env.AGPWIKI_TEST_RUN) await prepareTemplate(base);
// Claim before creating, so other runs' cleanup never finds this database
// unowned. A database already under this name was left by an exited process
// that had the same pid, so it is safe to replace.
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
