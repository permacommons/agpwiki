import type { PostgresConfig } from 'config';
import pg from 'pg';
import createDataAccessLayer from 'rev-dal';

// Each test file gets its own database, cloned from a migrated template, so
// files running in parallel never see each other's rows.
export const TEMPLATE_DATABASE = 'agpwiki_test_template';
export const FILE_DATABASE_PREFIX = 'agpwiki_test_file_';
const TEMPLATE_LOCK_ID = 4_231_742;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

const withMaintenanceClient = async <T>(base: PostgresConfig, run: (client: pg.Client) => Promise<T>) => {
  const client = new pg.Client({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
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
  withMaintenanceClient(base, client =>
    client.query(`CREATE DATABASE ${quote(database)} TEMPLATE ${quote(TEMPLATE_DATABASE)}`)
  );

export const dropDatabase = (base: PostgresConfig, database: string) =>
  withMaintenanceClient(base, client => client.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`));

export const dropDatabases =(base: PostgresConfig, prefix: string, { onlyIdle = false } = {}) =>
  withMaintenanceClient(base, async client => {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database d
        WHERE left(datname, length($1)) = $1
          AND NOT ($2 AND EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname))`,
      [prefix, onlyIdle]
    );
    for (const { datname } of rows) {
      await client.query(`DROP DATABASE IF EXISTS ${quote(datname)} WITH (FORCE)`);
    }
    return rows.length;
  });
