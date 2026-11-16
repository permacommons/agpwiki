import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { insertTestUser } from './_test-users.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

let sharedDal: Dal | null = null;

export const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};

// Each test file runs in its own process, so this closes that file's pool.
test.after(async () => {
  await sharedDal?.disconnect();
  sharedDal = null;
});

export const createTestUser = () => insertTestUser({ prefix: 'servicetest', displayName: 'Service Test' });

export const createVerifiedTestUser = () =>
  insertTestUser({ prefix: 'servicetest', displayName: 'Service Test', emailVerified: true });
