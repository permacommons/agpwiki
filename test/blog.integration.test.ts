import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createBlogPost,
  updateBlogPost,
  listBlogPostRevisions,
  readBlogPostRevision,
  diffBlogPostRevisions,
} from '../src/services/blog-post-service.js';
import { NotFoundError } from '../src/lib/errors.js';
import { BLOG_AUTHOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { createTestUser, getDal } from './_service-fixtures.js';

test('Blog history includes archived revisions and restricts reads and diffs to the post', async () => {
  const dal = await getDal();
  const user = await createTestUser();
  const prefix = `test-blog-history-${randomBytes(8).toString('hex')}`;
  try {
    await grantRoleUpsert(dal, user.id, BLOG_AUTHOR_ROLE);
    const created = await createBlogPost(dal, {
      slug: prefix,
      title: { en: 'History' },
      body: { en: 'Original body.', de: 'Original German.' },
      summary: { en: 'Original summary.' },
    }, user.id);
    const updated = await updateBlogPost(dal, {
      slug: prefix,
      body: { en: 'Updated body.' },
      expectedRevId: created.currentRevId,
      revSummary: { en: 'Update body.' },
    }, user.id);
    const other = await createBlogPost(dal, {
      slug: `${prefix}-other`,
      title: { en: 'Other post' },
      body: { en: 'Other body.' },
    }, user.id);
    // Distinct dates make descending order deterministic even on fast databases.
    await dal.query("UPDATE posts SET _rev_date = _rev_date - INTERVAL '1 day' WHERE _rev_id = $1", [created.currentRevId]);
    const history = await listBlogPostRevisions(dal, prefix);
    assert.equal(history.postId, created.id);
    assert.deepEqual(history.revisions.map(revision => revision.revId), [updated.currentRevId, created.currentRevId]);
    const original = await readBlogPostRevision(dal, prefix, created.currentRevId);
    assert.deepEqual(original.revision.body, { en: 'Original body.', de: 'Original German.' });
    assert.deepEqual(original.revision.summary, { en: 'Original summary.' });
    assert.equal(original.revision.oldRevOf, created.id);
    assert.equal(original.revision.revUser, user.id);
    assert.equal((await readBlogPostRevision(dal, prefix, updated.currentRevId)).revision.oldRevOf, null);
    const diff = await diffBlogPostRevisions(dal, { slug: prefix, fromRevId: created.currentRevId });
    assert.equal(diff.fromRevId, created.currentRevId);
    assert.equal(diff.toRevId, updated.currentRevId);
    assert.equal(diff.fields.body.kind, 'localized');
    if (diff.fields.body.kind === 'localized') {
      assert.match(diff.fields.body.modified.en.from, /Original body/);
      assert.match(diff.fields.body.modified.en.to, /Updated body/);
      assert.equal(diff.fields.body.modified.de, undefined);
    }
    const explicitDiff = await diffBlogPostRevisions(dal, {
      slug: prefix, fromRevId: updated.currentRevId, toRevId: created.currentRevId,
    });
    assert.equal(explicitDiff.toRevId, created.currentRevId);
    for (const revId of [other.currentRevId, '00000000-0000-4000-8000-000000000000']) {
      await assert.rejects(readBlogPostRevision(dal, prefix, revId), NotFoundError);
      await assert.rejects(diffBlogPostRevisions(dal, { slug: prefix, fromRevId: revId }), NotFoundError);
      await assert.rejects(diffBlogPostRevisions(dal, {
        slug: prefix, fromRevId: created.currentRevId, toRevId: revId,
      }), NotFoundError);
    }
    // Historical deletion flags must not hide a revision of a still-live post.
    await dal.query('UPDATE posts SET _rev_deleted = true WHERE _rev_id = $1', [created.currentRevId]);
    assert.equal((await readBlogPostRevision(dal, prefix, created.currentRevId)).revision.revDeleted, true);
    assert.equal((await listBlogPostRevisions(dal, prefix)).revisions.length, 2);
    assert.equal((await diffBlogPostRevisions(dal, {
      slug: prefix, fromRevId: created.currentRevId,
    })).toRevId, updated.currentRevId);
    for (const slug of [`${prefix}-missing`, prefix]) {
      if (slug === prefix) await dal.query('UPDATE posts SET _rev_deleted = true WHERE id = $1', [created.id]);
      await assert.rejects(listBlogPostRevisions(dal, slug), NotFoundError);
      await assert.rejects(readBlogPostRevision(dal, slug, created.currentRevId), NotFoundError);
      await assert.rejects(diffBlogPostRevisions(dal, { slug, fromRevId: created.currentRevId }), NotFoundError);
    }
  } finally {
    await dal.query('DELETE FROM posts WHERE slug LIKE $1', [`${prefix}%`]);
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});
