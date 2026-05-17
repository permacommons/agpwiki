// Idempotently ensures the agentic-test user exists with all the
// account-lifecycle gates passed (email verified, not blocked,
// agent_access_request approved). Without these, MCP tokens
// authenticate-but-fail at the userCanUseAgentFeatures check.
//
// Run from the agpwiki repo root:
//   node --import tsx agentic-testing/lib/provision-user.ts

import { randomBytes } from 'node:crypto';

import { initializePostgreSQL } from '../../src/db.js';
import User from '../../src/models/user.js';

const TEST_USER_EMAIL = 'agentic-test@example.com';
const TEST_USER_USERNAME_PREFIX = 'agentictest';

const main = async () => {
  const dal = await initializePostgreSQL();

  let user = await User.filterWhere({ email: TEST_USER_EMAIL }).first();
  if (!user) {
    user = await User.create({
      username: `${TEST_USER_USERNAME_PREFIX}${Date.now()}`,
      displayName: 'Agentic Test',
      email: TEST_USER_EMAIL,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
    });
    console.log(`created user ${user.id} (${TEST_USER_EMAIL})`);
  } else {
    console.log(`existing user ${user.id} (${TEST_USER_EMAIL})`);
  }

  if (!user.emailVerifiedAt) {
    await dal.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [user.id]);
    console.log('  marked email verified');
  } else {
    console.log('  email already verified');
  }

  if (user.blockedAt) {
    await dal.query('UPDATE users SET blocked_at = NULL WHERE id = $1', [user.id]);
    console.log('  cleared block');
  } else {
    console.log('  not blocked');
  }

  await dal.query(
    `
    INSERT INTO agent_access_requests (id, user_id, interests, profile_url, status, approved_at)
    VALUES (gen_random_uuid(), $1, 'agentic testing', 'https://example.com', 'approved', NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET status = 'approved',
          approved_at = COALESCE(agent_access_requests.approved_at, NOW())
    `,
    [user.id]
  );
  console.log('  agent_access_request: approved');

  const result = await dal.query(
    `
    SELECT u.email,
           u.email_verified_at IS NOT NULL AS verified,
           u.blocked_at IS NULL AS not_blocked,
           r.status AS access_status
    FROM users u
    LEFT JOIN agent_access_requests r ON r.user_id = u.id
    WHERE u.id = $1
    `,
    [user.id]
  );
  console.log('\nFinal state:');
  console.log(result.rows[0]);

  await dal.disconnect();
  process.exit(0);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
