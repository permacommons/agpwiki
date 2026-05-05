#!/usr/bin/env bash
# Claude Code launcher for agentic-testing.
#
# Contract — required environment:
#   AGENTIC_TASK_FILE  Absolute path to the task prompt file (markdown).
#                      Everything after the first `## Prompt` heading
#                      is sent to the agent as the user message.
#   AGENTIC_RUN_DIR    Absolute path to a per-run output directory
#                      (already exists). Transcript is written here.
#
# Optional environment:
#   AGENTIC_DISALLOWED_MCP_PATTERNS  Whitespace-separated list of MCP
#                      tool patterns to hide from the inner agent.
#                      Each becomes its own --disallowedTools= flag
#                      (the comma-separated form silently fails — see
#                      README). Default `mcp__*` denies every MCP
#                      tool; the AGENTIC_ALLOWED_MCP_PATTERNS list
#                      then re-permits the local MCP. Override only
#                      if you need a more permissive surface.
#   AGENTIC_ALLOWED_MCP_PATTERNS  Whitespace-separated list of MCP
#                      tool patterns to permit. Default
#                      `mcp__agpwiki-local__*` so only our local MCP
#                      is visible regardless of which other MCPs the
#                      operator has registered at user scope.
#   AGENTIC_MAX_BUDGET_USD  Cap on inner-agent spend. Default 5.
#
# Runs from a private CWD inside the run dir so the inner agent
# can't see the host repo via Read/Bash.

set -euo pipefail

if [[ -z "${AGENTIC_TASK_FILE:-}" ]]; then
  echo "claude.sh: AGENTIC_TASK_FILE not set" >&2; exit 2
fi
if [[ -z "${AGENTIC_RUN_DIR:-}" ]]; then
  echo "claude.sh: AGENTIC_RUN_DIR not set" >&2; exit 2
fi
if [[ ! -d "$AGENTIC_RUN_DIR" ]]; then
  echo "claude.sh: AGENTIC_RUN_DIR does not exist: $AGENTIC_RUN_DIR" >&2; exit 2
fi

# Deny-everything-then-allow-ours. Whatever user-scope MCPs the
# operator has registered, only agpwiki-local will reach the inner
# agent. The wildcard deny is required because every operator has a
# different set of user-scope MCPs and we can't enumerate them.
DISALLOWED_DEFAULT='mcp__*'
ALLOWED_DEFAULT='mcp__agpwiki-local__*'
DISALLOWED="${AGENTIC_DISALLOWED_MCP_PATTERNS:-$DISALLOWED_DEFAULT}"
ALLOWED="${AGENTIC_ALLOWED_MCP_PATTERNS:-$ALLOWED_DEFAULT}"
MAX_BUDGET_USD="${AGENTIC_MAX_BUDGET_USD:-5}"

# Build per-pattern --disallowedTools / --allowedTools flags. CRITICAL:
# each pattern must be its own flag; the comma-joined form silently
# fails for leading patterns and has caused production writes in the
# past (see README lessons).
disallow_args=()
for pattern in $DISALLOWED; do
  disallow_args+=("--disallowedTools=$pattern")
done
allow_args=()
for pattern in $ALLOWED; do
  allow_args+=("--allowedTools=$pattern")
done

PROMPT="$(awk '/^## Prompt$/{p=1; next} p' "$AGENTIC_TASK_FILE")"
if [[ -z "${PROMPT// /}" ]]; then
  echo "claude.sh: no '## Prompt' section found in $AGENTIC_TASK_FILE" >&2
  exit 2
fi

TRANSCRIPT="$AGENTIC_RUN_DIR/transcript.jsonl"
CWD="$AGENTIC_RUN_DIR/cwd"
mkdir -p "$CWD"

cd "$CWD"
exec claude --print --output-format stream-json --include-partial-messages --verbose \
  --dangerously-skip-permissions \
  "${disallow_args[@]}" \
  "${allow_args[@]}" \
  --max-budget-usd "$MAX_BUDGET_USD" \
  "$PROMPT" < /dev/null > "$TRANSCRIPT"
