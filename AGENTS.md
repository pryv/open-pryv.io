# AGENTS.md

Welcome, agent. This file is a fast-orientation guide so you don't have to rediscover the repo the hard way. It complements `README.md`, `INSTALL.md`, `README-DBs.md`, `CHANGELOG-v2.md`, and `SINGLE-TO-MULTIPLE.md` — read those for depth; read this one first for shape.

## What this repo is

`open-pryv.io` is the v2 codebase of Pryv.io — a personal-data REST/WebSocket platform. It is a **single Node.js codebase** that produces a single binary (`bin/master.js`) and a single Docker image (`pryvio/open-pryv.io`). Registration, MFA, API, high-frequency series, previews, and the email renderer all run inside that binary as cluster workers.

Some sibling projects live in separate repos and are consumed as dependencies or downloaded as artifacts at deploy time — they are **not** bundled here:

- [`pryv/lib-js`](https://github.com/pryv/lib-js) — the `pryv` npm package (JS client lib).
- [`pryv/pryv-datastore`](https://github.com/pryv/pryv-datastore) — the datastore interface that custom datastore plugins implement.
- [`pryv/app-web-auth3`](https://github.com/pryv/app-web-auth3) — the Vue.js auth/register/password-reset web pages.

The v1 line (pre-single-binary) is preserved on the [`release/1.9.3`](https://github.com/pryv/open-pryv.io/tree/release/1.9.3) branch and is no longer updated.

## Quick repo map

```
bin/              Entry points and admin CLIs
  master.js         Supervisor — forks cluster workers, runs rqlited, AcmeOrchestrator
  bootstrap.js      Multi-core onboarding (issue/consume sealed bundle)
  backup.js         Engine-agnostic backup + restore (JSONL + gzip)
  migrate.js        Schema migration runner (status / up)
  dns-records.js    Persistent DNS record admin
  migrate-platform.js  Move platform data between rqlite and postgresql
  check-config.js / config-to-env.js  Validate a config / convert it to an env file
  integrity-check.js Per-user integrity verification
  mail.js           Mail template admin (in-process email)
  observability.js  Optional APM admin (enable / disable / set-license-key)

components/       Source code split by domain
  api-server/       HTTP REST API (Express)
  hfs-server/       High-frequency series ingest
  previews-server/  Image preview renderer
  dns-server/       Embedded DNS server for multi-core DNS-based topology
  mail/             In-process email renderer (Pug templates in PlatformDB)
  middleware/       Express middleware (auth, wrong-core, regSubdomainPathMap, ...)
  mall/             Data access layer (events, streams — engine-agnostic)
  cache/            Caching layer
  platform/         PlatformDB interface + config-snapshot hash drift
  storage/          Storage facade — uses the engines selected in config
  audit/            Audit logging (uses SQLite directly)
  business/         Cross-domain logic:
    accesses/  acme/  auth/  backup/  bootstrap/  integrity/
    mfa/  notifications/  observability/  series/  system-streams/  users/  webhooks/
  webhooks/         Outbound event delivery (optional named `scopes` filter)
  errors/ messages/ test-helpers/ tracing/ utils/ externals/

storages/         Plugin tree for storage engines (npm workspace)
  interfaces/
    baseStorage/  dataStore/  platformStorage/  fileStorage/
    seriesStorage/  auditStorage/  backup/  migrations/
  engines/
    postgresql/     baseStorage, dataStore, seriesStorage, auditStorage, platformStorage, fileStorage (low-volume attachments)
    sqlite/         per-user SQLite (baseStorage, dataStore, auditStorage)
    rqlite/         distributed SQLite (platformStorage default; required multi-core)
    filesystem/     attachments + previews on disk (fileStorage)
    s3/             attachments on S3-compatible object stores (fileStorage)
    influxdb/       high-frequency series (seriesStorage)
  datastores/       Custom datastore plugins (e.g. `account` for system streams)
  manifest-schema.js  Schema for engine manifests
  pluginLoader.js     Reads `storages.<type>.engine` + loads the chosen engine

config/           default-config.yml + plugins
Dockerfile        Canonical container (bundles rqlited, sharp)
test/             Integration test entry — see `just test …` in justfile
```

## Running locally

Prerequisites: Node.js 22.x, PostgreSQL 14+ (or SQLite — bundled), [just](https://github.com/casey/just#installation).

```bash
just setup-dev-env     # prepares var-pryv/ layout + launches PG/rqlite binaries
just install           # npm install across workspaces
just start-master      # boot the single-binary cluster
```

**Tests** (from repo root, via `justfile`):

```bash
just test all                      # full suite, PostgreSQL baseStorage (default)
just test <component>              # single component, PostgreSQL baseStorage
just test-sqlite all               # full suite, SQLite baseStorage
just test-sqlite <component>       # single component, SQLite baseStorage
just clean-test-data               # reset test DBs + per-user dirs
```

**Production-ish single node**:

```bash
NODE_ENV=production node bin/master.js --config /path/to/your/override-config.yml
```

`NODE_ENV=test` short-circuits optional integrations (observability providers, strict startup checks). Always honour it in new code — tests must stay hermetic.

## Five architectural truths that aren't obvious from grep

1. **`bin/master.js` owns the lifecycle.** It:
   - Runs a minimal `@pryv/boiler` init to read config,
   - Spawns and supervises an **embedded `rqlited`** in both single- and multi-core mode (no separate DB process to manage; skipped entirely when `storages.platform.engine: postgresql` — the single-core diskless shape),
   - Forks cluster workers: `cluster.apiWorkers` (default 2) API workers, `cluster.hfsWorkers` HFS workers, `cluster.previewsWorker` previews worker,
   - On the CA-holder core only, runs the **AcmeOrchestrator** that polls PlatformDB for cert state (other cores poll + materialize),
   - Handles the `--bootstrap` mode used to add new cores (decrypts a sealed bundle, writes `override-config.yml` + TLS files, acks the issuer, falls through into normal startup).

   Don't add a PM2 / systemd / Docker-compose-style process supervisor around it. master.js *is* the supervisor.

2. **TLS termination is native.** api-server workers call `https.createServer(buildHttpsOptions(config), requestHandler)` and `setSecureContext()` for **zero-downtime hot-swap** on cert renewal. The `requestHandler` is an in-process dispatcher (`components/api-server/src/hfsIngress.ts`) that routes `^/<user>/events/<id>/series` and `^/<user>/series/batch` to the HFS worker on `localhost:4000` before falling through to `app.expressApp`. This is the **quick / out-of-the-box** ingress; for high-throughput installs, front with nginx (`docs/nginx-ingress-sample.conf`) and let it do the routing instead — the in-process dispatcher stays present but is bypassed because external traffic doesn't reach it.

   If you must front-proxy, wire the front's reload into `letsEncrypt.onRotateScript` in config so the front picks up new certs within the same renewal cycle.

3. **Wildcard certs are first-class.** `components/business/src/acme/deriveHostnames.js` returns `{ commonName, altNames, challenge: 'dns-01' | 'http-01' }` from existing topology config:

   | Config | Hosts | Challenge |
   |---|---|---|
   | `dnsLess.isActive: true` + `dnsLess.publicUrl` | the URL's hostname | `http-01` |
   | `dns.active: true` + `dns.domain: X` | `X` + `*.X` | `dns-01` |
   | `core.url: https://Y/` (DNSless multi-core) | `Y` | `http-01` |

   The embedded DNS server answers `_acme-challenge.X` transiently during DNS-01 — you don't need to integrate certbot or a third-party DNS API.

4. **Storage engines are pluggable at runtime.** Engine choice is per-core. The config keys in `config/default-config.yml` are:

   ```yaml
   storages:
     base:     { engine: postgresql }   # baseStorage + dataStore
     platform: { engine: rqlite }       # platformStorage — or postgresql (single-core dnsLess only)
     series:   { engine: influxdb }     # seriesStorage
     file:     { engine: filesystem }   # fileStorage
     audit:    { engine: sqlite }       # auditStorage
     engines:
       postgresql: { host: 127.0.0.1, port: 5432, database: pryv-node, user: pryv, password: '', max: 20 }
       # sqlite, rqlite, influxdb, filesystem also configurable here
   ```

   The `pluginLoader` reads `storages/engines/<name>/manifest.json` to see which `storageTypes` each engine provides. From code:

   ```js
   const engine = pluginLoader.getEngineModule(pluginLoader.getEngineFor('platformStorage'));
   ```

   Adding an engine = new directory under `storages/engines/` with a `manifest.json` + `src/index.js`. Don't reinvent — the plugin pattern exists.

   PostgreSQL is a first-class production engine for every `storageType`. `platform` defaults to rqlite (Raft consensus is what makes multi-core work); single-core dnsLess deployments in full PG mode may select postgresql instead — the diskless shape, with `storages.file.engine: s3` for attachments and `bin/migrate-platform.js` to move platform data when the topology changes. See `README-DBs.md` for the human-readable DB layout.

5. **Cluster CA lifecycle.** The first `master.js` boot on a fresh box mints a self-signed cluster CA under `/etc/pryv/ca/`. **Back that directory up immediately** — the private key never leaves the host, and losing it means you can't add or rotate cores. `bin/bootstrap.js new-core --id <name> --ip <ip>` issues a sealed AES-256-GCM-encrypted bundle + one-time join token to onboard additional cores. Bundle and passphrase travel **on different channels**. See `SINGLE-TO-MULTIPLE.md`.

6. **`components/tracing/` is a permanent no-op shim — keep the architectural slot, plug a `DummyTracing` instance.** Jaeger / OpenTracing / cls-hooked were removed during the v2 dependency cleanup. The 8 hot-path consumers (api-server `application.js` / `Result.js` / `socket-io/Manager.js`, business `MethodContext.js`, middleware `setMethodId.js` / `setMinimalMethodContext.js`, storage `storage/index.js` + `storages/index.js`) still import from `tracing` — every call collapses to a `DummyTracing` no-op. The hfs-server side (`components/hfs-server/src/tracing/`) follows the same pattern: `cls.js` and the trace middleware are no-op pass-throughs. New Relic APM (the opt-in observability façade) is the active observability path and runs in parallel, *not* through this component. If a future tracer (OpenTelemetry, Tempo, custom) is wanted, replace the body of `components/tracing/src/Tracing.js` with the real impl — the 8 consumers do not need to change.

## Common pitfalls for agents

- **Don't assume a single engine.** The engine plugin tree lets operators choose between PostgreSQL (default) and SQLite for `baseStorage` / `dataStore` / `auditStorage`; contributions that hard-code either inside business logic will get rejected. Use `pluginLoader.getEngineModule(pluginLoader.getEngineFor('<storageType>'))`.
- **Don't add an APM agent at `require()` time unconditionally.** Observability (APM) is opt-in via the pluggable provider façade; the agent is bootstrapped by `bin/_observability-boot.js` only when a provider is explicitly enabled (admin CLI: `bin/observability.js`). Always honour `NODE_ENV=test` as a no-op.
- **Don't introduce a second TLS terminator.** See truth #2.
- **Don't hot-wire cert rotation with `fs.watchFile` or cron.** Use the existing `AcmeOrchestrator` → `acme:rotate` IPC → worker `reloadTls()` path.
- **Don't ship multi-process orchestration shims** (PM2, runit, supervisord configs). master.js replaces those. If you need to restart a worker, master.js already does it (see `cluster.on('exit', ...)`).
- **Don't write PlatformDB directly.** Go through `components/platform/` — it enforces config-snapshot hashes and cluster-wide semantics. Bypassing it silently desyncs cores.
- **CMC `accept` / `scope-update` / `revoke` triggers are personal-token-only.** `consent/accept-cmc`, `consent/scope-update-cmc`, and `consent/revoke-cmc` writes mutate access state on the user's account; the gate (`components/cmc/src/cmcAcceptAccessGate.ts`) rejects app- or shared-access tokens with `400 invalid-operation` + `error.data.id === 'cmc-accept-requires-personal-token'`. Don't try to relax this gate to make a test pass — the gate exists to enforce user-presence at the moment of acceptance. Apps without a personal token use `pryv.cmc.requestAccept(...)` (lib-js `@pryv/cmc` ≥ 3.8) to hand off to `app-web-auth3`'s `/cmc-accept` page. The plugin-managed access exemption (`clientData.cmc.kind === 'capability'` / `role === 'counterparty'`) is how cross-platform delivery still works — don't widen it. See `components/cmc/INTERNALS.md` "Token-class gate on lifecycle triggers" for the full story.

## TypeScript conventions

Naming: a bare `Xxx` is a canonical type defined once and imported (`import type`); `XxxLike` is a *local structural* model of just the members a file actually uses; `XxxRow` is a storage-engine row shape (snake_case columns); `Wire`/`Raw` prefixes mark unparsed wire shapes before normalization. Use the **most precise real type available** — `unknown` only for genuinely-opaque pass-through and runtime-validator inputs, never as a shortcut when a real shape exists. Explicit `any` fails lint (`just lint-ts-any`, part of `just lint`); the few legitimate escape hatches carry a justified `eslint-disable` comment in place — read them before adding a new one. Don't add field initializers (`= ''`, `?? 0`) just to satisfy the compiler: they silently change undefined-by-default runtime semantics — use `field!: T`, `field?: T`, or an explicit union instead. Gates: `just typecheck` (tsc, `strict: true`), `just type-coverage` (floor 81%), and the open-index-signature ratchet (`scripts/open-type-ratchet`, part of `just lint`) — `[k: string]: unknown` disables typo detection on reads, so the site count may only go down; enumerate a new shape's fields unless the openness is load-bearing (dynamic key access, passthrough, the open event data model).

### Canonical type homes — import, don't redeclare

| You need | Import from |
|---|---|
| `Event`, `Stream`, `Access`, `Permission(Level)`, `StreamPermission`, `FeaturePermission`, `AccessType`, `Webhook`, `UserId`, `HttpHeaders`, `ApiResult`, `StreamQuery` (API/wire shapes) | `business/src/types/public.ts` |
| `StoredEvent`, `StoredStream`, `StoredAccess`, `StoredPermission`, `SessionData` (storage-side shapes) | `storages/interfaces/_shared/domain.ts` |
| `Callback`, `UserOrId`, `StoredItem`, `Query`, `UpdateData`, `FindOptions`, `EventsQueryState` (storage plumbing) | `storages/interfaces/_shared/types.ts` |
| `Mall`, `MallEvents`, `MallStreams`, `MallTransactionLike`, `DataStore`, `StoreSupports` | `components/mall/src/types.ts` |
| `Logger`, `LogFn`, `ConfigLike` | `@pryv/boiler` (components and engines; `storages/interfaces/**` use the mirror pair in `_shared/types.ts` — contract files stay boiler-free) |
| `SqliteDb`, `SqliteStmt<Row>`, `SqlParam` | `storages/engines/sqlite/src/types.ts` |
| CMC views: `MallLike` groups, `CmcAccessLike`, `CmcClientData`, `OutboundDeps`, `FetchLike` | `components/cmc/src/_types.ts` |
| Storage contracts (`UserStorage<T>`, `Sessions`, `UserAccountStorage`, `UserAuditDatabase`+`AuditEvent`, `BackupReader`+`BackupManifest`, …) | the `storages/interfaces/<kind>/` file that defines them |

**Three layers, never merged:** wire (`Event`, what the API returns), stored (`StoredEvent`, what flows through interfaces and the mall — carries `headId`/`deleted`/`endTime`), engine row (`XxxRow`, per-engine, converted at the `toDB`/`fromDB` boundary). If your shape genuinely differs from all three, it's probably a narrow view — name it `XxxLike` and keep it local.

**Lint-enforced — one type name, one meaning:** every noun in this table is guarded by `no-restricted-syntax` in `eslint.ts-any.config.js` (part of `just lint`) — declaring a local `type`/`interface` with a canonical name fails lint with a pointer to the canonical home. A local structural view gets its own name (`XxxLike`), an engine row `XxxRow`, a domain-distinct concept a real name of its own (e.g. `SeriesQuery`, not `Query`). When several shapes compete for a bare noun, the API-facing (wire) shape owns it. When adding a row to this table, add the noun to the `CANONICAL_NOUNS` block in the config.

### Patterns

- **Method-context scratch fields**: api-server method chains refine the context as `type MethodContext = BaseMethodContext & { myField?: T }` with *named, typed* fields — never `[key: string]: any`. A field written by one component and read by another belongs on the base `MethodContext` class. Mid-chain reads of step-populated fields use one capture with an invariant comment: `const x = context.x!; // Invariant: <populating step> ran earlier in this chain.`
- **DI-seam narrow views**: modules that receive dependencies for fake-based unit testing (CMC handlers) type them with the shared narrow views (`cmc/src/_types.ts`), not the full interfaces.
- **Typed require handles**: when a `require()`d module erases a useful signature (e.g. a `: never` throw helper), re-bind it: `const m: typeof import('./m.ts') = require('./m.ts');`. This applies to **class extends too** — `class X extends require('./Base.ts').Base` makes the parent `any` and silences ALL override-compatibility checking; re-bind the require (`const { Base } = require('./Base.ts') as typeof import('./Base.ts');`) so the inheritance seam is checked.
- **Generic storage bases**: `BaseStoragePG<T>` / `BaseStorageSQLite<TItem>` are generic over the stored item shape and declare `implements UserStorage<T>`. Collection subclasses bind their item type (`extends BaseStoragePG<StoredAccess>`); free-form collections (profile) stay on the default `StoredItem`. Override callbacks carry `T | null` to match the base contracts — don't strip the `| null`.

## Config precedence

`@pryv/boiler` layers configs (lowest → highest):

1. `config/default-config.yml` (committed defaults)
2. `config/plugins/*` (derived values like system streams)
3. `${NODE_ENV}-config.yml` or the file passed via `--config <path>`
4. `override-config.yml` at the baseConfigDir (written by `master.js --bootstrap` on core join)
5. Environment variables — boiler uses `__` (double underscore) as the nested-key separator (e.g. `auth__adminAccessKey=…` sets `auth.adminAccessKey`). See `@pryv/boiler` for the exact mapping rules.

Understand this before debugging why a setting "isn't taking effect".

## Where to read next

**In this repo:**
- `README.md` — project overview + quick-start.
- `INSTALL.md` — operator install steps.
- `README-DBs.md` — storage-by-storage DB layout and engine selection.
- `SINGLE-TO-MULTIPLE.md` — multi-core onboarding, cluster CA, sealed bundle flow.
- `CHANGELOG-v2.md` — API-facing changes; `CHANGELOG-v2-back.md` — internal changes.
- `components/business/src/acme/` — ACME orchestrator + cert renewer internals.
- `components/platform/` — PlatformDB interface + rqlite specifics.
- `storages/manifest-schema.js` + `storages/pluginLoader.js` — how engines are loaded.
- `storages/engines/<name>/manifest.json` — what each engine provides.

**External docs (pryv.github.io):**
- [API reference](https://pryv.github.io/) — canonical REST/WebSocket reference (full, light, admin, system variants).
- [Concepts](https://pryv.github.io/concepts/) — streams, events, accesses, permissions.
- [Data in Pryv](https://pryv.github.io/data-in-pryv/) — data model deep-dive.
- [Event types](https://pryv.github.io/event-types/) — the curated type catalogue.
- [System streams](https://pryv.github.io/customer-resources/system-streams/) — how account fields map to streams.
- [Getting started](https://pryv.github.io/getting-started/) — first API calls.
- [Guides](https://pryv.github.io/guides/) — app guidelines, audit logs, consent, custom auth, data modelling, webhooks.
- [FAQ API](https://pryv.github.io/faq-api/) and [FAQ Infra](https://pryv.github.io/faq-infra/).

**Operator-facing setup guides (pryv.github.io/customer-resources/):**
- [Infrastructure procurement](https://pryv.github.io/customer-resources/infrastructure-procurement/) — topology + sizing.
- [Pryv.io setup](https://pryv.github.io/customer-resources/pryv.io-setup/) — single-node topology.
- [Single node to cluster](https://pryv.github.io/customer-resources/single-node-to-cluster/) — multi-core upgrade.
- [SSL certificate](https://pryv.github.io/customer-resources/ssl-certificate/) — built-in ACME / Let's Encrypt.
- [Backup](https://pryv.github.io/customer-resources/backup/) — `bin/backup.js`.
- [Core migration](https://pryv.github.io/customer-resources/core-migration/) — moving a core to a new host.
- [MFA](https://pryv.github.io/customer-resources/mfa/) — SMS-based two-factor.
- [Emails setup](https://pryv.github.io/customer-resources/emails-setup/) — in-process vs microservice.
- [Observability (APM)](https://pryv.github.io/customer-resources/observability/) — opt-in New Relic integration.
- [Healthchecks](https://pryv.github.io/customer-resources/healthchecks/) and [platform validation](https://pryv.github.io/customer-resources/platform-validation/).
- [Change log](https://pryv.github.io/change-log/).

_A few operator pages on pryv.github.io (notably `dns-config`, `audit-setup`, and `system-streams`) still mix v1 and v2 wording; when in doubt, trust this repo's `config/default-config.yml`, `README-DBs.md`, and the `bin/*` admin CLIs over the rendered doc site._

## Where to file issues / PRs

- Bugs + feature requests: [`pryv/open-pryv.io` GitHub Issues](https://github.com/pryv/open-pryv.io/issues).
- Pull requests against `master`. For anything touching the cluster CA, ACME orchestrator, PlatformDB interface, or the storage plugin tree — open a draft PR early and tag a maintainer; those areas have subtle invariants that aren't obvious from a local diff.

## When in doubt

- Read `bin/master.js` top-to-bottom. It's the single entry point and its comments explain more than this file can.
- If a config key feels like it should exist but you can't find it: check `config/default-config.yml` — if it's not there, it probably isn't a thing.
- Test changes against both engines before assuming engine-agnostic behaviour: `just test all` (PostgreSQL default) and `just test-sqlite all`.

— Happy hacking.
