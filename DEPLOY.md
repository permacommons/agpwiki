# Deployment

This doc covers a basic production deployment for the AGP Wiki web app and MCP server.

## Build artifacts

The build outputs to `dist/` with a `src/` prefix. The entrypoint is:

- `dist/src/index.js` (web app)
- `dist/src/mcp/stdio.js` (MCP server, stdio transport)
- `dist/src/mcp/stdio-playwright.js` (local-only MCP with Playwright)

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
  }
}
```

## Database

Provision Postgres and apply grants from `dal/setup-db-grants.sql`. On boot, the app runs migrations automatically.

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

The MCP server uses stdio transport and must be run as a separate process. It requires a token via `AGPWIKI_MCP_TOKEN`.

Create a token for a user:

```bash
npm run create-token
```

### systemd (MCP stdio)

Example unit at `/etc/systemd/system/agpwiki-mcp.service`:

```
[Unit]
Description=AGP Wiki MCP server (stdio)
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/agpwiki
Environment=NODE_ENV=production
Environment=NODE_CONFIG_DIR=/opt/agpwiki/config
Environment=AGPWIKI_MCP_TOKEN=REPLACE_ME
ExecStart=/usr/bin/node /opt/agpwiki/dist/src/mcp/stdio.js
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

### Connecting to MCP from a workstation

Codex (or another MCP client) can spawn the remote stdio server over SSH. Example `~/.codex/config.toml` entry:

```toml
[mcp_servers.agpwiki-prod]
command = "bash"
args = ["-lc", "ssh agpwiki@your-host 'AGPWIKI_MCP_TOKEN=REPLACE_ME node /opt/agpwiki/dist/src/mcp/stdio.js'"]
```

Notes:

- The stdio MCP server is not an HTTP service. Use SSH or a dedicated MCP bridge if you need network transport.
- Do not expose `AGPWIKI_MCP_TOKEN` publicly. Rotate it via the web UI or CLI.

## Playwright MCP (local only)

`npm run mcp-playwright` is intended for local research (Playwright deps, DISPLAY, etc.). It should not run on the production host.

## Backups

At minimum, run `pg_dump` nightly. For example:

```bash
pg_dump -Fc agpwiki > /var/backups/agpwiki-$(date +%F).dump
```

## Smoke checks

- `GET /health` returns `{"status":"ok"}`
- `GET /meta/welcome` renders
- MCP tool calls succeed using a valid token
