import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import config, { type PostgresConfig } from 'config';
import pg from 'pg';

import {
  claimDatabase,
  createDatabaseFromTemplate,
  dropAbandonedDatabases,
  dropDatabases,
  TEMPLATE_LOCK_ID,
} from './_database.ts';

// Exercises the per-file database harness itself. Every database here uses a
// prefix unique to this process, so the test never touches other files' or
// other runs' databases.
const base = config.get<PostgresConfig>('postgres');
const prefix = `agpwiki_test_harness_${process.pid}_`;
const databaseModule = pathToFileURL(new URL('./_database.ts', import.meta.url).pathname).href;

const connect = async () => {
  const client = new pg.Client({ ...base, database: 'postgres' });
  await client.connect();
  return client;
};

const existingDatabases = async () => {
  const client = await connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE left(datname, length($1)) = $1 ORDER BY datname',
      [prefix]
    );
    return rows.map(row => row.datname);
  } finally {
    await client.end();
  }
};

/** Run a module script in a fresh Node process that can import the harness. */
const runChild = (script: string, timeoutMs = 15_000) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...env, HARNESS_BASE: JSON.stringify(base) },
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
    assert.deepEqual(await existingDatabases(), [owned]);
  } finally {
    await claim.release();
  }

  assert.deepEqual(await dropAbandonedDatabases(base, prefix), [owned]);
  assert.deepEqual(await existingDatabases(), []);
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
  assert.deepEqual(await existingDatabases(), [database]);

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
  assert.deepEqual(await existingDatabases(), [database]);
});
