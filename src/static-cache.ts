import path from 'node:path';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const FAST_ASSET_EXTENSIONS = new Set(['.css', '.js']);

export const getStaticCacheControl = (requestPath: string, hasVersionQuery: boolean) => {
  const extension = path.extname(requestPath).toLowerCase();

  if (hasVersionQuery) {
    return 'public, max-age=31536000, immutable';
  }

  if (FONT_EXTENSIONS.has(extension)) {
    return 'public, max-age=2592000';
  }

  if (FAST_ASSET_EXTENSIONS.has(extension)) {
    return 'public, max-age=3600';
  }

  return 'public, max-age=300';
};
