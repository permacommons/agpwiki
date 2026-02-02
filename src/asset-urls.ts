import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

const versionedAssetUrl = (relativePath: string) => {
  const fullPath = path.resolve(PUBLIC_DIR, relativePath);
  const contents = fs.readFileSync(fullPath);
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
  return `/static/${relativePath}?v=${hash}`;
};

export const layoutAssets = {
  siteCss: versionedAssetUrl('styles/site.css'),
  searchJs: versionedAssetUrl('scripts/search.js'),
  metaTooltipsJs: versionedAssetUrl('scripts/meta-tooltips.js'),
  tocJs: versionedAssetUrl('scripts/toc.js'),
};
