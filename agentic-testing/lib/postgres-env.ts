import type { PostgresConfig } from 'config';
import config from 'config';

const pgConfig = config.get<PostgresConfig>('postgres');

const entries: Array<[string, string | number | undefined]> = [
  ['PGHOST', pgConfig.host ?? 'localhost'],
  ['PGPORT', pgConfig.port ?? 5432],
  ['PGDATABASE', pgConfig.database ?? 'agpwiki'],
  ['PGUSER', pgConfig.user ?? 'agpwiki_user'],
  ['PGPASSWORD', pgConfig.password],
];

for (const [key, value] of entries) {
  if (value !== undefined) {
    console.log(`${key}=${value}`);
  }
}
