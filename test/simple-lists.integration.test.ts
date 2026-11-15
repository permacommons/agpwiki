import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import BlogPost from '../src/models/blog-post.js';
import User from '../src/models/user.js';
import WikiPage from '../src/models/wiki-page.js';
import { listBlogPosts } from '../src/services/blog-post-service.js';
import { listProposalPages } from '../src/services/proposal-status-service.js';

let dal: Awaited<ReturnType<typeof initializePostgreSQL>>;
test.after(async () => { await dal?.disconnect(); });

test('Simple lists preserve pagination, revision guards, proposal scope and status', async () => {
  dal = await initializePostgreSQL();
  const prefix = `simple-list-${randomBytes(8).toString('hex')}`;
  const user = await User.create({
    username: prefix.replaceAll('-', ''),
    email: `${prefix}@example.com`, displayName: 'List test',
    passwordHash: randomBytes(32).toString('hex'),
  });
  try {
    const posts = [];
    for (const suffix of ['older', 'newer', 'deleted']) {
      const post = await BlogPost.createFirstRevision({ id: user.id });
      post.slug = `${prefix}-${suffix}`;
      post.title = { en: suffix };
      post.body = { en: 'Original body' };
      // Equal creation dates exercise revision-date ordering before pagination.
      post.createdAt = new Date('2200-01-01T00:00:00Z');
      await post.save();
      posts.push(post);
    }
    const [older, newer, deleted] = posts;
    await newer.newRevision({ id: user.id });
    newer.body = { en: 'Current body' };
    await newer.save();
    await deleted.deleteAllRevisions({ id: user.id });
    await dal.query("UPDATE posts SET _rev_date = '2200-01-02' WHERE id = $1", [older.id]);
    await dal.query("UPDATE posts SET _rev_date = '2200-01-03' WHERE id = $1", [newer.id]);
    const first = await listBlogPosts(dal, { limit: 1 });
    assert.equal(first[0].id, newer.id);
    assert.deepEqual(first[0].body, { en: 'Current body' });
    const second = await listBlogPosts(dal, { limit: 1, offset: 1 });
    assert.equal(second[0].id, older.id);
    assert.deepEqual((await listBlogPosts(dal, { limit: 2 })).map(post => post.id), [newer.id, older.id]);

    for (const suffix of ['b', 'a', 'deleted', 'outside']) {
      const page = await WikiPage.createFirstRevision({ id: user.id });
      page.slug = suffix === 'outside' ? `${prefix}-outside` : `meta/proposals/${prefix}-${suffix}`;
      page.title = { en: suffix };
      await page.save();
      if (suffix === 'a') {
        await page.newRevision({ id: user.id });
        page.title = { en: 'Current proposal' };
        page.properties = { proposal: { status: 'withdrawn' } };
        await page.save();
      }
      if (suffix === 'deleted') await page.deleteAllRevisions({ id: user.id });
    }
    const proposals = (await listProposalPages(dal)).filter(page => page.slug.includes(prefix));
    assert.deepEqual(proposals.map(page => page.slug), [`meta/proposals/${prefix}-a`, `meta/proposals/${prefix}-b`]);
    assert.deepEqual(proposals[0].title, { en: 'Current proposal' });
    assert.equal(proposals[0].status, 'withdrawn');
    assert.equal(proposals[1].status, null);
    assert.ok(proposals[0].updatedAt instanceof Date);
  } finally {
    await dal.query('DELETE FROM posts WHERE slug LIKE $1', [`${prefix}%`]);
    await dal.query('DELETE FROM pages WHERE slug LIKE $1 OR slug LIKE $2', [`${prefix}%`, `meta/proposals/${prefix}%`]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});
