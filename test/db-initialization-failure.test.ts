import assert from 'node:assert/strict';
import test from 'node:test';

import DataAccessLayer from 'rev-dal/lib/data-access-layer';

import { initializePostgreSQL } from '../src/db.js';

// Runs in its own process so this is the first initialization attempt.
test('a failed initialization closes its pool and a later call retries', async t => {
  const prototype = DataAccessLayer.prototype as {
    migrate: (...args: unknown[]) => Promise<unknown>;
    disconnect: () => Promise<void>;
  };
  const originalMigrate = prototype.migrate;
  let failNextMigration = true;
  t.mock.method(prototype, 'migrate', function (this: unknown, ...args: unknown[]) {
    if (failNextMigration) {
      failNextMigration = false;
      return Promise.reject(new Error('Simulated migration failure.'));
    }
    return originalMigrate.apply(this, args);
  });
  const disconnect = t.mock.method(prototype, 'disconnect');

  await assert.rejects(initializePostgreSQL(), /Simulated migration failure/);
  assert.equal(disconnect.mock.callCount(), 1, 'the failed attempt is disconnected');
  const failedDal = disconnect.mock.calls[0]?.this as { pool: unknown; isConnected(): boolean };
  assert.equal(failedDal.pool, null);
  assert.equal(failedDal.isConnected(), false);

  const dal = await initializePostgreSQL();
  try {
    assert.notEqual(dal, failedDal);
    assert.equal(dal.isConnected(), true);
    assert.equal(await initializePostgreSQL(), dal);
  } finally {
    await dal.disconnect();
  }
});
