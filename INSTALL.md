# Installing Open Pryv.io

## Prerequisites

- **Node.js** 24.x **below 24.19.0** (matches `engines.node` in `package.json`). Once the SQLite
  driver is built against Node 24.19+ headers, which is what installing on 24.19 or later does, the
  process aborts when a SQLite statement is garbage-collected
  ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)); SQLite is the default audit
  engine, so this hits every native install. The Docker image is not affected (it pins Node
  24.18.0). See "Node major bumps" below for pinning the version.
- **Database**: PostgreSQL 14+ (default) or SQLite (bundled — alternative for low-volume / single-user deployments)
- **rqlite** — distributed SQLite used for the platform DB. The `rqlited` binary is bundled under `bin-ext/` after `just setup-dev-env` (Docker image: `/app/bin-ext/rqlited`). `bin/master.js` spawns and supervises it; no manual install needed in single- or multi-core deployments.
- **InfluxDB** 1.x (optional, for high-throughput HF series; PostgreSQL, the default, and SQLite also serve as series engine)
- **GraphicsMagick** (optional — for image previews): `apt install graphicsmagick`
- [just](https://github.com/casey/just#installation) (task runner)

## Setup

```bash
git clone https://github.com/pryv/open-pryv.io.git && cd open-pryv.io
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

For a fresh single-core install, the docker image ships an interactive wizard that produces a complete `pryv-config.yml` from prompts (DNS topology, storage engine, secrets, TLS strategy, app-web-user-account URL, …) and validates the host environment before writing.

Pick (or create) the host directory where you want your install to live, `cd` into it, and run:

```bash
mkdir -p /opt/pryv && cd /opt/pryv
docker run -it --rm \
  -v "$(pwd):/app/pryv" \
  pryvio/open-pryv.io:2.0.0-rc.2 init
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
  pryvio/open-pryv.io:2.0.0-rc.2 \
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
  account: https://your-account-app.example.com   # app-web-user-account root (access.defaultAuthUrl without /auth)
  assets:
    definitions: https://pryv.github.io/assets-pryv.me/index.json

storages:
  base:
    engine: postgresql    # or sqlite
  platform:
    engine: rqlite        # default; master.js spawns the embedded rqlited (postgresql: single-core dnsLess only, see "Diskless" below)
  file:
    engine: filesystem
  series:
    engine: postgresql    # or sqlite, or influxdb
  audit:
    engine: sqlite        # or postgresql
  engines:
    postgresql:
      host: localhost
      port: 5432
      database: pryv_db
      user: postgres
      password: <db-password>
      max: 20
    filesystem:
      # attachments co-locate with per-user data under sqlite.path (below); only previews have their own dir
      previewsDirPath: /path/to/data/previews
    sqlite:
      path: /path/to/data/users
    rqlite:
      url: http://localhost:4001
      raftPort: 4002
      dataDir: /path/to/data/rqlite-data
      binPath: /path/to/rqlited        # default: bin-ext/rqlited
      readyTimeoutMs: 30000            # boot budget for rqlited's HTTP API; raise on slow nodes
      logFile: null                    # null: rqlited writes to the master's stdout/stderr; or a file it appends to
```

On stop (SIGTERM / SIGINT), the master stops its workers, then stops rqlited and waits for it to exit before exiting itself: rqlited snapshots the platform DB when it closes, and must not be killed during that snapshot. Give the master that time: a supervisor stop timeout of at least 30 s (systemd `TimeoutStopSec=30s`; Docker's default is 10 s: `docker stop -t 30`, or `stop_grace_period: 30s` in Compose; the master's own deadline is 28 s, rqlited is killed after 20 s, with an `ERROR` in the log).

### Assets

`service.assets.definitions` points to a JSON file describing UI assets (CSS, icons, login button). If not set, it auto-generates `{publicUrl}/www/assets/index.json` — but service-core does **not** serve this path.

Options:
- Use the public Pryv assets: `https://pryv.github.io/assets-pryv.me/index.json`
- Host your own and set the URL in config
- Serve them from the core itself with a hosted site (see [Hosted sites](#hosted-sites-static-folder-or-fixed-proxy-on-a-reserved-name)), e.g. a `www` site whose folder holds `assets/index.json`, then set `service.assets.definitions: https://www.<dns.domain>/assets/index.json`

### Email

Transactional mails (password reset, welcome, email verification, registration
code) are rendered in-process and sent over your SMTP relay. Point the server at
a relay and a sender address:

```yaml
services:
  email:
    enabled:
      resetPassword: true
      welcome: true
      # verifyEmail is ON by default — see below. Set false to turn it off.
    method: in-process
    defaultLang: en
    from: { name: 'Example', address: 'no-reply@example.com' }
    smtp: { host: smtp.example.com, port: 587, auth: { user: '...', pass: '...' } }
auth:
  # Where the verification link lands: the /verify-email page of your account app.
  emailVerificationPageURL: https://account.example.com/verify-email
```

**Email verification is on by default.** An address added to an account is sent a
verification link, so the server needs `auth.emailVerificationPageURL` and a
working mail setup. If either is missing the server still starts — it logs one
warning per boot and keeps verification off until you fill them in. Set
`services.email.enabled.verifyEmail: false` to turn the feature off without the
warning; set it to `true` explicitly and the page URL becomes required at boot.

"A working mail setup" means: for `in-process`, `services.email.smtp.host`; for
`microservice` or `mandrill`, `services.email.url` and `key`. The sender
(`services.email.from`) is recommended for deliverability but is not required
for the server to consider mail configured.

Run `node bin/check-config.js <your-config.yml>` to see both as warnings before
you boot.

Templates for all four mail types ship with the server (English and French) and
are seeded into PlatformDB the first time a core boots with an empty template
set. Edit them afterwards with `bin/mail.js templates set`, or point
`services.email.templatesRootDir` at your own Pug directory to seed that instead.

Legacy alternative: the external `service-mail` process.

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

**HFS Host header** — The `proxy_set_header Host` for the path-style HFS locations should be a plain IP:port (e.g. `127.0.0.1:4000`). With the username in the host (`dns.domain` set), the HFS worker moves the host's first label into the URL path, so a public host name there would corrupt the route. In dnsLess mode the HFS worker leaves the host alone, as the api-server does, so the plain IP:port is harmless and keeps the same config valid in both modes.

**Socket.IO in cluster mode** — When `apiWorkers > 1`, the server only accepts WebSocket transport (no HTTP long-polling). This is because cluster round-robin scheduling breaks polling session state across workers. Clients must connect with `transports: ['websocket']`.

**Hosted sites behind nginx** - the in-process dispatcher recognises a hosted site by the `Host` header, so the `location /` block must keep `proxy_set_header Host $http_host;` (as in the sample). nginx terminates TLS there, so a site sends HSTS only with `hsts: always` (see [Hosted sites](#hosted-sites-static-folder-or-fixed-proxy-on-a-reserved-name)). Alternatively serve the folder from nginx with its own `server` block and leave `hostedSites` for the name reservation and the DNS answer.

## Hosted sites (static folder or fixed proxy on a reserved name)

A platform name can serve a web site instead of a user account: a folder of static files
(an auth / account UI bundle, a landing page, `assets/index.json`) or a fixed upstream that
the core proxies. The name becomes a reserved username on every core.

```yaml
# override-config.yml
hostedSites:
  account:
    static: /srv/pryv/sites/account         # absolute folder holding index.html (404.html optional)
  docs:
    proxy: https://example.github.io/docs/  # fixed upstream; the request path and query are appended
    headers:                                 # optional, added to every response of this site
      content-security-policy: "default-src 'self'"
    frameAncestors: ["'self'", "https://app.example.com"]  # optional, who may frame the site
    hsts: auto                               # optional: auto (default), always or never
```

Where the site answers:

| Topology | URL of site `account` | Origin |
|---|---|---|
| DNS (`dns.domain` set, `dnsLess.isActive: false`) | `https://account.<dns.domain>/` | its own origin, covered by the `*.<dns.domain>` certificate |
| dnsLess (`dnsLess.isActive: true`) | `<dnsLess.publicUrl>/account/` | **the same origin as the API**, not a separate one |

In dnsLess mode the site shares the API's origin (one host name, one certificate): build a
bundle for that base (e.g. Vite `--base=/account/`), and prefer the DNS topology for
anything that must not share an origin with the API. A site name cannot shadow an API route
there (`reg`, `system`, `www`, `auth`, `users`, `oauth2`, `service`, `apps` are refused; `access` is refused in every topology).
Without `dns.domain` and without dnsLess there is no host name to match, and the boot is
refused.

Static sites behave like GitHub Pages: `index.html` for a folder (a folder without its
trailing slash redirects), `/page` serves `page.html`, a miss serves `404.html` with status
404 (or a plain-text 404), `ETag` / `Last-Modified` with `304`, `Range`, `HEAD`,
`Cache-Control: public, max-age=0`. Dotfiles (e.g. a `.git` folder) and anything resolving
outside the folder (a symlink pointing out) answer 404. No compression: put nginx in front
for that. Files can be replaced at any time without a restart (writing in place, or swapping
in a new folder by rename at the same path). The folder's real path is resolved at boot, so if `static` is itself
a symlink that you re-point at a new release folder, restart the core afterwards.

Proxy sites forward `GET` and `HEAD` only. Request headers are forwarded by allow-list
(`accept`, `accept-encoding`, `accept-language`, `if-none-match`, `if-modified-since`,
`range`, `user-agent`): cookies, `Authorization` and the client address never reach the
upstream. Response headers are passed by allow-list too (content, caching and `location`
headers); `set-cookie` and `strict-transport-security` from the upstream are dropped. The
upstream's `Content-Security-Policy` is kept as a further policy after the site's own (see the
anti-framing paragraph below: it can tighten, never relax framing), and its `Permissions-Policy`
is kept unless the site's `headers` set one. The upstream policy applies as written, under the
site's origin: its `'self'` means the site, so absolute references back to the upstream's own
host are blocked unless the policy lists that host. The site's `headers` cannot remove it (they
only add policies), so a policy that breaks the page behind the core must be fixed on the
upstream. A redirect inside the upstream base is rewritten to the site. An unreachable upstream
answers 502, a silent one 504 after 30 s. An `http://` upstream is accepted with a boot
warning (the content travels in clear between the core and the upstream). An upstream on
this platform's own domain is refused (it would loop).

Every site answer carries `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security:
max-age=31536000` when served over TLS (by default, see `hsts` below; this host only, no
`includeSubDomains`) and the site's `headers`. The API's CORS, JSON and `api-version` headers are never added, and the
core never sets a cookie for a site.

Whether an answer carries HSTS is set per site with `hsts`, from the configuration only (no
request header such as `X-Forwarded-Proto` is trusted):

- `auto` (default): only when the request reached this core over TLS. Behind a proxy that
  terminates TLS (nginx, a load balancer, Dokku) the core sees plain HTTP and sends none.
- `always`: on every answer. Set it when a proxy in front terminates TLS and the site is
  reachable over HTTPS only (plain HTTP redirected or closed): browsers then refuse plain
  HTTP to that host for a year. In dnsLess mode the site shares the API's host, so this
  applies to that whole host. The header only takes effect when the browser received it over
  HTTPS (RFC 6797): on a site reachable over plain HTTP only it does nothing.
- `never`: never, even over TLS.

A `strict-transport-security` in the site's `headers` is sent as written and replaces the
built-in value, whatever `hsts` says (e.g. to add `includeSubDomains` or `preload`).

Every site answer (any status, including 404 and the redirects) also refuses to be framed,
against clickjacking: `Content-Security-Policy: frame-ancestors 'none'` and
`X-Frame-Options: DENY`. To let other pages frame a site, list them in `frameAncestors`
(CSP source expressions, e.g. `"'self'"` or `"https://app.example.com"`; no spaces, `;` or
`,`): the answers then carry `frame-ancestors <the list>`, plus `X-Frame-Options:
SAMEORIGIN` when the list is `["'self'"]` alone (X-Frame-Options cannot express a list, so it
is omitted otherwise). Write the keywords with their single quotes (`"'self'"`, `"'none'"`;
unquoted, browsers read a host name), and `'none'` only alone. A `content-security-policy` in the
site's `headers` is sent as a second policy next to the anti-framing one (a proxy upstream's CSP
as a third): browsers enforce all of them, so each can tighten framing but not relax it. `x-frame-options` cannot be set in `headers`: use
`frameAncestors`.

Boot checks (the core refuses to start, with a message naming the site):

- a `static` folder that does not exist or holds no `index.html`;
- an existing user whose username is a site name (rename the user, or pick another name);
- a site name equal to the id of any core of the platform;
- a name that clashes with `reg`, `access`, `mfa`, `lsc`, `core.id` or a
  `dns.staticEntries` key, or any other shape error (`bin/check-config.js` reports these
  too, without a database).

With the embedded DNS (`dns.active: true`), `<name>.<dns.domain>` answers the A / AAAA of
the cores that serve the site. With an external DNS, point the name at those cores
yourself.

Known limitation: `/socket.io/` on a site host is still answered by the API's Socket.IO
endpoint, which takes that path before any other handler.


## Data directories

| Path | Content |
|------|---------|
| `data/users/` | SQLite DBs (audit, user index, per-user account) |
| `data/users/{userId}/` | Per-user file attachments |
| `data/previews/` | Generated image previews |
| `data/rqlite-data/` | Platform DB (rqlite Raft log + SQLite snapshot) |

## Encryption at rest (optional)

By default the data directories above are stored as plaintext on disk; encrypting
the underlying volume is the operator's responsibility (host full-disk encryption,
cloud-disk encryption, or PostgreSQL TDE for external PG). Platform *secrets*
(Let's Encrypt account keys, observability tokens, cluster bootstrap bundles) are
always encrypted at rest (AES-256-GCM).

For a turnkey option, a separately published image variant
**`pryvio/open-pryv.io-encrypted`** layers the
[`container-encrypted-volume`](https://github.com/pryv/container-encrypted-volume)
facility onto the stock image. It provisions and mounts an encrypted volume inside
the container on boot, so the data directories sit on ciphertext at rest. It is
**off by default** (`CEV_ENABLED=false`) — the variant boots exactly like the stock
image until you opt in — and the stock `pryvio/open-pryv.io` image is unchanged.

What it protects: stolen / decommissioned disks, off-host volume backups,
snapshots. It does **not** protect a running container (that is access control's
job). It satisfies the encryption-at-rest expectations of HIPAA §164.312(a)(2)(iv)
and GDPR Art.32(1)(a).

To enable (LUKS backend shown):

```bash
docker run --privileged \
  -e CEV_ENABLED=true \
  -e CEV_KEY_PROVIDER=aws-kms -e CEV_KMS_BLOB=/run/secrets/cev.blob -e CEV_AWS_REGION=eu-central-2 \
  -v pryv-encrypted:/app/var-pryv/encrypted \
  -v "$PWD/override-config.yml":/app/config/override-config.yml:ro \
  -p 3000:3000 \
  pryvio/open-pryv.io-encrypted:<tag>
```

Then relocate the data roots onto the encrypted mount in your `override-config.yml`
(they support `${ENV}` interpolation; do **not** reuse `/app/var-pryv/rqlite-data`,
which is a declared `VOLUME`):

```yaml
storages:
  base:   { engine: sqlite }      # SQLite base storage lands on the mount
  engines:
    sqlite:     { path: /app/var-pryv/encrypted/mnt/users }   # attachments co-locate here → already on the encrypted mount
    rqlite:     { dataDir: /app/var-pryv/encrypted/mnt/rqlite-data }
```

Notes:
- LUKS needs `--privileged` (or `--cap-add SYS_ADMIN` + device mappings); restricted
  Kubernetes Pod Security profiles may forbid it — use host-side FDE there instead.
- An **external** PostgreSQL data dir and remote S3 attachments are outside this
  mount — encrypt those operator-side / with bucket SSE.
- Key custody, rotation, and disaster recovery (key lost = data lost) are covered in
  the companion's [`docs/OPERATING.md`](https://github.com/pryv/container-encrypted-volume/blob/master/docs/OPERATING.md).

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

### Diskless (PostgreSQL + S3, or PostgreSQL only) — nothing to persist on the app host

Single-core **dnsLess** deployments in full PostgreSQL mode can run with **no persistent filesystem at all** on the app container: every durable byte lives in PostgreSQL and an S3-compatible object store. This suits hosts with ephemeral disks and storage backends (SMB/NFS) that embedded databases can't run on.

When **low attachment volume** is foreseen, the S3 store can be dropped entirely: `storages.file.engine: postgresql` keeps attachments as chunked rows inside PostgreSQL — one durable service, one `pg_dump` covering everything. ⚠ Attachment bytes then inflate the database, its WAL and every backup; the server logs a warning at boot to that effect. Pick S3 for anything attachment-heavy.

Config recipe (the `init` wizard offers all of this when you pick dnsLess + postgresql):

```yaml
storages:
  base:     { engine: postgresql }
  platform: { engine: postgresql }   # no rqlite process, no Raft ports
  series:   { engine: postgresql }
  audit:    { engine: postgresql }
  file:     { engine: s3 }             # or: postgresql (LOW attachment volume only)
  engines:
    postgresql:
      host: <pg-host>
      database: pryv_db
      user: pryv
      password: <password>
    s3:
      endpoint: https://s3.example.com   # omit for AWS (region-derived)
      region: us-east-1
      bucket: pryv-attachments
      accessKeyId: null                  # null = AWS credential chain / IAM
      secretAccessKey: null
      forcePathStyle: true               # MinIO / most self-hosted stores
      keyPrefix: ''
    # The remaining paths are caches / unused placeholders — point them at
    # ephemeral storage (tmpfs). Nothing durable is written there.
    filesystem:
      previewsDirPath: /tmp/pryv/previews         # preview cache — rebuilt on demand
    sqlite:
      path: /tmp/pryv/users                       # unused in full PG mode
logs:
  file: { active: false }                         # console logging only
# letsEncrypt.tlsDir (when TLS is enabled) is also ephemeral-safe: certs are
# authoritative in the platform DB and re-materialized at boot.
# letsEncrypt:
#   tlsDir: /tmp/pryv/tls
```

Constraints (enforced at boot): `dnsLess.isActive: true`, `storages.base.engine: postgresql`, no embedded DNS (`dns.active`), no rqlite cluster discovery. Going **multi-core** later requires moving platform data back to rqlite first:

```bash
# master stopped; PostgreSQL reachable; rqlited started
node bin/migrate-platform.js --from postgresql --to rqlite
# then set storages.platform.engine: rqlite and restart
```

The same CLI migrates the other way (`--from rqlite --to postgresql`) when adopting the diskless shape on an existing deployment.

The shape is verifiable: the app container runs with `--read-only` rootfs + tmpfs mounts, e.g.

```bash
docker run -d --name pryvio --read-only \
  --tmpfs /tmp --tmpfs /app/var-pryv \
  -v /host/config:/app/pryv:ro \
  -p 3000:3000 \
  pryvio/open-pryv.io \
  node bin/master.js --config /app/pryv/pryv-config.yml
```

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
  pryvio/open-pryv.io:2.0.0-rc.2
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
  pryvio/open-pryv.io:2.0.0-rc.2
```

The Dockerfile already declares `EXPOSE 80 443 3000 3001 4000 53/udp 53/tcp`; the
`-p` flags above publish the relevant ones to the host. For DNS-active mode
add `-p 53:53/udp -p 53:53/tcp`: the embedded DNS server answers over UDP and
TCP (RFC 7766 makes TCP mandatory), so the host firewall / cloud security group
must allow **both UDP and TCP 53 inbound**.

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

**Port 53 (UDP and TCP)** for DNS-active mode (`dns.active: true` + embedded DNS server) is not supported by `dokku ports:set`. Workaround:

```bash
dokku docker-options:add <app> deploy,run "-p 53:5353/udp"
dokku docker-options:add <app> deploy,run "-p 53:5353/tcp"
```

For most Dokku deployments the simpler path is **dnsLess mode** — set `dnsLess.isActive: true` + `dnsLess.publicUrl: https://<reg-fqdn>` in `override-config.yml` and let the reverse proxy terminate TLS as usual.

**TCP port 443 in `proxy:disable` mode** (Option C — `master.js` terminates TLS via `letsEncrypt.*` / `http.ssl.*`). `dokku-nginx` is what normally bridges Dokku's port map to Docker `-p` flags; with the proxy disabled, `dokku ports:add https:443:443` shows the mapping but no host port is published. Add the binding explicitly, same shape as the UDP/53 workaround above:

```bash
dokku docker-options:add <app> deploy,run "-p 443:443/tcp"
```

Without this, clients hit `ECONNREFUSED` on 443 even though the container is healthy and `wget https://127.0.0.1:443` inside it succeeds.

**Bare-metal embedded DNS (non-Docker)**: when `bin/master.js` runs as a non-root user (typical) and `dns.port: 53`, Linux refuses the bind (UDP and TCP alike) unless the `node` binary carries `cap_net_bind_service`. Grant it once per host (and **after every Node upgrade: `apt install nodejs` wipes file capabilities**):

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(which node)"
sudo getcap "$(which node)"   # expect: cap_net_bind_service=ep
```

Without the cap, the embedded DNS server cannot bind and `master.js` fails fast: it exits with `Master startup failed: Error: DNS server failed to bind udp <ip>:53: …` (the same happens when another process already holds UDP or TCP 53). The cap covers both the UDP and the TCP listener. (Docker images don't need this: `node` runs as PID 1 / root inside the container.)

**Native HTTPS (ports 80 / 443)** when running ACME directly inside the
container (`letsEncrypt.enabled: true`) needs the same publishing dance —
`dokku ports:add` only exposes ports declared in the Dockerfile's `EXPOSE`.
Open-Pryv.io declares 80, 443, 3000, 3001, 4000, 53/udp and 53/tcp, so:

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

`setup_24.x` installs the LATEST 24.x. Until
[nodejs/node#65446](https://github.com/nodejs/node/issues/65446) is fixed, install and hold a
version below 24.19.0 instead (check `node -v` on every host, including existing ones that may have
been upgraded by a routine `apt upgrade`):

```bash
apt-cache madison nodejs                      # pick a 24.18.x (or earlier 24.x) entry
sudo apt-get install -y nodejs=24.18.1-1nodesource1
sudo apt-mark hold nodejs
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

### Upgrading the bundled rqlite (9.x to 10.x)

The Docker image and `storages/engines/rqlite/scripts/setup` bundle rqlite **10.5.1** (previously 9.4.5). rqlite 10 makes its snapshot store crash-safe at the point where a node killed during a snapshot could later restore stale pages into its copy of the platform DB under 9.x, checksums its snapshot files, and stops a node on a node-local SQLite error instead of letting it diverge silently. The flags and HTTP endpoints the core uses are unchanged.

- **The data directory is upgraded in place, one way.** At its first start, rqlite 10 converts the directory (log line `upgraded v8 snapshot directory …/rsnapshots to …/wsnapshots`) and rebuilds the node's database from its snapshot store (`clean snapshot predates recording of snapshot index and term, full restore needed`, then `node restored`). rqlite 9 cannot open the directory afterwards: it stops with `panic: log not found`. Going back to an older release therefore needs the data directory restored from a backup (below).
- **Back up every node first:** `curl -s 'http://localhost:4001/db/backup' -o platform-backup.sqlite` on the leader (`?noleader` on a follower for its own copy), and an archive of the rqlite data directory taken while the core is stopped.
- **Upgrade from 2.0.0-rc.33 or later.** Up to rc.32 the master could exit before rqlited finished its snapshot on close, which is exactly what leaves the snapshot store inconsistent. Stopping an older release for this upgrade (including replacing its container by the new image) risks the damage this upgrade then restores. Move to rc.33 first, still on rqlite 9, or stop an older core as described in "Platform DB integrity" (rqlited first, then the master).
- **Check the snapshot store before the first rqlite 10 start.** That start replaces the database with the content of the snapshot store, so a store left inconsistent by an earlier interrupted snapshot would replace a healthy database. Stop the core cleanly (the stop leaves a `clean_snapshot` file and an empty `db.sqlite-wal` in the data directory), then compare the database with the newest snapshot, which must be identical, and make sure the snapshot store holds nothing else than `<id>.db` files and `<id>/meta.json` directories (with Docker, run this in the volume that holds the rqlite data). Only the newest snapshot matters: rqlite 10 converts that one and deletes the rest of the store, so a leftover inside an older snapshot's directory (for example an empty `<id>.data` file) is harmless, while a `*.tmp` entry or a file other than `meta.json` inside the newest snapshot's directory means the last snapshot did not complete: start the core again on the old version, stop it cleanly, and check again:

  ```bash
  cd var-pryv/rqlite-data
  test -f clean_snapshot && test ! -s db.sqlite-wal && echo "clean stop"
  ls -la rsnapshots/
  cmp db.sqlite "rsnapshots/$(ls rsnapshots | grep '\.db$' | sort -t- -k2,2n | tail -1)" && echo "store matches"
  ```

  If the stop was not clean (no `clean_snapshot`, or a non-empty `db.sqlite-wal`), start the core again on the OLD binary or image, stop it cleanly, and repeat the check. On a follower whose store still does not match, move its data directory aside and start it again so it rejoins and receives a fresh snapshot from the leader (with the same rqlite version as the leader: a node cannot join a cluster of an older major), then repeat the check. On the leader, do not upgrade: back up with `/db/backup` and rebuild the platform DB from that backup (`/db/load` on a fresh leader, followers rejoined from scratch).
- **Clusters: upgrade every node back to back, and never add or re-add a node while versions are mixed.** A node on 10 and a node on 9 replicate through the Raft log, but a snapshot transfer between the two majors fails in both directions, so a follower that falls behind the leader's log cannot catch up until both run 10, and a node on 10 cannot join a cluster still led by 9. Upgrading the non-voting followers first lets each one act as a canary for the leader and keeps a simple rollback for it (move its directory aside and rejoin with the old binary). Upgrade the leader right after.
- **Verify every node** after its restart, each on its own copy (`level=none`, see "Platform DB integrity"): `PRAGMA integrity_check` returns `ok`, the same `keyValue` row count on every node, and `/status` reports the new version.
- **Native installs:** `scripts/setup` never replaces an existing `bin-ext/rqlited` (it warns when the version differs from the pinned one). Replace the binary while the core is stopped, after the backup and the check above, and keep the old one next to it for a rollback. The release tarballs are at `https://github.com/rqlite/rqlite/releases/tag/v10.5.1` (Linux only; on macOS `scripts/setup` uses Homebrew's `rqlite`).
- **Rollback:** stop the core, restore the archived data directory and the previous binary (writes made since the upgrade are lost; compare with a `/db/backup` taken from the upgraded node before stopping it), or start a fresh 9.x node and `/db/load` a backup taken from the upgraded node. In a cluster, once the leader is back on 9, wipe and rejoin every follower with the old binary: a follower holds log entries the restored leader never had, no snapshot crosses the two majors, and rqlite 9 never opens a converted directory.
- **Keep the HTTP port (default 4001) closed to the outside.** It is unauthenticated (rqlite 10 also serves a web console there). Cores replicate and forward writes over the Raft port (4002, mutual TLS); open 4001 between cores only for admin tools you run against a peer.

## First-boot DNS chain (dns-active mode)

Before a dns-active deployment can issue a wildcard cert via Let's Encrypt DNS-01, the embedded DNS server must answer authoritatively for the zone: SOA + NS for the apex (`<domain>`), and an A record for `core.<domain>` (the canonical API hostname). Public recursors discard delegated answers when no SOA is present, so `acme-client`'s DNS-01 preflight errors with `No TXT records found for name: _acme-challenge.<domain>` before the LE round-trip even starts.

`bin/master.js` seeds this chain on every boot when `dns.active: true` + `dns.domain` is set:

1. Reads `dns.publicIp` from the YAML — the wizard prompts for it (auto-detected via `checkip.amazonaws.com`); set it by hand for hand-written configs.
2. Merges a default SOA (primary `core.<domain>.`, admin derived from `letsEncrypt.email` or `admin@<domain>`, RFC 1912 timing) into `dns.records.root.soa` **only if empty**.
3. Merges a default NS (`core.<domain>.`) into `dns.records.root.ns` **only if empty**.
4. Writes `A core.<domain> -> publicIp` to PlatformDB via `setDnsRecord('core', ...)` **only if no record under that subdomain exists**.

Operator-edited records always win — anything you set under `dns.records.root.*` in YAML, or load via `bin/dns-records.js load` (see below), is left untouched.

You still need the **parent zone NS delegation** in your registrar / parent DNS provider (Infomaniak, Route 53, Cloudflare, …):

```
<domain>.    IN NS  core.<domain>.    ; or your designated NS hostname
core.<domain>. IN A  <publicIp>        ; glue record at the parent
```

The glue record at the parent is what lets recursors find `core.<domain>` before they've ever talked to your authoritative server. Without it, NS chains break on the first lookup.

If `dns.publicIp` is unset on boot, master logs `FATAL: dns.publicIp is unset …` and **skips** the ACME orchestrator start (which would otherwise burn the LE rate limit on a guaranteed-fail issuance). Set the field and restart.

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

The first-boot bootstrap (above) also writes through `bin/dns-records.js`-equivalent paths (`setDnsRecord('core', ...)` + an in-memory mutation of `dns.records.root` for SOA/NS). It only fills records that are missing — any subdomain you `load` via this CLI is left in place across restarts. To take ownership of the `core` A record (e.g. to point it at multiple IPs), `node bin/dns-records.js load core-override.yaml` once; the bootstrap will see it on the next boot and not overwrite.

## Cluster security

When you go multi-core, the Raft channel between cores carries replicated PlatformDB writes (registrations, DNS records, core-info). It must be authenticated. Open Pryv.io ships with a self-managed cluster CA model and bootstrap CLI that automates the setup — see [`SINGLE-TO-MULTIPLE.md`](SINGLE-TO-MULTIPLE.md) for the operator walkthrough. The security guarantees:

- **mTLS on Raft.** With `storages.engines.rqlite.tls.{caFile,certFile,keyFile,verifyClient}` set, both ends of every Raft connection verify the peer's cert against the cluster CA. Unauthenticated TCP on port 4002 is rejected.
- **CA-holder model.** The cluster CA's private key (`/etc/pryv/ca/ca.key`, mode 0600) lives on **exactly one** host — the core that runs `bin/bootstrap.js new-core`. Only this host can issue node certs. Back up `/etc/pryv/ca/` off-host: losing the key means you cannot add or rotate cores without standing up a new cluster.
- **Sealed bundles.** The CLI emits a passphrase-encrypted file (AES-256-GCM, scrypt KDF) carrying identity + platform secrets + node cert/key + CA cert + a one-time join token. The new core consumes it via `bin/master.js --bootstrap <file> --bootstrap-passphrase-file <pass>`.
- **One-shot join tokens.** Each bundle contains a token that verifies exactly once at the issuing core's `/system/admin/cores/ack` endpoint and is then burned. Default TTL 24h. Replays return HTTP 401. The ack endpoint deliberately bypasses admin-key auth — the new core authenticates via the token, not the admin key.
- **Bundle/passphrase split.** Transfer the bundle file and the passphrase on different channels (e.g. file via `scp`, passphrase via password manager). Compromise of either alone is not enough to ack.

Single-core deployments do not need any of this — `tls: null` (the default) leaves the Raft setup at plain loopback TCP, which is fine for a single host.

## PlatformDB PII hashing (default since 2.0.0-rc.3)

PlatformDB rows are stored as deterministic HMAC-SHA-256 tokens (not cleartext) by default since 2.0.0-rc.3. In multi-region clusters every PlatformDB row crosses every region's Raft ring — without hashing, plaintext usernames + `isUnique` system-stream values (default: `email`) + persistent DNS subdomain keys would transit jurisdictions purely as a side effect of the routing/uniqueness index.

`platform.piiMode: hashed` (the default) swaps those columns to opaque, deterministic tokens derived from a cluster-wide pepper. Equality lookups still work; the inverse is infeasible without the pepper. The mode is pseudonymisation under EDPB / WP29 Opinion 05/2014 — strengthens Art.32(1)(a) evidence + defence-in-depth; **does NOT** lift the requirement for an Art.46 mechanism (SCCs / BCRs) for cross-border replication. Recital 26 still applies to HMAC'd PII.

Legacy single-region deployments that prefer plaintext can opt out by setting `platform.piiMode: cleartext` in `override-config.yml`.

### Configuration

```yaml
platform:
  piiMode: hashed                                 # cleartext (default) | hashed
  piiHmacKey: <BASE64-32-BYTES>                   # MUST be identical on every core
```

Generate the pepper with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the same value into every core's `override-config.yml`. The bootstrap bundle (`bin/bootstrap.js new-core`) propagates `platform.piiHmacKey` to joiners alongside `letsEncrypt.atRestKey` (bundle v3), so a newly-joined core comes up agreeing on the pepper.

**Loss of the pepper strands every hashed row** — there is no way to derive usernames/emails from PlatformDB without both the pepper and the home core's user-account storage. Back the key up alongside the cluster CA (`/etc/pryv/ca/`).

### Initial cutover (cleartext → hashed)

For a deployment that has been running in cleartext mode under an earlier release and is switching to hashed (now the default):

```sh
# 1. Pause writers (or take the cluster offline) and back up.
bin/backup.js --output /tmp/backup-pre-pii-rehash

# 2. Set platform.piiMode: hashed + platform.piiHmacKey in EVERY core's override-config.yml.

# 3. From any single core: report what will change.
node bin/platform-pii-migrate.js status

# 4. Apply.
node bin/platform-pii-migrate.js up

# 5. Restart the cluster so all workers boot with the new mode.
```

The tool is idempotent — partial runs continue safely. It touches `user-core/*`, `user-unique/*`, and `user-indexed/*` rows only. Persistent DNS records (`dns-record/*`) stay cleartext (operator infrastructure names, not user PII).

### Pepper rotation

Use `bin/platform-pii-rotate.js` (see `--help` for the full procedure). Single-core: one invocation. Multi-core: run on each core in turn, after distributing the new pepper to every core's config. The tool re-derives HMAC tokens for usernames + `isUnique` fields from the home core's user-account storage. Persistent DNS records are unaffected — their subdomains are stored cleartext (operator infrastructure names, not user PII).

### Hashed-mode caveats

- `GET /reg/:email/username` and `GET /reg/:email/uid` (legacy v1 email→username recovery) return **410 Gone** in hashed mode. Recovery flows must accept the username as user input instead; full two-hop recovery (hash email → identify home core → fetch cleartext username) is on the backlog.
- The single-core "find username by email" path in `auth.cores` surfaces "unknown" rather than attempting a HMAC username against the local users index.
- Admin endpoints under `/reg/admin/servers/:server/users` return `username` fields as HMAC tokens — clients consuming these need to recognise the hashed shape.

## Platform DB integrity

A corrupted primary-key index on the platform DB raises no error by itself: upserts then store a key twice and lookups miss rows (user-to-core mappings, unique-field reservations, DNS records). Each core checks its own copy, read-only:

- **At every boot**, `master.js` runs the check once and logs an `ERROR` naming the duplicated keys when it fails. It never blocks the boot.
- **Periodically while the core runs**, `master.js` repeats the same check every `storages.platform.integrityCheckIntervalMs` (default `3600000`, one hour; `0` disables it). It logs an `ERROR` at every failed check, an `INFO` line once when the check passes again, and a `WARNING` when the check cannot run (e.g. rqlited unreachable).
- **On demand**, `node bin/integrity-check.js --platform` (exit code `1` on failure or when the platform DB cannot be reached, `--json` for the report). A run without `--user` checks the platform DB after the users. On a core started with `--config <file>` (e.g. a multi-core joiner's host-config), pass the same `--config <file>` so the tool reads that core's storage and rqlite URL. Run it where the core's rqlited is reachable (e.g. inside the core's running container, not a one-off container where no rqlited runs).

With rqlite, each node holds its own SQLite file, so run the check on every core (it reads the node the core talks to: with `storages.engines.rqlite.external` behind a load balancer, that is whichever node answered). It runs `PRAGMA integrity_check` and a duplicate-key scan that bypasses the index (`NOT INDEXED`). With PostgreSQL it runs the duplicate-key scan only (index scans disabled).

**Repair (rqlite).** `REINDEX` and `DELETE … WHERE rowid = …` are refused on a corrupted table: rebuild it from its rows instead.

1. Back up the node that failed the check, its own copy: `curl -s 'http://localhost:4001/db/backup?noleader' -o platform-backup.sqlite`.
2. Inspect each duplicated key on that node: `POST /db/query?level=none` with `SELECT rowid, key, value FROM keyValue NOT INDEXED WHERE key = '<key>'` (at the default level a follower forwards the query to the leader, which shows the leader's rows). A write that missed the corrupted index inserted a new row, so the highest `rowid` is usually the latest value, but check before choosing.
3. Rehearse on a copy of the backup with `sqlite3`, then send the rebuild as ONE transaction to the leader: it replays on every node, each rebuilding from its own rows. Rowids differ between nodes, so express a different choice by key and value, never by rowid, e.g. `WHERE (rowid IN (SELECT MAX(rowid) FROM keyValue NOT INDEXED GROUP BY key) AND key <> '<key>') OR (key = '<key>' AND value = '<chosen value>')`. The default keeps the newest row of each key:

   ```bash
   curl -s -XPOST 'http://localhost:4001/db/execute?transaction' -H 'Content-Type: application/json' -d '[
     "CREATE TABLE keyValue_new (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
     "INSERT INTO keyValue_new (key, value) SELECT key, value FROM keyValue NOT INDEXED WHERE rowid IN (SELECT MAX(rowid) FROM keyValue NOT INDEXED GROUP BY key)",
     "DROP TABLE keyValue",
     "ALTER TABLE keyValue_new RENAME TO keyValue"
   ]'
   ```
4. Verify EVERY node, each on its own copy: re-run `node bin/integrity-check.js --platform` on every core (adding `--config <file>` on a core started with one; it reads with `level=none`), and check the rebuild itself with `level=none` reads on each node, because at the default level a follower forwards the read to the leader and answers with the leader's copy. A rebuild can fail on a follower alone (e.g. its copy holds a duplicate that the new table's primary key refuses) and leave that node's old table in place without any error on the leader. Right after the rebuild, on each node:

   ```bash
   curl -s -XPOST 'http://localhost:4001/db/query?level=none' -H 'Content-Type: application/json' --data-binary @- <<'EOF'
   ["SELECT sql FROM sqlite_master WHERE name = 'keyValue'", "SELECT MIN(rowid), COUNT(*) FROM keyValue"]
   EOF
   ```

   A rebuilt table reads `CREATE TABLE "keyValue" …` (quoted name, from the rename) and its rowids start at `1`; the same row count on every node. No restart is needed.

If the rehearsal fails (e.g. `DROP TABLE` reports "database disk image is malformed": the damage is structural, not a missing index entry), do not send it to the cluster. If the damaged node is a follower and a healthy voter holds the data, recover it from that peer: stop that core, remove its rqlite data directory, and start it again so it rejoins and receives a fresh snapshot. Never do this on the only voter (a two-core setup with one voter and one non-voter has a single copy that counts): restore it instead from a healthy node's backup (`/db/backup?noleader` on that node, then `/db/load` on the leader).

**Repair (PostgreSQL).** Delete the unwanted duplicates by `ctid` (`SELECT ctid, key, value FROM platform_kv WHERE key = '<key>'`, after `SET enable_indexscan = off; SET enable_bitmapscan = off;` in the same `psql` session), then `REINDEX TABLE platform_kv`.

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
