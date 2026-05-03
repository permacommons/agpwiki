import path from 'node:path';
import config from 'config';

import {
  FilesystemMediaStorage,
  type ImageExtension,
  type MediaStorage,
} from '../lib/media-storage.js';

let cached: MediaStorage | null = null;

export const getMediaStorage = (): MediaStorage => {
  if (cached) return cached;

  const stagingPath = path.resolve(
    process.cwd(),
    config.get<string>('media.storage.filesystem.stagingPath')
  );
  const finalPath = path.resolve(
    process.cwd(),
    config.get<string>('media.storage.filesystem.finalPath')
  );

  cached = new FilesystemMediaStorage({
    stagingPath,
    finalPath,
    maxFileBytes: config.get<number>('media.storage.maxFileBytes'),
    allowedExtensions: config.get<readonly ImageExtension[]>(
      'media.storage.allowedExtensions'
    ),
    fetchTimeoutMs: config.get<number>('media.fetchTimeoutMs'),
    userAgent: config.get<string>('media.userAgent'),
  });
  return cached;
};

// Test-only: drop the cached singleton so a fresh one is built next
// time. Production code should never call this.
export const __resetMediaStorageForTests = () => {
  cached = null;
};
