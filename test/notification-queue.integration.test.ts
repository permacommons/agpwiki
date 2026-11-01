import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { initializePostgreSQL } from '../src/db.js';
import { claimPendingNotificationJobs, resetProcessingNotificationJobs } from '../src/services/notification-queue.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;
let sharedDal: Dal | null = null;
test.after(async () => { await sharedDal?.disconnect(); });

const withIsolatedQueue = async (run: (dal: Dal, client: PoolClient) => Promise<void>) => {
  sharedDal ??= await initializePostgreSQL();
  const client = await sharedDal.getConnection() as PoolClient;
  try {
    await client.query('BEGIN');
    // A connection-local table keeps worker-wide operations away from other tests' jobs.
    await client.query('CREATE TEMP TABLE notification_jobs (LIKE public.notification_jobs INCLUDING ALL) ON COMMIT DROP');
    const dal = { query: (sql: string, parameters: unknown[]) => client.query(sql, parameters) } as Dal;
    await run(dal, client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
};

test('The notification queue claims due jobs in order without claiming locked or future jobs', async () => {
  await withIsolatedQueue(async (dal, client) => {
    const now = new Date('2026-01-01T00:00:00Z');
    await client.query(`INSERT INTO notification_jobs (type, payload, available_at, status) VALUES
      ('first', '{}', $1::timestamptz - interval '2 seconds', 'pending'),
      ('second', '{}', $1::timestamptz - interval '1 second', 'pending'),
      ('future', '{}', $1::timestamptz + interval '1 second', 'pending'),
      ('locked', '{}', $1, 'processing')`, [now]);
    const first = await claimPendingNotificationJobs(dal, 1, now);
    assert.deepEqual(first.jobs.map(job => job.type), ['first']);
    assert.equal(first.jobs[0].status, 'processing');
    assert.equal(first.jobs[0].lockToken, first.lockToken);
    assert.equal(first.jobs[0].lockedAt?.getTime(), now.getTime());
    const second = await claimPendingNotificationJobs(dal, 10, now);
    assert.deepEqual(second.jobs.map(job => job.type), ['second']);
    assert.notEqual(second.lockToken, first.lockToken);
    assert.deepEqual((await claimPendingNotificationJobs(dal, 10, now)).jobs, []);
  });
});

test('Notification worker startup resets only locked processing jobs', async () => {
  await withIsolatedQueue(async (dal, client) => {
    await client.query(`INSERT INTO notification_jobs (type, payload, status, locked_at, lock_token) VALUES
      ('locked', '{}', 'processing', now(), gen_random_uuid()),
      ('unlocked', '{}', 'processing', NULL, NULL),
      ('pending', '{}', 'pending', NULL, NULL),
      ('failed', '{}', 'failed', NULL, NULL)`);
    assert.equal(await resetProcessingNotificationJobs(dal), 1);
    const rows = await client.query('SELECT type, status, locked_at, lock_token FROM notification_jobs ORDER BY type');
    assert.deepEqual(rows.rows, [
      { type: 'failed', status: 'failed', locked_at: null, lock_token: null },
      { type: 'locked', status: 'pending', locked_at: null, lock_token: null },
      { type: 'pending', status: 'pending', locked_at: null, lock_token: null },
      { type: 'unlocked', status: 'processing', locked_at: null, lock_token: null },
    ]);
    assert.equal(await resetProcessingNotificationJobs(dal), 0);
  });
});
