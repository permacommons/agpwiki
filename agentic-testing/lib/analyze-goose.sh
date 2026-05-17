#!/usr/bin/env bash
# Extract a quick analysis of a Goose --output-format=stream-json
# transcript: tool-call counts, the final retrospective text, and a
# flag for any non-local extension calls.
#
# Goose's stream-json emits one event per token (text deltas), each
# with the same message id, plus toolRequest / toolResponse content
# items as separate messages. The analyzer aggregates text by message
# id and counts toolRequest items by tool name.
#
# Extension-init failures (e.g., MCP auth rejection) are emitted to
# stderr by goose, NOT into the JSON stream — so the launcher captures
# stderr separately and this analyzer reads `stderr.log` from the run
# dir if it sits beside the transcript.
#
# Usage:
#   analyze-goose.sh <transcript.jsonl> > analysis.md

set -euo pipefail

if [[ -z "${1:-}" ]]; then
  echo "usage: analyze-goose.sh <transcript.jsonl>" >&2
  exit 2
fi
TRANSCRIPT="$1"
if [[ ! -f "$TRANSCRIPT" ]]; then
  echo "analyze-goose.sh: transcript not found: $TRANSCRIPT" >&2
  exit 2
fi
RUN_DIR="$(dirname "$TRANSCRIPT")"
STDERR_LOG="$RUN_DIR/stderr.log"

# Be lenient about non-JSON lines (banner art, warnings) that may
# leak from goose into the file when stderr isn't separately captured.
JQ_PARSE='fromjson? // empty'

cat <<HEAD
# Agentic test analysis (goose)

**Transcript:** \`$TRANSCRIPT\`
**Generated:** $(date -u '+%Y-%m-%d %H:%M:%S UTC')

## Tool-call counts

\`\`\`
HEAD

# Count toolRequest items by tool name. Goose's stream-json nests the
# tool name under .toolCall.value.name, with .toolCall.status indicating
# whether the parse-from-LLM succeeded. The _meta.goose_extension field
# carries the authoritative extension owner (cleaner than parsing the
# "<ext>__<tool>" name prefix, which only some extensions use).
jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "message") |
  .message.content[]? |
  select(.type == "toolRequest") |
  (.toolCall.value.name // .toolCall.name // .name // "unknown")
' | sort | uniq -c | sort -rn
echo '```'
echo

# Isolation: any toolRequest whose `_meta.goose_extension` is not
# "agpwiki-local" is non-local. Cross-check by name prefix as a
# fallback for events that lack _meta.
prod_calls=$(jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "message") |
  .message.content[]? |
  select(.type == "toolRequest") |
  ((._meta.goose_extension // "?") + " :: " +
    (.toolCall.value.name // .toolCall.name // .name // "unknown"))
' | grep -v '^agpwiki-local :: ' | sort -u || true)

cat <<'HEAD'
## Isolation check

HEAD
if [[ -z "$prod_calls" ]]; then
  echo "_OK — no non-local extension calls in the transcript._"
else
  echo "**WARNING — non-local or unqualified tool calls detected:**"
  echo
  echo '```'
  echo "$prod_calls"
  echo '```'
fi
echo

# Tool errors: toolResponse items with status=error/failed or
# value.isError=true. The error payload may sit under .toolResult.error
# (top-level error string, e.g. unknown-tool) or under
# .toolResult.value.content[].text (MCP tool returning an error response).
tool_errors=$(jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "message") |
  .message.content[]? |
  select(.type == "toolResponse" and (
    (.toolResult.value.isError // false) == true or
    (.toolResult.status // "") == "error" or
    (.toolResult.status // "") == "failed"
  )) |
  ("toolResponse(" + (.id // "?") + "): " +
    ((.toolResult.error // (.toolResult.value.content[]?.text) // "?") | tostring))
' 2>/dev/null || true)

# Stderr-side errors: extension-init failures, malformed config, etc.
# These don't appear in the transcript stream.
stderr_errors=""
if [[ -f "$STDERR_LOG" ]]; then
  stderr_errors=$(grep -iE 'failed to start extension|invalid header|HTTP 4[0-9]{2}|HTTP 5[0-9]{2}|Skipping malformed|Unknown extension' "$STDERR_LOG" | head -20 || true)
fi

cat <<'HEAD'
## Tool errors

HEAD
if [[ -z "$tool_errors" && -z "$stderr_errors" ]]; then
  echo "_None._"
else
  if [[ -n "$tool_errors" ]]; then
    echo "**Tool responses:**"
    echo '```'
    echo "$tool_errors"
    echo '```'
    echo
  fi
  if [[ -n "$stderr_errors" ]]; then
    echo "**Stderr (extension/init):**"
    echo '```'
    echo "$stderr_errors"
    echo '```'
  fi
fi
echo

# Token usage from the terminal "complete" event.
cat <<'HEAD'
## Usage

```
HEAD
jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -r '
  select(.type == "complete") |
  "total_tokens=" + ((.total_tokens // 0) | tostring)
' | tail -1
echo '```'
echo

cat <<'HEAD'
## Retrospective (final agent message)

HEAD
# Aggregate text deltas by message id (stream-json emits one event
# per token sharing an id), keep only the final assistant message.
jq -R "$JQ_PARSE" "$TRANSCRIPT" | jq -s '
  [ .[] | select(.type == "message" and .message.role == "assistant") ]
  | group_by(.message.id)
  | map({
      id: .[0].message.id,
      created: .[0].message.created,
      text: ([.[].message.content[]? | select(.type == "text") | .text] | join(""))
    })
  | sort_by(.created)
  | .[-1].text // ""
' -r | tail -c 16000
