# Changelog - API Changes

## `accesses.update` is back — versioned, chain-checked, composite-id (Plan 66 Phase C)

- **NEW** `PUT /accesses/:id` — `accesses.update` is no longer a `goneResource` stub. It mutates the head row, snapshots the prior state into history (single-collection `headId` shape), and bumps the access's `serial`. The returned access carries the new wire-format composite id `<base>:<serial>` (or bare `<base>` when never updated).
- **Mutable fields:** `name`, `deviceName`, `permissions`, `expireAfter` / `expires`, `clientData`. Immutable: `token`, `type`, `createdBy`, `id`, `lastUsed`, `created`, `modified`, `modifiedBy`. Sending any field outside the mutable whitelist returns `invalid-parameters-format`.
- **Who can update what:** `personal` accesses are immutable (no caller can update them). An `app` access can update only the `shared` accesses it directly manages (chain match by `base`, so a future-versioned app still matches). `shared` accesses cannot update anything. No self-update is permitted via this method (selfrevoke stays available via `accesses.delete`).
- **Chain rules enforced on update:**
  - **A** — a managed `shared`'s new `permissions` must remain a subset of its managing `app`'s permissions.
  - **B / C** — narrowing an `app`'s permissions (or `expires`) is strict-rejected if any of its managed shareds would now sit outside the new scope or outlive the new expiry. Error includes `data.offendingChildren: [ids]` so the caller can resolve children first and retry.
  - **D** — a managed `shared`'s `expires` cannot exceed its managing `app`'s `expires` (parent with `expires: null` imposes no cap).
- **Composite-id conflict (NEW error)** — `accesses.update` and `accesses.delete` now require the caller's id to match the current head's `serial`. A stale composite returns **`409 stale-resource`** with `data: { provided, currentSerial }`; refetch the access and retry with the current head id. Bare `<base>` is only valid on a never-updated access; the same `409` fires if the access has since been versioned.
- **Soft-deleted access → `unknownResource`** — no info leak via differentiated error.
- **NEW pubsub event** — every successful update emits both `USERNAME_BASED_ACCESSES_CHANGED` (existing, backwards-compat) and `ACCESS_UPDATED { accessId: '<base>:<serial>', serial }` on the owner's channel. Recipients of shared-token credentials see the new scope on their next API call (token-scoped notification is out of scope, backlogged at `SCOPED-NOTIFICATION.md`).
- **Cache invalidation** — `cache.unsetAccessLogic` fires for the updated base alongside the storage write, parallel to the existing `accesses.delete` pattern. Auth-by-token lookups observe the new permissions immediately.
- **Composite-id conflict also on `accesses.delete`** — `DELETE /accesses/:id` validates the same way; pass the composite id you last read or accept a `409 stale-resource`. The subsequent delete path still operates on the bare base internally.

## `accesses.create` — managed shared expiry now capped by parent (Plan 66 Phase B, BREAKING)

- **BREAKING** When an `app` access creates a `shared` access scoped under it, the new shared's `expires` (resolved from `expireAfter` if provided) now cannot exceed the managing app's `expires`. Violations return `invalid-operation` with `data: { parentExpires, requestedExpires }`. This was previously allowed and would silently produce a shared access that outlived its managing parent — confusing audit and breaking the symmetry with `accesses.update`'s chain rules.
- **Edge case unchanged**: when the managing access has no `expires` (e.g. typical personal-issued app accesses), no cap applies. Practically this means the vast majority of integrations — which create accesses with `expireAfter` under a personal token — are unaffected.
- **What to change**: integrations that issue shared accesses with a longer lifetime than the managing app must instead extend the managing app's expiry first (or reissue both).
- **Why now**: Plan 66 introduces `accesses.update` with the same chain rule, and applying it only on update would have produced asymmetric behavior. Retrofitting `create` is the consistency call.

## High-frequency series — in-process dispatch from the public port

- **CHANGE** `POST /<user>/events/<id>/series` and `POST /<user>/series/batch` are now reachable on the **same public port** as the rest of the API (typically `:443` or `http.port`), routed in-process to the HFS worker on `:4000` by a dispatcher in front of api-server. Previously these endpoints only worked if (a) clients reached port `:4000` directly, or (b) an external reverse-proxy (nginx etc.) routed them. Setting `cluster.hfsWorkers: 1` is sufficient — no extra ingress required.
- **CHANGE** SDKs that read `features.noHF` on `/service/info` short-circuit cleanly when the deployment isn't serving HF (i.e. `cluster.hfsWorkers === 0` and no explicit `service.features.noHF: false` override). Combined with this in-process dispatcher, the previous opaque "Failed loading serie: undefined" failure mode no longer occurs on either path: HFS is either reachable on the same port as the API or explicitly advertised as unavailable.
- **Deployment notes**: this is the **quick / out-of-the-box** ingress for raw deploys (`node bin/master.js` under systemd, etc.). For long-term high-throughput installs, front the cluster with nginx — a reference vhost ships under `docs/nginx-ingress-sample.conf`. nginx is more efficient and unlocks edge features (rate-limiting, header munging, static assets); the in-process dispatcher stays present but is bypassed because external traffic doesn't hit it.
- **Why**: customers running raw deploys (no Dokku, no nginx) and wanting HF were previously stuck with workers that started cleanly on `:4000` but were unreachable from outside the host. The Dokku-flavoured installs sidestepped this with a per-app nginx snippet; raw deploys had no equivalent. The in-process dispatcher closes that gap.

## `accesses.delete` — personal-access delete no longer cascades

- **CHANGE** `DELETE /accesses/:id` on a `personal`-type access no longer cascade-deletes the app/shared accesses it created (the ones with `createdBy === <that personal access id>`). The response's `relatedDeletions` is empty/absent in that case, and the descendant accesses survive in storage.
- **Unchanged** for `app` and `shared` deletes: cascade still applies — every descendant access (filtered to not-self + not-expired) is included in `relatedDeletions` and removed alongside the parent.
- **Why** the in-source comment ("deleting a personal access does not delete the accesses it created") has been the documented intent since 2023, but an operator-precedence typo (`!type === 'personal'` parses as `(!type) === 'personal'` → always false) made the early-return branch dead and personal deletes silently cascaded. Personal access tokens are session tokens; cascading on session-delete wiped out every app/shared the user had granted while logged in, which surprises users on logout/session-rotation flows. Comment and behavior now match.
- **Migration note** for callers that relied on the cascade-on-personal-delete behavior: explicitly delete each child access (`DELETE /accesses/:childId`) before deleting the personal access, or use `app`/`shared` deletes which still cascade.

## `audit.syslog.active` defaults to `false`

- **CHANGE** `config/default-config.yml`: `audit.syslog.active` now defaults to `false`. Operators on bare-metal hosts with a syslog daemon listening on `/dev/log` (rsyslog / journald) who want the host-syslog mirror must set `audit.syslog.active: true` in `override-config.yml`. The per-user audited streams (`audit.storage.*`) are unaffected — the existing audit data path keeps emitting unchanged.
- **Why**: containerized deploys are now the dominant install shape and typically have no syslog daemon. The previous default crashed api-server workers on the first audited request (`ENOENT` from `sendto(2)` on a missing socket path bubbled to `uncaughtException` because `winston-syslog` emits `'error'` with no listener). The transport now also has a defensive `'error'` listener that downgrades these to a `warn` log line, so accidental misconfiguration no longer crashes workers regardless of this flag.

## `POST /system/admin/certs/force-renew` — admin route

- **NEW** `POST /system/admin/certs/force-renew` — triggers an immediate ACME renewal of the cluster's TLS cert, bypassing the daily `renewBeforeDays` check. Body `{ "hostname": string? }` (optional — defaults to the configured primary hostname). Response on success: `200 { ok: true, hostname, issuedAt, expiresAt }`. Response on operator-grade failure: `400 { ok: false, error: string }` (e.g. core is not the renewer, ACME upstream rejection, timeout). Auth: `auth.adminAccessKey` via the `Authorization` header (unauth → 404, same contract as every other `/system/*` route).
- **BEHAVIOUR**: only the core configured with `letsEncrypt.certRenewer: true` runs the renewal; calling the route on a non-renewer core returns `400 { error: "core is not the renewer" }`. Newly-issued cert + account material is replicated to peers via the existing rqlite `tls-cert/<hostname>` keyspace, hot-swapped into the running `https.Server` via `setSecureContext` IPC, and materialized to disk by every core.
- **TIMEOUT**: master replies within 180 s — long enough to absorb DNS-01 propagation + LE issuance round-trip in normal conditions. A timeout returns `400` with an `error` describing the upstream failure mode.
- **Why**: previously operators had to wait until the cert hit `renewBeforeDays` or stop+restart the renewer with a clock skew to force an early renewal. Useful for incident response (compromised key, hostname change, missed expiry alarm) and for drilling the renewal path in staging.

## `bin/bootstrap.js init-ca-holder` — new subcommand

- **NEW** `node bin/bootstrap.js init-ca-holder` mints the CA-holder core's own cluster-CA-signed node cert + key and merges `storages.engines.rqlite.tls.{caFile,certFile,keyFile,verifyClient:true}` into `override-config.yml`. Operators promoting a single-core deploy to multi-core run this once on the existing core before issuing the first `new-core` bundle to a peer.
- **Flags**: `--ca-dir <path>` (default `/etc/pryv/ca` or `cluster.ca.path`), `--tls-dir <path>` (default `/etc/pryv/tls` or `http.ssl.tlsDir`), `--no-write-config` (skip the override-config merge if you want to manage TLS pointers by hand).
- **Idempotent**: re-running on a host that already has CA + TLS material + matching config exits with `(existing)` notes and no rewrites — safe to script.
- **Why**: previously the CA-holder core's rqlited served plain TCP while joiners' rqlited tried mTLS with `verifyClient:true`, so cluster formation stalled until the operator hand-minted the holder's cert (the Plan-36 one-off `issue-use1-cert.js` workaround). Now the same code path that joiners use produces the holder's cert.

## Bootstrap bundle now propagates `letsEncrypt.atRestKey`

- **CHANGE** `bin/bootstrap.js new-core` reads `letsEncrypt.atRestKey` from the issuing core's resolved config and embeds it in the encrypted bundle. The joining core's `bin/master.js --bootstrap` writes it into `override-config.yml` automatically — operators no longer need to copy the value into every core's config by hand.
- **Backwards-compat**: when the issuer hasn't set `letsEncrypt.atRestKey` (or it's still on `REPLACE ME`), the field is omitted and operators continue to sync by hand. Existing clusters bootstrapped before this change keep working unchanged.
- **Operator caveat**: once `atRestKey` is set on a cluster, every core must agree forever; rotating it would require re-encrypting every cert + ACME-account row in rqlite. Losing it means re-issuing every LE cert.
- **Why**: removes one operator-sync step + a class of bugs where two cores ended up encrypting cert rows with different keys, blocking cross-core decryption.

## `/reg/hostings` — `availableCore` URLs are now slash-terminated

- **CHANGE** `GET /reg/hostings` response: every `regions.<region>.zones.<zone>.hostings.<h>.availableCore` now ends with `/`, matching the long-standing `serviceInfo.{register,api,access}` convention. Empty-string for unavailable hostings is unchanged.
- **CHANGE** `GET /reg/cores` response: `core.url` is also slash-terminated. Same convention.
- **CHANGE** wrong-core 421 response (`error.coreUrl`) follows the same convention.
- **Client compatibility**: clients that did `host + 'users'` previously produced `https://single.example.devusers`. Doing `host + 'users'` now produces `https://single.example.dev/users` — the *intended* behaviour. Clients that pre-strip-and-re-add the trailing slash continue to work unchanged.
- **Why**: a deploy session surfaced the malformed-URL pattern (`https://single.api.datasafe.devusers`) on a fresh single-core; same drift was confirmed on `reg.pryv.me`. Centralized in `Platform.coreIdToUrl()`.

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
