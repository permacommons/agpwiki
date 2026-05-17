// Issue an MCP API token for the agentic-test user and print it on
// stdout as `TOKEN=<value>`. Caller captures with grep + cut.
//
// The token's `label` carries a timestamp so repeat runs don't
// collide on the (user_id, label) unique constraint.
//
// Run from the agpwiki repo root:
//   node --import tsx agentic-testing/lib/issue-token.ts

import { initializePostgreSQL } from '../../src/db.js';
import { generateApiToken, hashToken } from '../../src/auth/tokens.js';
import ApiToken from '../../src/models/api-token.js';
import User from '../../src/models/user.js';

const TEST_USER_EMAIL = 'agentic-test@example.com';

const main = async () => {
  const dal = await initializePostgreSQL();

  const user = await User.filterWhere({ email: TEST_USER_EMAIL }).first();
  if (!user) {
    throw new Error(
      `Test user not found: ${TEST_USER_EMAIL}. Run provision-user.ts first.`
    );
  }

  const token = generateApiToken();
  await ApiToken.create({
    userId: user.id,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 8),
    tokenLast4: token.slice(-4),
    label: `agentic-test-${Date.now()}`,
    createdAt: new Date(),
  });

  console.log(`TOKEN=${token}`);
  await dal.disconnect();
  process.exit(0);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
