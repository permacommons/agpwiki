#!/usr/bin/env bash
# Codex CLI launcher for agentic-testing.
#
# Contract — required environment:
#   AGENTIC_TASK_FILE  Absolute path to the task prompt file (markdown).
#                      Everything after the first `## Prompt` heading is
#                      sent to the agent as the user message.
#   AGENTIC_RUN_DIR    Absolute path to a per-run output directory
#                      (already exists). transcript.jsonl is written here.
#   AGENTIC_TOKEN      Bearer token for the local MCP server.
#   AGENTIC_MCP_URL    URL of the local MCP server.
#
# Optional environment:
#   AGENTIC_CODEX_MODEL              Model to pass to `codex exec -m`.
#                                    Default: codex's built-in default.
#   AGENTIC_CODEX_REASONING_EFFORT   "low" | "medium" | "high". Default "low"
#                                    to keep parity with the canonical claude
#                                    runs (which don't crank thinking).
#   AGENTIC_MAX_TURNS                Reserved for future use; codex exec has
#                                    no per-run turn cap flag today.
#
# Isolation strategy: `--ignore-user-config` makes codex skip
# `~/.codex/config.toml` (so any user-scope MCPs registered by the
# operator stay invisible to the inner agent), while still consuming
# `~/.codex/auth.json` for login. We then register only the local
# agpwiki MCP via inline `-c` overrides — nothing is written to the
# user's codex config.
#
# Runs from a private CWD inside the run dir so the inner agent can't
# see the host repo via shell tools.

set -euo pipefail

if [[ -z "${AGENTIC_TASK_FILE:-}" ]]; then
  echo "codex.sh: AGENTIC_TASK_FILE not set" >&2; exit 2
fi
if [[ -z "${AGENTIC_RUN_DIR:-}" ]]; then
  echo "codex.sh: AGENTIC_RUN_DIR not set" >&2; exit 2
fi
if [[ ! -d "$AGENTIC_RUN_DIR" ]]; then
  echo "codex.sh: AGENTIC_RUN_DIR does not exist: $AGENTIC_RUN_DIR" >&2; exit 2
fi
if [[ -z "${AGENTIC_TOKEN:-}" ]]; then
  echo "codex.sh: AGENTIC_TOKEN not set (setup should have provided it)" >&2; exit 2
fi
if [[ -z "${AGENTIC_MCP_URL:-}" ]]; then
  echo "codex.sh: AGENTIC_MCP_URL not set" >&2; exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "codex.sh: 'codex' not on PATH (install @openai/codex)" >&2; exit 2
fi

REASONING="${AGENTIC_CODEX_REASONING_EFFORT:-low}"
MODEL="${AGENTIC_CODEX_MODEL:-}"

PROMPT="$(awk '/^## Prompt$/{p=1; next} p' "$AGENTIC_TASK_FILE")"
if [[ -z "${PROMPT// /}" ]]; then
  echo "codex.sh: no '## Prompt' section found in $AGENTIC_TASK_FILE" >&2
  exit 2
fi

TRANSCRIPT="$AGENTIC_RUN_DIR/transcript.jsonl"
CWD="$AGENTIC_RUN_DIR/cwd"
mkdir -p "$CWD"

# Build codex invocation. Each `-c key=value` override carries a TOML
# value; strings must be TOML-quoted (hence the embedded double quotes).
codex_args=(
  exec
  --json
  --skip-git-repo-check
  --dangerously-bypass-approvals-and-sandbox
  --ignore-user-config
  -C "$CWD"
  -c "mcp_servers.agpwiki-local.url=\"$AGENTIC_MCP_URL\""
  -c "mcp_servers.agpwiki-local.bearer_token_env_var=\"AGENTIC_TOKEN\""
  -c "model_reasoning_effort=\"$REASONING\""
)
if [[ -n "$MODEL" ]]; then
  codex_args+=(-m "$MODEL")
fi

# AGENTIC_TOKEN is already in the env — codex reads it via the
# bearer_token_env_var binding above.
cd "$CWD"
exec codex "${codex_args[@]}" "$PROMPT" < /dev/null > "$TRANSCRIPT"
