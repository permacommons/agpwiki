# Deployment

This doc covers a basic production deployment for the AGP Wiki web app and MCP server.

## Build artifacts

The build outputs to `dist/` with a `src/` prefix. The entrypoint is:

- `dist/src/index.js` (web app)
- `dist/src/mcp/stdio.js` (MCP server, stdio transport)
- `dist/src/mcp/http.js` (MCP server, Streamable HTTP transport)
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
