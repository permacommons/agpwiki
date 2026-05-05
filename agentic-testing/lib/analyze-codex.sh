#!/usr/bin/env bash
# Extract a quick analysis of a Codex CLI --json transcript: tool-call
# counts, the final retrospective text, and a flag for any non-local
# MCP calls (which would mean isolation broke).
#
# Codex --json emits one event per line. The events we care about:
#   - {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
#   - {"type":"item.completed","item":{"type":"command_execution",
#       "command":"...","exit_code":N,"status":"completed|failed",...}}
#   - {"type":"item.completed","item":{"type":"mcp_tool_call",
#       "server":"...","tool":"...", ...}}
#   - {"type":"item.completed","item":{"type":"web_search","query":"...",...}}
#   - {"type":"turn.completed","usage":{...}}
#
# This analyzer is best-effort: it counts by item.type, and surfaces a
# few well-known sub-types specifically (MCP server/tool, shell exit
# codes). Unknown types fall through to the count bucket.
#
# Usage:
#   analyze-codex.sh <transcript.jsonl> > analysis.md

set -euo pipefail

if [[ -z "${1:-}" ]]; then
  echo "usage: analyze-codex.sh <transcript.jsonl>" >&2
  exit 2
fi
TRANSCRIPT="$1"
if [[ ! -f "$TRANSCRIPT" ]]; then
  echo "analyze-codex.sh: transcript not found: $TRANSCRIPT" >&2
  exit 2
fi

# Codex's --json stream may include non-JSON lines from stderr if a
# caller merged 2>&1; canonical launcher invocations don't, but the
# analyzer is also a re-analysis target (`run analyze`), so be lenient.
JQ_PARSE='fromjson? // empty'

cat <<HEAD
# Agentic test analysis (codex)

**Transcript:** \`$TRANSCRIPT\`
**Generated:** $(date -u '+%Y-%m-%d %H:%M:%S UTC')

## Tool-call counts

\`\`\`
HEAD

# Count item.completed events grouped by a synthesized "tool name".
# - mcp_tool_call -> "mcp__<server>__<tool>" (matches the claude
#   analyzer's surface naming so the two analyses read alike)
# - command_execution -> "shell"
# - web_search -> "web_search"
# - agent_message / reasoning -> not counted as tool calls
# - anything else -> the raw item.type
jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "item.completed") | .item |
  if .type == "mcp_tool_call" then
    "mcp__" + (.server // "?") + "__" + (.tool // "?")
  elif .type == "command_execution" then
    "shell"
  elif .type == "web_search" then
    "web_search"
  elif .type == "agent_message" or .type == "reasoning" then
    empty
  else
    .type
  end
' | sort | uniq -c | sort -rn
echo '```'
echo

# Production-MCP isolation check. Anything other than agpwiki-local in
# the server slot is a breach.
prod_calls=$(jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "item.completed") | .item |
  select(.type == "mcp_tool_call") |
  .server // "?"
' | grep -v '^agpwiki-local$' | sort -u || true)

cat <<'HEAD'
## Isolation check

HEAD
if [[ -z "$prod_calls" ]]; then
  echo "_OK — no non-local MCP servers called in the transcript._"
else
  echo "**ISOLATION BREACH — the inner agent called non-local MCP servers:**"
  echo
  echo '```'
  echo "$prod_calls"
  echo '```'
fi
echo

# Tool errors: shell exits != 0, MCP error envelopes, codex error events.
shell_errors=$(jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "item.completed") | .item |
  select(.type == "command_execution" and (.exit_code // 0) != 0) |
  "shell exit=" + (.exit_code | tostring) + " status=" + (.status // "?") + ": " + (.command // "?")
' 2>/dev/null || true)

mcp_errors=$(jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "item.completed") | .item |
  select(.type == "mcp_tool_call" and ((.status // "") == "failed" or (.is_error // false) == true)) |
  "mcp " + (.server // "?") + "/" + (.tool // "?") + ": " + ((.error // .result // "?") | tostring)
' 2>/dev/null || true)

stream_errors=$(jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "error" or .type == "thread.failed" or .type == "turn.failed") |
  ((.message // .error // .) | tostring)
' 2>/dev/null || true)

errors="$(printf '%s\n%s\n%s\n' "$shell_errors" "$mcp_errors" "$stream_errors" | sed '/^$/d')"

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

# Token / cost summary from the final turn.completed (most recent wins).
cat <<'HEAD'
## Usage

```
HEAD
jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "turn.completed") | .usage |
  "input_tokens=" + ((.input_tokens // 0) | tostring) +
  "  cached_input_tokens=" + ((.cached_input_tokens // 0) | tostring) +
  "  output_tokens=" + ((.output_tokens // 0) | tostring) +
  "  reasoning_output_tokens=" + ((.reasoning_output_tokens // 0) | tostring)
' | tail -1
echo '```'
echo

cat <<'HEAD'
## Retrospective (final agent_message)

HEAD
# Last agent_message text from the transcript.
jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "item.completed") | .item |
  select(.type == "agent_message") | .text
' | tail -c 16000
