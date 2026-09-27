import type { PostgresConfig } from 'config';
import config from 'config';
import type { PoolClient } from 'pg';

import createDataAccessLayer, {
  setDebugLogger,
  setLanguageProvider,
  setRevisionSummaryEnabled,
} from 'rev-dal';
import { initializeManifestModels } from 'rev-dal/lib/create-model';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { setBootstrapResolver } from 'rev-dal/lib/model-handle';
import languages from '../locales/languages.js';
import debug from '../util/debug.js';
import './models/index.js';

type JsonObject = Record<string, unknown>;

let postgresDAL: DataAccessLayer | null = null;
let connectionPromise: Promise<DataAccessLayer> | null = null;
// Node's test runner can initialize separate worker processes against the same
// empty database. Use a database-level advisory lock so only one process runs
// migrations at a time.
const MIGRATION_LOCK_ID = 4_231_741;

setLanguageProvider(languages);
setDebugLogger(debug);
setRevisionSummaryEnabled(true);

function getPostgresConfig(): PostgresConfig {
  const moduleConfig = config as JsonObject & { postgres?: PostgresConfig };
  if (moduleConfig.postgres) {
    return moduleConfig.postgres;
  }
  if (typeof config.get === 'function') {
    return config.get<PostgresConfig>('postgres');
  }
  throw new Error('PostgreSQL configuration not found.');
}

async function withMigrationLock<T>(
  dal: DataAccessLayer,
  callback: () => Promise<T>
): Promise<T> {
  const client = (await dal.getConnection()) as PoolClient;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    return await callback();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

function shouldRunMigrations(): boolean {
  return process.env.AGPWIKI_SKIP_DB_MIGRATIONS !== '1';
}

export async function initializePostgreSQL(): Promise<DataAccessLayer> {
  if (postgresDAL) {
    return postgresDAL;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    let attemptDal: DataAccessLayer | null = null;
    try {
      debug.db('Initializing PostgreSQL DAL...');

      const dalConfig = getPostgresConfig();
      const dal = createDataAccessLayer(
        dalConfig as Partial<PostgresConfig> & JsonObject
      ) as unknown as DataAccessLayer;
      attemptDal = dal;

      await dal.connect();
      initializeManifestModels(dal);
      setBootstrapResolver(() => ({
        getModel: dal.getModel.bind(dal),
      }));

      if (shouldRunMigrations()) {
        await withMigrationLock(dal, async () => {
          await dal.migrate();
          debug.db('PostgreSQL migrations completed');
        });
      } else {
        debug.db('PostgreSQL migrations skipped via AGPWIKI_SKIP_DB_MIGRATIONS=1');
      }

      debug.db('PostgreSQL DAL connected successfully');
      // Publish the DAL only once it is connected and migrated: callers that
      // arrive meanwhile wait on connectionPromise instead of receiving a DAL
      // whose pool already works against a partially created schema.
      postgresDAL = dal;
      return dal;
    } catch (error) {
      // Clear cached state so a later retry does not inherit a failed
      // initialization attempt, and close this attempt's pool: retries each
      // open a new one.
      connectionPromise = null;
      await attemptDal?.disconnect().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Failed to initialize PostgreSQL DAL: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  })();

  return connectionPromise;
}

export async function getPostgresDAL(): Promise<DataAccessLayer> {
  if (postgresDAL) {
    return postgresDAL;
  }
  return initializePostgreSQL();
}
