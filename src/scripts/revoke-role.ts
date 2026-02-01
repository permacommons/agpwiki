import readline from 'node:readline/promises';

import { initializePostgreSQL } from '../db.js';
import { isValidRole, revokeRole, VALID_ROLES } from '../mcp/roles.js';
import User from '../models/user.js';

const prompt = async (label: string, rl: readline.Interface) => {
  const value = await rl.question(label);
  return value.trim();
};

const main = async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let dal: Awaited<ReturnType<typeof initializePostgreSQL>> | undefined;

  try {
    const email = await prompt('User email: ', rl);
    const role = await prompt(`Role (${VALID_ROLES.join(', ')}): `, rl);

    if (!email || !role) {
      throw new Error('User email and role are required.');
    }
    if (!isValidRole(role)) {
      throw new Error(`Role must be one of: ${VALID_ROLES.join(', ')}`);
    }

    dal = await initializePostgreSQL();
    const user = await User.filterWhere({ email }).first();
    if (!user) {
      throw new Error(`No user found for email: ${email}`);
    }

    await revokeRole(dal, user.id, role);

    console.log(`Revoked role ${role} from ${user.email}`);
  } finally {
    if (dal) {
      await dal.disconnect();
    }
    rl.close();
  }
};

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to revoke role: ${message}`);
  process.exitCode = 1;
});
