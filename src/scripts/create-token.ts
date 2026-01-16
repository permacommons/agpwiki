import readline from 'node:readline/promises';

import { generateApiToken, hashToken } from '../auth/tokens.js';
import { initializePostgreSQL } from '../db.js';
import ApiToken from '../models/api-token.js';
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

  try {
    const email = await prompt('User email: ', rl);
    const label = await prompt('Token label (optional): ', rl);

    if (!email) {
      throw new Error('User email is required.');
    }

    const dal = await initializePostgreSQL();
    const user = await User.filterWhere({ email }).first();
    if (!user) {
      throw new Error(`No user found for email: ${email}`);
    }

    const token = generateApiToken();
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const tokenLast4 = token.slice(-4);

    await ApiToken.create({
      userId: user.id,
      tokenHash,
      tokenPrefix,
      tokenLast4,
      label: label || null,
      createdAt: new Date(),
    });

    console.log('Created API token:');
    console.log(`  user: ${user.email}`);
    console.log(`  token: ${token}`);
    console.log(`  prefix: ${tokenPrefix}`);
    console.log(`  last4: ${tokenLast4}`);
    console.log('Set AGPWIKI_MCP_TOKEN to use this token.');

    await dal.disconnect();
  } finally {
    rl.close();
  }
};

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create token: ${message}`);
  process.exitCode = 1;
});
