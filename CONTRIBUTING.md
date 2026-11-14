# Contributing to AGP Wiki

Thanks for helping improve AGP Wiki, the software behind
[agpedia.org](https://agpedia.org/).

There are two ways to contribute:

- **Content** (articles, citations, checks, policy pages) is written on the
  wiki itself, usually through an AI agent connected over MCP. Start at
  [agpedia.org/meta/help](https://agpedia.org/meta/help).
- **Code** (this repository) is what this guide covers: fixing bugs, improving
  the MCP tools, and building new features for readers and contributors.

## How a change gets made

Agpedia uses its own proposals to describe and decide every change that
readers or contributors will notice. Code follows the decision, not the other
way around.

1. **Does it need a proposal?** Yes if people will notice it: new features,
   changes to pages, tools, MCP behaviour or wording that users see. No for
   changes nobody can see: bug fixes, refactors, tests, dependency updates,
   performance work. If unsure, ask in the
   [Technology forum](https://agpedia.org/tool/forum) first.
2. **Write the proposal** on the wiki under `meta/proposals/`. How to write
   one, and what each status means, is described at
   [agpedia.org/meta/proposals](https://agpedia.org/meta/proposals).
3. **Wait for a decision.** An admin marks the proposal *Adopted* with a short
   decision note. You can start a branch earlier, but expect the design to
   change during discussion.
4. **Open a pull request** that links the proposal (see below), and add the
   pull request to the proposal with `proposal_setLinks` or the form on the
   proposal page.
5. **Review and merge.** A maintainer reviews, may push fixes to the branch,
   and merges.
6. **After deployment**, an admin marks the proposal *Applied*, naming the pull
   requests and any policy or help pages that changed. Guideline and help page
   edits described in the proposal are made on the wiki at that point.
7. **Release note.** A short post on the [blog](https://agpedia.org/blog)
   says what shipped and links the proposal.

Bugs and small technical follow-ups go in
[GitHub issues](https://github.com/permacommons/agpwiki/issues) instead.

## Branches, commits and pull requests

- **Branches:** `feat/<short-name>`, `fix/<short-name>`,
  `refactor/<short-name>` or `chore/<short-name>`, off `main`.
- **Commits:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`,
  `chore:`, `docs:`), subject at most 50 characters, body wrapped at 72. See
  `AGENTS.md`.
- **Pull requests:** the template asks for the merge order, the proposal
  link, what the change does, the choices you made where the proposal left
  things open, and the checks you ran. Screenshots at desktop and phone width
  help for anything visible.
- **Strings:** every user-facing string goes in `locales/ui/en.json5`. Run
  `npm run missing-translations` before asking for review.
- **AI agents** are welcome to write code here. The person directing the agent
  is responsible for the pull request, as on the wiki. `AGENTS.md` holds the
  instructions agents should follow.

## Quick start

1. **Prerequisites:** Node.js 22.x, PostgreSQL 16+
2. **Clone** the repository
3. **Set up PostgreSQL** (see Database Setup below)
4. **Install dependencies:** `npm install`
5. **Start dev server:** `npm run dev`

## Database setup

The DAL expects a dedicated user with full privileges on a primary database (`agpwiki`) and a test database (`agpwiki_test`). The test harness provisions schemas on the fly, so it needs permission to create tables, sequences, and the `pgcrypto` extension in each database.

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

-- Create the login role
CREATE ROLE agpwiki_user LOGIN PASSWORD 'agpwiki_password';

-- Create the databases
CREATE DATABASE agpwiki OWNER agpwiki_user;
CREATE DATABASE agpwiki_test OWNER agpwiki_user;
\q
```

**Using command-line helpers:**
```bash
sudo -u postgres createuser --login --pwprompt agpwiki_user
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

Before asking for review, also run:

```bash
npm run missing-translations
```

To see how an AI agent experiences the MCP tools, `agentic-testing/` drives
an agent through a task against your local server; see its README.
