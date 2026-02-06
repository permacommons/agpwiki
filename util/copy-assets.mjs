import { cpSync } from 'node:fs';
import path from 'node:path';

const ASSET_DIRS = ['src/mcp/prompt-library'];

const root = path.resolve(import.meta.dirname, '..');

for (const dir of ASSET_DIRS) {
  const src = path.join(root, dir);
  const dest = path.join(root, 'dist', dir);
  cpSync(src, dest, { recursive: true });
  console.log(`copied ${dir} → dist/${dir}`);
}
