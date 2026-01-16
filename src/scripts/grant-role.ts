import readline from 'node:readline/promises';

import { initializePostgreSQL } from '../db.js';
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
    const role = await prompt('Role (e.g., blog_author): ', rl);

    if (!email || !role) {
      throw new Error('User email and role are required.');
    }

    const dal = await initializePostgreSQL();
    const user = await User.filterWhere({ email }).first();
    if (!user) {
      throw new Error(`No user found for email: ${email}`);
    }

    await dal.query(
      'INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [user.id, role]
    );

    console.log(`Granted role ${role} to ${user.email}`);
    await dal.disconnect();
  } finally {
    rl.close();
  }
};

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to grant role: ${message}`);
  process.exitCode = 1;
});
