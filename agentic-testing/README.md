# Agentic testing

Drives an autonomous LLM agent through agpwiki's MCP surface and
captures what it does. The point isn't to verify code paths
(unit/integration tests do that) — it's to surface **tool ergonomics
problems**: where the server's guidance was confusing, where an
error message didn't tell the agent how to recover, where a missing
affordance forced a workaround.

This directory is **agent-agnostic**. The setup contract is the same
no matter which LLM agent you point at it; only the launcher script
is agent-specific. Claude Code is shipped as the reference
implementation; adding launchers for other agents is a matter of
matching the contract below.

## Quickstart

```bash
# One-time: ensure dev DB and migrations are up; start servers in
# separate terminals (or use `./agentic-testing/run bootstrap`):
npm run dev          # web + auto-applied migrations on :3000
npm run mcp-http     # MCP HTTP transport on :3333

# End-to-end with Claude Code:
./agentic-testing/run launch claude --task tasks/create-article.md

# Same template, different topic — no need to edit the file:
./agentic-testing/run launch codex \
  --task tasks/create-article.md --topic 'Leucocoprinus birnbaumii'
```

That's the full happy path. After it finishes, look in
`agentic-testing/runs/<timestamp>/` for the transcript and analysis.
`launch` also prints `article: http://127.0.0.1:3000/<slug>` at the
end so the operator can inspect the result directly — keep in mind
that re-launching the same topic wipes that URL (see lesson 8).

## What `setup` does

`./agentic-testing/run setup` is the agent-agnostic preflight. It:

1. Restarts the dev web server (`:3000`) and MCP HTTP server
   (`:3333`) so the in-memory code matches the working tree.
   Tracks each via its own PID file under `runs/`, so we never
   touch a process the operator started themselves outside the
   harness. If the operator is managing one of those servers
   externally, prints a `WARN:` and proceeds (next-run rendering
   may be stale until they restart it).
2. Populates `seed/meta/` from production agpedia.org if empty.
   (Snapshots are gitignored — production page bodies are mutable
   content, not source-controlled artifacts.)
3. Provisions the test user `agentic-test@example.com` with all
   account-lifecycle gates passed (email verified, not blocked,
   `agent_access_request` approved). Idempotent.
4. Seeds `/meta/*` pages into the local DB so the inner agent has
   a realistic orientation surface.
5. Issues a fresh MCP API token for the test user.
6. Writes `runs/.mcp-config.json` (chmod 600, gitignored) — a
   Claude-Code-format MCP config that defines exactly one server
   (agpwiki-local) with the bearer token wired in. The claude
   launcher passes this to `claude --strict-mcp-config`, which
   makes the inner agent ignore every other MCP source. Other
   launchers (codex, goose) use their own equivalents and only
   need `TOKEN` + `MCP_URL`.
7. Verifies the config file carries only agpwiki-local before
   any launch happens.
8. Wipes prior test artifacts when asked (see the cleanup
   section). Default is `--no-clean`; pass `--full-clean` or
   `--target-slug <slug>` to clean.

When `setup` succeeds it prints machine-readable values:

```
TOKEN=<bearer token>
MCP_URL=http://127.0.0.1:3333/mcp
MCP_CONFIG_FILE=/abs/path/to/agentic-testing/runs/.mcp-config.json
TASKS_DIR=/abs/path/to/agentic-testing/tasks
RUNS_DIR=/abs/path/to/agentic-testing/runs
```

That's the **contract** any launcher consumes. A non-Claude agent
can call `setup` standalone, capture those values, and configure
its own MCP client accordingly. Setup does **not** modify the
operator's claude config — the per-run config file is the only
artifact.

## Subcommands

| Verb | What it does |
| --- | --- |
| `setup` | Idempotent preflight. Prints the contract above. |
| `launch <agent> --task <path>` | Runs `setup`, invokes `lib/launchers/<agent>.sh`, captures transcript + analysis to `runs/<ts>/`. |
| `analyze <transcript>` | Re-run analysis against an existing transcript. |
| `clean --full` / `clean --slug <slug>` | Wipe DB + media-storage artifacts. Mode flag required. |
| `bootstrap` | Start `npm run dev` + `npm run mcp-http` if not running. |
| `refresh-seed` | Re-fetch `/meta/*` page bodies from agpedia.org into `seed/meta/`. |

## Writing a task

Tasks live in `tasks/`. A task is a markdown file with a single
required heading: `## Prompt`. Everything below that heading is
sent to the inner agent as the user message; the rest of the file
is operator notes.

The shipped example is `tasks/create-article.md`. Use it as a
template — pick a topic, set the framing, and end with a
**retrospective** structure the agent fills in. The retrospective
is the load-bearing output: vague retrospectives are useless;
specific ones drive concrete tool/doc improvements.

Good retrospective structures ask for:
- Tool-call summary (what the agent actually did)
- Server guidance — what worked
- Server guidance — what was confusing, missing, or contradictory
- Tool friction (specific error messages, schema mismatches)
- Missing affordances (what should exist but doesn't)
- Workarounds adopted (places the agent did something non-obvious)
- Suggested improvements (concrete, small)

## Adding a launcher for another agent

The contract for `lib/launchers/<agent>.sh` is:

**Required input env:**
- `AGENTIC_TASK_FILE` — absolute path to the task markdown.
  Everything after the first `## Prompt` heading is the prompt.
- `AGENTIC_RUN_DIR` — absolute path to a per-run output directory
  that already exists. Write `transcript.jsonl` (or whatever
  format your agent produces) here.

**Provided env:**
- `AGENTIC_TOKEN` — the MCP bearer token to use against `:3333`.
- `AGENTIC_MCP_URL` — `http://127.0.0.1:3333/mcp`.
- `AGENTIC_MCP_CONFIG_FILE` — path to a Claude-Code-format MCP
  config JSON containing exactly `agpwiki-local`. The claude
  launcher passes this to `--strict-mcp-config`. Other launchers
  can ignore it and use `AGENTIC_TOKEN` + `AGENTIC_MCP_URL` to
  build their own equivalent.

**Required behavior:**
- Run the agent end-to-end without operator intervention.
- Run from a private CWD (use `$AGENTIC_RUN_DIR/cwd/`) so the
  inner agent can't read the host repo through filesystem tools.
- Make the inner agent load **only** agpwiki-local — every other
  MCP the operator has registered must be invisible. The
  mechanism is launcher-specific (claude: `--strict-mcp-config`;
  codex: `--ignore-user-config --disable apps`; goose: per-run
  `XDG_CONFIG_HOME`), but the contract is the same. Permission-list flags
  (`--allowedTools` / `--disallowedTools` and analogues) are not a
  substitute — they're bypassed by danger flags.
- Exit zero on success, non-zero on failure.

**Analyzers are agent-specific** because each agent's transcript
format is different (Claude Code emits `stream-json`, Codex CLI
emits its own JSONL events, etc.). Drop a matching
`lib/analyze-<agent>.sh` next to the launcher; the umbrella `run`'s
`pick_analyzer` looks up `analyze-<agent>.sh` by the agent name
parsed from the run-dir suffix and falls back to `analyze-claude.sh`
if that file isn't present. The shipped analyzers (`analyze-claude.sh`,
`analyze-codex.sh`, `analyze-goose.sh`) all produce the same section
shape — tool-call counts, isolation check, tool errors, usage,
final-message text — so cross-agent comparison reads consistently.

## Output structure

```
runs/<utc-timestamp>/
├── transcript.jsonl       agent-specific format (Claude: stream-json)
├── analysis.md            tool counts + retrospective + isolation check
└── cwd/                   inner agent's working dir (so it can't see this repo)
```

Old runs are not auto-cleaned — inspect freely between runs. Wipe
the whole `runs/` dir whenever you want; it's gitignored.

## Lessons baked into the preflight

These are the failure modes the preflight exists to prevent. Read
once, internalize.

1. **Production write — isolate by which MCPs load, not by
   permissions.** If the operator has a production agpedia (or any
   write-capable) MCP registered at user scope and the inner agent
   sees it, the agent can — and on at least one occasion did —
   pick it over the local one and write to the live wiki.
   `--disallowedTools` and `--allowedTools` look like a fix but
   are *permission* gates, and `--dangerously-skip-permissions`
   skips permission entirely, silently neutralizing them. The
   isolation here is structural instead: the claude launcher uses
   `--strict-mcp-config --mcp-config <our file>`, which makes the
   inner agent's MCP catalog be exactly that file — every other
   MCP source is ignored. Codex uses `--ignore-user-config` for
   user MCP config plus `--disable apps` for hosted Codex app
   connectors; goose uses a per-run `XDG_CONFIG_HOME`. None of these depend
   on permission gating. **If you add a new launcher, the contract
   is "the inner agent must load only agpwiki-local" — verify by
   inspecting whatever init/handshake event the agent emits, not
   by asking the model what it can see.**

2. **Stale running server.** `npm run mcp-http` runs `tsx
   src/mcp/http.ts` — no watch. `npm run dev` runs `tsx watch
   src/index.ts` — has a watcher, but it misses real cases:
   branch switches that don't touch file mtimes, and changes to
   non-imported assets the watch graph hasn't picked up. A run
   made against a stale server tests an old surface — for the
   MCP that's misleading tool descriptions / validators; for the
   dev server it's stale render output (markdown plugins, route
   handlers, templates) that doesn't reflect what writes
   actually do. The most insidious form is a **branch switch**
   — checking out a different commit doesn't necessarily touch
   file mtimes, so freshness probes based on `mtime >
   process_start` give false confidence while in-memory code is
   from a different branch entirely. **`setup` unconditionally
   restarts both `mcp-http` and `npm run dev`** as the only
   reliable closure of this gap.

3. **Test user lifecycle gates.** A freshly-created user can't
   use agent features until `email_verified_at` is set, not
   blocked, AND an `agent_access_request` row with status
   `'approved'` exists. Token-auth fails as "Invalid or expired
   token" otherwise — even when the token is fine.

4. **Empty local DB has no orientation surface.** Without
   `/meta/policy`, every mutating tool fails the `policyHash`
   gate, AND the agent has nothing to read for orientation. Seed
   `/meta/*` once per fresh DB.

5. **`npm run create-token` is interactive.** Doesn't accept
   piped input. Use `lib/issue-token.ts` instead.

6. **`claude mcp list` health checks can fail-positive.** It
   pings without sending the bearer token, so a 401 looks like
   "✗ Failed to connect" even when the server is fine. The
   curl probe in `setup` step 1–2 verifies connectivity directly.

7. **Run-to-run variance is real.** Same prompt, same surface,
   same agent — different runs make different choices on whether
   to WebFetch sources, include images, depth of treatment.
   Don't draw conclusions from a single run.

8. **Leftover artifacts bias signal.** A run launched on a DB
   that still contains the topic's article will land the inner
   agent on existing content — it audits and edits rather than
   creating from scratch, exercising a different surface than
   intended. The cleanup step in `setup` prevents this. By default
   `launch` parses `Topic:` from the task file, slugifies it, and
   deletes only that page (plus its `page_aliases` and
   `page_checks` rows) — so prior runs on other topics stay
   visible at `:3000` for inspection. Citations, citation_claims,
   and media are preserved across scoped cleans because they
   aren't FK-linked to a specific page in the data model.
   Operator overrides on `launch`: `--full-clean` (nuclear clean
   of the dev DB's article namespace), `--no-clean` (skip cleanup),
   `--target-slug <slug>` (override the derived slug). When the
   task has no `Topic:` line and no override is given, `launch`
   falls back to `--no-clean` rather than wiping the dev DB
   implicitly. Standalone `setup` also defaults to `--no-clean`;
   pass `--full-clean` or `--target-slug <slug>` to clean.

## Goose: working configurations and known limitations

Goose works as a launcher, but model + runtime + transport + chat
template all need to compose. This section catalogues what we've
seen so other operators can pick a viable starting point.

### Validated working: goose + llama-server + a 30B-class instruct
### model + reduced tool surface

The configuration that produced a real article end-to-end via 20+
MCP tool calls:

- **Inference runtime:** `llama-server` (from llama.cpp) instead of
  ollama. ollama's bundled chat templates have known gaps for some
  model families — the canonical Jinja template in the model's
  `tokenizer_config.json` works correctly when applied via
  `--chat-template-file` to `llama-server`.
- **Provider:** goose's `openai_compatible` (or `openai`) provider
  pointed at the local llama-server endpoint
  (`http://127.0.0.1:8081/v1`). Goose's bearer-token interpolation
  via `${VAR}` syntax in the YAML carries `AGENTIC_TOKEN` to the
  MCP.
- **Reduced tool surface:** the `agpwiki-local` extension's
  `available_tools` whitelist set to the ~6 tools needed for
  article creation (e.g. `wiki_readPage`, `wiki_createPage`,
  `citation_create`, `claim_create`, `citation_query`,
  `page_check_create`). Less-capable models can't keep the full
  ~36-tool spec in working memory; whitelisting a focused subset
  lets them orient and finish the task.
- **Model:** a 30B-class instruct-tuned model that natively
  supports OpenAI-compatible function calling. The agent followed
  policy-page orientation (read `meta/policy` → style → citations
  → scope → values, in that order), constructed CSL-JSON
  citations, and produced a sensibly-structured article.

### Known limitations and per-stack failure modes

**Goose's `<extension>__<tool>` prefix** — goose namespaces
streamable_http and stdio extension tool names as
`<extension>__<tool>`. Many local LLMs strip that prefix when
emitting calls (training-data normalization). Goose's dispatcher
has a fuzzy-match path for *platform* extensions like `developer`
(verified: bare `shell` routes correctly), but not for
streamable_http. So bare `wiki_readPage` from a model that
strips the prefix returns `-32002 Tool not found` from goose's
catalog before reaching our MCP. There's no MCP-server-side fix —
the prefix is added unilaterally by goose at import time.
Workarounds: a model that emits qualified names correctly (most
function-calling-tuned 30B+ instruct variants do, when the chat
template is right), or a goose-side dispatcher patch.

**Ollama chat template gaps** — for some Qwen3 variants ollama's
shipped chat template doesn't extract the model's tool-call output
correctly: the model emits structured calls, ollama returns empty
`content` and empty `tool_calls`. Goose then has nothing to
dispatch. Direct ollama API calls with the same tools array
(bypassing goose) reproduce the issue. See ollama issue #11621.
Fix: use `llama-server` with the canonical chat template instead.

**Default ollama context window** — many ollama-shipped models
default to a 4 K `num_ctx`. Goose serializes its tool spec into
the prompt, so 36 tools is ~16 K of static prompt — already past
the limit, the user task gets truncated, the model sees no task
and returns nothing. Fix: a custom Modelfile bumping `num_ctx`
(`PARAMETER num_ctx 32768`), or set `OLLAMA_CONTEXT_LENGTH` env
var, or switch to llama-server with explicit `-c <size>`.

**`GOOSE_TOOLSHIM` + streaming primaries** — toolshim is supposed
to wrap models that emit text-shaped pseudo-tool-calls, by routing
them through a smaller "shim" model that reformats. With ollama
streaming the primary's output, goose currently feeds individual
*tokens* to the shim ("`{`", "`\n`", ...). No fragment contains a
complete JSON call, so the shim returns `noop` for every chunk.
Fix: don't use toolshim with streaming primaries. (For models
that genuinely emit text-shaped pseudo-calls and need a shim,
non-streaming + a fast structured-output shim model can work.)

For the upstream goose project, the relevant tracked issue is
[#6883](https://github.com/block/goose/issues/6883) (qwen3-coder +
many tools → XML fallback, fixed in PR
[#6882](https://github.com/block/goose/pull/6882)). The
prefix-stripping symptom described above is distinct from #6883
and is not currently tracked.

## Caveats

- This harness writes to your local agpwiki dev DB and your
  local filesystem. It is **not** safe to run against any
  production database. The MCP URL is hard-coded to
  `127.0.0.1:3333` for that reason.
- The seed in `seed/meta/` is a snapshot of mutable production
  content. Don't commit it; refresh it deliberately when
  conventions move.
- Inner agents may make WebFetch / WebSearch calls during a run.
  Those go through the agent's own network, not through the MCP.
  No credentials are passed.
