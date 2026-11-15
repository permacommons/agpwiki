import assert from 'node:assert/strict';
import test from 'node:test';

import { getPostgresDAL, initializePostgreSQL } from '../src/db.js';

// Each test file runs in its own process, so these are the first calls to
// initialize the DAL, as on a cold server receiving simultaneous requests.
test('concurrent callers only receive the DAL once it is connected and migrated', async () => {
  const [first, second, viaGetter] = await Promise.all([
    initializePostgreSQL().then(dal => ({ dal, connected: dal.isConnected() })),
    initializePostgreSQL().then(dal => ({ dal, connected: dal.isConnected() })),
    getPostgresDAL().then(dal => ({ dal, connected: dal.isConnected() })),
  ]);

  try {
    assert.equal(second.dal, first.dal);
    assert.equal(viaGetter.dal, first.dal);
    assert.equal(first.connected, true);
    assert.equal(second.connected, true, 'second caller waits for initialization');
    assert.equal(viaGetter.connected, true, 'getPostgresDAL waits for initialization');

    assert.equal(await initializePostgreSQL(), first.dal);
  } finally {
    await first.dal.disconnect();
  }
});
