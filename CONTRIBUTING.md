# Contributing to AGP Wiki

Thanks for helping improve AGP Wiki.

## Quick start

1. **Prerequisites:** Node.js 22.x, PostgreSQL 16+
2. **Clone** the repository
3. **Set up PostgreSQL** (see Database Setup below)
4. **Install dependencies:** `npm install`
5. **Start dev server:** `npm run dev`

## Database setup

The DAL expects a dedicated user with full privileges on a primary database (`agpwiki`) and a test database (`agpwiki_test`). The user also needs `CREATEDB`: `npm test` creates a database per test file (see [Checks](#checks)). Migrations create tables, sequences and the `pgcrypto` extension, so the user needs permission for those in each database.

### 1. Install PostgreSQL 16 or newer

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib
```

**macOS (Homebrew):**
```bash
brew install postgresql
brew services start postgresql
```

### 2. Ensure PostgreSQL is running

**Linux:**
```bash
sudo service postgresql start
```

**macOS:** Use `brew services list` to confirm PostgreSQL is running.

### 3. Create the application role and databases

**Using psql:**
```bash
sudo -u postgres psql

-- Create the login role (CREATEDB lets the tests give each test file its own database)
CREATE ROLE agpwiki_user LOGIN CREATEDB PASSWORD 'agpwiki_password';

-- Create the databases
CREATE DATABASE agpwiki OWNER agpwiki_user;
CREATE DATABASE agpwiki_test OWNER agpwiki_user;
\q
```

**Using command-line helpers:**
```bash
sudo -u postgres createuser --login --createdb --pwprompt agpwiki_user
sudo -u postgres createdb agpwiki -O agpwiki_user
sudo -u postgres createdb agpwiki_test -O agpwiki_user
```

### 4. Grant permissions and enable extensions

Run the provided setup script:

```bash
sudo -u postgres psql \
  -v app_db=agpwiki \
  -v app_user=agpwiki_user \
  -v test_db=agpwiki_test \
  -v test_user=agpwiki_user \
  -f node_modules/rev-dal/setup-db-grants.sql
```

This script:
- Grants `agpwiki_user` all privileges on both databases
- Sets default privileges for future tables/sequences
- Installs the `pgcrypto` extension (needed for UUID generation)

### 5. Initialize the schema

Start the application once to run migrations:

```bash
npm run dev
```

The application automatically applies pending migrations on startup. You can stop it (Ctrl+C) after it finishes booting if you only need to initialize the database.

## MCP policy bootstrap

MCP write tools require callers to read `/meta/policy` and submit its current
`contentHash` as `policyHash`. Fresh deployments may need to create that page
before the normal policy check can succeed.

For that bootstrap window only, a sysadmin can explicitly set:

```json5
mcp: {
  skipPolicyCheck: true,
}
```

Use the setting only long enough to create or repair `/meta/policy`, then remove
it or set it back to `false` and restart the MCP server.

### Troubleshooting

- **Connection failures:** Verify PostgreSQL is running on `localhost:5432`
- **Permission errors:** Re-run `node_modules/rev-dal/setup-db-grants.sql`
- **Missing extensions:** Ensure `pgcrypto` exists in both databases
- **`permission denied to create database` in tests:** Grant `CREATEDB` to the role (see [Checks](#checks))

## Media thumbnail caching

Thumbnail requests resolve the current media revision in PostgreSQL before
checking disk. Cached files live under `<slug>/_revisions/<revId>/`, so a
refresh or slug reuse cannot select thumbnails left by an older revision.
Updates, refreshes, and deletions reclaim cached files on a best-effort basis;
cleanup failures are logged and do not turn a committed edit into an error.

Slug-only cache files from older deployments are ignored and thumbnails rebuild
on demand. Those files are reclaimed by subsequent edits or deletions.

## Checks

CI runs `npm run lint`, `npm run typecheck` and `npm test`. It also builds the
app and starts each production entry point (web, MCP HTTP, MCP stdio) from
`dist/` against `agpwiki_test`:

```bash
npm run build
npm run smoke:start
```

The smoke test needs ports 3000 and 3333 free. On failure it prints each
process's output; set `SMOKE_VERBOSE=1` to print it on success too.

### Test databases

A test file that uses PostgreSQL starts with this import, before any other:

```ts
import './_use-database.js';
```

The file then gets its own database, copied from `agpwiki_test_template`, so
test files running in parallel cannot affect each other. The template is
migrated once per run, and each file's database is dropped when the file
finishes, so tests need no cleanup. Tests in the same file share a database:
page creation refuses likely duplicates, so fixture pages need titles that are
unique within their file. Importing it after anything that loads `config`
throws, because config reads its settings only once.

Test files without the import get no database, and therefore open no
connection: if one connects, it fails with `database
"agpwiki_test_file_none_requested" does not exist`, which means it needs the
import. Files that use the database are named `*.integration.test.ts` by
convention, but the import is what gives a file a database.

Several runs can share the PostgreSQL server at once, for example from two
terminals. Each test process holds a PostgreSQL advisory lock on its database
for as long as it runs, and a new run's setup only drops file databases whose
process has exited, such as those left by an interrupted run. The harness and
its tests are in `test/_database.ts` and `test/test-databases.integration.test.ts`.

To run selected files with the same setup:

```bash
npm run test:file -- test/forum.integration.test.ts test/slug.test.ts
```

The database role needs `CREATEDB`. For a role created before this requirement:

```bash
sudo -u postgres psql -c "ALTER ROLE agpwiki_user CREATEDB;"
```
