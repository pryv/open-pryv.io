# Installing service-core

## Prerequisites

- **Node.js** 24.x (matches `engines.node` in `package.json`)
- **Database**: PostgreSQL 14+ (default) or SQLite (bundled — alternative for low-volume / single-user deployments)
- **rqlite** — distributed SQLite used for the platform DB. The `rqlited` binary is bundled under `bin-ext/` after `just setup-dev-env` (Docker image: `/app/bin-ext/rqlited`). `bin/master.js` spawns and supervises it; no manual install needed in single- or multi-core deployments.
- **InfluxDB** 1.x (optional — for high-frequency series; PostgreSQL can also serve as series engine)
- **GraphicsMagick** (optional — for image previews): `apt install graphicsmagick`
- [just](https://github.com/casey/just#installation) (task runner)

## Setup

```bash
git clone <repo-url> service-core && cd service-core
just setup-dev-env    # local file structure + PostgreSQL + rqlite (dev)
just install          # npm install across all workspaces
```

## Configuration

YAML config files, loaded in order (last wins):

1. `config/default-config.yml`
2. `config/{NODE_ENV}-config.yml`
3. `--config /path/to/override.yml`
4. `--key:path=value` on command line

### Quickest path: `docker run … init` (interactive wizard)

For a fresh single-core install, the docker image ships an interactive wizard that produces a complete `pryv-config.yml` from prompts (DNS topology, storage engine, secrets, TLS strategy, app-web-auth3 URL, …) and validates the host environment before writing.

Pick (or create) the host directory where you want your install to live, `cd` into it, and run:

```bash
mkdir -p /opt/pryv && cd /opt/pryv
docker run -it --rm \
  -v "$(pwd):/app/pryv" \
  pryvio/open-pryv.io:2.0.0-rc.1 init
```

After the wizard finishes, `$PWD` contains `pryv-config.yml` + `run-pryv.sh` + a `data/` folder for user data. Start the server with `./run-pryv.sh`.

The mount **target** (right of the `:`) must not be `/app/config` — that directory is owned by the image and holds the bundled config plugins (`systemStreams`, `paths-config`, …); a directory mount over it would mask them and master.js would refuse to boot. `/app/pryv` is the conventional non-conflicting choice and is hardcoded in the wizard; no path argument is needed.

The wizard:
- Auto-discovers the host path from `/proc/self/mountinfo` so the generated `run-pryv.sh` carries the operator's real on-disk path. No env-var override needed in the common case.
- Prompts for ~15 deployment-specific choices; defaults are pre-filled and accepted with enter.
- Auto-derives the user-data folder to `<pwd>/data` (sibling to the config). No prompt.
- Pins `letsEncrypt.tlsDir: <pwd>/data/tls` so the ACME-issued cert lives on the same operator-mounted volume as the workers' `http.ssl.{certFile,keyFile}` paths — survives container restarts cleanly.
- Generates random secrets (`auth.adminAccessKey`, `auth.filesReadTokenSecret`, `letsEncrypt.atRestKey`) — *back these up before discarding the container output, losing them locks you out of audit + cert decryption*.
- For `dnsLess: false` (multi-core / subdomain-per-user), prints a host pre-flight block with the commands to free UDP/53 on the host (disable `systemd-resolved` on Ubuntu 24+ / Fedora / modern Debian).
- Refuses to overwrite an existing `pryv-config.yml` — move the file aside to re-run.
- Writes a sibling `run-pryv.sh` launcher that pins the image, self-locates via `cd "$(dirname "$0")" && pwd`, mounts config + data, and publishes the right ports for the configuration you chose:

```bash
# Inside the install dir created above:
./run-pryv.sh
# Override the host data dir if you want it elsewhere:
PRYV_DATA_DIR=/srv/pryv/data ./run-pryv.sh
```

If you prefer hand-crafting the YAML (or already have one), skip to **Minimal production config** below. The wizard's output matches that shape exactly.

### Validating an existing config

`check-config` runs the same structural checks the wizard runs (REQUIRED service fields, REQUIRED_WHEN auth secrets, dnsLess vs dns.active, PG creds when applicable, etc.) against a config you already have, without booting. Useful for catching half-configured cases (e.g. `access.defaultAuthUrl` missing — would silently break SDK sign-in) before they hit production.

```bash
docker run --rm \
  -v "$(pwd):/app/pryv" \
  pryvio/open-pryv.io:2.0.0-rc.1 \
  check-config /app/pryv/pryv-config.yml
```

Exit 0 = all required-at-boot checks passed. Exit 1 = at least one problem (printed). Warnings (e.g. missing `access.defaultAuthUrl`) print but don't fail.

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
  # Required fields — master refuses to start with any of these missing.
  name: My Pryv Instance
  serial: "2026042001"                         # platform-specific build tag; bump on config change
  eventTypes: https://pryv.github.io/event-types/flat.json
  home: https://your-domain.com
  support: https://your-domain.com
  terms: https://your-domain.com
  # Optional — SDKs display / fetch these; falls back to sensible defaults.
  assets:
    definitions: https://pryv.github.io/assets-pryv.me/index.json

storages:
  base:
    engine: postgresql    # or sqlite
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
      binPath: /path/to/rqlited        # default: bin-ext/rqlited
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

**Note**: When using built-in HTTPS, the public API port also routes HFS series and previews traffic in-process. Clients only need access to the configured `http.port` (typically `:443`); HFS and previews stay on their internal ports (`:4000` / `:3001`) and are reached via dispatchers in front of the api-server.

> **HFS in standalone mode**: high-frequency series endpoints (`/{user}/events/{id}/series`, `/{user}/series/batch`) are routed from the public port to the HFS worker on `:4000` by an in-process dispatcher in api-server. Set `cluster.hfsWorkers: 1` (or more) to enable HFS; SDKs read `features.noHF` on `/service/info` to know whether the cluster serves HFS (auto-derived from `cluster.hfsWorkers` — explicit `service.features.noHF` in config takes precedence).
>
> The in-process dispatcher is the **quick / out-of-the-box** path. For long-term high-throughput installs, front the cluster with nginx — see `docs/nginx-ingress-sample.conf` for the reference vhost. nginx is more efficient at proxying and unlocks edge features (rate-limiting, header munging, static assets).

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

## Docker / Dokku deployment

### What to persist

The container writes to two distinct roots. Only these need to survive restart:

| Container path | Purpose | Must persist? |
|---|---|---|
| `/app/data` | User files, attachments, previews, audit SQLite (`PRYV_DATADIR`) | **YES** |
| `/app/var-pryv/rqlite-data` | PlatformDB — rqlite Raft log + SQLite snapshot | **YES** |
| `/app/bin-ext/rqlited` | rqlited binary baked into the image | **NO** — never mount over |
| `/app/config/override-config.yml` | Operator-owned overrides | YES (or bake into image) |

The Dockerfile declares `VOLUME ["/app/var-pryv/rqlite-data"]` so this is the default persistent path for docker operators. **Do NOT bind-mount `/app/var-pryv` wholesale** — earlier image builds placed the rqlited binary at `/app/var-pryv/rqlite-bin/rqlited`, and a stray broad mount used to shadow it. The binary is now at `/app/bin-ext/rqlited`, outside any data path, so the trap is avoided by default.

### Docker (plain)

If you generated the config + launcher via the wizard (see **Configuration → Quickest path** above), just run the sibling `run-pryv.sh`. Otherwise, the manual form:

```bash
docker run \
  -v /host/pryv/data:/app/data \
  -v /host/pryv/rqlite-data:/app/var-pryv/rqlite-data \
  -v /host/pryv/override-config.yml:/app/config/override-config.yml:ro \
  -e NODE_ENV=production \
  -e PRYV_DATADIR=/app/data \
  -p 3000:3000 \
  pryvio/open-pryv.io:2.0.0-rc.1
```

The default entrypoint dispatches on the first arg: no args boots `bin/master.js` (the normal server); `init <path>` runs the wizard; `check-config <path>` runs the validator; anything else passes through (e.g. `docker run pryvio/open-pryv.io node --version`).

When running with `letsEncrypt.enabled: true` (master serves HTTPS itself
instead of being fronted by a reverse proxy), publish 443 (HTTP-01 also
needs 80, DNS-01 doesn't):

```bash
docker run \
  ... \
  -p 443:443/tcp \
  -p 80:80/tcp \
  pryvio/open-pryv.io:2.0.0-rc.1
```

The Dockerfile already declares `EXPOSE 80 443 3000 3001 4000 53/udp`; the
`-p` flags above publish the relevant ones to the host. For DNS-active mode
add `-p 53:53/udp`.

### Dokku

```bash
dokku apps:create open-pryv-io

# Persistent mounts — data + PlatformDB only
dokku storage:mount open-pryv-io \
  /var/lib/dokku/data/storage/open-pryv-io/data:/app/data
dokku storage:mount open-pryv-io \
  /var/lib/dokku/data/storage/open-pryv-io/rqlite-data:/app/var-pryv/rqlite-data
dokku storage:mount open-pryv-io \
  /var/lib/dokku/data/storage/open-pryv-io/config/override-config.yml:/app/config/override-config.yml

dokku config:set open-pryv-io NODE_ENV=production PRYV_DATADIR=/app/data PRYV_LOGSDIR=/app/data/logs
```

**After `dokku ps:restart`**, always run `dokku proxy:build-config <app>`. Dokku's nginx upstream list does not refresh on container restart; without rebuilding the proxy config, the public URL will 502 even though the container is healthy. An `wget http://127.0.0.1:3000/reg/service/info` inside the container will succeed throughout — the symptom is only visible externally.

**PostgreSQL via `dokku postgres:link`** exports `DATABASE_URL` into the container environment. Open-Pryv.io v2 reads `storages.engines.postgresql.{host,port,database,user,password}` from `override-config.yml` directly — `DATABASE_URL` is **not** auto-consumed today. Populate the concrete keys in your override-config. A future `--from-database-url` convenience is tracked in the roadmap.

**UDP port 53** for DNS-active mode (`dns.active: true` + embedded DNS server) is not supported by `dokku ports:set`. Workaround:

```bash
dokku docker-options:add <app> deploy,run "-p 53:5353/udp"
```

For most Dokku deployments the simpler path is **dnsLess mode** — set `dnsLess.isActive: true` + `dnsLess.publicUrl: https://<reg-fqdn>` in `override-config.yml` and let the reverse proxy terminate TLS as usual.

**TCP port 443 in `proxy:disable` mode** (Option C — `master.js` terminates TLS via `letsEncrypt.*` / `http.ssl.*`). `dokku-nginx` is what normally bridges Dokku's port map to Docker `-p` flags; with the proxy disabled, `dokku ports:add https:443:443` shows the mapping but no host port is published. Add the binding explicitly, same shape as the UDP/53 workaround above:

```bash
dokku docker-options:add <app> deploy,run "-p 443:443/tcp"
```

Without this, clients hit `ECONNREFUSED` on 443 even though the container is healthy and `wget https://127.0.0.1:443` inside it succeeds.

**Bare-metal embedded DNS (non-Docker)** — when `bin/master.js` runs as a non-root user (typical) and `dns.port: 53`, Linux refuses the bind unless the `node` binary carries `cap_net_bind_service`. Grant it once per host (and **after every Node upgrade — `apt install nodejs` wipes file capabilities**):

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(which node)"
sudo getcap "$(which node)"   # expect: cap_net_bind_service=ep
```

Without the cap, the embedded DNS server hangs silently — `dns2`'s `listen()` promise waits for a `'listening'` event that the failing UDP server never emits, and `master.js` stops mid-init right after `TCP pub/sub broker started`, never forking workers. (Docker images don't need this — `node` runs as PID 1 / root inside the container.)

**Native HTTPS (ports 80 / 443)** when running ACME directly inside the
container (`letsEncrypt.enabled: true`) needs the same publishing dance —
`dokku ports:add` only exposes ports declared in the Dockerfile's `EXPOSE`.
Open-Pryv.io declares 80, 443, 3000, 3001, 4000 and 53/udp, so:

```bash
dokku ports:add <app> http:80:80
dokku ports:add <app> https:443:443
```

…will work. If you front the container with Dokku's built-in nginx instead
(reverse-proxy mode), leave LE off, set `http.ssl.*` to nothing, and let
Dokku terminate TLS — `letsEncrypt.enabled` is purely opt-in.


## Upgrades

### Node major bumps (v2 → v2)

When a release ticks the `engines.node` major (e.g. 22.x → 24.x), upgrade
the runtime on every host **before** restarting the new code. On
NodeSource-based installs:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

If you're running native HTTPS or the embedded DNS as non-root, also
re-grant `cap_net_bind_service` on the new binary — `apt install nodejs`
clears file capabilities (see the embedded-DNS note in the Dokku section
above for the full failure mode and command).

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
