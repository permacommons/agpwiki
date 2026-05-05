#!/usr/bin/env bash
# Extract a quick analysis of a Claude Code stream-json transcript:
# tool-call counts, the final retrospective text, and a flag for
# any production-MCP calls (which would mean isolation broke).
#
# Usage:
#   analyze-claude.sh <transcript.jsonl> > analysis.md

set -euo pipefail

if [[ -z "${1:-}" ]]; then
  echo "usage: analyze-claude.sh <transcript.jsonl>" >&2
  exit 2
fi
TRANSCRIPT="$1"
if [[ ! -f "$TRANSCRIPT" ]]; then
  echo "analyze-claude.sh: transcript not found: $TRANSCRIPT" >&2
  exit 2
fi

cat <<HEAD
# Agentic test analysis

**Transcript:** \`$TRANSCRIPT\`
**Generated:** $(date -u '+%Y-%m-%d %H:%M:%S UTC')

## Tool-call counts

\`\`\`
HEAD

jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$TRANSCRIPT" | sort | uniq -c | sort -rn
echo '```'
echo

# Isolation check — flag any MCP tool call (`mcp__...`) that isn't
# the local one. This catches user-scope production MCPs that leaked
# past --disallowedTools without depending on a hardcoded list of
# which specific MCPs the operator happens to have registered.
prod_calls=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$TRANSCRIPT" \
  | grep -E '^mcp__' \
  | grep -v '^mcp__agpwiki-local__' || true)

cat <<'HEAD'
## Isolation check

HEAD
if [[ -z "$prod_calls" ]]; then
  echo "_OK — no production-MCP calls in the transcript._"
else
  echo "**ISOLATION BREACH — the inner agent called production MCPs:**"
  echo
  echo '```'
  echo "$prod_calls" | sort -u
  echo '```'
fi
echo

# Tool errors.
errors=$(jq -r 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .is_error == true) | (.content[0].text // (.content | tostring))' "$TRANSCRIPT" 2>/dev/null || true)

cat <<'HEAD'
## Tool errors

HEAD
if [[ -z "$errors" ]]; then
  echo "_None._"
else
  echo '```'
  echo "$errors"
  echo '```'
fi
echo

cat <<'HEAD'
## Retrospective (final assistant message)

HEAD
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' "$TRANSCRIPT" | tail -c 16000
