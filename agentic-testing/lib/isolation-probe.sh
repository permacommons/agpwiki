#!/usr/bin/env bash
# Verify that an outside Claude Code session sees ONLY the local
# agpwiki MCP, not any user-scope production MCPs that might be
# configured in ~/.claude.json. Run before launching the real test.
#
# This catches the "comma-separated --disallowedTools silently
# fails" failure mode (see README) by exercising the same flag
# pattern the real launcher will use.

set -euo pipefail

# Mirror the defaults in lib/launchers/claude.sh: deny every MCP
# tool, then allow only the local one. Operator can override either
# list via AGENTIC_DISALLOWED_MCP_PATTERNS / AGENTIC_ALLOWED_MCP_PATTERNS.
DISALLOWED_DEFAULT='mcp__*'
ALLOWED_DEFAULT='mcp__agpwiki-local__*'
DISALLOWED="${AGENTIC_DISALLOWED_MCP_PATTERNS:-$DISALLOWED_DEFAULT}"
ALLOWED="${AGENTIC_ALLOWED_MCP_PATTERNS:-$ALLOWED_DEFAULT}"

disallow_args=()
for pattern in $DISALLOWED; do
  disallow_args+=("--disallowedTools=$pattern")
done
allow_args=()
for pattern in $ALLOWED; do
  allow_args+=("--allowedTools=$pattern")
done

# Run from /tmp so the probe can't see this repo via Read/Bash.
cd /tmp
output=$(claude --print --dangerously-skip-permissions --max-budget-usd 1 \
  "${disallow_args[@]}" \
  "${allow_args[@]}" \
  "List ONLY the MCP tool prefixes you can call (the literal mcp__...__ prefixes from your tool list). Output one per line, prefixed 'visible:'. Do not include human-readable server names." < /dev/null 2>&1)

echo "$output"
echo

visible=$(echo "$output" | grep '^visible:' | sort -u || true)
unexpected=$(echo "$visible" | grep -v 'visible: mcp__agpwiki-local__' || true)

if [[ -z "$visible" ]]; then
  echo "isolation-probe: agent did not list any MCP prefixes; check the --print invocation" >&2
  exit 1
fi
if [[ -n "$unexpected" ]]; then
  echo "isolation-probe: unexpected MCP surface visible to the inner agent:" >&2
  echo "$unexpected" >&2
  echo "STOP — fix --disallowedTools / --allowedTools before launching the real test." >&2
  exit 1
fi
echo "isolation-probe: OK (only mcp__agpwiki-local__ visible)"
