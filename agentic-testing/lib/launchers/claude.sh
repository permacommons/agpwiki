#!/usr/bin/env bash
# Claude Code launcher for agentic-testing.
#
# Contract — required environment:
#   AGENTIC_TASK_FILE        Absolute path to the task prompt file (markdown).
#                            Everything after the first `## Prompt` heading
#                            is sent to the agent as the user message.
#   AGENTIC_RUN_DIR          Absolute path to a per-run output directory
#                            (already exists). Transcript is written here.
#   AGENTIC_MCP_CONFIG_FILE  Absolute path to a Claude-Code MCP config JSON
#                            with exactly one server (agpwiki-local).
#                            `setup` writes it to runs/.mcp-config.json.
#
# Optional environment:
#   AGENTIC_MAX_BUDGET_USD   Cap on inner-agent spend. Default 5.
#
# Isolation strategy: `--strict-mcp-config --mcp-config <file>`. Claude
# Code ignores every other MCP source (user-scope, project-scope,
# settings.json) and loads only what's in the file. Operator MCPs at
# user scope are structurally invisible — they aren't in the inner
# agent's tool catalog at all, so `--dangerously-skip-permissions`
# can't unlock them. The danger flag stays on so the agent doesn't
# need an exhaustive `--allowedTools` list for built-in tools.
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
if [[ -z "${AGENTIC_MCP_CONFIG_FILE:-}" ]]; then
  echo "claude.sh: AGENTIC_MCP_CONFIG_FILE not set (setup should have written one)" >&2; exit 2
fi
if [[ ! -f "$AGENTIC_MCP_CONFIG_FILE" ]]; then
  echo "claude.sh: AGENTIC_MCP_CONFIG_FILE missing: $AGENTIC_MCP_CONFIG_FILE" >&2; exit 2
fi

MAX_BUDGET_USD="${AGENTIC_MAX_BUDGET_USD:-5}"

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
  --strict-mcp-config --mcp-config "$AGENTIC_MCP_CONFIG_FILE" \
  --dangerously-skip-permissions \
  --max-budget-usd "$MAX_BUDGET_USD" \
  "$PROMPT" < /dev/null > "$TRANSCRIPT"
