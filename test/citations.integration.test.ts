import assert from 'node:assert/strict';
import test from 'node:test';
import { NotFoundError, ValidationError } from '../src/lib/errors.js';
import { WIKI_ADMIN_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import {
  createCitation,
  deleteCitation,
  readCitation,
  updateCitation,
} from '../src/services/citation-service.js';
import { createCitationClaim, readCitationClaim, updateCitationClaim } from '../src/services/citation-claim-service.js';
import { cleanupTestArtifacts, createTestUser, getDal } from './_service-fixtures.js';

test('Service rejects citation create when ISBN is an array', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-invalid-isbn-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await assert.rejects(
      () =>
        createCitation(
          dal,
          {
            key: citationKey,
            data: {
              type: 'book',
              title: 'Invalid ISBN Citation',
              ISBN: ['9780444525123', '9780080931395'],
            },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'data.ISBN'));
        return true;
      }
    );
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service rejects citation update when CSL shape fails citeproc', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-invalid-author-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Valid Citation',
          URL: 'https://example.com/valid-citation',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        updateCitation(
          dal,
          {
            key: citationKey,
            data: {
              type: 'webpage',
              title: 'Invalid Author Shape',
              author: 'Alice Example',
              URL: 'https://example.com/invalid-author',
            },
            revSummary: { en: 'Introduce invalid author shape.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'data'));
        return true;
      }
    );
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service createCitation ignores submitted data.id and returns warning', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-ignore-id-create-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    const created = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: 'client-provided-id',
          type: 'webpage',
          title: 'Citation with ignored id',
          URL: 'https://example.com/citation-ignore-id-create',
        },
      },
      userId
    );

    assert.ok(
      created.warnings?.includes('Ignored data.id; citation key is authoritative.')
    );
    assert.equal(Object.hasOwn(created.data ?? {}, 'id'), false);

    const saved = await readCitation(dal, citationKey);
    assert.equal(Object.hasOwn(saved.data ?? {}, 'id'), false);
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service updateCitation ignores submitted data.id and returns warning', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-ignore-id-update-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Base citation',
          URL: 'https://example.com/citation-ignore-id-update',
        },
      },
      userId
    );

    const updated = await updateCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: 'client-update-id',
          type: 'webpage',
          title: 'Updated citation',
          URL: 'https://example.com/citation-ignore-id-update-v2',
        },
        revSummary: { en: 'Update citation while submitting data.id.' },
      },
      userId
    );

    assert.ok(
      updated.warnings?.includes('Ignored data.id; citation key is authoritative.')
    );
    assert.equal(Object.hasOwn(updated.data ?? {}, 'id'), false);

    const saved = await readCitation(dal, citationKey);
    assert.equal(Object.hasOwn(saved.data ?? {}, 'id'), false);
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service createCitationClaim requires quoteLanguage when quote provided', async () => {
  const dal = await getDal();
  const citationKey = `test-claim-quote-lang-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  const claimId = 'birthdate';
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Claim test citation',
          URL: 'https://example.com/claim-test',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        createCitationClaim(
          dal,
          {
            key: citationKey,
            claimId,
            assertion: { en: 'A test claim.' },
            quote: { en: 'A test quote.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'quoteLanguage'));
        return true;
      }
    );
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service createCitationClaim and updateCitationClaim write revisions', async () => {
  const dal = await getDal();
  const citationKey = `test-claim-revisions-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  const claimId = `claim-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Claim test citation',
          URL: 'https://example.com/claim-test-revisions',
        },
      },
      userId
    );

    const created = await createCitationClaim(
      dal,
      {
        key: citationKey,
        claimId,
        assertion: { en: 'Initial claim assertion.' },
        quote: { en: 'Initial quoted text.' },
        quoteLanguage: 'en',
        locatorType: 'page',
        locatorValue: { und: '42' },
      },
      userId
    );

    assert.equal(created.claimId, claimId);
    assert.equal(created.locatorValue?.und, '42');

    const updatedClaimId = `${claimId}-updated`;
    const updated = await updateCitationClaim(
      dal,
      {
        key: citationKey,
        claimId,
        newClaimId: updatedClaimId,
        assertion: { en: 'Updated claim assertion.' },
        revSummary: { en: 'Update claim assertion.' },
      },
      userId
    );

    assert.equal(updated.claimId, updatedClaimId);
    assert.equal(updated.assertion?.en, 'Updated claim assertion.');

    const readBack = await readCitationClaim(dal, citationKey, updatedClaimId);
    assert.equal(readBack.claimId, updatedClaimId);
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service deleteCitation soft-deletes a citation', async () => {
  const dal = await getDal();
  const citationKey = `test-delete-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const userId = user.id;

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation to Delete',
          URL: 'https://example.com/delete-test',
        },
      },
      userId
    );

    const readBefore = await readCitation(dal, citationKey);
    assert.equal(readBefore.key, citationKey);
    await grantRoleUpsert(dal, userId, WIKI_ADMIN_ROLE);

    const deleteResult = await deleteCitation(
      dal,
      { key: citationKey, revSummary: { en: 'Admin deletion.' } },
      userId
    );

    assert.equal(deleteResult.deleted, true);
    assert.equal(deleteResult.key, citationKey);
    const citationDeleteRow = await dal.query(
      'SELECT _rev_summary FROM citations WHERE key = $1 AND _old_rev_of IS NULL AND _rev_deleted = true',
      [citationKey]
    );
    assert.equal(citationDeleteRow.rowCount, 1);
    assert.deepEqual(
      (citationDeleteRow.rows[0] as { _rev_summary: Record<string, string> | null })._rev_summary,
      { en: 'Admin deletion.' }
    );

    await assert.rejects(
      () => readCitation(dal, citationKey),
      error => {
        assert.ok(error instanceof NotFoundError);
        return true;
      }
    );
  } finally {
    await cleanupTestArtifacts(dal, {
      citationPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});
