# Changelog - API Changes

## ID minting algorithm — cuid v1/v2 → cuid2

- New event / stream / access / webhook / session / password-reset IDs are now minted with `@paralleldrive/cuid2`. Format is **24 lowercase alphanumeric characters, first char a letter, no prefix** — distinct from the legacy cuid v1/v2 format (`c` prefix + 24 chars, 25 total).
- Existing IDs in production databases remain valid; this is purely a forward-going change.
- **Client compatibility**: clients that locally validate IDs against the legacy `^c[a-z0-9-]{24}$` pattern need to relax their regex to accept the new shape too. The recommended permissive pattern is `^([a-z][a-z0-9]{23}|c[a-z0-9-]{24})$`. Server-side schema validation already accepts both.
- **Why**: the original `cuid` package is deprecated by its author in favour of cuid2; cuid2 has cluster-aware entropy and a stronger collision profile.

## 2.0.0-pre — Publication as open-pryv.io

### In-process mail delivery — optional replacement for the external service-mail process

- **NEW**: `services.email.method: in-process` — render + send welcome + reset-password emails inside the api-server workers, no separate `service-mail` process. Templates live in PlatformDB, cluster-wide.
- **CONFIG** (unchanged back-compat path) — `services.email.method: microservice` keeps calling the external `pryv/service-mail` over HTTP for deployments that still run it. Default stays `microservice` in this release; a follow-up release flips the default to `in-process` once both modes have had production exposure.
- **CONFIG** — `services.email.{smtp,from,defaultLang,templatesRootDir,welcomeTemplate,resetPasswordTemplate,enabled}`. SMTP creds + sender stay per-core in `override-config.yml` (operator-local, not replicated); template content lives in PlatformDB (cluster-wide, rqlite-replicated).
- **NEW**: admin HTTP API under `/system/admin/mail/` for editing templates without a deploy:
  - `GET /system/admin/mail/templates` — list `[{type, lang, part, length}]`.
  - `GET /system/admin/mail/templates/:type/:lang/:part` — raw Pug source (`text/plain`).
  - `PUT /system/admin/mail/templates/:type/:lang/:part` — body `{ pug: string }`; triggers cross-worker refresh.
  - `DELETE /system/admin/mail/templates/:type/:lang/:part` — removes one part; `DELETE .../:type/:lang/` (no part) wipes both html + subject for that lang.
  - `POST /system/admin/mail/send-test` — body `{ type, lang, recipient }` — triggers a real SMTP send with stub substitutions. Handy for smoke-testing a new template.
  - Auth: `auth.adminAccessKey` via the `Authorization` header. Unauthorized requests return 404 (same contract as every other `/system/*` route — deliberate, to avoid advertising the surface).
- **NEW**: `bin/mail.js` standalone admin CLI — same shape as `bin/observability.js`. Subcommands: `templates list`, `templates get <type> <lang> <part>`, `templates set <type> <lang> <part> --file <path>`, `templates delete <type> <lang> [part]`, `templates seed --from <dir>`, `send-test <type> <lang> <recipient>`.
- **BEHAVIOUR** — in-process mode uses `nodemailer` under the hood. `smtp.sendmail: true` + `smtp.path: /usr/sbin/sendmail` supported for dev. High-frequency mail (bulk) is still out of scope; fail-fast semantics unchanged (existing callers treat mail failures as non-fatal).
- **DOC**: [Email configuration](https://pryv.github.io/customer-resources/emails-setup/) rewritten for both modes, with the PlatformDB keyspace + CLI + admin-API + cluster propagation notes.

### Optional observability (APM) — New Relic as first provider

- **NEW**: opt-in observability layer with a provider-agnostic façade (`components/business/src/observability/`) and a single concrete provider today — **New Relic**. Other backends (Datadog / OpenTelemetry / Sentry) can be added later without touching business code or the admin CLI base.
- **CONFIG** (PlatformDB keyspace `observability/*`, cluster-wide, AES-256-GCM encrypted at rest for secrets):
  - `observability.enabled` — boolean. Default off.
  - `observability.provider` — `"newrelic"` (only option in this release).
  - `observability.appName` — cluster-wide label. Defaults to `open-pryv.io (<dns.domain>)`.
  - `observability.logLevel` — `error` | `warn` | `info` | `debug`. **Default `error`** — only errors ship to the provider; raise explicitly to capture warns/info during incidents.
  - `observability.newrelic.licenseKey` — ingest license key. Encrypted via HKDF-derived key from `auth.adminAccessKey`.
- **CONFIG**: local `observability.enabled: false` in `override-config.yml` always wins over PlatformDB — emergency kill-switch for a single misbehaving core.
- **NEW**: `bin/observability.js` admin CLI — standalone (no HTTP dep), manages PlatformDB directly. Subcommands: `show`, `enable <provider>`, `disable`, `set-log-level`, `set-app-name`, `newrelic set-license-key`. License key value never echoed.
- **BEHAVIOUR**: reported APM hostname = `new URL(core.url).hostname` (e.g. `core-use1.pryv.me`) — matches `/reg/hostings`, LE cert SAN, and operator dashboards. No separate "APM host name" field to curate.
- **BEHAVIOUR**: agent enforces `high_security: true`. Authorization / cookie / proxy-authorization headers and request bodies are never forwarded to the provider.
- **DEPENDENCY**: `newrelic` added under `optionalDependencies`. Installs that can't fetch it still succeed; observability simply refuses to activate.
- **DOC**: [Observability (APM)](https://pryv.github.io/customer-resources/observability/) — operator guide covering enable / rotate / log levels / disable / NRQL validation queries.

### Multi-core registration + `/service/info` + `/reg/access` (dnsLess=false)

- **BEHAVIOUR**: Cross-core `POST /users` is now a server-side transparent HTTPS forward — landing core HTTPS-proxies the POST to the selected hosting's core and returns its response verbatim. Clients receive a single normal registration response (`{username, apiEndpoint}`) regardless of which core DNS round-robin directed them to. The legacy `{core: {url: …}}` redirect response shape is no longer emitted in multi-core mode; v1-era SDKs that relied on re-POSTing should be updated to ignore `res.body.core` — the new shape is compatible (target's response has no `core.url`).
- **NEW**: `service.version` field in `/service/info`. Populated from the server's API version (e.g. `"2.0.0-pre.2"`). SDKs (lib-js, app-web-auth3) read this to select the direct-core `/users` registration endpoint. Older SDKs without the gate fall back harmlessly.
- **CHANGED (multi-core only)**: `/service/info`'s `register` and `access` URLs now use the distribution-reserved subdomains — `register: https://reg.{domain}/`, `access: https://access.{domain}/access/` — instead of the core-specific FQDN. The embedded DNS auto-publishes `reg.{domain}`, `access.{domain}`, `mfa.{domain}` to every available core, so these URLs are core-symmetric and load-balanced by DNS. `dnsLess.isActive: true` deployments are unchanged.
- **NEW (multi-core only)**: `GET /service/info` at the root of reserved subdomains (e.g. `https://reg.{domain}/service/info`, `https://access.{domain}/service/info`). Alias for `/reg/service/info`. Lets SDKs bootstrap from the register subdomain directly without knowing the `/reg/` path prefix.
- **NEW (multi-core only)**: Hostname-path mapping — requests to `reg.{domain}/<path>`, `access.{domain}/<path>`, `mfa.{domain}/<path>` are handled as `/reg/<path>` internally. Lets clients use v1-style rootless URLs (`reg.pryv.me/perki/server`) while the internal routing stays under `/reg/*`. Idempotent — clients that still send the `/reg/` prefix continue to work.
- **CHANGED**: `POST /reg/:uid/server` now looks up the user's home core via the replicated PlatformDB (`user-core/<username>`) instead of the per-core SQLite index, so any core in a multi-core cluster answers correctly. Returns 404 with `unknown-user` when no mapping exists, same shape as before.
- **CHANGED**: `POST /reg/access` response now includes `authUrl` (popup sign-in URL, built from `access.defaultAuthUrl` + query params), `url` (deprecated alias for `authUrl`), `lang`, `returnUrl` (camelCase alias for the existing `returnURL`), and `serviceInfo` (embedded v1-compatible). `poll` is built from the local `core.url` rather than the cluster-wide `service.register`, making it core-affine: subsequent poll GETs reliably hit the core that owns the in-memory state.
- **CHANGED**: `GET /reg/access/:key` NEED_SIGNIN response now also includes `poll`, `authUrl`, `url`, `lang`, `returnUrl`, and `serviceInfo`. Clients that re-hydrate their state from the poll body (some lib-js / app-web-auth3 code paths) now see a complete state shape.
- **CONFIG (multi-core only)**: `service.{name,serial,home,support,terms,eventTypes}` are now **required** — master fails fast at startup with a clear "Configuration is invalid at [service]" error listing the missing fields. Previously a missing `service:` block resulted in an api-server crash loop with no surfaced cause.
- **CONFIG**: `access.defaultAuthUrl` — URL of the deployed auth UI (e.g. `https://pryv.github.io/app-web-auth3/access/access.html` for the public static build, or your own fork). Populated into the `authUrl` field of `/reg/access` responses.
- **CONFIG**: Unresolved `${VAR}` env-var placeholders in any config string now fail startup fast with a clear error naming the missing variable. Previously `path: "${PRYV_LOGSDIR}/api-server.errors.log"` with `PRYV_LOGSDIR` unset would silently create a literal `${PRYV_LOGSDIR}` directory on disk. Respects the `active: false` / `enabled: false` block-skip (placeholders inside disabled blocks are ignored).
- **FIX (regression)**: Welcome-mail and other account-stream-derived fields (`email`, etc.) now work under `NODE_ENV=production` even when `production-config.yml` does not override `custom.systemStreams.account`. Previously the `systemStreams` plugin ran synchronously before `@pryv/boiler` loaded `default-config.yml`, so `accountMap` missed `:system:email` and `POST /users` silently returned 201 without ever reaching `sendWelcomeMail` with a valid recipient. Plugin is now registered as `pluginAsync` so it sees the fully-loaded config.

### Schema migrations — engine-agnostic runner + CLI
- **BREAKING (upgrade path)**: v1 → v2 is **not** an in-place upgrade. To bring a v1 install to v2:
  1. Bring the v1 install up to **v1.9.3** using the code on the `release/1.9.3` branch (its MongoDB migrations handle that hop).
  2. Export v1.9.3 data with **`dev-migrate-v1-v2`** (see that repo's README).
  3. Restore the produced archive into v2 via `node bin/backup.js --restore`.

  All legacy in-place MongoDB migrations (`1.9.0`–`1.9.4`) and the `versions` collection/table have been removed from the v2 codebase. Attempting a direct `git pull + npm install` from a v1 data directory into v2 will leave orphaned data that v2 does not understand.
- **NEW**: Engine-agnostic schema migration runner. Each migration-capable engine (currently PostgreSQL and rqlite) tracks its own integer version in a `schema_migrations` table/row; each migration bumps it by +1. Filename format is `YYYYMMDD_HHMMSS_<slug>.js` (timestamped for branch-safety). See `storages/interfaces/migrations/README.md` for conventions. Forward-only — `down()` is not executed by the runner.
- **NEW**: `bin/migrate.js` admin CLI for standalone migration operations. Subcommands:
  - `status` — per-engine current version + pending migrations (YAML)
  - `up [--target N] [--dry-run]` — apply pending migrations, optionally up to version N, optionally preview-only
- **CHANGED**: Config key `cluster.runMigrations` (default true) → `migrations.autoRunOnStart` (default true). Master applies pending migrations across all migration-capable engines before forking workers. Set to `false` to run them manually with `bin/migrate.js`.

### Persistent DNS records — management endpoints and CLI
- **NEW**: `DELETE /reg/records/:subdomain` — admin-key protected route to remove a persisted runtime DNS record. Symmetric to `POST /reg/records`. Returns 404 when the subdomain has no persisted record, 403 without admin auth. Master process is nudged over IPC so the local DnsServer drops the entry immediately; remote cores see the change on their next periodic refresh.
- **NEW**: `bin/dns-records.js` admin CLI for managing persistent DNS records directly in PlatformDB — useful during bootstrap, disaster recovery, or when the API itself is misconfigured and cannot be reached. Subcommands:
  - `list` — print all persisted records as YAML.
  - `load <file>` — upsert records from a YAML file. `--dry-run` to preview, `--replace` to delete records not present in the file.
  - `delete <subdomain>` — remove one record.
  - `export [file]` — dump to a YAML file (stdout if omitted).

  File format:
  ```yaml
  records:
    - subdomain: _acme-challenge
      records:
        txt: ["validation-token"]
    - subdomain: www
      records:
        a: ["1.2.3.4"]
  ```
  The CLI opens the storages barrel directly so it works with or without `master.js` running; a running DnsServer picks up changes within its refresh interval (default 30 s).

### Auto-renewed public TLS certificates (Let's Encrypt)
- **NEW**: Opt-in `letsEncrypt.*` config block. When `letsEncrypt.enabled: true`, the core issues and auto-renews the public-facing SSL certificate on its own — no more `certbot` cron / manual cert rotation. Supports both HTTP-01 (single-host) and DNS-01 (wildcard) challenges. Challenge type and hostnames are **derived from the existing topology config** (`dnsLess.publicUrl` → single host HTTP-01, `core.url` → single host HTTP-01, `dns.domain` → `*.{domain}` + apex via DNS-01), so there is no separate `hostnames` list to keep in sync.
- **Defaults:** feature is OFF (`enabled: false`) — existing deployments see no behaviour change. Operators who already terminate TLS in a reverse proxy (Caddy / Traefik / nginx-proxy-manager handling ACME on its own) keep doing that and leave `letsEncrypt.enabled: false`.
- **NEW**: Certificate material — the ACME account key plus every cert's private key — is **encrypted at rest** in rqlite (AES-256-GCM with a key derived from an operator-supplied `letsEncrypt.atRestKey`). A stolen rqlite snapshot alone does not yield a usable private key.
- **NEW**: `letsEncrypt.certRenewer: true` — set on **exactly one** core (typically the cluster CA holder) to designate it as the ACME renewer. That core runs the daily check; on renewal it writes the new cert row to rqlite, which replicates to every other core, which then picks it up on its next file-materialization tick.
- **NEW**: `letsEncrypt.onRotateScript` — optional absolute path to a script invoked on every successful cert rotation on that core. Receives `PRYV_CERT_HOSTNAME` / `PRYV_CERT_PATH` / `PRYV_CERT_KEYPATH` in env. Typical contents: `nginx -t && nginx -s reload` or `systemctl reload caddy`. Non-zero exit logs and keeps going; no retry.
- **NEW**: `bin/master.js` broadcasts a cluster IPC message after each rotation so HTTPS workers hot-swap the TLS context via `https.Server.setSecureContext()` — new TLS handshakes use the new cert, in-flight connections continue uninterrupted, no worker restart.
- **NEW**: `GET /system/admin/certs` — admin-key-protected route returning `{ certs: [{ hostname, issuedAt, expiresAt, daysUntilExpiry }] }`. PlatformDB metadata only — never the PEM material itself.

### Multi-core bootstrap CLI + Raft mTLS
- **NEW**: `bin/bootstrap.js` — operator CLI that issues a sealed bundle for a new core joining a multi-core cluster. Subcommands:
  - `new-core --id <coreId> --ip <ip> [--url <url>] [--hosting <h>] [--out <path>] [--token-ttl <ms>]` — generates the cluster CA on first call, signs a node cert for the new core, mints a one-time join token, pre-registers the new core in PlatformDB (`available:false`) and DNS (`{core-id}.{domain}` + appends to `lsc.{domain}`), assembles + encrypts the bundle (AES-256-GCM, scrypt KDF) and writes it to `--out` (default `./bootstrap-<id>.json.age`). Prints the passphrase, file path and expiry.
  - `list-tokens` — prints active (un-consumed, un-expired) tokens.
  - `revoke-token <coreId> [--ip <ip>]` — revokes active tokens for a core; with `--ip`, also unwinds the DNS + PlatformDB pre-registration.
- **NEW**: `bin/master.js --bootstrap <bundle> --bootstrap-passphrase-file <pass>` — consume mode for a fresh core. Decrypts and validates the bundle, writes `override-config.yml` and TLS files (`/etc/pryv/tls/{ca,node}.{crt,key}`), POSTs an ack to the bundle's ack URL with TLS pinned to the bundled CA, deletes the bundle on success, then chains into normal startup.
- **NEW**: `POST /system/admin/cores/ack` — endpoint the new core POSTs to. Authenticated by the one-time join token in the request body (NOT the admin key — the new core authenticates by token). Body: `{ coreId, token, tlsFingerprint }`. On success, flips PlatformDB's `available:true` for the core and returns a snapshot of the cluster's cores. Replays return HTTP 401.
- **NEW**: `storages.engines.rqlite.tls.{caFile, certFile, keyFile, verifyClient, verifyServerName}` config — enables mutually-authenticated TLS on the Raft channel. When unset (default `tls: null`), rqlited spawns with plain TCP exactly as before — single-core and existing VPN-protected multi-core deployments are unchanged.
- **NEW**: `cluster.ca.path` (default `/etc/pryv/ca`) and `cluster.tokens.path` (default `/var/lib/pryv/bootstrap-tokens.json`) config — used only by `bin/bootstrap.js` and the matching ack endpoint.

### Docker image
- **RENAMED**: Docker image `pryvio/core` → `pryvio/open-pryv.io` for the v2 line. Pull `pryvio/open-pryv.io:2.0.0-pre` (and the per-commit `pryvio/open-pryv.io:2.0.0-pre-<sha>` tag) instead of `pryvio/core:*`. The `pryvio/core` repository is preserved for the v1 line (`1.9.3` and earlier) and is no longer updated.

## Multi-core (DNSless variant)

- **NEW**: `core.url` config override (per-core, top-priority). Set explicit URLs in DNSless multi-core deployments where DNS is managed externally and FQDNs cannot be derived from `{core.id}.{dns.domain}`. Other cores discover this URL via `Platform.coreIdToUrl()`, which now reads from a PlatformDB-backed in-memory cache populated on `Platform.registerSelf()`.
- **NEW**: `Platform.registerSelf()` now writes `url` into core info in PlatformDB so other cores can resolve the explicit URL via `/reg/cores`, `/system/admin/cores`, and the wrong-core middleware.
- **NEW**: HTTP 421 Misdirected Request returned by `/:username/*` routes when the user is hosted on a different core in a multi-core deployment. Response shape: `{ error: { id: 'wrong-core', message, coreUrl } }`. Clients (SDKs) MUST retry against `coreUrl` directly — there is no HTTP redirect (cross-origin redirects strip Authorization headers, WebSockets cannot follow). The middleware is mounted on `/:username/*` only; `/reg/*` and `/system/*` are intentionally load-balanced. No-op in single-core mode.
- **CHANGED**: `GET /system/admin/cores` and `/reg/cores` now return the explicit `core.url` when set; otherwise fall back to `https://{core.id}.{dns.domain}` derivation as before.

## Known gaps in v2.0.0

- **OAuth2 authorization code flow** (RFC 6749 `/oauth2/authorize`, `/oauth2/token`, client registration, refresh tokens, PKCE) is **not** in v2. Clients that need OAuth2-style authorization must continue using the existing `/reg/access` polling flow (ported from the former `service-register`).

## Multi-factor authentication (merged from former service-mfa)

- **NEW**: `POST /{username}/mfa/activate` — start MFA setup; personal access token required. Body carries the profile content (e.g. `{ phone: '+41...' }`) used as template substitutions for the SMS provider. Returns `{ mfaToken }` (HTTP 302).
- **NEW**: `POST /{username}/mfa/confirm` — confirm MFA activation. Authorization header is the `mfaToken` from activate. Body has the SMS `code`. On success returns 10 recovery codes and persists `profile.private.data.mfa`.
- **NEW**: `POST /{username}/mfa/challenge` — re-trigger the SMS challenge for a pending MFA login. Authorization header is the `mfaToken`.
- **NEW**: `POST /{username}/mfa/verify` — verify the SMS code and release the Pryv access token stashed by `auth.login`. Authorization header is the `mfaToken`.
- **NEW**: `POST /{username}/mfa/deactivate` — disable MFA for the calling user. Personal access token required.
- **NEW**: `POST /{username}/mfa/recover` — disable MFA using a recovery code. Unauthenticated; body is `{ username, password, recoveryCode }`.
- **CHANGED**: `auth.login` — when the user has MFA active (`profile.private.data.mfa` set) and the server has MFA enabled, the login response is `{ mfaToken }` instead of `{ token, apiEndpoint, ... }`. The caller must follow up with `mfa.verify` to receive the real access token.
- **KEPT**: `system.deactivateMfa` (admin override) remains available alongside the new user-facing `mfa.deactivate`.
- **CONFIG**: new `services.mfa` block — `mode` (`disabled`/`challenge-verify`/`single`), `sms.endpoints.{challenge,verify,single}.{url,method,body,headers}`, `sessions.ttlSeconds`. Default `mode: disabled` — backwards-compatible; existing deployments see no behaviour change.

## Registration service merged into core (formerly service-register)

### Registration & user management
- **NEW**: `GET /reg/cores?username=X|email=X` — core discovery endpoint. Returns `{ core: { url } }` for the core hosting the given user. Single-instance always returns self.
- **NEW**: `GET /system/admin/users` — list all registered users (admin-key protected). Returns `{ users: [{ username, id, email, language }] }`.
- **NEW**: `POST /system/users/validate` — pre-registration validation with unique field reservation.
- **NEW**: `PUT /system/users` — system-level user field update (indexed/unique fields in PlatformDB).
- **NEW**: `DELETE /system/users/:username?onlyReg=true&dryRun=true` — system-level platform deletion with dry-run support.
- **CHANGED**: Registration (`POST /users`, `POST /reg/user`) now validates locally via PlatformDB instead of forwarding to external service-register.
- **CHANGED**: `GET /reg/:username/check_username` and `GET /reg/:email/check_email` routes are now always available (previously DNS-less only).

### Multi-core deployment
- **NEW**: `core.id` config — core identity for multi-core deployments (FQDN = `{core.id}.{dns.domain}`).
- **NEW**: `GET /system/admin/cores` — list all cores with user counts.
- **NEW**: `GET /reg/hostings` — regions/zones/hostings hierarchy with core availability.
- **NEW**: `/reg/access` REDIRECTED status — auth page redirects to user's home core.
- **NEW**: rqlite process management in master.js — auto-starts rqlited for multi-core PlatformDB.

### DNS server
- **NEW**: Optional embedded DNS server (`dns.active: true`) for resolving `{username}.{domain}` to core IPs.
- **NEW**: `POST /reg/records` — admin endpoint for runtime DNS entry updates (e.g. ACME challenges).

### Service info & apps
- **NEW**: `GET /:username/service/infos` — backward-compatible alias for `service/info`.
- **NEW**: `GET /apps`, `GET /apps/:appid` — config-based application listing.
- **NEW**: `POST /access/invitationtoken/check` — check invitation token validity.

### Legacy backward-compatible routes
- **NEW**: `GET /reg/:email/username` and `GET /reg/:email/uid` — email → username lookup.
- **NEW**: `GET /reg/:uid/server` (redirect) and `POST /reg/:uid/server` (JSON) — server discovery.
- **NEW**: `GET /reg/admin/users/:username` — individual user details.
- **NEW**: `GET /reg/admin/servers`, `GET /reg/admin/servers/:name/users`, `GET /reg/admin/servers/:src/rename/:dst` — core management.

### Invitations
- **NEW**: `GET /reg/admin/invitations` — list all invitation tokens.
- **NEW**: `GET /reg/admin/invitations/post?count=N` — generate new invitation tokens.
- **CHANGED**: Invitation tokens stored in PlatformDB instead of static config. Config `invitationTokens` seeds PlatformDB on first boot. Tokens consumed on successful registration.

### Removed
- **REMOVED**: External service-register dependency — all registration logic is self-contained in the core binary.

## Consolidated master process (single Docker image)

- **CHANGED**: Socket.IO connections now use WebSocket transport only when running in cluster mode. HTTP long-polling fallback is no longer available in clustered deployments. Single-process mode (development, tests) is unaffected.
- **REMOVED**: Separate `pryvio/hfs` and `pryvio/preview` Docker images — all services now run in a single `pryvio/open-pryv.io` container via `node bin/master.js`.

## System streams refactor

- **REMOVED**: `:_system:helpers` stream and its children (`:_system:active`, `:_system:unique`) — these internal marker streams are no longer part of the system streams tree. Account field uniqueness and indexing are now enforced directly by the platform coordination layer.
- **No other API changes**: All other system stream IDs (`:_system:email`, `:_system:language`, `:system:email`, etc.) remain unchanged. Events, permissions, and stream queries work identically.

## Removed: `openSource:isActive` flag

- **REMOVED**: `openSource:isActive` configuration key — no longer recognized. All features (webhooks, HFS/series events, distributed cache sync, registration email check) are now always enabled regardless of deployment mode.

## Removed deprecated features from v1

### Stream ID prefix backward compatibility
- **REMOVED**: The old dot-prefix (`.`) notation for system stream IDs is no longer accepted or returned. Use the standard prefixes (`:_system:` for private, `:system:` for custom) exclusively.
- **REMOVED**: The `disable-backward-compatibility-prefix` HTTP header is no longer supported (no longer needed since prefix conversion is removed).

### Deprecated endpoint `/register/create-user`
- **REMOVED**: `POST /register/create-user` endpoint. Use `POST /system/create-user` instead.

### `streamId` (singular) backward compatibility
- **REMOVED**: Events no longer return `streamId` (singular). Only `streamIds` (array) is returned.
- **REMOVED**: Event creation/update no longer accepts `streamId`. Use `streamIds: [...]` instead.

### Tags backward compatibility
- **REMOVED**: `tags` property on events (input and output). Tags were previously converted to prefixed streamIds.
- **REMOVED**: `tags` query parameter for events.get.
- **REMOVED**: Tag-based access permissions (`{ tag: ..., level: ... }`).

### Final cleanup
- **REMOVED**: `/service/infos` endpoint (use `/service/info` instead).

### FollowedSlices
- **REMOVED**: FollowedSlices feature — API methods (`followedSlices.create`, `followedSlices.get`, `followedSlices.delete`), routes, and storage backends have been fully removed.
