#!/usr/bin/env bash
# Pull the latest /meta/* page bodies from agpedia.org into
# agentic-testing/seed/meta/. Run on demand when production
# conventions have moved and you want the next agentic test to
# orient against the new surface.
#
# Refreshes are deliberate, not automatic — the seed corpus is
# decoupled from codebase commits to avoid coupling production
# content drift to source-tree changes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="$(cd "$HERE/.." && pwd)/seed/meta"
SOURCE_BASE="${AGENTIC_TESTING_SEED_SOURCE:-https://agpedia.org}"

mkdir -p "$SEED_DIR"

slugs=(
  meta/policy
  meta/values
  meta/scope
  meta/contributing
  meta/citations
  meta/conduct
  meta/governance
  meta/style
  meta/mcp-reference
  meta/setup
  meta/wishlist
)

echo "Refreshing seed from $SOURCE_BASE -> $SEED_DIR"

failed=0
for slug in "${slugs[@]}"; do
  filename="$(echo "$slug" | tr '/' '_').md"
  url="${SOURCE_BASE}/${slug}?format=raw"
  http_code=$(curl -s -o "$SEED_DIR/$filename.tmp" -w "%{http_code}" "$url")
  if [[ "$http_code" == "200" ]]; then
    mv "$SEED_DIR/$filename.tmp" "$SEED_DIR/$filename"
    bytes=$(wc -c < "$SEED_DIR/$filename" | tr -d ' ')
    echo "  ok   $slug ($bytes bytes)"
  else
    rm -f "$SEED_DIR/$filename.tmp"
    echo "  fail $slug (HTTP $http_code)"
    failed=$((failed + 1))
  fi
done

if [[ $failed -gt 0 ]]; then
  echo "$failed slug(s) failed to fetch"
  exit 1
fi
