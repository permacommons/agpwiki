#!/usr/bin/env bash
# Goose CLI launcher for agentic-testing.
#
# Goose handles a wide range of model + runtime combinations, and
# different combinations expose different failure modes against this
# MCP — see `agentic-testing/README.md` → "Goose: working
# configurations and known limitations" for what we've validated and
# what we haven't.
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
#   AGENTIC_GOOSE_PROVIDER         Goose provider name. Default "ollama".
#                                  See goose's docs for valid values
#                                  (e.g. "openai", "anthropic",
#                                  "ollama", "openai_compatible").
#   AGENTIC_GOOSE_MODEL            Model name to pass to goose. No
#                                  default — set to whatever model is
#                                  available in your provider. The
#                                  README's "Goose: working
#                                  configurations" section lists
#                                  combinations we've validated.
#   AGENTIC_OLLAMA_HOST            Default "http://localhost:11434".
#                                  Only relevant when provider=ollama.
#   AGENTIC_GOOSE_MAX_TURNS        Default 200.
#   AGENTIC_GOOSE_MAX_TOOL_REPS    Default 4. Caps consecutive identical
#                                  tool calls — small models loop.
#   AGENTIC_GOOSE_TOOLSHIM         "1" to enable goose's toolshim layer
#                                  (a secondary model that parses the
#                                  primary's text output into
#                                  structured tool calls). Off by
#                                  default. Has compatibility issues
#                                  with streaming primaries — see the
#                                  README's known-limitations notes.
#   AGENTIC_GOOSE_TOOLSHIM_MODEL   Ollama model used as the shim. No
#                                  default — set when toolshim is
#                                  enabled.
#   AGENTIC_GOOSE_DEBUG_BINDS      "1" to enable goose's bundled
#                                  `developer` extension (gives the
#                                  inner agent shell + filesystem
#                                  inside its private CWD). Off by
#                                  default so the agent's surface is
#                                  just agpwiki-local.
#   AGENTIC_GOOSE_BIN              Absolute path to the goose binary.
#                                  Defaults to $(which goose). Useful
#                                  for running a locally-built or
#                                  -patched goose alongside the
#                                  system install.
#   AGENTIC_GOOSE_SYSTEM           Text to pass to `goose run --system`.
#                                  Default: unset (no extra system
#                                  prompt). Special value "builtin"
#                                  injects an opinionated reminder
#                                  that addresses failure modes
#                                  observed with mid-tier local
#                                  models (MediaWiki priors,
#                                  malformed citation_create
#                                  payloads, skipped meta-page
#                                  orientation). Set to any other
#                                  string to use that text verbatim.
#                                  Capable frontier-quality models
#                                  generally don't need this.
#
# Isolation strategy: per-run XDG_CONFIG_HOME pointing at a freshly
# written config.yaml. That config defines only the agpwiki-local
# extension and explicitly disables goose's bundled platform tools
# (developer, analyze, apps, todo, summon, …), so the test surface
# stays focused on the wiki MCP.
# The bearer token is interpolated into the Authorization header via
# goose's `${VAR}` syntax, so AGENTIC_TOKEN must be present in the
# child env (and is — the run script exports it).
#
# Runs from a private CWD inside the run dir to keep the inner agent
# from reading the host repo via filesystem tools (relevant if the
# operator opts in to the developer extension).

set -euo pipefail

if [[ -z "${AGENTIC_TASK_FILE:-}" ]]; then
  echo "goose.sh: AGENTIC_TASK_FILE not set" >&2; exit 2
fi
if [[ -z "${AGENTIC_RUN_DIR:-}" ]]; then
  echo "goose.sh: AGENTIC_RUN_DIR not set" >&2; exit 2
fi
if [[ ! -d "$AGENTIC_RUN_DIR" ]]; then
  echo "goose.sh: AGENTIC_RUN_DIR does not exist: $AGENTIC_RUN_DIR" >&2; exit 2
fi
if [[ -z "${AGENTIC_TOKEN:-}" ]]; then
  echo "goose.sh: AGENTIC_TOKEN not set (setup should have provided it)" >&2; exit 2
fi
if [[ -z "${AGENTIC_MCP_URL:-}" ]]; then
  echo "goose.sh: AGENTIC_MCP_URL not set" >&2; exit 2
fi
GOOSE_BIN="${AGENTIC_GOOSE_BIN:-$(command -v goose 2>/dev/null || true)}"
if [[ -z "$GOOSE_BIN" || ! -x "$GOOSE_BIN" ]]; then
  echo "goose.sh: 'goose' binary not found (set AGENTIC_GOOSE_BIN or put goose on PATH)" >&2
  exit 2
fi

PROVIDER="${AGENTIC_GOOSE_PROVIDER:-ollama}"
MODEL="${AGENTIC_GOOSE_MODEL:-}"
OLLAMA_HOST="${AGENTIC_OLLAMA_HOST:-${OLLAMA_HOST:-http://localhost:11434}}"
MAX_TURNS="${AGENTIC_GOOSE_MAX_TURNS:-200}"
MAX_TOOL_REPS="${AGENTIC_GOOSE_MAX_TOOL_REPS:-4}"
TOOLSHIM="${AGENTIC_GOOSE_TOOLSHIM:-0}"
TOOLSHIM_MODEL="${AGENTIC_GOOSE_TOOLSHIM_MODEL:-}"

if [[ -z "$MODEL" ]]; then
  echo "goose.sh: AGENTIC_GOOSE_MODEL not set — pick a model your provider supports (see README)" >&2
  exit 2
fi
if [[ "$TOOLSHIM" == "1" || "$TOOLSHIM" == "true" ]] && [[ -z "$TOOLSHIM_MODEL" ]]; then
  echo "goose.sh: AGENTIC_GOOSE_TOOLSHIM is on but AGENTIC_GOOSE_TOOLSHIM_MODEL is not set" >&2
  exit 2
fi

PROMPT="$(awk '/^## Prompt$/{p=1; next} p' "$AGENTIC_TASK_FILE")"
if [[ -z "${PROMPT// /}" ]]; then
  echo "goose.sh: no '## Prompt' section found in $AGENTIC_TASK_FILE" >&2
  exit 2
fi

GOOSE_HOME_DIR="$AGENTIC_RUN_DIR/goose-home"
mkdir -p "$GOOSE_HOME_DIR/.config/goose"

# Write the per-run goose config. Define agpwiki-local AND
# explicitly disable each bundled platform extension — goose
# defaults unmentioned bundled extensions to ENABLED, so just
# omitting them isn't enough; verified by observing `developer`
# auto-load and call `write` against our filesystem during a
# minimal-config probe. The list below mirrors what `goose configure`
# enables by default; if goose adds a new bundled extension, this
# launcher won't isolate against it until the list is updated.
cat > "$GOOSE_HOME_DIR/.config/goose/config.yaml" <<EOF
GOOSE_PROVIDER: $PROVIDER
GOOSE_MODEL: $MODEL
OLLAMA_HOST: $OLLAMA_HOST

extensions:
  agpwiki-local:
    enabled: true
    type: streamable_http
    name: agpwiki-local
    uri: $AGENTIC_MCP_URL
    headers:
      Authorization: Bearer \${AGENTIC_TOKEN}
    envs: {}
    env_keys: ["AGENTIC_TOKEN"]
    timeout: 300

  developer:        { enabled: false, type: platform, name: developer,        bundled: true }
  analyze:          { enabled: false, type: platform, name: analyze,          bundled: true }
  apps:             { enabled: false, type: platform, name: apps,             bundled: true }
  todo:             { enabled: false, type: platform, name: todo,             bundled: true }
  tom:              { enabled: false, type: platform, name: tom,              bundled: true }
  summarize:        { enabled: false, type: platform, name: summarize,        bundled: true }
  chatrecall:       { enabled: false, type: platform, name: chatrecall,       bundled: true }
  extensionmanager: { enabled: false, type: platform, name: extensionmanager, bundled: true }
  code_execution:   { enabled: false, type: platform, name: code_execution,   bundled: true }
  skills:           { enabled: false, type: platform, name: skills,           bundled: true }
  orchestrator:     { enabled: false, type: platform, name: orchestrator,     bundled: true }
  summon:           { enabled: false, type: platform, name: summon,           bundled: true }
EOF

if [[ "${AGENTIC_GOOSE_DEBUG_BINDS:-0}" == "1" ]]; then
  # Re-enable the developer extension as a debug option (gives the
  # inner agent shell + filesystem inside its private CWD). Off by
  # default so the test surface is just the wiki MCP.
  sed -i 's/^  developer:        { enabled: false,/  developer:        { enabled: true, /' \
    "$GOOSE_HOME_DIR/.config/goose/config.yaml"
fi

TRANSCRIPT="$AGENTIC_RUN_DIR/transcript.jsonl"
STDERR_LOG="$AGENTIC_RUN_DIR/stderr.log"
CWD="$AGENTIC_RUN_DIR/cwd"
mkdir -p "$CWD"

# Make CWD its own git root so goose's hint loader (which walks from
# CWD up to the nearest .git, importing AGENTS.md / CLAUDE.md /
# .goosehints along the way) stops here instead of climbing into the
# host repo. Without this, goose will inject the host's AGENTS.md —
# i.e. the agpwiki source-tree context — into the agent's system
# prompt, which is an information-isolation breach that biases the
# test signal. Confirmed empirically: prior to this, our test
# agent's system prompt contained the agpwiki AGENTS.md verbatim.
if [[ ! -d "$CWD/.git" ]]; then
  git init -q "$CWD"
fi

# Optional system-prompt reminder. Default: no --system flag at all
# — capable models don't need extra steering and the reminder eats
# context that would otherwise be available for tool results. The
# "builtin" sentinel injects an opinionated reminder targeted at
# failure modes observed with mid-tier local models (MediaWiki
# priors, malformed citation_create payloads, skipped meta-page
# orientation); use it when running against a model that needs the
# extra hand-holding.
BUILTIN_SYSTEM_REMINDER='CRITICAL CONTEXT — read carefully before acting.

You are NOT working with Wikipedia or MediaWiki. This is a different
encyclopedia called Agpedia. Forget MediaWiki patterns from your
training data — most do not apply.

SLUGS:
  - Lowercase, hyphenated, paths separated by "/". Example slugs:
    meta/policy, meta/style, meta/citations, eastern-bluebird.
  - There are NO MediaWiki-style namespaces. The slugs Help:Editing,
    Help:Contents, Project:Style, Project:Guidelines,
    Template:Infobox, Template:Disambiguation, Template:Commons, etc.
    DO NOT EXIST. Do not call wiki_readPage with any of those.

LINKS in article body text:
  - Use Markdown link syntax: [Display text](/slug-target).
  - Do NOT use [[Wikilinks]] or [[Target|Display]] — those will not
    render and will appear as literal bracketed text on the page.

YOUR FIRST ACTION must be: call wiki_readPage with slug="meta/policy".
That page tells you which other policy pages to read (style,
citations, scope, values). Read all of them before authoring. Do not
guess at MediaWiki-shaped page names.

CITATION SCHEMA: citation_create takes a wrapper object:
  {
    "key": "doe-bluebirds-2010",
    "data": {
      "id": "doe-bluebirds-2010",
      "type": "article-journal",
      "title": "...",
      "author": [{"family": "Doe", "given": "Jane"}],
      "container-title": "Journal of ...",
      "volume": "45",
      "page": "123-145",
      "issued": {"date-parts": [[2010]]}
    }
  }
The data field must be CSL JSON. Do NOT send flat fields like
{"author": "Doe, Jane", "title": "..."} at the top level — those are
rejected with a validation error.

DO NOT invent sources. If you do not have a real, verifiable source
for a claim, do real web research first or omit the claim. Fabricated
authors and titles are worse than no citation.'

case "${AGENTIC_GOOSE_SYSTEM:-}" in
  "")        SYSTEM_TEXT="" ;;
  builtin)   SYSTEM_TEXT="$BUILTIN_SYSTEM_REMINDER" ;;
  *)         SYSTEM_TEXT="$AGENTIC_GOOSE_SYSTEM" ;;
esac

cd "$CWD"
# AGENTIC_TOKEN must remain in env so goose's ${VAR} interpolation in
# the YAML resolves at extension-init time. Stderr goes to its own
# file — goose surfaces extension-init failures there, and the
# analyzer reads it to flag MCP handshake problems that the
# transcript itself can't see.
#
# Toolshim env vars (GOOSE_TOOLSHIM=1, GOOSE_TOOLSHIM_OLLAMA_MODEL=...)
# are read by goose at session-start; passing them here turns on the
# shim layer for this run only without touching user config.
toolshim_env=()
if [[ "$TOOLSHIM" == "1" || "$TOOLSHIM" == "true" ]]; then
  toolshim_env=(
    GOOSE_TOOLSHIM=1
    GOOSE_TOOLSHIM_OLLAMA_MODEL="$TOOLSHIM_MODEL"
  )
fi

system_args=()
if [[ -n "$SYSTEM_TEXT" ]]; then
  system_args=(--system "$SYSTEM_TEXT")
fi

exec env XDG_CONFIG_HOME="$GOOSE_HOME_DIR/.config" \
  "${toolshim_env[@]}" \
  "$GOOSE_BIN" run \
    --no-session \
    --output-format stream-json \
    --max-turns "$MAX_TURNS" \
    --max-tool-repetitions "$MAX_TOOL_REPS" \
    "${system_args[@]}" \
    -t "$PROMPT" \
    < /dev/null \
    > "$TRANSCRIPT" \
    2> "$STDERR_LOG"
