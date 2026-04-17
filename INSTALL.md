# Installing service-core

## Prerequisites

- **Node.js** 22.x
- **Database**: PostgreSQL 14+ (recommended) or MongoDB 4.2+
- **rqlite** — distributed SQLite used for the platform DB. The `rqlited` binary is bundled under `var-pryv/rqlite-bin/` after `just setup-dev-env`. `bin/master.js` spawns and supervises it; no manual install needed in single- or multi-core deployments.
- **SQLite** (bundled — used for audit and per-user account/index storage)
- **InfluxDB** 1.x (optional — for high-frequency series; PostgreSQL can also serve as series engine)
- **GraphicsMagick** (optional — for image previews): `apt install graphicsmagick`
- [just](https://github.com/casey/just#installation) (task runner)

## Setup

```bash
git clone <repo-url> service-core && cd service-core
just setup-dev-env    # local file structure + MongoDB (dev)
just install          # npm install across all workspaces
```

## Configuration

YAML config files, loaded in order (last wins):

1. `config/default-config.yml`
2. `config/{NODE_ENV}-config.yml`
3. `--config /path/to/override.yml`
4. `--key:path=value` on command line

### Minimal production config

```yaml
# override-config.yml
auth:
  adminAccessKey: <random-32-char-string>
  filesReadTokenSecret: <random-32-char-string>
  trustedApps: '*@https://your-domain.com*'

cluster:
  apiWorkers: 2       # N API workers sharing :3000
  hfsWorkers: 1       # M HFS workers sharing :4000 (0 = disabled)
  previewsWorker: true

dnsLess:
  isActive: true
  publicUrl: https://your-domain.com

http:
  ip: 0.0.0.0
  port: 3000

service:
  name: My Pryv Instance
  eventTypes: https://pryv.github.io/event-types/flat.json
  home: https://your-domain.com
  support: https://your-domain.com
  terms: https://your-domain.com
  assets:
    definitions: https://pryv.github.io/assets-pryv.me/index.json

storages:
  base:
    engine: postgresql    # or mongodb
  platform:
    engine: rqlite        # only supported value; master.js spawns the embedded rqlited
  file:
    engine: filesystem
  series:
    engine: postgresql    # or influxdb
  audit:
    engine: sqlite
  engines:
    postgresql:
      host: localhost
      port: 5432
      database: pryv_db
      user: postgres
      password: <db-password>
      max: 20
    filesystem:
      attachmentsDirPath: /path/to/data/users
      previewsDirPath: /path/to/data/previews
    sqlite:
      path: /path/to/data/users
    rqlite:
      url: http://localhost:4001
      raftPort: 4002
      dataDir: /path/to/data/rqlite-data
      binPath: /path/to/rqlited        # default: var-pryv/rqlite-bin/rqlited
```

### Assets

`service.assets.definitions` points to a JSON file describing UI assets (CSS, icons, login button). If not set, it auto-generates `{publicUrl}/www/assets/index.json` — but service-core does **not** serve this path.

Options:
- Use the public Pryv assets: `https://pryv.github.io/assets-pryv.me/index.json`
- Host your own and set the URL in config

### Email (optional)

For password resets and welcome emails, deploy `service-mail` and configure:

```yaml
services:
  email:
    enabled:
      resetPassword: true
      welcome: true
    method: microservice
    url: http://service-mail-host:9000/sendmail/
    key: <shared-secret>
```


## Running — standalone with HTTPS

master.js supports built-in SSL — no reverse proxy needed.

### Option A: backloop.dev (development)

```yaml
http:
  ssl:
    backloop.dev: true
dnsLess:
  isActive: true
  publicUrl: https://my-computer.backloop.dev:3000
```

```bash
NODE_ENV=development node bin/master.js --config override.yml
```

### Option B: custom certificates (production)

```yaml
http:
  ip: 0.0.0.0
  port: 443
  ssl:
    keyFile: /path/to/privkey.pem
    certFile: /path/to/fullchain.pem
    caFile: /path/to/chain.pem       # optional
dnsLess:
  isActive: true
  publicUrl: https://your-domain.com
```

```bash
NODE_ENV=production node bin/master.js --config override.yml
```

**Note**: When using built-in HTTPS, all three ports (API :3000, HFS :4000, Previews :3001) are served directly by master.js. No additional routing is needed — the client-facing `publicUrl` only covers the API port; HFS and previews are accessed internally or via the API.

> **HFS in standalone mode**: The HFS high-frequency series endpoints (`/{user}/events/{id}/series`) are served on port 4000. In standalone mode without nginx, clients need to reach port 4000 directly. If your firewall only exposes port 443, you will need nginx (see below) or to configure HFS on the same port (not yet supported).

### Option C: built-in HTTPS with auto-renewed Let's Encrypt certificate

You can skip the manual certbot step entirely. Add the `letsEncrypt` block and leave `http.ssl.certFile` / `keyFile` pointing at the managed paths:

```yaml
http:
  ip: 0.0.0.0
  port: 443
  ssl:
    keyFile: var-pryv/tls/your-domain.com/privkey.pem
    certFile: var-pryv/tls/your-domain.com/fullchain.pem
dnsLess:
  isActive: true
  publicUrl: https://your-domain.com
letsEncrypt:
  enabled: true
  email: ops@your-domain.com
  atRestKey: '<base64 of 32 random bytes>'   # see below
  certRenewer: true                          # single-core → this IS the renewer
```

Generate the `atRestKey` once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the resulting string into the YAML (mode 0600 on the override file — it carries admin-level material). In a multi-core deployment every core must have the **same** `atRestKey`; `certRenewer: true` is set on exactly one core (usually the cluster CA holder).

The core derives hostnames from your topology — wildcards for `dns.domain`, single host for `dnsLess.publicUrl` or `core.url` — so there is no separate `hostnames` list to keep in sync. The renewer handles initial issuance, renewal (default 30 days before expiry), and cluster-wide replication via rqlite. Cert files land at `var-pryv/tls/<hostname>/{fullchain.pem,privkey.pem}` (wildcards become `wildcard.<apex>`). Operators with a reverse proxy can point `letsEncrypt.onRotateScript` at a script (`nginx -s reload`, `systemctl reload caddy`, …) — see `SINGLE-TO-MULTIPLE.md` for the multi-core walkthrough and the Cluster security section below.

When `letsEncrypt.enabled: false` (the default), everything in Options A and B works exactly as before.


## Running — behind nginx

Use nginx for SSL termination and multi-port routing.

```yaml
# override-config.yml — no SSL, nginx handles it
http:
  ip: 0.0.0.0
  port: 3000
dnsLess:
  isActive: true
  publicUrl: https://your-domain.com
```

```bash
NODE_ENV=production node bin/master.js --config override.yml
```

### Ports exposed by master.js

| Port | Service | Description |
|------|---------|-------------|
| 3000 | API (N workers) | REST endpoints, Socket.IO, registration |
| 4000 | HFS (M workers) | `/{user}/events/{id}/series`, `/{user}/series/batch` |
| 3001 | Previews (0-1) | Image preview generation (internal) |

### nginx configuration

```nginx
upstream api_backend {
    server 127.0.0.1:3000;
}

upstream hfs_backend {
    server 127.0.0.1:4000;
}

server {
    listen 443 ssl;
    server_name core.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 50m;  # match config uploads.maxSizeMb

    # Default — API server
    location / {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Socket.IO — WebSocket upgrade
    location /socket.io/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # HFS — high-frequency series
    location ~ ^/[^/]+/events/[^/]+/series {
        proxy_pass http://hfs_backend;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:4000;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ ^/[^/]+/series/batch {
        proxy_pass http://hfs_backend;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:4000;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name core.example.com;
    return 301 https://$host$request_uri;
}
```

### Important nginx notes

**HFS Host header** — The `proxy_set_header Host` for HFS locations must be a plain IP:port (e.g. `127.0.0.1:4000`), not the domain. The HFS `subdomainToPath` middleware extracts the subdomain from Host and prepends it to the URL path, which corrupts the route if a real domain is passed.

**Socket.IO in cluster mode** — When `apiWorkers > 1`, the server only accepts WebSocket transport (no HTTP long-polling). This is because cluster round-robin scheduling breaks polling session state across workers. Clients must connect with `transports: ['websocket']`.


## Data directories

| Path | Content |
|------|---------|
| `data/users/` | SQLite DBs (audit, user index, per-user account) |
| `data/users/{userId}/` | Per-user file attachments |
| `data/previews/` | Generated image previews |
| `data/rqlite-data/` | Platform DB (rqlite Raft log + SQLite snapshot) |


## Upgrades

### From v1.x

V1 → v2 is **not** an in-place upgrade. Steps:

1. Bring the v1 install up to **v1.9.3** using the code on the `release/1.9.3` branch. Its MongoDB migrations handle that hop in place.
2. Export v1.9.3 data with **`dev-migrate-v1-v2`** (see that repo's `README.md`). Produces a v2-compatible backup archive.
3. Restore into v2:
   ```bash
   node bin/backup.js --restore /path/to/archive
   ```

Attempting `git pull + npm install` from a v1 data directory directly into v2 will leave orphaned data that v2 does not understand.

### Within v2

v2 uses a forward-only, engine-agnostic schema migration runner (see `storages/interfaces/migrations/README.md`). By default `bin/master.js` applies pending migrations before forking workers (`migrations.autoRunOnStart: true`).

To operate migrations manually:

```bash
node bin/migrate.js status             # per-engine current version + pending
node bin/migrate.js up                 # apply all pending
node bin/migrate.js up --dry-run       # preview
node bin/migrate.js up --target 3      # stop per-engine at version 3
```

Set `migrations.autoRunOnStart: false` in config to disable auto-run at startup and rely on the CLI only.

## Managing persistent DNS records

When the embedded DNS server is active (`dns.active: true`), runtime DNS entries (ACME challenges, admin-managed subdomains) are persisted in PlatformDB so they survive restart and replicate across cores. Two ways to manage them:

### HTTP (admin-key)

```bash
# Upsert
curl -X POST https://api.example.com/reg/records \
  -H "Authorization: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "_acme-challenge", "records": {"txt": ["token"]}}'

# Delete
curl -X DELETE https://api.example.com/reg/records/_acme-challenge \
  -H "Authorization: $ADMIN_KEY"
```

### CLI (`bin/dns-records.js`)

Useful during bootstrap, disaster recovery, or when the HTTP API is unreachable. The CLI writes directly to PlatformDB; a running master picks up changes within its refresh interval (default 30 s).

```bash
node bin/dns-records.js list                        # print all records (YAML)
node bin/dns-records.js load records.yaml           # upsert from file
node bin/dns-records.js load records.yaml --dry-run # preview only
node bin/dns-records.js load records.yaml --replace # also delete records absent from file
node bin/dns-records.js delete _acme-challenge
node bin/dns-records.js export backup.yaml
```

File format:
```yaml
records:
  - subdomain: _acme-challenge
    records:
      txt: ["validation-token"]
  - subdomain: www
    records:
      a: ["1.2.3.4"]
  - subdomain: reg
    records:
      cname: core-a.example.com
```

Static entries declared in `dns.staticEntries` config are authoritative and cannot be shadowed by PlatformDB entries; attempts to write a matching subdomain are rejected.

## Cluster security

When you go multi-core, the Raft channel between cores carries replicated PlatformDB writes (registrations, DNS records, core-info). It must be authenticated. Open Pryv.io ships with a self-managed cluster CA model and bootstrap CLI that automates the setup — see [`SINGLE-TO-MULTIPLE.md`](SINGLE-TO-MULTIPLE.md) for the operator walkthrough. The security guarantees:

- **mTLS on Raft.** With `storages.engines.rqlite.tls.{caFile,certFile,keyFile,verifyClient}` set, both ends of every Raft connection verify the peer's cert against the cluster CA. Unauthenticated TCP on port 4002 is rejected.
- **CA-holder model.** The cluster CA's private key (`/etc/pryv/ca/ca.key`, mode 0600) lives on **exactly one** host — the core that runs `bin/bootstrap.js new-core`. Only this host can issue node certs. Back up `/etc/pryv/ca/` off-host: losing the key means you cannot add or rotate cores without standing up a new cluster.
- **Sealed bundles.** The CLI emits a passphrase-encrypted file (AES-256-GCM, scrypt KDF) carrying identity + platform secrets + node cert/key + CA cert + a one-time join token. The new core consumes it via `bin/master.js --bootstrap <file> --bootstrap-passphrase-file <pass>`.
- **One-shot join tokens.** Each bundle contains a token that verifies exactly once at the issuing core's `/system/admin/cores/ack` endpoint and is then burned. Default TTL 24h. Replays return HTTP 401. The ack endpoint deliberately bypasses admin-key auth — the new core authenticates via the token, not the admin key.
- **Bundle/passphrase split.** Transfer the bundle file and the passphrase on different channels (e.g. file via `scp`, passphrase via password manager). Compromise of either alone is not enough to ack.

Single-core deployments do not need any of this — `tls: null` (the default) leaves the Raft setup at plain loopback TCP, which is fine for a single host.

## Troubleshooting

### Socket.IO: "Transport unknown" or "xhr poll error"

In cluster mode (`apiWorkers > 1`), HTTP long-polling is disabled. Clients must use:
```js
io(endpoint, { transports: ['websocket'] });
```
**Workaround**: set `cluster.apiWorkers: 1` (not recommended for production).

### HFS: "Unknown resource" on series endpoints

The HFS runs on port 4000. If your reverse proxy only forwards to 3000, series endpoints return 404. Add the HFS nginx locations shown above.

The `Host` header sent to HFS must be a plain IP:port — see "HFS Host header" above.

### Previews: "Could not load the sharp module"

```bash
npm install --os=linux --cpu=x64 sharp
```
Or disable: `cluster.previewsWorker: false`.
