# Contributing to AGP Wiki

Thanks for helping improve AGP Wiki.

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
sudo -u postgres psql -f dal/setup-db-grants.sql
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

### Troubleshooting

- **Connection failures:** Verify PostgreSQL is running on `localhost:5432`
- **Permission errors:** Re-run `dal/setup-db-grants.sql`
- **Missing extensions:** Ensure `pgcrypto` exists in both databases
