// One-shot seed script: imports a snapshot of agpedia.org's /meta/*
// pages and a few example articles into the LOCAL dev DB so an
// agentic test has a realistic orientation surface to work against.
// Idempotent — skips pages that already exist; doesn't update bodies.
//
// Inputs: pre-fetched markdown bodies in agentic-testing/seed/meta/
// (use `agentic-testing/lib/refresh-seed.sh` to populate them, or
// `agentic-testing/run refresh-seed`).
//
// Run from the agpwiki repo root:
//   node --import tsx agentic-testing/lib/seed-meta.ts

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializePostgreSQL } from '../../src/db.js';
import { createWikiPage } from '../../src/services/wiki-page-service.js';
import User from '../../src/models/user.js';
import WikiPage from '../../src/models/wiki-page.js';

const SEED_USER_EMAIL = 'agentic-test@example.com';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../seed/meta');

// (slug, title) pairs scraped from production HTML at seed time.
const SEEDS: ReadonlyArray<readonly [string, string]> = [
  ['meta/policy', 'Editorial Policies'],
  ['meta/values', 'Agpedia Values'],
  ['meta/scope', 'Agpedia Scope'],
  ['meta/contributing', 'Contributing to Agpedia'],
  ['meta/citations', 'Citation Standards'],
  ['meta/conduct', 'Operator Conduct'],
  ['meta/governance', 'Governance'],
  ['meta/style', 'Style Guide'],
  ['meta/mcp-reference', 'MCP Reference'],
  ['meta/setup', 'Agent Setup'],
  ['meta/wishlist', 'Article Wishlist'],
];

const slugToFilename = (slug: string) => `${slug.replace(/\//g, '_')}.md`;

const main = async () => {
  const dal = await initializePostgreSQL();
  const user = await User.filterWhere({ email: SEED_USER_EMAIL }).first();
  if (!user) {
    throw new Error(
      `Seed user not found: ${SEED_USER_EMAIL}. Run provision-user.ts first.`
    );
  }

  let created = 0;
  let skipped = 0;
  let missing = 0;

  for (const [slug, title] of SEEDS) {
    const existing = await WikiPage.filterWhere({
      slug,
      _oldRevOf: null,
      _revDeleted: false,
    } as Record<string, unknown>).first();
    if (existing) {
      console.log(`  skip ${slug} (exists)`);
      skipped += 1;
      continue;
    }

    const filename = slugToFilename(slug);
    const filePath = path.join(SEED_DIR, filename);
    let body: string;
    try {
      body = await fs.readFile(filePath, 'utf8');
    } catch {
      console.warn(`  miss ${slug} — no file at ${filePath}`);
      missing += 1;
      continue;
    }

    try {
      await createWikiPage(
        dal,
        {
          slug,
          title: { en: title },
          body: { en: body },
          originalLanguage: 'en',
          revSummary: { en: 'Snapshot from agpedia.org for local agentic-test seeding.' },
        },
        user.id
      );
      created += 1;
      console.log(`  ok   ${slug} (${title})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  fail ${slug}: ${msg}`);
    }
  }

  console.log(`\nDone. created=${created} skipped=${skipped} missing=${missing}`);
  await dal.disconnect();
  process.exit(0);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
