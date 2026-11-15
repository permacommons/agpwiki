import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { insertTestUser } from './_test-users.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

let sharedDal: Dal | null = null;

export const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};

// Each test file runs in its own process, so this closes that file's pool.
test.after(async () => {
  await sharedDal?.disconnect();
  sharedDal = null;
});

export const createTestUser = () => insertTestUser({ prefix: 'servicetest', displayName: 'Service Test' });

export const createVerifiedTestUser = () =>
  insertTestUser({ prefix: 'servicetest', displayName: 'Service Test', emailVerified: true });

export const cleanupTestArtifacts = async (
  dal: Dal,
  {
    slugPrefix,
    citationPrefix,
    claimPrefix,
    mediaSlugPrefix,
    forumThreadPrefix,
    userId,
  }: {
    slugPrefix?: string;
    citationPrefix?: string;
    claimPrefix?: string;
    mediaSlugPrefix?: string;
    forumThreadPrefix?: string;
    userId?: string;
  }
) => {
  if (slugPrefix) {
    await dal.query('DELETE FROM page_aliases WHERE slug LIKE $1', [slugPrefix]);
    await dal.query(
      'DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [slugPrefix]
    );
    await dal.query(
      'DELETE FROM page_signoffs WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [slugPrefix]
    );
    await dal.query(
      'DELETE FROM page_protections WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [slugPrefix]
    );
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (mediaSlugPrefix) {
    await dal.query('DELETE FROM media WHERE slug LIKE $1', [mediaSlugPrefix]);
  }
  if (citationPrefix) {
    await dal.query(
      'DELETE FROM citation_claims WHERE citation_id IN (SELECT id FROM citations WHERE key LIKE $1)',
      [citationPrefix]
    );
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [citationPrefix]);
  }
  if (claimPrefix) {
    await dal.query('DELETE FROM citation_claims WHERE claim_id LIKE $1', [claimPrefix]);
  }
  if (forumThreadPrefix) {
    const jobFilter = `payload->>'threadId' IN (SELECT id::text FROM forum_threads WHERE title->>'en' LIKE $1)`;
    await dal.query(`DELETE FROM notifications WHERE job_id IN (SELECT id FROM notification_jobs WHERE ${jobFilter})`, [forumThreadPrefix]);
    await dal.query(`DELETE FROM notification_deliveries WHERE job_id IN (SELECT id FROM notification_jobs WHERE ${jobFilter})`, [forumThreadPrefix]);
    await dal.query(`DELETE FROM notification_jobs WHERE ${jobFilter}`, [forumThreadPrefix]);
    await dal.query(
      "DELETE FROM forum_thread_subscriptions WHERE thread_id IN (SELECT id FROM forum_threads WHERE title->>'en' LIKE $1)",
      [forumThreadPrefix]
    );
    await dal.query(
      "DELETE FROM forum_comments WHERE thread_id IN (SELECT id FROM forum_threads WHERE title->>'en' LIKE $1)",
      [forumThreadPrefix]
    );
    await dal.query("DELETE FROM forum_threads WHERE title->>'en' LIKE $1", [forumThreadPrefix]);
  }
  if (userId) {
    await dal.query('DELETE FROM admin_events WHERE actor_user_id = $1', [userId]);
    await dal.query('DELETE FROM page_signoffs WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM notification_deliveries WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM forum_thread_subscriptions WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM api_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM oauth_access_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM oauth_refresh_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM oauth_authorization_codes WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM agent_access_requests WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM user_notice_dismissals WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};
