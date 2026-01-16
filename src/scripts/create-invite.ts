import readline from 'node:readline/promises';

import { generateInviteCode, hashToken } from '../auth/tokens.js';
import { initializePostgreSQL } from '../db.js';
import SignupInvite from '../models/signup-invite.js';
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
    const issuerEmail = await prompt('Issuer email (optional): ', rl);
    const email = await prompt('Invitee email (optional): ', rl);
    const role = await prompt('Role to grant (optional): ', rl);
    const days = await prompt('Expires in days (default 7): ', rl);

    const expiresInDays = days ? Number(days) : 7;
    const expiresAt = Number.isNaN(expiresInDays)
      ? null
      : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const dal = await initializePostgreSQL();
    let issuedBy: string | null = null;
    if (issuerEmail) {
      const issuer = await User.filterWhere({ email: issuerEmail }).first();
      if (!issuer) {
        throw new Error(`No user found for issuer email: ${issuerEmail}`);
      }
      issuedBy = issuer.id;
    }

    const code = generateInviteCode();
    const codeHash = hashToken(code);
    const codePrefix = code.slice(0, 8);

    await SignupInvite.create({
      codeHash,
      codePrefix,
      email: email || null,
      role: role || null,
      issuedBy,
      createdAt: new Date(),
      expiresAt: expiresAt ?? null,
    });

    console.log('Created signup invite:');
    console.log(`  code: ${code}`);
    console.log(`  prefix: ${codePrefix}`);
    if (expiresAt) {
      console.log(`  expires: ${expiresAt.toISOString()}`);
    }
    if (email) {
      console.log(`  email: ${email}`);
    }
    if (role) {
      console.log(`  role: ${role}`);
    }
    console.log('Share the signup link: /tool/auth/signup');

    await dal.disconnect();
  } finally {
    rl.close();
  }
};

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create invite: ${message}`);
  process.exitCode = 1;
});
