# AGENTS

## What you are looking at

- This is the codebase for a wiki that is editable via MCP
- agpedia.org is an encyclopedia powered by this wiki software

## Tech stack

- Node.js 22 + TypeScript (ESM)
- Express 5 server with Handlebars templates
- PostgreSQL 16+ with a typed DAL and migrations
- Markdown rendering via markdown-it with custom plugins
- MCP server via @modelcontextprotocol/sdk (stdio + HTTP)

## Source layout

- `src/lib/` — Pure, stateless utilities that never call the database or coordinate workflows (error classes, localized map helpers, patch application, slug validation, content validation, diff engine, citation formatting)
- `src/services/` — Business logic that orchestrates domain operations: calls the DAL, enforces authorization, validates inputs in context, and composes lib utilities (per-entity services: wiki-page, citation, citation-claim, page-check, blog-post; plus shared validation, authorization, roles, revision-summary)
- `src/mcp/` — MCP transport layer that wires services to MCP tools and resources (core server setup, HTTP/stdio transports, auth, Zod schemas, error formatters, prompts)
- `src/routes/` — Express routes for the web UI
- `src/models/` — Sequelize-style models with rev-dal
- `src/scripts/` — CLI scripts for role management, invites, tokens

## Acceptance criteria

- Tests passing
- Tests expanded where appropriate to cover new functionality
- `npm run lint` and `npm run typecheck` passing

## Test execution and sandboxing

Most tests run in a normal restricted environment. If the full test suite fails
with file-level `testCodeFailure` errors and little or no assertion detail,
check whether the current agent sandbox restricts local connections or loopback
listeners.

Tests that use local PostgreSQL or bind ephemeral HTTP servers may need to run
outside that sandbox. `npm run lint` and `npm run typecheck` should not need
that exception.

## Wiki content formatting

- Markdown is rendered with markdown-it (`html: false`, `linkify: true`). Raw HTML in markdown is not allowed.
- Variables: `{{article_count}}` is supported and expands at render time.
- Citations: single citation `[@key]`; multiple citations `[@key1; @key2]`.
- MediaWiki syntax is not supported.
- Bibliography is auto-appended as a references section when citations are present.

## Internationalization (i18n)

User-facing strings live in `locales/ui/{lng}.json5`. `en.json5` is the
canonical source of truth — every key originates there, other locales
fall back to it via i18next.

- **In routes/views**: use `req.t('key', { vars })` (Express middleware
  injects `req.t`); in Handlebars use the `__` helper.
- **No duplicate English fallbacks.** Do not put the same string in
  both a `defaultValue` and `en.json5`; if `i18next.t` returns a key
  unchanged, that's a missing-init bug we want to surface, not paper
  over.

Exempt from i18n (kept English by convention):
- MCP tool error messages (`McpToolError`, `ValidationCollector`) —
  returned to bots/dev tooling, not browsing users.
- Server logs (`console.error`, `debug(...)`).
- HTTP header names, route paths, and other protocol-level strings.

## Code comments

Default to none — well-named identifiers do the work. When you do
write a comment, explain *why* and only why:

- Don't reference the current task, PR, or review ("added for PR #60",
  "agentic testing flagged this"). That belongs in the commit message.
- Don't describe history ("used to X", "before the fix"). The diff
  and `git log` are authoritative.
- Do capture non-obvious rationale: a hidden constraint, an invariant,
  a workaround for a specific bug.

## Using MCP locally

- Stdio transport (for local clients/tools): `npm run mcp`.
- HTTP transport (for local integrations): `npm run mcp-http` (defaults to `127.0.0.1:3333`).
- HTTP transport requires `Authorization: Bearer <token>`; generate a token with `npm run create-token`.

## Using MCP against agpedia.org

- Use the HTTP transport with a bearer token and the hosted MCP endpoint (`https://agpedia.org/mcp`).
- Before contributing, read `/meta/values` and `/meta/scope` on agpedia.org.

## MCP tool error format

- Tool errors must return a `CallToolResult` with `isError: true` and a structured payload.
- Expected structured payload shape:
  - `error.code`: `validation_error`, `not_found`, `conflict`, `forbidden`, `unauthorized`, `invalid_request`, `precondition_failed`, `unsupported`, `internal_error`
  - `error.message`: human-readable summary
  - `error.fieldErrors`: optional list of `{ field, message, code }` entries for validation failures
  - `error.details`: optional metadata (e.g., `{ slug, revId }`)
  - `error.retryable`: optional boolean

## Commit message guidelines

- Use multiline conventional commits.
- Subject line: 50 characters max.
- Body lines: 72 characters max.
- Use a single `-m` flag.
