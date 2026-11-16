import assert from 'node:assert/strict';
import test from 'node:test';

import { profilePath, profileSlug, profileUsernameOf } from '../src/lib/profile-paths.js';
import { isBlockedSlug } from '../src/lib/slug.js';
import { isValidUsername, normalizeUsername } from '../src/lib/username.js';

test('Registration rejects names whose normalized usernames conflict with profile addresses', () => {
  for (const name of [
    '', ' _- ', 'alice@example.org', 'alice/bob', '/alice', 'alice/', '/', '.', '..',
    'Discussion', 'CHECKS', 'dis-cussion', 'c_h_e_c_k_s',
    'Ｄｉｓｃｕｓｓｉｏｎ', 'alice／bob', '．．', 'alice＠example.org',
  ]) {
    assert.equal(isValidUsername(name), false, name);
  }
});

test('Supported usernames keep readable, reversible profile addresses', () => {
  for (const name of [
    'Alice Smith', 'alice_bob', 'alice-bob', 'comments', 'operator-edit',
    'publish-draft', 'api', 'tool', 'user', 'alice.smith', '...',
    'Élodie', '李明', 'alice?bob', 'alice#bob', 'alice%bob',
  ]) {
    assert.equal(isValidUsername(name), true, name);
    const username = normalizeUsername(name);
    const slug = profileSlug(username);
    assert.equal(isBlockedSlug(slug), false, name);
    assert.equal(profileUsernameOf(slug), username, name);
    assert.equal(decodeURIComponent(new URL(profilePath(username), 'https://example.org').pathname), `/${slug}`, name);
  }
});
