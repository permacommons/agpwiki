import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import config, { type PostgresConfig } from 'config';
import pg from 'pg';

import {
  claimDatabase,
  createDatabaseFromTemplate,
  dropAbandonedDatabases,
  dropDatabases,
  FILE_DATABASE_PREFIX,
  listDatabases,
  NO_DATABASE,
  TEMPLATE_LOCK_ID,
} from './_database.ts';

// Exercises the per-file database harness itself. Every database here uses a
// prefix unique to this process, so the test never touches other files' or
// other runs' databases.
const base = config.get<PostgresConfig>('postgres');
const prefix = `agpwiki_test_harness_${process.pid}_`;
const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
const databaseModule = moduleUrl('./_database.ts');

const connect = async () => {
  const client = new pg.Client({ ...base, database: 'postgres' });
  await client.connect();
  return client;
};

/** Run a module script in a fresh Node process that can import the harness. */
const runChild = (script: string, timeoutMs = 15_000, extraEnv: Record<string, string> = {}) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, HARNESS_BASE: JSON.stringify(base), ...extraEnv },
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child process did not exit within ${timeoutMs}ms:\n${output}`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });

after(async () => {
  await dropDatabases(base, prefix);
});

test('cleanup keeps claimed databases even when nothing is connected to them', async () => {
  const owned = `${prefix}owned`;
  const abandoned = `${prefix}abandoned`;
  const claim = await claimDatabase(base, owned);
  try {
    await createDatabaseFromTemplate(base, owned);
    await createDatabaseFromTemplate(base, abandoned);

    // Neither database has a connection; only the claim tells them apart.
    assert.deepEqual(await dropAbandonedDatabases(base, prefix), [abandoned]);
    assert.deepEqual(await listDatabases(base, prefix), [owned]);
  } finally {
    await claim.release();
  }

  assert.deepEqual(await dropAbandonedDatabases(base, prefix), [owned]);
  assert.deepEqual(await listDatabases(base, prefix), []);
});

test('a database can only be claimed by one process at a time', async () => {
  const database = `${prefix}contested`;
  const claim = await claimDatabase(base, database);
  try {
    await assert.rejects(claimDatabase(base, database), /already claimed by another process/);
  } finally {
    await claim.release();
  }
  const reclaimed = await claimDatabase(base, database);
  await reclaimed.release();
});

test('a crashed owner releases its claim', async () => {
  const database = `${prefix}crashed`;
  const result = await runChild(`
    const { claimDatabase, createDatabaseFromTemplate } = await import(${JSON.stringify(databaseModule)});
    const base = JSON.parse(process.env.HARNESS_BASE);
    await claimDatabase(base, ${JSON.stringify(database)});
    await createDatabaseFromTemplate(base, ${JSON.stringify(database)});
    process.kill(process.pid, 'SIGKILL');
  `);
  assert.equal(result.signal, 'SIGKILL', result.output);
  assert.deepEqual(await listDatabases(base, prefix), [database]);

  // The server notices the closed socket asynchronously; wait for the lock.
  let dropped: string[] = [];
  for (let attempt = 0; attempt < 50 && dropped.length === 0; attempt++) {
    dropped = await dropAbandonedDatabases(base, prefix);
    if (dropped.length === 0) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(dropped, [database]);
});

test('holding a claim does not keep the owner process alive', async () => {
  const database = `${prefix}exiting`;
  const result = await runChild(`
    const { claimDatabase } = await import(${JSON.stringify(databaseModule)});
    const base = JSON.parse(process.env.HARNESS_BASE);
    const claim = await claimDatabase(base, ${JSON.stringify(database)});
    let released = false;
    process.on('beforeExit', async () => {
      if (released) return;
      released = true;
      await claim.release();
      console.log('released');
    });
  `);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /released/);
});

test('cloning the template waits while the template is being migrated', async () => {
  const database = `${prefix}clone`;
  const migrator = await connect();
  let cloned = false;
  let clone: Promise<void> | undefined;
  try {
    await migrator.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_ID]);
    clone = createDatabaseFromTemplate(base, database).then(() => {
      cloned = true;
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(cloned, false, 'clone ran while the template lock was held exclusively');
  } finally {
    await migrator.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_ID]);
    await migrator.end();
  }
  await clone;
  assert.equal(cloned, true);
  assert.deepEqual(await listDatabases(base, prefix), [database]);
});

test('a file that imports _use-database connects to its own database', async () => {
  const result = await runChild(`
    import ${JSON.stringify(moduleUrl('./_use-database.ts'))};
    import { initializePostgreSQL } from ${JSON.stringify(moduleUrl('../src/db.ts'))};
    const dal = await initializePostgreSQL();
    const { rows } = await dal.query('SELECT current_database() AS name');
    console.log(JSON.stringify({ name: rows[0].name, pid: process.pid }));
    await dal.disconnect();
  `, 60_000);
  assert.equal(result.code, 0, result.output);
  const line = result.output.split('\n').find(output => output.startsWith('{"name"'));
  assert.ok(line, result.output);
  const { name, pid } = JSON.parse(line) as { name: string; pid: number };
  assert.equal(name, `${FILE_DATABASE_PREFIX}${process.env.AGPWIKI_TEST_RUN ?? 'solo'}_${pid}`);

  // The child dropped its database on exit.
  const client = await connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    assert.equal(rowCount, 0);
  } finally {
    await client.end();
  }
});

test('importing _use-database after config fails with a clear error', async () => {
  const result = await runChild(`
    import 'config';
    import ${JSON.stringify(moduleUrl('./_use-database.ts'))};
  `);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /import '\.\/_use-database\.js' first/);
});

// This file doesn't import _use-database, so it gets what every such file
// gets. Global setup arranges that, so the test needs it.
test(
  'files without the import cannot connect',
  { skip: process.env.AGPWIKI_TEST_RUN ? false : 'needs the global setup' },
  async () => {
    assert.equal(base.database, NO_DATABASE);
    const client = new pg.Client(base);
    await assert.rejects(client.connect(), { code: '3D000' }); // invalid_catalog_name
  }
);

test('_use-database keeps other NODE_CONFIG overrides', async () => {
  const overrides = JSON.parse(process.env.NODE_CONFIG ?? '{}') as { postgres?: Record<string, unknown> };
  const result = await runChild(
    `
    import ${JSON.stringify(moduleUrl('./_use-database.ts'))};
    const { default: config } = await import('config');
    const postgres = config.get('postgres');
    console.log(JSON.stringify({ max: postgres.max, database: postgres.database }));
  `,
    60_000,
    { NODE_CONFIG: JSON.stringify({ ...overrides, postgres: { ...overrides.postgres, max: 3 } }) }
  );
  assert.equal(result.code, 0, result.output);
  const line = result.output.split('\n').find(output => output.startsWith('{"max"'));
  assert.ok(line, result.output);
  const { max, database } = JSON.parse(line) as { max: number; database: string };
  assert.equal(max, 3);
  assert.ok(database.startsWith(FILE_DATABASE_PREFIX), database);
});
