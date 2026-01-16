import readline from 'node:readline/promises';

import { hashPassword } from '../auth/password.js';
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
    const email = await prompt('Email: ', rl);
    const password = await prompt('New password (will be echoed): ', rl);

    if (!email || !password) {
      throw new Error('Email and password are required.');
    }

    const dal = await initializePostgreSQL();

    const user = await User.filterWhere({ email }).first();
    if (!user) {
      throw new Error(`No user found for email: ${email}`);
    }

    user.passwordHash = await hashPassword(password);
    await user.save();

    console.log('Password reset:');
    console.log(`  id: ${user.id}`);
    console.log(`  email: ${user.email}`);

    await dal.disconnect();
  } finally {
    rl.close();
  }
};

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to reset password: ${message}`);
  process.exitCode = 1;
});
