import './_use-database.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import User from '../src/models/user.js';
import { fetchUserMap } from '../src/routes/lib/history.js';
import { loadUserAuthors, loadUserDisplayNames } from '../src/services/user-lookup-service.js';

let dal: Awaited<ReturnType<typeof initializePostgreSQL>>;
test.after(async () => { await dal?.disconnect(); });

test('User lookups batch names and authors, omit missing users, and skip empty inputs', async t => {
  dal = await initializePostgreSQL();
  const ids: string[] = [];
  try {
    for (const name of ['First Author', 'Second Author']) {
      const suffix = randomBytes(8).toString('hex');
      const user = await User.create({
        username: `lookup${suffix}`,
        displayName: name,
        email: `lookup-${suffix}@example.com`,
        passwordHash: randomBytes(32).toString('hex'),
        blockedAt: name === 'Second Author' ? new Date() : null,
      });
      ids.push(user.id);
    }
    const query = t.mock.method(dal, 'query');
    assert.deepEqual(await loadUserDisplayNames(dal, []), new Map());
    assert.deepEqual(await loadUserAuthors(dal, new Set()), new Map());
    assert.equal(query.mock.callCount(), 0);
    const requested = [ids[0], randomUUID(), ids[1], ids[0]];
    const names = await loadUserDisplayNames(dal, requested);
    assert.equal(query.mock.callCount(), 1);
    assert.equal(names.size, 2);
    assert.equal(names.get(ids[0]), 'First Author');
    assert.equal(names.get(ids[1]), 'Second Author');
    const authors = await loadUserAuthors(dal, requested);
    assert.equal(query.mock.callCount(), 2);
    assert.equal(authors.size, 2);
    for (const id of ids) {
      const author = authors.get(id)!;
      assert.deepEqual(Object.keys(author).sort(), ['name', 'username']);
      assert.equal(author.name, names.get(id));
      assert.match(author.username, /^lookup/);
    }
    assert.deepEqual(await fetchUserMap(dal, requested), names);
    assert.equal(query.mock.callCount(), 3);
  } finally {
    t.mock.restoreAll();
  }
});
