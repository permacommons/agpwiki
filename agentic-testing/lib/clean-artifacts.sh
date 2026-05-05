#!/usr/bin/env bash
# Wipe agentic-test-authored artifacts from the local dev DB and
# (in --full mode) the media-storage cache. Idempotent. Leaves /meta/*
# seed pages alone.
#
# Modes (one is required — there is no default, because --full is
# destructive enough to need explicit operator opt-in):
#   --slug <slug>   Scoped: delete only the named page and its
#                   per-page dependents (page_aliases, page_checks).
#                   Citations, citation_claims, and media are
#                   preserved — they're not FK-linked to a single
#                   page in the data model and can be reused across
#                   runs. This is what `launch` uses when it can
#                   derive a slug from the task's Topic line.
#   --full          Nuclear: delete every non-/meta page plus this
#                   test user's citations, citation_claims, and media,
#                   and clear the media-storage cache directory. Use
#                   only when you actually want to wipe the dev DB's
#                   article namespace.
#
# Connection: PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE env vars.
# Defaults match the local docker-compose dev DB.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5435}"
PGUSER="${PGUSER:-agpwiki_user}"
PGPASSWORD="${PGPASSWORD:-agpwiki_password}"
PGDATABASE="${PGDATABASE:-agpwiki}"
TEST_USER_EMAIL="${AGENTIC_TEST_USER_EMAIL:-agentic-test@example.com}"

export PGPASSWORD

mode=""
slug=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) mode=slug; slug="${2:-}"; shift 2 ;;
    --slug=*) mode=slug; slug="${1#--slug=}"; shift ;;
    --full) mode=full; shift ;;
    *) echo "clean-artifacts.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$mode" ]]; then
  echo "clean-artifacts.sh: a mode flag is required (--slug <slug> or --full)" >&2
  exit 2
fi

if [[ "$mode" == "slug" ]] && [[ -z "$slug" ]]; then
  echo "clean-artifacts.sh: --slug requires a non-empty value" >&2
  exit 2
fi

if [[ "$mode" == "slug" ]]; then
  echo "scope: slug=$slug (target only — citations, claims, media preserved)"
  psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" \
    -v slug="$slug" <<'SQL'
DELETE FROM page_checks WHERE target_rev_id IN (
  SELECT _rev_id FROM pages WHERE slug = :'slug'
);
DELETE FROM page_aliases WHERE page_id IN (
  SELECT id FROM pages WHERE slug = :'slug'
);
DELETE FROM pages WHERE slug = :'slug';
SQL
  exit 0
fi

# --full: nuclear clean.
echo "scope: full (all non-meta pages + this user's citations/claims/media)"
psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" \
  -v test_email="$TEST_USER_EMAIL" <<'SQL'
-- Children first to satisfy FK constraints. Order matters.
DELETE FROM page_checks WHERE target_rev_id IN (
  SELECT _rev_id FROM pages WHERE slug NOT LIKE 'meta/%'
);
DELETE FROM page_aliases WHERE page_id IN (
  SELECT id FROM pages WHERE slug NOT LIKE 'meta/%'
);
DELETE FROM citation_claims WHERE citation_id IN (
  SELECT id FROM citations
  WHERE _rev_user = (SELECT id FROM users WHERE email = :'test_email')
);
DELETE FROM citations
  WHERE _rev_user = (SELECT id FROM users WHERE email = :'test_email');
DELETE FROM pages WHERE slug NOT LIKE 'meta/%';
DELETE FROM media
  WHERE _rev_user = (SELECT id FROM users WHERE email = :'test_email');
SQL

# Wipe cached media thumbnails (filesystem backend).
if [[ -d "$REPO_ROOT/var/media-storage/files" ]]; then
  rm -rf "$REPO_ROOT/var/media-storage/files"/*
fi

# Sanity: zero non-meta pages remain.
remaining=$(psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" -tAc \
  "SELECT count(*) FROM pages WHERE slug NOT LIKE 'meta/%' AND _old_rev_of IS NULL AND _rev_deleted = false;")
echo "non-meta pages remaining: $remaining"
if [[ "$remaining" != "0" ]]; then
  echo "warning: pages remain that weren't authored by $TEST_USER_EMAIL"
  echo "  (could be from a different test user; review and clean manually if needed)"
fi
