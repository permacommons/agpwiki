import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { McpToolError } from '../src/lib/errors.js';
import {
  FilesystemMediaStorage,
  type ImageExtension,
  sniffImageMagic,
} from '../src/lib/media-storage.js';

const ALLOWED: ReadonlyArray<ImageExtension> = ['jpg', 'png', 'gif', 'webp'];

const setupTempStorage = async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'media-storage-'));
  const stagingPath = path.join(root, 'staging');
  const finalPath = path.join(root, 'files');
  await fs.mkdir(stagingPath, { recursive: true });
  await fs.mkdir(finalPath, { recursive: true });
  return { root, stagingPath, finalPath };
};

const cleanupTempStorage = async (root: string) => {
  await fs.rm(root, { recursive: true, force: true });
};

// Constructs a fetch impl that returns the given bytes with the given
// HTTP status. Lets tests inject precise byte sequences without
// hitting the network.
const stubBytesFetch = (
  bytes: Uint8Array,
  { status = 200, contentType = 'image/jpeg' }: { status?: number; contentType?: string } = {}
): typeof fetch =>
  (async () =>
    new Response(bytes, {
      status,
      headers: { 'content-type': contentType },
    })) as unknown as typeof fetch;

const stubFetchError = (message: string): typeof fetch =>
  (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;

// Magic-byte prefixes for synthetic test bytes.
const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF_HEAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
const WEBP_HEAD = Uint8Array.from([
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
]);

const padBytes = (head: Uint8Array, totalLen: number): Uint8Array => {
  if (totalLen <= head.length) return head;
  const out = new Uint8Array(totalLen);
  out.set(head, 0);
  return out;
};

test('sniffImageMagic recognizes the four allowlisted formats', () => {
  assert.equal(sniffImageMagic(Buffer.from(JPEG_HEAD)), 'jpg');
  assert.equal(sniffImageMagic(Buffer.from(PNG_HEAD)), 'png');
  assert.equal(sniffImageMagic(Buffer.from(GIF_HEAD)), 'gif');
  assert.equal(sniffImageMagic(Buffer.from(WEBP_HEAD)), 'webp');
});

test('sniffImageMagic returns null for non-image bytes', () => {
  assert.equal(sniffImageMagic(Buffer.from('plain text yo!!!')), null);
  assert.equal(sniffImageMagic(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])), null);
});

test('sniffImageMagic returns null on too-short buffer', () => {
  assert.equal(sniffImageMagic(Buffer.from([0xff, 0xd8])), null);
});

test('storeThumbnail happy path: writes to final dir, returns extension', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(JPEG_HEAD),
    });

    const stored = await storage.storeThumbnail('erik-portrait', 500, 'https://example/foo.jpg');
    assert.equal(stored.extension, 'jpg');
    assert.equal(stored.path, path.join(finalPath, 'erik-portrait', '500.jpg'));

    // Staging dir empty after success.
    const stagingEntries = await fs.readdir(stagingPath);
    assert.deepEqual(stagingEntries, []);

    // File on disk has the expected bytes.
    const onDisk = await fs.readFile(stored.path);
    assert.deepEqual(Uint8Array.from(onDisk), JPEG_HEAD);
  } finally {
    await cleanupTempStorage(root);
  }
});

test('storeThumbnail handles multi-segment slug by nesting directories', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(PNG_HEAD),
    });

    const stored = await storage.storeThumbnail(
      'biology/erik-portrait',
      250,
      'https://example/foo.png'
    );
    assert.equal(stored.extension, 'png');
    assert.equal(
      stored.path,
      path.join(finalPath, 'biology', 'erik-portrait', '250.png')
    );
  } finally {
    await cleanupTempStorage(root);
  }
});

test('storeThumbnail rejects oversize bytes (size cap, leaves staging empty)', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const tinyMax = 1024; // 1 KB cap
    const big = padBytes(JPEG_HEAD, 5000);
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: tinyMax,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(big),
    });

    await assert.rejects(
      storage.storeThumbnail('foo', 500, 'https://example/big.jpg'),
      (err: unknown) =>
        err instanceof McpToolError &&
        err.code === 'validation_error' &&
        (err.details as { kind?: string } | undefined)?.kind === 'size'
    );

    // Staging cleaned up.
    const stagingEntries = await fs.readdir(stagingPath);
    assert.deepEqual(stagingEntries, []);
    // No final file created.
    const finalDir = path.join(finalPath, 'foo');
    await assert.rejects(fs.readdir(finalDir), { code: 'ENOENT' });
  } finally {
    await cleanupTempStorage(root);
  }
});

test('storeThumbnail rejects bytes that do not match any supported format', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const garbage = Buffer.from('this is not an image, this is plain ASCII text and goes on');
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(Uint8Array.from(garbage)),
    });

    await assert.rejects(
      storage.storeThumbnail('foo', 500, 'https://example/foo.jpg'),
      (err: unknown) =>
        err instanceof McpToolError &&
        err.code === 'validation_error' &&
        (err.details as { kind?: string } | undefined)?.kind === 'mime'
    );

    const stagingEntries = await fs.readdir(stagingPath);
    assert.deepEqual(stagingEntries, []);
  } finally {
    await cleanupTempStorage(root);
  }
});

test('storeThumbnail rejects extension outside the allowlist', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    // Allowlist excludes webp; serve WebP bytes; expect rejection.
    const allowedSubset: ReadonlyArray<ImageExtension> = ['jpg', 'png', 'gif'];
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: allowedSubset,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(WEBP_HEAD),
    });

    await assert.rejects(
      storage.storeThumbnail('foo', 500, 'https://example/foo.webp'),
      (err: unknown) =>
        err instanceof McpToolError &&
        err.code === 'validation_error' &&
        (err.details as { kind?: string } | undefined)?.kind === 'mime'
    );
  } finally {
    await cleanupTempStorage(root);
  }
});

test('storeThumbnail wraps fetch failure as retryable internal_error', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubFetchError('network unreachable'),
    });

    await assert.rejects(
      storage.storeThumbnail('foo', 500, 'https://example/foo.jpg'),
      (err: unknown) =>
        err instanceof McpToolError &&
        err.code === 'internal_error' &&
        err.retryable === true &&
        (err.details as { kind?: string } | undefined)?.kind === 'fetch'
    );

    const stagingEntries = await fs.readdir(stagingPath);
    assert.deepEqual(stagingEntries, []);
  } finally {
    await cleanupTempStorage(root);
  }
});

test('findStored returns null when nothing cached', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
    });
    assert.equal(await storage.findStored('nope', 500), null);
  } finally {
    await cleanupTempStorage(root);
  }
});

test('findStored returns the cached entry after store', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(JPEG_HEAD),
    });
    await storage.storeThumbnail('erik', 250, 'https://example/foo.jpg');
    const stored = await storage.findStored('erik', 250);
    assert.ok(stored);
    assert.equal(stored.extension, 'jpg');
    assert.equal(await storage.findStored('erik', 500), null);
  } finally {
    await cleanupTempStorage(root);
  }
});

test('deleteAllForSlug removes the slug directory', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(JPEG_HEAD),
    });
    await storage.storeThumbnail('erik', 250, 'https://example/foo.jpg');
    await storage.storeThumbnail('erik', 500, 'https://example/foo.jpg');
    assert.ok(await storage.findStored('erik', 250));

    await storage.deleteAllForSlug('erik');

    assert.equal(await storage.findStored('erik', 250), null);
    assert.equal(await storage.findStored('erik', 500), null);

    // Idempotent: deleting again is a no-op.
    await storage.deleteAllForSlug('erik');
  } finally {
    await cleanupTempStorage(root);
  }
});

test('renameSlug moves cached thumbnails to a new directory', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(PNG_HEAD),
    });
    await storage.storeThumbnail('erik', 250, 'https://example/foo.png');
    await storage.renameSlug('erik', 'erik-portrait');

    assert.equal(await storage.findStored('erik', 250), null);
    const moved = await storage.findStored('erik-portrait', 250);
    assert.ok(moved);
    assert.equal(moved.extension, 'png');
  } finally {
    await cleanupTempStorage(root);
  }
});

test('renameSlug into a multi-segment target creates parent dirs', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
      fetchImpl: stubBytesFetch(PNG_HEAD),
    });
    await storage.storeThumbnail('erik', 250, 'https://example/foo.png');
    await storage.renameSlug('erik', 'biology/erik-portrait');

    const moved = await storage.findStored('biology/erik-portrait', 250);
    assert.ok(moved);
  } finally {
    await cleanupTempStorage(root);
  }
});

test('renameSlug is a no-op when source dir is missing', async () => {
  const { root, stagingPath, finalPath } = await setupTempStorage();
  try {
    const storage = new FilesystemMediaStorage({
      stagingPath,
      finalPath,
      maxFileBytes: 25 * 1024 * 1024,
      allowedExtensions: ALLOWED,
      fetchTimeoutMs: 5000,
      userAgent: 'test',
    });
    // Should not throw — DB-level rename succeeds even when nothing
    // was ever cached.
    await storage.renameSlug('never-stored', 'still-never-stored');
  } finally {
    await cleanupTempStorage(root);
  }
});
