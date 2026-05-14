import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';

import { McpToolError } from './errors.js';

export type ImageExtension = 'jpg' | 'png' | 'gif' | 'webp';

export interface StoredThumbnail {
  // Absolute path on disk. Route handler streams from here.
  path: string;
  // Extension matches detected file signature, allowlist-validated.
  extension: ImageExtension;
}

export interface MediaStorage {
  // Sync-feeling lookup for an existing thumbnail. Returns null on
  // miss; never fetches.
  findStored(slug: string, wikimediaStep: number): Promise<StoredThumbnail | null>;

  // Fetches sourceUrl, validates (size + MIME + extension), atomically
  // moves into place. Returns the stored entry. Throws McpToolError
  // with details.kind ∈ {size, mime, fetch, io} on failure. Idempotent
  // overwrite for the same (slug, step).
  storeThumbnail(
    slug: string,
    wikimediaStep: number,
    sourceUrl: string
  ): Promise<StoredThumbnail>;

  // Removes every thumbnail under <slug>/. Used by deleteMedia and
  // refreshMedia (wipe-and-rebuild-on-demand).
  deleteAllForSlug(slug: string): Promise<void>;

  // Atomically renames the slug directory. Used by updateMedia when
  // newSlug is provided.
  renameSlug(oldSlug: string, newSlug: string): Promise<void>;
}

export interface FilesystemMediaStorageOptions {
  stagingPath: string;
  finalPath: string;
  maxFileBytes: number;
  allowedExtensions: ReadonlyArray<ImageExtension>;
  fetchTimeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

const ENOENT = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

export const detectImageExtension = async (buf: Buffer): Promise<ImageExtension | null> => {
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(buf);
  } catch {
    return null;
  }
  if (!detected) return null;
  if (detected.ext === 'jpg' || detected.ext === 'png' || detected.ext === 'gif') {
    return detected.ext;
  }
  if (detected.ext === 'webp') return 'webp';
  return null;
};

export class FilesystemMediaStorage implements MediaStorage {
  constructor(private readonly opts: FilesystemMediaStorageOptions) {}

  private slugFinalDir(slug: string): string {
    return path.join(this.opts.finalPath, slug);
  }

  async findStored(slug: string, wikimediaStep: number): Promise<StoredThumbnail | null> {
    const dir = this.slugFinalDir(slug);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (ENOENT(err)) return null;
      throw err;
    }
    const prefix = `${wikimediaStep}.`;
    const match = entries.find(e => e.startsWith(prefix));
    if (!match) return null;
    const ext = match.slice(prefix.length) as ImageExtension;
    if (!this.opts.allowedExtensions.includes(ext)) return null;
    return { path: path.join(dir, match), extension: ext };
  }

  async storeThumbnail(
    slug: string,
    wikimediaStep: number,
    sourceUrl: string
  ): Promise<StoredThumbnail> {
    await fs.mkdir(this.opts.stagingPath, { recursive: true });
    const stagingFile = path.join(this.opts.stagingPath, `${randomUUID()}.tmp`);

    let succeeded = false;
    try {
      // 1. Fetch (with timeout, streaming, size cap).
      const controller = new AbortController();
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(sourceUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': this.opts.userAgent,
            // Avoid surprises from Wikimedia's content negotiation
            // (it can serve WebP via Accept). We accept the common
            // image types we allowlist; bytes are still signature-checked.
            Accept: 'image/jpeg, image/png, image/gif, image/webp',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new McpToolError(
          'internal_error',
          `Failed to fetch thumbnail: ${message}`,
          { details: { kind: 'fetch', sourceUrl }, retryable: true }
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new McpToolError(
          'internal_error',
          `Thumbnail fetch returned status ${response.status}.`,
          {
            details: { kind: 'fetch', status: response.status, sourceUrl },
            // 5xx is worth retrying; 4xx means the request itself is bad
            // (e.g., a stale thumbnailUrlTemplate after a Commons rename).
            retryable: response.status >= 500,
          }
        );
      }
      if (!response.body) {
        throw new McpToolError('internal_error', 'Thumbnail fetch returned empty body.', {
          details: { kind: 'fetch', sourceUrl },
          retryable: true,
        });
      }

      let bytesWritten = 0;
      const writeStream = createWriteStream(stagingFile);
      const reader = response.body.getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          bytesWritten += value.byteLength;
          if (bytesWritten > this.opts.maxFileBytes) {
            controller.abort();
            throw new McpToolError(
              'validation_error',
              `Thumbnail exceeds ${this.opts.maxFileBytes} bytes.`,
              { details: { kind: 'size', maxFileBytes: this.opts.maxFileBytes } }
            );
          }
          if (!writeStream.write(Buffer.from(value))) {
            await new Promise<void>(resolve => writeStream.once('drain', () => resolve()));
          }
        }
      } finally {
        writeStream.end();
        await new Promise<void>((resolve, reject) => {
          writeStream.once('finish', () => resolve());
          writeStream.once('error', reject);
        });
      }

      // 2. Detect type from file signatures.
      const head = Buffer.alloc(4100);
      const fd = await fs.open(stagingFile, 'r');
      let bytesRead = 0;
      try {
        const result = await fd.read(head, 0, head.length, 0);
        bytesRead = result.bytesRead;
      } finally {
        await fd.close();
      }
      const detected = await detectImageExtension(head.subarray(0, bytesRead));
      if (!detected) {
        throw new McpToolError(
          'validation_error',
          'Thumbnail bytes did not match any supported image format (jpg/png/gif/webp).',
          { details: { kind: 'mime' } }
        );
      }
      if (!this.opts.allowedExtensions.includes(detected)) {
        throw new McpToolError(
          'validation_error',
          `Thumbnail format ${detected} is not in the allowlist.`,
          { details: { kind: 'mime', detected, allowed: this.opts.allowedExtensions } }
        );
      }

      // 3. Atomic rename into the slug directory.
      const slugDir = this.slugFinalDir(slug);
      await fs.mkdir(slugDir, { recursive: true });
      const finalFile = path.join(slugDir, `${wikimediaStep}.${detected}`);
      await fs.rename(stagingFile, finalFile);

      succeeded = true;
      return { path: finalFile, extension: detected };
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new McpToolError('internal_error', `Thumbnail storage I/O error: ${message}`, {
        details: { kind: 'io' },
        retryable: false,
      });
    } finally {
      if (!succeeded) {
        try {
          await fs.unlink(stagingFile);
        } catch {
          // best-effort cleanup; nothing to do if already gone
        }
      }
    }
  }

  async deleteAllForSlug(slug: string): Promise<void> {
    const dir = this.slugFinalDir(slug);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      if (ENOENT(err)) return;
      throw err;
    }
  }

  async renameSlug(oldSlug: string, newSlug: string): Promise<void> {
    if (oldSlug === newSlug) return;
    const oldDir = this.slugFinalDir(oldSlug);
    const newDir = this.slugFinalDir(newSlug);
    // Ensure new parent exists (multi-segment slug case).
    await fs.mkdir(path.dirname(newDir), { recursive: true });
    try {
      await fs.rename(oldDir, newDir);
    } catch (err) {
      if (ENOENT(err)) {
        // No thumbnails to move — fine. Service-layer rename
        // succeeds even when nothing was cached yet.
        return;
      }
      throw err;
    }
  }
}
