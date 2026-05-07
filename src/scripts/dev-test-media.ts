// One-shot script to exercise the media pipeline against the real Commons API.
// Creates a test user, registers a Commons file as a media entity, renders
// markdown that references it, and prints results. Cleans up by default.
//
//   tsx src/scripts/dev-test-media.ts            # uses default Commons title
//   tsx src/scripts/dev-test-media.ts "File:..." # custom Commons title
//   tsx src/scripts/dev-test-media.ts --keep     # leave the entity behind for browser inspection
import { randomBytes } from 'node:crypto';

import { initializePostgreSQL } from '../db.js';
import { loadMediaEntriesForSources } from '../lib/media-render.js';
import User from '../models/user.js';
import { renderMarkdown } from '../render.js';
import { createMedia } from '../services/media-service.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const positional = args.filter(arg => !arg.startsWith('--'));
const commonsTitle =
  positional[0] ?? 'File:Erik Moeller, cross processed portrait.JPG';

const main = async () => {
  const dal = await initializePostgreSQL();
  const stamp = Date.now();
  const username = `mediatest${stamp}`;
  const email = `media-test-${stamp}@example.com`;
  const slug = `dev-test-${stamp}`;

  const user = await User.create({
    username,
    displayName: 'Media Dev Test',
    email,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });

  console.log(`\n[1/3] Created test user ${user.id}`);
  console.log(`[2/3] Fetching Commons metadata for: ${commonsTitle}`);

  let createdSlug: string | null = null;
  try {
    const created = await createMedia(
      dal,
      {
        slug,
        commonsTitle,
        title: { en: 'Erik Möller (dev test)' },
        caption: { en: 'Caption from the dev test script' },
        revSummary: { en: 'Initial registration via dev-test-media script.' },
      },
      user.id
    );
    createdSlug = created.slug;

    console.log(`[3/3] Created media entity: slug=${created.slug}`);
    console.log('--- entity summary ---');
    const data = created.data as Record<string, unknown>;
    console.log({
      mediaType: created.mediaType,
      commonsTitle: created.commonsTitle,
      mime: data.mime,
      width: data.width,
      height: data.height,
      license: data.license,
      author: data.author,
      thumbnailUrlTemplate: data.thumbnailUrlTemplate,
      commonsPageUrl: data.commonsPageUrl,
    });

    const sample = [
      '# Demo',
      '',
      `![A view](/media/${created.slug}){size=500 caption="Caption override from markdown"}`,
      '',
      `Inline reference: ![inline view](/media/${created.slug}){size=250} in flowing text.`,
      '',
      `![Larger render](/media/${created.slug}){size=800}`,
      '',
    ].join('\n');
    const registry = await loadMediaEntriesForSources(dal, [sample]);
    const rendered = await renderMarkdown(sample, [], { mediaRegistry: registry, locale: 'en' });
    console.log('\n--- rendered HTML ---');
    console.log(rendered.html);

    if (keep) {
      console.log(`\nLeft entity in place. Visit http://localhost:3000/media/${created.slug} to inspect.`);
      console.log(`Test user id: ${user.id}`);
    }
  } finally {
    // Hard DELETE is intentional for this dev script — fast, contained,
    // and reverses the run completely. Production code MUST go through
    // `deleteMedia` (soft-delete + storage cleanup + admin role check)
    // and `User`-model deletion. Do not lift this pattern into seed
    // scripts or admin tooling.
    if (!keep && createdSlug) {
      await dal.query('DELETE FROM media WHERE slug = $1', [createdSlug]);
      console.log('\nCleaned up media entity.');
    }
    if (!keep) {
      await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
      console.log('Cleaned up test user.');
    }
    await dal.disconnect();
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
