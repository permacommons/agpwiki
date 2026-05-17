#!/usr/bin/env bash
# Verify the MCP config file the claude launcher will hand to
# `claude --strict-mcp-config --mcp-config <file>` carries exactly
# the agpwiki-local server and nothing else. With `--strict-mcp-config`
# the inner agent loads only what's in this file — every other MCP
# source (user-scope, project-scope, settings.json) is ignored — so
# the file is the entire isolation surface. If it's clean, isolation
# is clean.
#
# This is a JSON sanity check, not a model probe. We do not ask the
# agent what it can see, because a model can't reliably distinguish
# between "I have this tool" and "I know this tool name from
# training/context."
#
# Argv[1]: path to the MCP config JSON (defaults to
# $AGENTIC_MCP_CONFIG_FILE; or runs/.mcp-config.json if unset).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIG="${1:-${AGENTIC_MCP_CONFIG_FILE:-$HERE/../runs/.mcp-config.json}}"

if [[ ! -f "$CONFIG" ]]; then
  echo "isolation-probe: config file not found: $CONFIG" >&2
  echo "  (run \`./agentic-testing/run setup\` first to generate it)" >&2
  exit 1
fi

if ! servers=$(jq -r '.mcpServers | keys | sort | join(",")' "$CONFIG" 2>/dev/null); then
  echo "isolation-probe: $CONFIG is not valid JSON" >&2
  exit 1
fi

if [[ "$servers" != "agpwiki-local" ]]; then
  echo "isolation-probe: $CONFIG carries unexpected servers: [$servers]" >&2
  echo "  expected exactly: agpwiki-local" >&2
  echo "  the launcher uses --strict-mcp-config, so anything in this file" >&2
  echo "  reaches the inner agent. STOP and fix before launching." >&2
  exit 1
fi

echo "isolation-probe: ok ($CONFIG carries only agpwiki-local; --strict-mcp-config will enforce)"
