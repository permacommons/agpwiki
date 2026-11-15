import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession } from '../src/auth/session.js';
import { hashToken } from '../src/auth/tokens.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { blockUserAccount, getAccountLifecycleState, unblockUserAccount } from '../src/services/account-lifecycle.js';
import { createPasswordResetToken, requestPasswordReset, resetPasswordWithToken } from '../src/services/password-reset.js';
import AuthSession from '../src/models/auth-session.js';
import PasswordResetToken from '../src/models/password-reset-token.js';
import User from '../src/models/user.js';
import { createTestUser, getDal } from './_service-fixtures.js';

test('Service unblockUserAccount clears blocked account state', async () => {
  const dal = await getDal();

  const user = await createTestUser();

  await blockUserAccount(dal, user.id, user.id, 'Test block');
  const blockedState = await getAccountLifecycleState(user.id);
  assert.equal(blockedState?.isBlocked, true);

  await unblockUserAccount(user.id);
  const unblockedState = await getAccountLifecycleState(user.id);

  assert.equal(unblockedState?.isBlocked, false);
  assert.equal(unblockedState?.user.blockedAt, null);
  assert.equal(unblockedState?.user.blockedBy, null);
  assert.equal(unblockedState?.user.blockReason, null);
});

test('Service resetPasswordWithToken updates password and revokes sessions', async () => {
  const dal = await getDal();

  const user = await createTestUser();
  user.passwordHash = await hashPassword('old-password');
  await user.save();

  const session = await createSession(user.id);
  const { token } = await createPasswordResetToken(user);
  const { token: otherToken } = await createPasswordResetToken(user);
  const records = await PasswordResetToken.filterWhere({ userId: user.id }).run();

  assert.equal(records.length, 2);
  assert.notEqual(records[0]?.tokenHash, token);
  assert.equal(records.every(record => record.usedAt === null), true);

  const resetUser = await resetPasswordWithToken(dal, token, 'new-password');
  assert.equal(resetUser?.id, user.id);

  const reloadedUser = await User.filterWhere({ id: user.id }).first();
  assert.ok(reloadedUser);
  assert.equal(await verifyPassword('new-password', reloadedUser.passwordHash), true);
  assert.equal(await verifyPassword('old-password', reloadedUser.passwordHash), false);

  const usedRecords = await PasswordResetToken.filterWhere({ userId: user.id }).run();
  assert.equal(usedRecords.every(record => Boolean(record.usedAt)), true);

  const activeSession = await AuthSession.findActiveByHash(hashToken(session.token));
  assert.equal(activeSession, null);

  const secondUse = await resetPasswordWithToken(dal, token, 'another-password');
  assert.equal(secondUse, null);

  const otherUse = await resetPasswordWithToken(dal, otherToken, 'another-password');
  assert.equal(otherUse, null);
});

test('Service requestPasswordReset skips blocked accounts', async () => {
  const dal = await getDal();

  const user = await createTestUser();
  await blockUserAccount(dal, user.id, user.id, 'Test block');

  const result = await requestPasswordReset(user.email);
  const records = await PasswordResetToken.filterWhere({ userId: user.id }).run();

  assert.equal(result.requested, false);
  assert.equal(records.length, 0);
});
