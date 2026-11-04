# Deployment

This doc covers a basic production deployment for the AGP Wiki web app and MCP server.

## Build artifacts

The build outputs to `dist/` with a `src/` prefix. The entrypoint is:

- `dist/src/index.js` (web app)
- `dist/src/mcp/stdio.js` (MCP server, stdio transport)
- `dist/src/mcp/http.js` (MCP server, Streamable HTTP transport)
- `dist/src/scripts/process-notifications.js` (notification worker)

## Configuration

Defaults live in `config/default.json`. For production, either:

- create `config/production.json`, or
- set environment variables supported by `node-config`.

Minimum:

- `NODE_ENV=production`
- `server.port` (if not 3000)
- `postgres.*` settings

Example `config/production.json`:

```json
{
  "server": { "port": 3000 },
  "postgres": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "agpwiki",
    "user": "agpwiki_user",
    "password": "REPLACE_ME",
    "max": 20,
    "idleTimeoutMillis": 30000,
    "connectionTimeoutMillis": 2000
  },
  "altcha": {
    "hmacKey": "REPLACE_ME",
    "enabled": true
  },
  "wikiLinkPreviews": {
    "previewTokenSecret": "REPLACE_ME",
    "previewTokenTtlSeconds": 86400
  }
}
```

### ALTCHA CAPTCHA

The account request form uses ALTCHA for spam prevention. Generate a secure HMAC key:

```bash
npm run generate-altcha-key
```

Add the output to your production config under `altcha.hmacKey`.

### Wiki Link Preview Tokens

Internal wiki-link hover previews use a signed per-page token for the
`/api/wiki-link-preview` endpoint. The default secret in
`config/default.json` is only for local development and must be replaced in
production.

Generate a secure random secret, for example:

```bash
openssl rand -hex 32
```

Add the result to your production config under
`wikiLinkPreviews.previewTokenSecret`.

## Database

Provision Postgres and apply grants from `node_modules/rev-dal/setup-db-grants.sql` (see `CONTRIBUTING.md` for the required variables). On boot, the app runs migrations automatically.

## Roles

List the supported roles and their meanings:

```bash
npm run list-roles
```

## Build + run (manual)

```bash
npm ci
npm run build
NODE_ENV=production npm run start
```

## systemd (web app)

Example unit at `/etc/systemd/system/agpwiki.service`:

```
[Unit]
Description=AGP Wiki web app
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/agpwiki
Environment=NODE_ENV=production
Environment=NODE_CONFIG_DIR=/opt/agpwiki/config
ExecStart=/usr/bin/node /opt/agpwiki/dist/src/index.js
Restart=always
RestartSec=5
User=agpwiki
Group=agpwiki

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agpwiki.service
```

## Reverse proxy (nginx)

```nginx
server {
  listen 80;
  server_name agpedia.example;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## HTTPS (certbot + nginx)

Quick start with Let’s Encrypt:

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d agpedia.example
```

Notes:

- Certbot will install TLS certs and update your nginx config automatically.
- It also sets up auto-renewal via systemd timers.
- For multiple domains, repeat `-d` for each hostname.

## MCP server (production)

Use the Streamable HTTP transport so ordinary users can connect over HTTPS with their API tokens.

### systemd (MCP HTTP)

Example unit at `/etc/systemd/system/agpwiki-mcp.service`:

```
[Unit]
Description=AGP Wiki MCP server (HTTP)
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/agpwiki
Environment=NODE_ENV=production
Environment=NODE_CONFIG_DIR=/opt/agpwiki/config
ExecStart=/usr/bin/node /opt/agpwiki/dist/src/mcp/http.js
Restart=always
RestartSec=5
User=agpwiki
Group=agpwiki

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agpwiki-mcp.service
```

## Notification worker

Run forum notification delivery as a separate long-lived worker process.
This deployment assumes exactly one notification worker instance. On startup,
the worker resets any previously in-flight `processing` jobs back to
`pending`, so do not run multiple notification workers concurrently.

### systemd (notifications)

Example unit at `/etc/systemd/system/agpwiki-notifications.service`:

```
[Unit]
Description=AGP Wiki notification worker
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/agpwiki
Environment=NODE_ENV=production
Environment=NODE_CONFIG_DIR=/opt/agpwiki/config
ExecStart=/usr/bin/node /opt/agpwiki/dist/src/scripts/process-notifications.js
Restart=always
RestartSec=5
User=agpwiki
Group=agpwiki

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agpwiki-notifications.service
```

### nginx proxy for MCP

Forward `/mcp` to the MCP HTTP service:

```nginx
location /mcp {
  proxy_pass http://127.0.0.1:3333;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Connecting to MCP from a workstation

Use the Streamable HTTP client with a bearer token:

```toml
[mcp_servers.agpwiki-prod]
command = "bash"
args = ["-lc", "AGPWIKI_MCP_URL=https://your-host/mcp AGPWIKI_MCP_TOKEN=REPLACE_ME node /path/to/your/mcp-client.js"]
```

Notes:

- MCP HTTP requires `Authorization: Bearer <token>`.
- Rotate tokens via the web UI or CLI.

## Backups

At minimum, run `pg_dump` nightly. For example:

```bash
pg_dump -Fc agpwiki > /var/backups/agpwiki-$(date +%F).dump
```

If you also publish a sanitized public dump, generate it separately:

```bash
npm run dump-public-data
```

This writes a redacted content-only archive to `public/downloads/dumps/`.

## Smoke checks

- `GET /health` returns `{"status":"ok"}`
- `GET /meta/welcome` renders
- internal wiki-link hover previews load on article pages
- MCP tool calls succeed using a valid token

## Wiki Link Preview Runtime Notes

- The hover preview endpoint is `/api/wiki-link-preview`.
- Local blue-link previews are rendered server-side from existing wiki
  content.
- Missing red-link previews may trigger a server-side lookup against
  Wikipedia and show a sanitized lead-paragraph extract when available.
- Wikipedia lookups are on-demand only. They are not done during page
  render.
- Preview caches are process-local in-memory caches. They do not survive
  restarts, and multiple app instances do not share cache state.
- The app sends a project-specific `User-Agent` when calling Wikipedia.


## Wikidata infobox cache

Infobox snapshots are stored in PostgreSQL's `wikidata_items` table and survive
restarts. Creating or updating a page with a Wikidata ID warms missing or stale
cache entries asynchronously after the save succeeds. Saving does not wait for
Wikidata, and fresh entries are not fetched again.

The web process also sweeps Wikidata IDs referenced by current, non-deleted pages
on startup and periodically thereafter. It processes missing entries first, then
the oldest stale entries, sequentially in bounded batches. Deployment settings under
`wikidata` in `config/default.json5` are:

- `refreshAfterHours: 24`: age after which a snapshot is stale.
- `fetchEnabled: true`: enables fetching through saves, views, and sweeps.
- `userAgent`: identifies the deployment and provides a contact URL.

Internal constants set a 60-second delay between completed sweeps, a maximum of
20 items per sweep, one-second request spacing, and an eight-second network
timeout. API endpoints are fixed in production; fetch tests inject their own.

All infobox Wikidata, SPARQL, and Commons metadata requests share one serial queue
per process, including requests triggered by saves, views, and sweeps. The queue
waits for response bodies, not just headers, before starting the next request.
The default spacing caps starts at roughly 60 requests per minute across these
endpoints; one item may require several requests. Other media-import requests do
not use this infobox queue and must be included when budgeting total traffic.

Action API requests include `maxlag=5`. HTTP 429/5xx responses, network failures,
and API errors activate endpoint-wide backoff, starting at five seconds and
increasing exponentially to five minutes. A longer `Retry-After` delay (seconds or
HTTP date) is honored without that cap. Requests to that endpoint fail while it
is in backoff; the existing item retry cooldown and later sweeps provide retries.
Success resets the endpoint backoff. API error envelopes returned with HTTP 200
are rejected, so they cannot replace a usable snapshot with empty data.

These internal limits are conservative defaults, not a guarantee against throttling.
Check the current [Wikimedia API limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
and [SPARQL limits](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual#Query_limits)
before increasing traffic. SPARQL also has processing-time limits.

Views still provide a fallback for operator edits and saves followed by immediate
views. Cached snapshots are returned immediately, with stale entries refreshed in
the background. A view without a cached snapshot waits at most three seconds;
the fetch continues afterward, and that response has no infobox if it timed out.
Failed fetches keep existing snapshots and have a ten-minute retry cooldown.

Current limitations:

- In-flight fetch sharing and retry cooldowns are in memory, scoped to one process.
  Saves, views, and sweeps in that process share them, along with request pacing
  and endpoint backoff. Separate web/MCP processes
  or replicas can duplicate requests; restarts clear cooldowns. Use database-backed
  coordination before relying on deduplication or aggregate rate limits across
  processes.
- Sweeps run only in the web process, not in MCP or notification workers. There is
  no durable job queue or strict freshness guarantee. Work resumes from database
  cache timestamps after restart, and large backlogs take multiple sweeps.
- Request queues are in memory and are not bounded by the sweep batch size;
  bursts of saves or uncached views can queue additional work.
- Saves can finish before warming completes. Wikidata outages can leave snapshots
  stale indefinitely or leave an uncached article without an infobox.
- Cache entries are not automatically purged when no article references them, and
  changes to infobox definitions or supported languages do not invalidate snapshots
  immediately; those changes take effect on a subsequent refresh.
