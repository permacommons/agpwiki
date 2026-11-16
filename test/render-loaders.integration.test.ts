import './_use-database.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import Citation from '../src/models/citation.js';
import Media from '../src/models/media.js';
import User from '../src/models/user.js';
import { loadCitationEntriesForSources } from '../src/services/citation-render-service.js';
import {
  buildMediaRegistryFromInstances,
  loadMediaEntriesForSources,
} from '../src/services/media-render-service.js';

let dal: Awaited<ReturnType<typeof initializePostgreSQL>>;
test.after(async () => { await dal?.disconnect(); });

test('Renderer loaders batch current live entries and preserve renderer fields', async t => {
  dal = await initializePostgreSQL();
  const prefix = `render-loader-${randomBytes(8).toString('hex')}`;
  const user = await User.create({
    username: prefix.replaceAll('-', ''),
    email: `${prefix}@example.com`,
    displayName: 'Render loader test',
    passwordHash: randomBytes(32).toString('hex'),
  });
  try {
    const citation = await Citation.createFirstRevision({ id: user.id });
    citation.key = prefix;
    citation.data = { title: 'Old citation' };
    await citation.save();
    await citation.newRevision({ id: user.id });
    citation.data = { title: 'Current citation', id: 'embedded-id' };
    await citation.save();

    const media = await Media.createFirstRevision({ id: user.id });
    media.slug = prefix;
    media.commonsTitle = 'File:Example.jpg';
    media.mediaType = 'image';
    media.data = { license: 'CC0' };
    media.title = { en: 'Old media' };
    await media.save();
    await media.newRevision({ id: user.id });
    media.title = { en: 'Current media' };
    media.caption = { en: 'Caption' };
    media.altText = null;
    await media.save();

    const deletedCitation = await Citation.createFirstRevision({ id: user.id });
    deletedCitation.key = `${prefix}-deleted`;
    deletedCitation.data = { title: 'Deleted citation' };
    await deletedCitation.save();
    await deletedCitation.deleteAllRevisions({ id: user.id });
    const deletedMedia = await Media.createFirstRevision({ id: user.id });
    deletedMedia.slug = `${prefix}-deleted`;
    deletedMedia.commonsTitle = 'File:Deleted.jpg';
    deletedMedia.mediaType = 'image';
    deletedMedia.data = {};
    await deletedMedia.save();
    await deletedMedia.deleteAllRevisions({ id: user.id });

    const query = t.mock.method(dal, 'query');
    assert.deepEqual(await loadCitationEntriesForSources(dal, ['No references.']), []);
    assert.deepEqual(await loadMediaEntriesForSources(dal, []), new Map());
    assert.equal(query.mock.callCount(), 0);

    const citations = await loadCitationEntriesForSources(dal, [
      `[@${prefix}; @${prefix}-deleted; @${prefix}-missing]`,
      `Again [@${prefix}].`,
    ]);
    assert.deepEqual(citations, [{ title: 'Current citation', id: prefix }]);
    assert.equal(query.mock.callCount(), 1);
    const entries = await loadMediaEntriesForSources(dal, [
      `![A](/media/${prefix}) ![B](/media/${prefix}-deleted) ![C](/media/${prefix}-missing)`,
      `![A again](/media/${prefix})`,
    ]);
    assert.deepEqual(entries, buildMediaRegistryFromInstances([media]));
    assert.equal(entries.get(prefix)?.altText, null);
    assert.equal(entries.get(prefix)?.revId, media._revID);
    assert.equal(query.mock.callCount(), 2);
  } finally {
    t.mock.restoreAll();
  }
});
