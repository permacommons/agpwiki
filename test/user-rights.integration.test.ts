import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORUM_MODERATOR_ROLE,
  BLOG_ADMIN_ROLE,
  BLOG_AUTHOR_ROLE,
  SITE_ADMIN_ROLE,
  WIKI_ADMIN_ROLE,
  grantRole,
  grantRoleUpsert,
  hasRole,
  revokeRole,
  userHasRole,
} from '../src/services/roles.js';
import { searchVerifiedUsersWithRights, updateUserRightsBelowSiteAdmin } from '../src/services/user-rights-service.js';
import { blockUserAccount } from '../src/services/account-lifecycle.js';
import { protectWikiPage } from '../src/services/page-protection-service.js';
import { createWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';
import User from '../src/models/user.js';
import { cleanupTestArtifacts, createTestUser, createVerifiedTestUser, getDal } from './_service-fixtures.js';

test('User rights search returns verified users with roles and excludes unverified users', async () => {
  const dal = await getDal();
  let verifiedUserId: string | null = null;
  let unverifiedUserId: string | null = null;
  let blockedUserId: string | null = null;

  try {
    const verifiedUser = await createVerifiedTestUser();
    const unverifiedUser = await createTestUser();
    const blockedUser = await createVerifiedTestUser();
    verifiedUserId = verifiedUser.id;
    unverifiedUserId = unverifiedUser.id;
    blockedUserId = blockedUser.id;

    verifiedUser.displayName = 'Rights Search Match';
    verifiedUser.email = `rights-search-${Date.now()}@example.com`;
    await verifiedUser.save();
    unverifiedUser.displayName = 'Rights Search Match Unverified';
    unverifiedUser.email = `rights-unverified-${Date.now()}@example.com`;
    await unverifiedUser.save();
    blockedUser.displayName = 'Rights Search Match Blocked';
    blockedUser.email = `rights-blocked-${Date.now()}@example.com`;
    await blockedUser.save();

    await grantRoleUpsert(dal, verifiedUser.id, WIKI_ADMIN_ROLE);
    await blockUserAccount(dal, blockedUser.id, verifiedUser.id, 'Test block');

    const results = await searchVerifiedUsersWithRights(dal, 'Rights Search Match');
    const resultsIncludingBlocked = await searchVerifiedUsersWithRights(
      dal,
      'Rights Search Match',
      { includeBlocked: true }
    );

    assert.ok(results.some(user => user.id === verifiedUser.id));
    assert.ok(!results.some(user => user.id === unverifiedUser.id));
    assert.ok(!results.some(user => user.id === blockedUser.id));
    assert.ok(resultsIncludingBlocked.some(user => user.id === blockedUser.id));
    assert.deepEqual(
      results.find(user => user.id === verifiedUser.id)?.roles,
      [WIKI_ADMIN_ROLE]
    );
  } finally {
    if (blockedUserId) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [blockedUserId]);
      await dal.query('DELETE FROM users WHERE id = $1', [blockedUserId]);
    }
    if (verifiedUserId) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [verifiedUserId]);
      await dal.query('DELETE FROM users WHERE id = $1', [verifiedUserId]);
    }
    if (unverifiedUserId) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [unverifiedUserId]);
      await dal.query('DELETE FROM users WHERE id = $1', [unverifiedUserId]);
    }
  }
});

test('User rights update changes only roles below site admin', async () => {
  const dal = await getDal();
  let userId: string | null = null;

  try {
    const user = await createVerifiedTestUser();
    userId = user.id;
    await grantRoleUpsert(dal, user.id, SITE_ADMIN_ROLE);
    await grantRoleUpsert(dal, user.id, WIKI_ADMIN_ROLE);
    await grantRoleUpsert(dal, user.id, BLOG_AUTHOR_ROLE);

    const result = await updateUserRightsBelowSiteAdmin(dal, user.id, [
      BLOG_ADMIN_ROLE,
      BLOG_ADMIN_ROLE,
      BLOG_AUTHOR_ROLE,
    ]);

    assert.deepEqual(
      result.changes.map(change => change.role).sort(),
      [BLOG_ADMIN_ROLE, WIKI_ADMIN_ROLE].sort()
    );
    assert.equal(result.changes.find(change => change.role === BLOG_ADMIN_ROLE)?.before, false);
    assert.equal(result.changes.find(change => change.role === BLOG_ADMIN_ROLE)?.after, true);
    assert.equal(result.changes.find(change => change.role === WIKI_ADMIN_ROLE)?.before, true);
    assert.equal(result.changes.find(change => change.role === WIKI_ADMIN_ROLE)?.after, false);
    assert.deepEqual(
      result.afterRoles.sort(),
      [BLOG_ADMIN_ROLE, BLOG_AUTHOR_ROLE, SITE_ADMIN_ROLE].sort()
    );
  } finally {
    if (userId) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      await dal.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  }
});

test('User rights update rolls back deletion when insertion fails', async t => {
  const dal = await getDal();
  const user = await createVerifiedTestUser();
  const originalQuery = dal.query.bind(dal);
  try {
    await grantRoleUpsert(dal, user.id, SITE_ADMIN_ROLE);
    await grantRoleUpsert(dal, user.id, WIKI_ADMIN_ROLE);
    const failure = new Error('Injected role insertion failure');
    const queryMock = t.mock.method(dal, 'query', async (...args: Parameters<typeof dal.query>) => {
      if (args[0].startsWith('INSERT INTO user_roles') && args[1]?.[0] === user.id) {
        throw failure;
      }
      return originalQuery(...args);
    });
    await assert.rejects(updateUserRightsBelowSiteAdmin(dal, user.id, [BLOG_AUTHOR_ROLE]), failure);
    queryMock.mock.restore();
    const rows = await dal.query('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [user.id]);
    assert.deepEqual(rows.rows.map(row => row.role), [SITE_ADMIN_ROLE, WIKI_ADMIN_ROLE].sort());
  } finally {
    t.mock.restoreAll();
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});

test('Concurrent user rights replacements report serialized before and after states', async t => {
  const dal = await getDal();
  const user = await createVerifiedTestUser();
  const originalQuery = dal.query.bind(dal);
  const deleted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondLock = Promise.withResolvers<void>();
  let lockCount = 0;
  const updates: Promise<unknown>[] = [];
  try {
    await grantRoleUpsert(dal, user.id, SITE_ADMIN_ROLE);
    t.mock.method(dal, 'query', async (...args: Parameters<typeof dal.query>) => {
      if (args[1]?.[0] !== user.id) return originalQuery(...args);
      if (args[0].includes('FOR UPDATE') && ++lockCount === 2) secondLock.resolve();
      const result = await originalQuery(...args);
      if (args[0].startsWith('DELETE FROM user_roles') && lockCount === 1) {
        deleted.resolve();
        await releaseFirst.promise;
      }
      return result;
    });
    const first = updateUserRightsBelowSiteAdmin(dal, user.id, [WIKI_ADMIN_ROLE]);
    updates.push(first);
    await Promise.race([deleted.promise, first.then(() => assert.fail('Expected role deletion'))]);
    const second = updateUserRightsBelowSiteAdmin(dal, user.id, [BLOG_AUTHOR_ROLE]);
    updates.push(second);
    await Promise.race([secondLock.promise, second.then(() => assert.fail('Expected user lock'))]);
    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult.beforeRoles, [SITE_ADMIN_ROLE]);
    assert.deepEqual(firstResult.afterRoles, [SITE_ADMIN_ROLE, WIKI_ADMIN_ROLE]);
    assert.deepEqual(secondResult.beforeRoles, firstResult.afterRoles);
    assert.deepEqual(secondResult.afterRoles, [SITE_ADMIN_ROLE, BLOG_AUTHOR_ROLE]);
    assert.deepEqual(secondResult.user.roles, secondResult.afterRoles);
    assert.deepEqual(secondResult.changes, [
      { role: WIKI_ADMIN_ROLE, before: true, after: false },
      { role: BLOG_AUTHOR_ROLE, before: false, after: true },
    ]);
    const rows = await dal.query('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [user.id]);
    assert.deepEqual(rows.rows.map(row => row.role), [SITE_ADMIN_ROLE, BLOG_AUTHOR_ROLE].sort());
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled(updates);
    t.mock.restoreAll();
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});

test('User rights update rejects site admin and unknown rights', async () => {
  const dal = await getDal();
  let userId: string | null = null;

  try {
    const user = await createVerifiedTestUser();
    userId = user.id;

    await assert.rejects(
      () => updateUserRightsBelowSiteAdmin(dal, user.id, [SITE_ADMIN_ROLE]),
      /site_admin cannot be changed/
    );
    await assert.rejects(
      () => updateUserRightsBelowSiteAdmin(dal, user.id, ['definitely_not_a_role']),
      /Unknown user right/
    );
  } finally {
    if (userId) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      await dal.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  }
});

test('Service site admins hold every role without separate grants', async () => {
  const dal = await getDal();
  const slug = `test-site-admin-protected-${Date.now()}`;
  let siteAdminId: string | null = null;

  try {
    const siteAdmin = await createTestUser();
    siteAdminId = siteAdmin.id;
    await grantRoleUpsert(dal, siteAdmin.id, SITE_ADMIN_ROLE);

    for (const role of [WIKI_ADMIN_ROLE, BLOG_ADMIN_ROLE, BLOG_AUTHOR_ROLE, FORUM_MODERATOR_ROLE]) {
      assert.equal(await userHasRole(dal, siteAdmin.id, role), true);
    }
    assert.equal(hasRole([SITE_ADMIN_ROLE], WIKI_ADMIN_ROLE), true);
    assert.equal(hasRole([BLOG_ADMIN_ROLE], WIKI_ADMIN_ROLE), false);

    await createWikiPage(
      dal,
      { slug, title: { en: 'Protected' }, body: { en: 'Original.' }, canonicalLanguage: 'en' },
      siteAdmin.id
    );
    await protectWikiPage(dal, { slug, reason: 'Policy page.' }, siteAdmin.id);
    const updated = await updateWikiPage(
      dal,
      { slug, body: { en: 'Edited by a site admin.' }, revSummary: { en: 'Edit.' } },
      siteAdmin.id
    );
    assert.equal(updated.body?.en, 'Edited by a site admin.');

    await grantRole(dal, siteAdmin.id, WIKI_ADMIN_ROLE);
    await revokeRole(dal, siteAdmin.id, WIKI_ADMIN_ROLE);
  } finally {
    await cleanupTestArtifacts(dal, { slugPrefix: `${slug}%` });
    await cleanupTestArtifacts(dal, { userId: siteAdminId ?? undefined });
  }
});
