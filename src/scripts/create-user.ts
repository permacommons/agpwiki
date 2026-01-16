import { randomBytes, scryptSync } from 'node:crypto';
import readline from 'node:readline/promises';

import { initializePostgreSQL } from '../db.js';
import User from '../models/user.js';

const prompt = async (label: string, rl: readline.Interface) => {
  const value = await rl.question(label);
  return value.trim();
};

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
};

const main = async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const displayName = await prompt('Display name: ', rl);
    const email = await prompt('Email: ', rl);
    const password = await prompt('Password (will be echoed): ', rl);

    if (!displayName || !email || !password) {
      throw new Error('Display name, email, and password are required.');
    }

    const dal = await initializePostgreSQL();

    const existing = await User.filterWhere({ email }).first();
    if (existing) {
      throw new Error(`User already exists for email: ${email}`);
    }

    const passwordHash = hashPassword(password);
    const user = await User.create({
      displayName,
      email,
      passwordHash,
      createdAt: new Date(),
    });

    console.log('Created user:');
    console.log(`  id: ${user.id}`);
    console.log(`  email: ${user.email}`);
    await dal.disconnect();
  } finally {
    rl.close();
  }
};

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create user: ${message}`);
  process.exitCode = 1;
});
