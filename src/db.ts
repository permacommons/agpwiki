import type { PostgresConfig } from 'config';
import config from 'config';

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

type JsonObject = Record<string, unknown>;

let postgresDAL: DataAccessLayer | null = null;
let connectionPromise: Promise<DataAccessLayer> | null = null;

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

export async function initializePostgreSQL(): Promise<DataAccessLayer> {
  if (postgresDAL) {
    return postgresDAL;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      debug.db('Initializing PostgreSQL DAL...');

      const dalConfig = getPostgresConfig();
      postgresDAL = createDataAccessLayer(
        dalConfig as Partial<PostgresConfig> & JsonObject
      ) as unknown as DataAccessLayer;

      await postgresDAL.connect();
      initializeManifestModels(postgresDAL);
      setBootstrapResolver(() => ({
        getModel: postgresDAL?.getModel.bind(postgresDAL) ?? (() => null),
      }));

      try {
        await postgresDAL.migrate();
        debug.db('PostgreSQL migrations completed');
      } catch (migrationError) {
        const message =
          migrationError instanceof Error ? migrationError.message : String(migrationError);
        debug.db(`PostgreSQL migration error (may be expected): ${message}`);
      }

      debug.db('PostgreSQL DAL connected successfully');
      return postgresDAL;
    } catch (error) {
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
