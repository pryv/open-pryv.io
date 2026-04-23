# AGENTS.md (proposed for upstream `pryv/open-pryv.io`)

This is a draft of an `AGENTS.md` file to drop at the root of `open-pryv.io`. It targets LLM coding agents (Claude Code, Cursor, Copilot, etc.) bootstrapping against this repo with **no private context** — only what's in the public tree plus a few canonical upstream repos.

---

# AGENTS.md

Welcome, agent. This file is a fast-orientation guide so you don't have to rediscover the repo the hard way. It complements `README.md`, `INSTALL.md`, `CHANGELOG-v2.md`, and `SINGLE-TO-MULTIPLE.md` — read those for depth; read this one first for shape.

## What this repo is

`open-pryv.io` is the **deployable meta-repo** for Pryv.io v2 — a personal-data REST/WebSocket platform. It bundles `service-core`, `service-register`, `service-mail`, `service-mfa`, `app-web-auth3`, `lib-js`, and `pryv-datastore` at pinned SHAs plus the boot/orchestration/CA/cert logic.

## Quick repo map

```
bin/              Entry points (master.js, bootstrap.js, backup.js, ...)
components/       Source code split by domain
  api-server/       HTTP REST API (Express)
  hfs-server/       High-frequency series ingest
  previews-server/  Image preview renderer
  business/         Cross-domain logic (auth, access, acme, backup, mfa, ...)
    acme/             Built-in ACME orchestrator + CertRenewer
  platform/         PlatformDB (rqlite) interface + engine manifests
  storage/          Storage facade (pluggable via `storages/` engines)
  audit/            Audit logging
  webhooks/         Outbound event delivery
config/           Default + override YAML configs
storages/         Plugin tree for storage engines
  engines/
    mongodb/        MongoDB engine (legacy-first, full parity)
    postgresql/     PostgreSQL engine (baseStorage, dataStore, platformStorage,
                    seriesStorage, auditStorage — full coverage)
    sqlite/         Per-user SQLite engine
    rqlite/         Distributed SQLite (platformStorage default)
    filesystem/     Attachments/previews on disk
    influxdb/       Legacy metrics store
  datastores/       Custom datastore plugins (e.g. `account`)
  pluginLoader.js   Reads `storages.<type>.engine` from config and returns
                    the chosen engine module.
Dockerfile        Canonical container for production use
test/             Integration tests — see `just test-*` in justfile
```

## Running locally

**One-line dev**:
```bash
npm install
just dev          # single-core, SQLite everywhere, http on :3000 via backloop.dev TLS
```

**Tests**:
```bash
just test                  # default engine matrix
just test-full-mongo       # MongoDB for all user stores
just test-postgres         # PostgreSQL matrix
```

**Production-ish single node**:
```bash
NODE_ENV=production node bin/master.js --config /path/to/your/override-config.yml
```

`NODE_ENV=test` short-circuits optional integrations (observability providers, strict startup checks). Always respect it in new code — tests must stay hermetic.

## Five architectural truths that aren't obvious from grep

1. **`bin/master.js` owns the lifecycle.** It:
   - Runs a minimal `boiler` init to read config,
   - Spawns and supervises an **embedded `rqlited`** in both single- and multi-core mode (no separate DB process to manage),
   - Forks `cluster` workers: `cluster.apiWorkers` (default 2) API workers, `cluster.hfsWorkers` HFS workers, `cluster.previewsWorker` previews worker,
   - On the CA-holder core, runs the **AcmeOrchestrator** that polls PlatformDB for cert state,
   - Handles the `--bootstrap` mode used to add new cores (decrypts a sealed bundle, writes `override-config.yml` + TLS files, acks the issuer, falls through into normal startup).

   Don't add a PM2 / systemd / Docker-compose-style process supervisor around it. master.js *is* the supervisor.

2. **TLS termination is native.** api-server workers call `https.createServer(buildHttpsOptions(config), app.expressApp)` and `setSecureContext()` for **zero-downtime hot-swap** on cert renewal. Don't put nginx/haproxy/caddy in front unless you have a specific reason — you'll duplicate rotation logic and break the IPC-driven hot-swap.

   If you must front-proxy, wire the front's reload into `letsEncrypt.onRotateScript` in config so the front picks up new certs within the same renewal cycle.

3. **Wildcard certs are first-class.** `components/business/src/acme/deriveHostnames.js` returns `{ commonName, altNames, challenge: 'dns-01' | 'http-01' }` from existing topology config:

   | Config | Hosts | Challenge |
   |---|---|---|
   | `dnsLess.isActive: true` + `dnsLess.publicUrl` | the URL's hostname | `http-01` |
   | `dns.active: true` + `dns.domain: X` | `X` + `*.X` | `dns-01` |
   | `core.url: https://Y/` (DNSless multi-core) | `Y` | `http-01` |
   | `dns.domain: X` (not authoritative here) | `X` + `*.X` | `dns-01` |

   The embedded DNS server answers `_acme-challenge.X` transiently during DNS-01 — you don't need to integrate certbot or a third-party DNS API.

4. **Storage engines are pluggable at runtime.** Pick your engine in config:
   ```yaml
   storages:
     baseStorage:     { engine: postgresql }
     dataStore:       { engine: postgresql }
     platform:        { engine: rqlite }   # always rqlite in v2
     seriesStorage:   { engine: postgresql }
     auditStorage:    { engine: sqlite }
     engines:
       postgresql: { host: ..., port: 5432, database: pryv-node, user: pryv, password: ..., max: 20 }
   ```
   The `pluginLoader` reads `storages/engines/<name>/manifest.json` to see which `storageTypes` each engine provides. Adding an engine = new directory under `storages/engines/` with a manifest + `src/index.js`. Don't reinvent — the plugin pattern exists.

   **Stale doc warning:** older `README-DBs.md` text implies Postgres is "conformance-tests only" — **the plugin tree supersedes that**. PostgreSQL is a first-class production engine for every `storageType` except (by design) `platform` which is rqlite-only for Raft consensus.

5. **Cluster CA lifecycle.** The first `master.js` boot on a fresh box mints a self-signed cluster CA under `/etc/pryv/ca/`. **Back that directory up immediately** — the private key never leaves the host and losing it means you can't add or rotate cores. `bin/bootstrap.js new-core --id <name> --ip <ip>` issues a sealed AES-256-GCM-encrypted bundle + one-time join token to onboard additional cores. Bundle and passphrase travel **on different channels**.

## Common pitfalls for agents

- **Don't assume MongoDB.** The engine plugin tree lets operators choose; a contribution that hard-codes MongoDB or SQLite inside business logic will get rejected. Use `pluginLoader.getEngineModule(pluginLoader.getEngineFor('<storageType>'))`.
- **Don't add an APM agent at `require()` time unconditionally.** Observability is opt-in per `macroPryv`-equivalent plan 38 (if your fork has it) or via the generic `PRYV_OBSERVABILITY_PROVIDER` env gate. Always honour `NODE_ENV=test` as a no-op.
- **Don't edit `README-DBs.md` without cross-checking the plugin tree.** The file predates the current `storages/engines/*` plugin loader; its "rqlite is the only runtime-selectable engine for platform" phrasing is narrower than the plugin manifests actually allow (though in practice rqlite is the only sensible platform choice).
- **Don't introduce a second TLS terminator.** See truth #2.
- **Don't hot-wire cert rotation with `fs.watchFile` or cron.** Use the existing `AcmeOrchestrator` → `acme:rotate` IPC → worker `reloadTls()` path.
- **Don't ship multi-process orchestration shims** (PM2, runit, supervisord configs). master.js replaces those. If you need to restart a worker, `master.js` already does it (see `cluster.on('exit', ...)`).

## Config precedence

`@pryv/boiler` layers configs in order (lowest → highest):
1. `config/default-config.yml` (committed defaults)
2. `config/plugins/*` (derived values like system streams)
3. Explicit `--config <path>` flag
4. `override-config.yml` at the baseConfigDir (written by `master.js --bootstrap` on core join; highest slot in addition to the explicit flag's)
5. Environment variables (`VARNAME` → `varname` with `__` meaning `:` for nested keys)

Understand this before debugging why a setting "isn't taking effect".

## Where to read next

- `SINGLE-TO-MULTIPLE.md` — multi-core onboarding, CA, bundle flow.
- `INSTALL.md` — operator install steps.
- `CHANGELOG-v2.md` — what changed from v1.
- `components/business/src/acme/` — ACME internals.
- `components/platform/` — PlatformDB interface + rqlite specifics.
- `storages/manifest-schema.js` + `storages/pluginLoader.js` — how engines are loaded.
- `storages/engines/<name>/manifest.json` — what each engine provides.

## When in doubt

- Read `bin/master.js` top-to-bottom. It's the single entry point and its comments explain more than this file can.
- If a config key feels like it should exist but you can't find it: check `config/default-config.yml` — if it's not there, it probably isn't a thing.
- Test changes with `just test-full-mongo` *and* at least one SQL engine (`just test-postgres` if available) before assuming engine-agnostic behaviour.

— Happy hacking.
