import type { PostgresConfig } from 'config';
import pg from 'pg';
import createDataAccessLayer from 'rev-dal';

// Each test file gets its own database, cloned from a migrated template, so
// files running in parallel never see each other's rows.
export const TEMPLATE_DATABASE = 'agpwiki_test_template';
export const FILE_DATABASE_PREFIX = 'agpwiki_test_file_';

// Held exclusively while migrating the template and shared while cloning it:
// Postgres refuses to clone a database that has open connections, so clones
// from one run must not overlap another run's migration.
export const TEMPLATE_LOCK_ID = 4_231_742;
// Two-key session locks (OWNER_LOCK_CLASS, hashtext(database name)) mark the
// process that owns a file database. Two-key locks don't share a key space
// with single-key ones such as TEMPLATE_LOCK_ID.
const OWNER_LOCK_CLASS = 4_231_743;

// Name of a database that is never created: test files that don't import
// test/_use-database.ts get it, so connecting from them fails.
export const NO_DATABASE = `${FILE_DATABASE_PREFIX}none_requested`;

/**
 * Point this process's config at `database`, keeping any other NODE_CONFIG
 * overrides (credentials, port). Must run before `config` is first loaded.
 */
export const setDatabaseOverride = (database: string) => {
  let overrides: { postgres?: Record<string, unknown> } & Record<string, unknown> = {};
  if (process.env.NODE_CONFIG) {
    try {
      overrides = JSON.parse(process.env.NODE_CONFIG);
    } catch {
      throw new Error('NODE_CONFIG must be valid JSON to run the tests.');
    }
  }
  process.env.NODE_CONFIG = JSON.stringify({
    ...overrides,
    postgres: { ...overrides.postgres, database },
  });
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

const createMaintenanceClient = (base: PostgresConfig) =>
  new pg.Client({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: 'postgres',
  });

const withMaintenanceClient = async <T>(base: PostgresConfig, run: (client: pg.Client) => Promise<T>) => {
  const client = createMaintenanceClient(base);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

const tryLockOwner = async (client: pg.Client, database: string) => {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
    [OWNER_LOCK_CLASS, database]
  );
  return rows[0]?.locked === true;
};

const unlockOwner = (client: pg.Client, database: string) =>
  client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [OWNER_LOCK_CLASS, database]);

// A plain DROP DATABASE stops autovacuum workers in the database itself,
// whereas FORCE tries to terminate them and, for a role that is not a
// superuser, fails with "permission denied to terminate process". So drop
// plainly, and force only when our own connections are still open.
const OBJECT_IN_USE = '55006';

const dropDatabaseWith = async (client: pg.Client, database: string) => {
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quote(database)}`);
  } catch (error) {
    if ((error as { code?: string }).code !== OBJECT_IN_USE) throw error;
    await client.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`);
  }
};

export const prepareTemplate = (base: PostgresConfig) =>
  withMaintenanceClient(base, async client => {
    await client.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_ID]);
    try {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE_DATABASE]);
      if (!existing.rowCount) await client.query(`CREATE DATABASE ${quote(TEMPLATE_DATABASE)}`);
      const dal = createDataAccessLayer({ ...base, database: TEMPLATE_DATABASE });
      await dal.connect();
      try {
        await dal.migrate();
      } finally {
        // Postgres refuses to copy a template that has open connections.
        await dal.disconnect();
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_ID]);
    }
  });

export const createDatabaseFromTemplate = (base: PostgresConfig, database: string) =>
  withMaintenanceClient(base, async client => {
    await client.query('SELECT pg_advisory_lock_shared($1)', [TEMPLATE_LOCK_ID]);
    try {
      await client.query(`CREATE DATABASE ${quote(database)} TEMPLATE ${quote(TEMPLATE_DATABASE)}`);
    } finally {
      await client.query('SELECT pg_advisory_unlock_shared($1)', [TEMPLATE_LOCK_ID]);
    }
  });

export interface DatabaseClaim {
  /** End the owner session, releasing the claim. */
  release(): Promise<void>;
}

/**
 * Mark the calling process as the owner of `database` until it releases the
 * claim or exits. Claim before creating the database, so cleanup never finds
 * it unowned. The claim is a session advisory lock on its own connection: a
 * crashed owner releases it automatically, after which cleanup may drop the
 * database.
 */
export const claimDatabase = async (base: PostgresConfig, database: string): Promise<DatabaseClaim> => {
  const client = createMaintenanceClient(base);
  // Losing this connection only makes the database eligible for cleanup.
  client.on('error', error => {
    console.error(`Lost the owner connection for test database ${database}: ${error.message}`);
  });
  await client.connect();
  let claimed = false;
  try {
    claimed = await tryLockOwner(client, database);
  } finally {
    if (!claimed) await client.end();
  }
  if (!claimed) throw new Error(`Test database ${database} is already claimed by another process.`);

  // The claim must not keep the process alive, or it would never reach the
  // beforeExit handler that drops the database and releases the claim.
  // Releasing refs the socket again so the disconnect can finish.
  const socket = client.connection.stream as { ref?: () => void; unref?: () => void };
  socket.unref?.();
  return {
    release: () => {
      socket.ref?.();
      return client.end();
    },
  };
};

export const dropDatabase = (base: PostgresConfig, database: string) =>
  withMaintenanceClient(base, client => dropDatabaseWith(client, database));

const listDatabases = async (client: pg.Client, prefix: string) => {
  const { rows } = await client.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE left(datname, length($1)) = $1 ORDER BY datname',
    [prefix]
  );
  return rows.map(row => row.datname);
};

/** Drop every database with this prefix. Use only once their owners are known to be done. */
export const dropDatabases = (base: PostgresConfig, prefix: string) =>
  withMaintenanceClient(base, async client => {
    const databases = await listDatabases(client, prefix);
    for (const database of databases) await dropDatabaseWith(client, database);
    return databases;
  });

/**
 * Drop databases with this prefix whose owning process has exited. A database
 * still claimed by a live process, from this run or an overlapping one, is
 * kept even when it has no open connections.
 */
export const dropAbandonedDatabases = (base: PostgresConfig, prefix: string) =>
  withMaintenanceClient(base, async client => {
    const dropped: string[] = [];
    for (const database of await listDatabases(client, prefix)) {
      if (!(await tryLockOwner(client, database))) continue;
      // Holding the owner lock while dropping keeps any process from claiming
      // the database in between.
      try {
        await dropDatabaseWith(client, database);
        dropped.push(database);
      } finally {
        await unlockOwner(client, database);
      }
    }
    return dropped;
  });
