#!/usr/bin/env node

import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { PostgresConfig } from 'config';
import config from 'config';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const findProjectRoot = (fromDir: string): string => {
  let currentDir: string | undefined = fromDir;

  while (currentDir) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    currentDir = parentDir === currentDir ? undefined : parentDir;
  }

  throw new Error('Unable to determine project root directory');
};

const PROJECT_ROOT = findProjectRoot(moduleDir);
const EXPORT_DIR = path.join(PROJECT_ROOT, 'public/downloads/dumps');
const ISO_DATE = new Date().toISOString().split('T')[0];
const SQL_FILE = `dump-${ISO_DATE}.sql`;
const TAR_FILE = `dump-${ISO_DATE}.tgz`;
const TEMP_SCHEMA = 'dump_public_export';

const isCurrent = (alias: string): string =>
  `${alias}._old_rev_of IS NULL AND COALESCE(${alias}._rev_deleted, FALSE) = FALSE`;

type SelectOverrides = Record<string, string>;

interface ViewJoin {
  type?: string;
  target: string;
  alias?: string;
  on: string;
}

interface ViewConfig {
  name: string;
  baseTable: string;
  alias: string;
  selectOverrides?: SelectOverrides;
  joins?: ViewJoin[];
  where?: string;
}

interface RunCommandOptions extends SpawnOptions {
  outputStream?: Writable;
}

const sanitizedUserOverrides: SelectOverrides = {
  email: "('redacted+' || u.id::text || '@example.invalid')::VARCHAR(254)",
  password_hash: "'redacted'::VARCHAR(255)",
};

const VIEW_CONFIGS: ViewConfig[] = [
  {
    name: 'sanitized_users',
    baseTable: 'users',
    alias: 'u',
    selectOverrides: sanitizedUserOverrides,
  },
  {
    name: 'current_pages',
    baseTable: 'pages',
    alias: 'p',
    where: isCurrent('p'),
  },
  {
    name: 'current_citations',
    baseTable: 'citations',
    alias: 'c',
    where: isCurrent('c'),
  },
  {
    name: 'current_posts',
    baseTable: 'posts',
    alias: 'po',
    where: isCurrent('po'),
  },
  {
    name: 'current_page_aliases',
    baseTable: 'page_aliases',
    alias: 'pa',
    joins: [
      {
        target: `${TEMP_SCHEMA}.current_pages`,
        alias: 'p',
        on: 'p.id = pa.page_id',
      },
    ],
  },
  {
    name: 'current_page_checks',
    baseTable: 'page_checks',
    alias: 'pc',
    joins: [
      {
        target: `${TEMP_SCHEMA}.current_pages`,
        alias: 'p',
        on: 'p.id = pc.page_id',
      },
    ],
    where: isCurrent('pc'),
  },
  {
    name: 'current_citation_claims',
    baseTable: 'citation_claims',
    alias: 'cc',
    joins: [
      {
        target: `${TEMP_SCHEMA}.current_citations`,
        alias: 'c',
        on: 'c.id = cc.citation_id',
      },
    ],
    where: isCurrent('cc'),
  },
];

const pgConfig = config.get<PostgresConfig>('postgres');
const dbHost = pgConfig.host ?? 'localhost';
const dbPort = pgConfig.port ?? 5432;
const dbName = pgConfig.database ?? 'agpwiki';
const dbUser = pgConfig.user ?? 'agpwiki_user';

console.log('Creating sanitized public database dump...');
console.log(`Database: ${dbName} on ${dbHost}:${dbPort}`);

if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

const outputPath = path.join(EXPORT_DIR, SQL_FILE);
const tarPath = path.join(EXPORT_DIR, TAR_FILE);
const indexPath = path.join(EXPORT_DIR, 'index.html');

function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { outputStream, stdio, ...spawnOverrides } = options;
    const spawnOptions: SpawnOptions = {
      ...spawnOverrides,
      stdio: outputStream ? ['ignore', 'pipe', 'inherit'] : (stdio ?? 'inherit'),
    };

    const proc = spawn(command, args, spawnOptions);

    if (outputStream && proc.stdout) {
      proc.stdout.pipe(outputStream, { end: false });
    }

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatTimestamp(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(value);
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function writeDumpIndex(): void {
  const entries = fs
    .readdirSync(EXPORT_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.tgz'))
    .map(entry => {
      const filePath = path.join(EXPORT_DIR, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        mtime: stats.mtime,
        size: stats.size,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const rows = entries
    .map(
      entry => `      <tr>
        <td><a href="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</a></td>
        <td>${formatTimestamp(entry.mtime)}</td>
        <td>${formatSize(entry.size)}</td>
      </tr>`
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agpedia Public Database Dumps</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: #fffaf0;
        --text: #1f1a14;
        --muted: #6b6257;
        --line: #d7cdbd;
        --accent: #8c3b19;
      }

      body {
        margin: 0;
        padding: 2rem;
        background: linear-gradient(180deg, #efe6d6 0%, var(--bg) 100%);
        color: var(--text);
        font: 16px/1.5 "IBM Plex Sans", system-ui, sans-serif;
      }

      main {
        max-width: 56rem;
        margin: 0 auto;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 2rem;
        box-shadow: 0 10px 30px rgba(49, 33, 18, 0.08);
      }

      h1 {
        margin: 0 0 0.5rem;
        font: 600 2rem/1.1 "Source Serif 4", Georgia, serif;
      }

      p {
        margin: 0 0 1.5rem;
        color: var(--muted);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        text-align: left;
        padding: 0.75rem 0;
        border-top: 1px solid var(--line);
      }

      th {
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }

      a {
        color: var(--accent);
        text-decoration: none;
      }

      a:hover, a:focus-visible {
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Agpedia Public Database Dumps</h1>
      <p>These database dumps are in PostgreSQL format. They redact sensitive information while preserving the full schema for public reuse.</p>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Updated</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </main>
  </body>
</html>
`;

  fs.writeFileSync(indexPath, html);
}

async function getTableColumnNames(tableName: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const columnsQuery = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${tableName}'
    ORDER BY ordinal_position
  `.trim();

  return new Promise((resolve, reject) => {
    const psql = spawn('psql', ['-t', '-A', '-c', columnsQuery], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';

    if (psql.stdout) {
      psql.stdout.on('data', data => {
        output += data.toString();
      });
    }

    psql.on('close', code => {
      if (code === 0) {
        const columns = output
          .split('\n')
          .map(entry => entry.trim())
          .filter(Boolean);
        resolve(columns);
      } else {
        reject(new Error(`psql exited with code ${code}`));
      }
    });
    psql.on('error', reject);
  });
}

async function getTableColumnsString(tableName: string, env: NodeJS.ProcessEnv): Promise<string> {
  const columns = await getTableColumnNames(tableName, env);
  return columns.join(', ');
}

async function createViewFromConfig(configEntry: ViewConfig, env: NodeJS.ProcessEnv): Promise<void> {
  const columns = await getTableColumnNames(configEntry.baseTable, env);
  const selectExpressions = columns.map(column => {
    if (configEntry.selectOverrides && Object.hasOwn(configEntry.selectOverrides, column)) {
      return `${configEntry.selectOverrides[column]} AS ${column}`;
    }
    return `${configEntry.alias}.${column}`;
  });

  const selectSection = selectExpressions.map(expr => `  ${expr}`).join(',\n');
  const lines = [
    `CREATE VIEW ${TEMP_SCHEMA}.${configEntry.name} AS`,
    'SELECT',
    selectSection,
    `FROM public.${configEntry.baseTable} ${configEntry.alias}`,
  ];

  if (configEntry.joins) {
    for (const join of configEntry.joins) {
      const joinType = join.type || 'JOIN';
      const aliasClause = join.alias ? ` ${join.alias}` : '';
      lines.push(`  ${joinType} ${join.target}${aliasClause} ON ${join.on}`);
    }
  }

  if (configEntry.where) {
    lines.push(`WHERE ${configEntry.where}`);
  }

  await runCommand('psql', ['-c', `${lines.join('\n')};`], { env });
}

async function copyFromView(
  targetTable: string,
  viewName: string,
  outputStream: fs.WriteStream,
  env: NodeJS.ProcessEnv,
  { orderBy = null }: { orderBy?: string | null } = {}
): Promise<void> {
  const columns = await getTableColumnsString(targetTable, env);
  outputStream.write(
    `\n--\n-- Data for Name: ${targetTable}; Type: TABLE DATA; Schema: public; Owner: -\n--\n\n`
  );
  outputStream.write(`COPY public.${targetTable} (${columns}) FROM stdin;\n`);

  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : '';
  const query = `COPY (SELECT * FROM ${viewName}${orderClause}) TO STDOUT`;

  await runCommand('psql', ['-c', query], { outputStream, env });
  outputStream.write('\\.\n\n');
}

async function ensureTempSchema(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand('psql', ['-c', `DROP SCHEMA IF EXISTS ${TEMP_SCHEMA} CASCADE`], { env });
  await runCommand('psql', ['-c', `CREATE SCHEMA ${TEMP_SCHEMA}`], { env });

  for (const configEntry of VIEW_CONFIGS) {
    await createViewFromConfig(configEntry, env);
  }
}

async function cleanupTempSchema(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand('psql', ['-c', `DROP SCHEMA IF EXISTS ${TEMP_SCHEMA} CASCADE`], { env });
}

async function createDump(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: dbHost,
    PGPORT: dbPort.toString(),
    PGDATABASE: dbName,
    PGUSER: dbUser,
  };

  if (pgConfig.password) {
    env.PGPASSWORD = pgConfig.password;
  }

  if (fs.existsSync(tarPath)) {
    console.log(`Overwriting existing dump for ${ISO_DATE}`);
  }

  let outputStream: fs.WriteStream | null = null;

  try {
    await ensureTempSchema(env);

    outputStream = fs.createWriteStream(outputPath);

    console.log('Step 1: Dumping schema...');
    await runCommand(
      'pg_dump',
      ['--schema-only', '--no-owner', '--no-privileges', '--no-tablespaces'],
      { outputStream, env }
    );

    console.log('Step 2: Dumping migrations table...');
    await runCommand(
      'pg_dump',
      ['--data-only', '--no-owner', '--no-privileges', '--table=migrations'],
      { outputStream, env }
    );

    console.log('Step 3: Dumping sanitized users...');
    await copyFromView('users', `${TEMP_SCHEMA}.sanitized_users`, outputStream, env, {
      orderBy: 'created_at',
    });

    console.log('Step 4: Dumping public content tables...');
    await copyFromView('pages', `${TEMP_SCHEMA}.current_pages`, outputStream, env);
    await copyFromView('citations', `${TEMP_SCHEMA}.current_citations`, outputStream, env);
    await copyFromView('posts', `${TEMP_SCHEMA}.current_posts`, outputStream, env);
    await copyFromView('page_aliases', `${TEMP_SCHEMA}.current_page_aliases`, outputStream, env);
    await copyFromView('page_checks', `${TEMP_SCHEMA}.current_page_checks`, outputStream, env);
    await copyFromView(
      'citation_claims',
      `${TEMP_SCHEMA}.current_citation_claims`,
      outputStream,
      env
    );

    outputStream.end();
    await once(outputStream, 'finish');

    console.log('Step 5: Compressing dump...');
    await runCommand('tar', ['-czf', tarPath, '-C', EXPORT_DIR, SQL_FILE], { stdio: 'inherit' });

    fs.unlinkSync(outputPath);

    const latestPath = path.join(EXPORT_DIR, 'latest.tgz');
    if (fs.existsSync(latestPath)) {
      fs.unlinkSync(latestPath);
    }
    fs.symlinkSync(TAR_FILE, latestPath);

    console.log('Step 6: Generating dump index page...');
    writeDumpIndex();

    const stats = fs.statSync(tarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`\nDump complete: ${tarPath}`);
    console.log(`Symlink updated: ${latestPath}`);
    console.log(`File size: ${sizeMB} MB`);
  } catch (error) {
    const serialized = error instanceof Error ? error : new Error(String(error));
    console.error('Error creating dump:', serialized);
    process.exitCode = 1;
  } finally {
    if (outputStream && !outputStream.closed) {
      outputStream.end();
      try {
        await once(outputStream, 'finish');
      } catch {
        // Ignore flush errors during teardown.
      }
    }

    try {
      await cleanupTempSchema(env);
    } catch (cleanupError) {
      const serializedCleanupError =
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      console.error('Failed to clean up temporary schema:', serializedCleanupError);
    }

    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // Ignore cleanup errors for partially written files.
      }
    }
  }
}

createDump().catch(error => {
  const serialized = error instanceof Error ? error : new Error(String(error));
  console.error('Fatal error:', serialized);
  process.exit(1);
});
