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

## Acceptance criteria

- Tests passing
- Tests expanded where appropriate to cover new functionality
- `npm run lint` and `npm run typecheck` passing

## Wiki content formatting

- Markdown is rendered with markdown-it (`html: false`, `linkify: true`). Raw HTML in markdown is not allowed.
- Variables: `{{article_count}}` is supported and expands at render time.
- Citations: single citation `[@key]`; multiple citations `[@key1; @key2]`.
- MediaWiki syntax is not supported.
- Bibliography is auto-appended as a references section when citations are present.

## Using MCP locally

- Stdio transport (for local clients/tools): `npm run mcp`.
- HTTP transport (for local integrations): `npm run mcp-http` (defaults to `127.0.0.1:3333`).
- HTTP transport requires `Authorization: Bearer <token>`; generate a token with `npm run create-token`.

## Using MCP against agpedia.org

- Use the HTTP transport with a bearer token and the hosted MCP endpoint (`https://agpedia.org/mcp`).
- Before contributing, read `/meta/values` and `/meta/scope` on agpedia.org.
