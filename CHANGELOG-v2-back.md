# Changelog - Internal (no API impact)

## Persistent DNS records — admin surface

- `components/api-server/src/routes/reg/records.js`: added `DELETE /reg/records/:subdomain`. Path refactored to share auth + IPC-nudge helpers with the existing POST handler.
- `bin/dns-records.js` (new): standalone Node CLI — subcommands `list`, `load <file>`, `delete <subdomain>`, `export [file]`. Reads/writes PlatformDB directly via `storages` barrel (no HTTP dependency). Uses `js-yaml` (already transitively present; no new dependency). Parses `--help` before boiler init to avoid boiler's yargs swallowing it.
- `components/api-server/test/dns-records-cli-seq.test.js` (new, `[DNSCLI]`): spawns the CLI as a subprocess and round-trips `list` / `load` (including `--dry-run` and `--replace`) / `export` / `delete`, plus error paths (missing subdomain, malformed file).
- `components/api-server/test/reg-records-seq.test.js`: `[RR10]`-`[RR12]` cover the DELETE route happy path, missing-auth rejection, and unknown-subdomain 404.

Context: end-to-end persistence of runtime DNS records (PlatformDB interface, rqlite backend, `DnsServer` load-on-start + 30 s refresh + write-through, `POST /reg/records` persistence, existing `[RGRC]` test) was shipped earlier in the 2.0.0-pre line. This change adds the DELETE symmetry and the offline-capable admin CLI — the remaining gap for operating DNS records in production without depending on the HTTP API being healthy.

## Test hardening + deploy validation

### Dockerfile bundling & external rqlite mode
- `Dockerfile`: rqlite binary now bundled in the Docker image (`/app/var-pryv/rqlite-bin/rqlited`). `master.js` spawns `rqlited` directly — previous images lacked the binary. Also removed `--omit=optional` so `sharp` installs for the previews worker.
- `bin/master.js`: new `rqlite.external` mode — when `storages.engines.rqlite.external: true`, master.js skips spawning rqlited and connects to an already-running external instance (multi-core deployments sharing one rqlited on the host).
- `storages/engines/rqlite/src/rqliteProcess.js`: new `waitForExternal(url, timeoutMs, log)` helper.
- `components/api-server/src/methods/mfa.js`: removed redundant internal docstring header.

### Test data cleanup: `just clean-test-data` resets MongoDB + rqlite
- `justfile` `clean-test-data` recipe updated to drop `pryv-node-test` MongoDB database and wipe the rqlite `keyValue` table, in addition to the SQLite user index + per-user directories it already cleaned.
- Rationale: the rqlite-only platform-engine migration made rqlite authoritative, but `clean-test-data` was still cleaning the obsolete legacy `var-pryv/users/platform-wide.db` SQLite file. As a result, full-suite runs on a previously-used workstation inherited stale `user-*` entries from rqlite and orphaned account-field rows from MongoDB, which caused the `root-seq.test.js [UA7B] beforeEach` integrity check to fail non-deterministically.
- With the fix: `just clean-test-data && just test all` → **1568 / 0** with integrity checks ENABLED. Same for `just test-pg all` → **1543 / 0**. No `DISABLE_INTEGRITY_CHECK=1` workaround needed on sequential runs anymore. Parallel runs still use the workaround because parallel workers share state across processes.

### Backup chunking fix
- `storages/interfaces/backup/FilesystemBackupWriter.js` `writeChunkedJsonlFiles()` — compressed-mode chunking check now also fires when `rawSize >= maxChunkSize`, not only every 100 items. Small datasets (< 100 items) with aggressive `maxChunkSize` previously produced a single chunk regardless of target; they now respect the soft limit. Large datasets are unaffected (100-item batch check still dominates; the raw-bytes trigger is a lower bound).
- Two tests in `components/business/test/unit/backup/filesystem-writer-reader.test.js` were subtly wrong — they used highly compressible payloads (`'Hello world '.repeat(5)`, short fixed strings) that gzip to almost nothing, so the compressed size never reached `maxChunkSize`. Updated to use non-compressible pseudo-random payloads so the chunking assertions are deterministic.
- New regression test `'round-trips a single event larger than maxChunkSize (soft-limit semantics)'` documents that an individual oversized item is written to exactly one chunk — chunks cannot split items.

## Multi-core refinements & platform config model

### DNSless multi-core minimum
- `config/plugins/core-identity.js` now honors an explicit `core.url` YAML override as the highest-priority source for `core:url`. Falls back to id+domain derivation, then to `dnsLess.publicUrl`.
- `Platform.js`:
  - New private `#coreUrlCache: Map<coreId, url>` populated by `_refreshCoreUrlCache()` from PlatformDB on `init()` and on `registerSelf()`. Lets `coreIdToUrl()` stay synchronous (~10 call sites in api-server) while honoring explicit URLs registered by other cores.
  - `registerSelf()` now writes `url: this.coreUrl || null` into the core info row so DNSless multi-core deployments can advertise their externally-correct URL.
  - `coreIdToUrl(coreId)`: cache lookup → derivation from id+domain → self URL fallback. NOTE: cache stays cold for changes made by OTHER cores until the next `init()` — periodic refresh for dynamic cluster membership is a planned follow-up.
- New middleware `components/middleware/src/checkUserCore.js` — wrong-core check on `/:username/*`. Returns HTTP 421 Misdirected Request with `{ error: { id: 'wrong-core', message, coreUrl } }` when `platform.getUserCore(username) !== platform.coreId`. No-op in single-core mode and for unknown users (existing 401/404 paths handle them). Test hook `_resetPlatformCache()` exposed for cross-test isolation.
- `components/middleware/src/index.js` exports the new middleware as `middleware.checkUserCore`.
- `components/api-server/src/routes/root.js` mounts `middleware.checkUserCore` on `Paths.UserRoot + '/*'` BEFORE `getAuth` and `initContextMiddleware` so wrong-core requests don't pay the cost of user/access loading.
- New tests in `components/api-server/test/reg-multicore-seq.test.js`: 5 wrong-core middleware tests `[MC09A..MC09E]` (wrong core, right core, unknown user, /reg bypass, single-core no-op) and 3 explicit-URL tests `[MC10A..MC10C]` (cache hit, derivation fallback, end-to-end through middleware).

### Persistent DNS records via PlatformDB
- `PlatformDB` interface gains `setDnsRecord(subdomain, records)` / `getDnsRecord(subdomain)` / `getAllDnsRecords()` / `deleteDnsRecord(subdomain)`. The rqlite backend (`storages/engines/rqlite/src/DBrqlite.js`) implements them on the existing `keyValue` table using a `dns-record/{subdomain}` key prefix — no schema migration needed.
- `Platform.js` gains delegating methods for the four DNS record operations.
- `DnsServer` (`components/dns-server/src/DnsServer.js`) now loads runtime DNS records from PlatformDB on `start()` and refreshes them every 30s by default (`platformRefreshIntervalMs` constructor option). YAML `dns.staticEntries` are authoritative — admin runtime entries cannot shadow them. `updateStaticEntry()` is now `async` and persists to PlatformDB before updating the in-memory map. New `deleteStaticEntry()` mirror.
- `POST /reg/records` (`components/api-server/src/routes/reg/records.js`) writes to PlatformDB first, then sends an IPC nudge to master so the local DnsServer refreshes immediately. Other cores in a multi-core deployment pick up the change via the periodic refresh.
- `bin/master.js` IPC handler refreshes from PlatformDB on `dns:updateRecords` instead of trusting the IPC payload — single source of truth.
- Multi-core impact: ACME challenges and other runtime DNS entries now survive master restart and propagate across all cores via rqlite RAFT replication.

### Configuration model: platform-wide vs per-core
- `default-config.yml` annotated with `# === PER-CORE / PLATFORM-WIDE / BOOTSTRAP / MIXED ===` section headers for every block.
- New "Configuration model: platform-wide vs per-core" section in `README.md` explaining the three categories and how multi-core operators must respect the split.
- `Platform.registerSelf()` logs a `[platform-config-snapshot]` line on boot with this core's observed values for known platform-wide keys (`dns.domain`, `integrity.algorithm`, `versioning.deletionMode`, `uploads.maxSizeMb`) plus a SHA-256 hash of `auth.adminAccessKey`. Operators can compare these across core logs to detect drift without the admin key value ever appearing in logs. `auth.adminAccessKey` is confirmed YAML-only (BOOTSTRAP, secret, never moves to PlatformDB).
- A full PlatformDB-backed `platform_config` table with live drift warnings and per-key migrations is a planned post-v2 follow-up.

## Multi-factor authentication implementation (merged from service-mfa)

### New business module `components/business/src/mfa/`
- `Profile.js` — per-user MFA state model (content + recovery codes); replaces lodash `_.isEmpty` with native check
- `Service.js` — abstract base for SMS providers. Takes a plain `mfaConfig` object (not boiler) for DI-friendly tests. Static `replaceAll`/`replaceRecursively` helpers (immutable — original mutated input).
- `ChallengeVerifyService.js` — two-endpoint SMS provider (external SMS service generates + validates the code)
- `SingleService.js` — single-endpoint SMS provider (service-core generates the code + validates locally, templates it into an HTTP call that only delivers the SMS)
- `generateCode.js` — drops bluebird, uses `node:util.promisify` + `node:crypto.randomBytes`
- `SessionStore.js` — in-memory `Map<mfaToken, {profile, context, _timeout}>` with TTL via per-session `setTimeout().unref()`. Single-core only; multi-core sharing deferred.
- `index.js` — barrel with `createMFAService(mfaConfig)` factory and `getMFAService`/`getMFASessionStore` process-wide singleton accessors

### API methods `components/api-server/src/methods/mfa.js`
- Registers `mfa.activate`, `mfa.confirm`, `mfa.challenge`, `mfa.verify`, `mfa.deactivate`, `mfa.recover` on the v2 API. Added to `components/audit/src/ApiMethods.js ALL_METHODS` (required for registration). `mfa.recover` is in `WITHOUT_USER_METHODS`.
- Reads `services.mfa` config per-invocation (not module load) so tests can inject config dynamically.
- Uses `errors.factory.apiUnavailable` (HTTP 503) when MFA is disabled server-wide.
- `saveMFAProfile` uses the `Profile` storage's dot-notation converter shape: `{data: {mfa: X}}` for set and `{data: {mfa: null}}` for unset — the converter turns NULL leaves into `$unset['data.mfa']`.

### HTTP routes `components/api-server/src/routes/mfa.js`
- Binds the 6 API methods to `POST /:username/mfa/*` endpoints
- `activate` and `deactivate` use `loadAccessMiddleware` (personal access token required); `confirm`/`challenge`/`verify` extract `mfaToken` from the Authorization header (supports raw token and `Bearer <token>` shapes) and pass it via `params.mfaToken`; `recover` is unauthenticated.
- New `Paths.MFA = /:username/mfa` entry

### Login integration `components/api-server/src/methods/auth/login.js`
- New `mfaCheckIfActive` step appended to the `auth.login` method chain. When MFA is enabled server-wide AND the user has `profile.private.data.mfa` set, it calls `mfaService.challenge()`, stashes the issued `{user, token, apiEndpoint}` in the SessionStore under a fresh `mfaToken`, and replaces the response with `{mfaToken}` — the caller must then call `mfa.verify` to release the real token.
- MFA disabled OR user has no `profile.mfa` → step is a no-op (login response unchanged).

### Config defaults `config/default-config.yml`
- New `services.mfa` block with `mode: disabled` default. SMS endpoints are empty strings; `sessions.ttlSeconds: 1800`. Existing deployments are fully backwards-compatible.

### Tests
- `components/business/test/unit/mfa/` — 23 unit tests across `generateCode` (2), `Profile` (3), `Service` (6), `createMFAService` factory (5), `SessionStore` (7)
- `components/api-server/test/mfa-seq.test.js` — 15 acceptance tests (`[MFAA]`/`[MA*]`) covering the full activate→confirm→login→challenge→verify→deactivate→recover lifecycle with `nock`-mocked SMS endpoints and `nock.disableNetConnect()` for fast failure on missing mocks
- Added `mfa` to the methods list in `components/test-helpers/src/helpers-base.js` AND `helpers-c.js` (the latter hardcodes the list)
- Added `require('api-server/src/methods/mfa')` to `components/api-server/test/helpers/core-process.js` (multi-core tests)

### Dropped
- `service-mfa`'s separate HTTP proxy, Dockerfile, runit lane. Repo is archived (final commit adds README pointer to the merge commit).
- Copied and dropped: `service-mfa/src/business/pryv/Connection.js` (replaced by direct `userProfileStorage` + `usersRepository` calls), its own `middlewares/`, its own `errorsHandling.js` (replaced by the core `errors.factory`).

## rqlite as the only platform engine

### Platform DB
- `storages.platform.engine` default flipped from `sqlite` → `rqlite`. rqlite is now the only supported runtime platform engine in v2.
- SQLite engine no longer advertises `platformStorage`: removed from `storages/engines/sqlite/manifest.json`, dropped `createPlatformDB` export from `storages/engines/sqlite/src/index.js`, deleted `DBsqlite.js` and the `[SQPF]` SQLite PlatformDB conformance test. SQLite remains in use for `baseStorage`, `dataStore`, and `auditStorage`.
- `mongodb` and `postgresql` engines still ship `PlatformDB` implementations for conformance tests, but cannot be selected as the runtime platform engine via config.

### master.js / lifecycle
- `bin/master.js` always spawns and supervises an embedded `rqlited` (no engine guard, no `external` flag check). The `storages.engines.rqlite.external` config (previously available) has been removed — master.js owns the rqlited lifecycle in both single- and multi-core mode.
- Single-core: rqlited runs as a standalone Raft node.
- Multi-core: rqlited uses DNS discovery on `lsc.{dns.domain}` to join peers.

### Migration script moved
- `bin/migrate-platform-to-rqlite.js` moved to `dev-migrate-v1-v2/migrate-platform-to-rqlite.js`. It is no longer needed for in-v2 single→multi-core upgrades (no migration step at all). Retained in the v1→v2 toolkit for the same shape of work, with a header note explaining the rework needed before reuse.

### Test infrastructure
- `storages/engines/rqlite/scripts/setup` — downloads `rqlited` v9.4.5 from GitHub releases (Linux/macOS, amd64/arm64), idempotent, mirrors mongodb pattern
- `storages/engines/rqlite/scripts/start` — single-node foreground/background launcher with pidfile and `/readyz` wait
- `storages/engines/rqlite/manifest.json`: declared `scripts.setup` and `scripts.start`
- `scripts/setup-dev-env`: invokes rqlite setup after mongodb

### Documentation
- `INSTALL.md`: rqlite added to prerequisites; minimal config updated; `data/rqlite-data/` documented
- `SINGLE-TO-MULTIPLE.md`: rewritten — removed manual rqlite install + data migration steps; new flow is DNS → config → restart → deploy second core (224 → 145 lines)
- `README.md`: storage engines table updated (rqlite added, `platform` removed from MongoDB/PostgreSQL/SQLite rows)
- `README-DBs.md`: rewrote "Platform Wide Shared Storage" section to describe the rqlite-everywhere model
- `storages/pluginLoader.js`: stale `platform: engine: sqlite` example updated

### Bug fix discovered during rqlite-engine live test (me-dns1.pryv.io v1.9.0 backup)
- `RestoreOrchestrator._restorePlatform`: v1 backups (and any future raw exports) write platform entries as `{key, value}` straight from the legacy SQLite/MongoDB platform-wide store, but `platformDB.importAll` expects the parsed shape `{username, field, value, isUnique}`. The orchestrator now bridges both shapes via a new `parseRawPlatformEntry` helper, so v1→v2 migrations restore platform data correctly. v2→v2 round-trips still pass entries through unchanged.
- Verified live: me-dns1 backup (14 users, 28064 events, 271 streams, 211 accesses, 63 platform records, 23 password hashes) restores cleanly into a fresh v2 instance with rqlite as platform engine — including end-to-end email lookup `pm@perki.com → perki`.

## Test deploy with Dokku

### Multi-core support
- `storages.engines.rqlite.external` config: skip embedded rqlited, connect to external instance
- `public-url.js` plugin: generate `api`/`register`/`access` service info for multi-core mode
- Config plugin order: `core-identity` runs before `public-url`
- `subdomainToPath` middleware: skip core's own subdomain in multi-core mode
- `/reg/cores`: check shared PlatformDB before local users_index for cross-core lookups

### Deployment tooling
- `INSTALL.md`: standalone HTTPS (backloop.dev / custom certs) + nginx reverse proxy guide
- `SINGLE-TO-MULTIPLE.md`: step-by-step single→multi-core upgrade guide
- `bin/migrate-platform-to-rqlite.js`: reads users from base storage, populates rqlite platform DB
- Dockerfile: `--ignore-scripts` + rebuild native modules, audit syslog `active:false` support

### RestoreOrchestrator
- Ensure default account fields for v1 backups (fixes "Unknown user" after migration)
- Engine-agnostic backup sanitize: `streamId`/`profileId` → `id`

## Migration toolkit v1→v2

### Backup writer: target file size on compressed output
- `FilesystemBackupWriter` `maxChunkSize` now applies to the **compressed** output size (was uncompressed)
- `bin/backup.js` accepts `--target-file-size <MB>` as alias for `--max-chunk-size`
- Soft limit (~10% overshoot acceptable) — checks compressed size every 100 items

## Backup, restore & integrity

### Backup/restore system (`storages/interfaces/backup/`)
- Engine-agnostic backup: JSONL+gzip format, chunked events/audit, flat attachments by fileId
- `BackupWriter`/`BackupReader` interfaces with filesystem implementation
- Data sanitization: strips `_id`/`__v`/`userId`, promotes `_id` to `id` (except streams)
- `BackupOrchestrator`: snapshot consistency (`snapshotBefore`), `--incremental` mode (auto-detects per-user timestamps)
- `RestoreOrchestrator`: conflict detection, `--skip-conflicts`, `--overwrite`, `--verify-integrity` with rollback
- Series data export/import via engine `exportDatabase()`/`importDatabase()`
- Overwrite protection on backup (requires `--incremental` to write to existing path)

### Integrity verification (`components/business/src/integrity/IntegrityCheck.js`)
- Per-user integrity checking: recomputes hashes on events and accesses
- Reusable from CLI and from restore (`--verify-integrity`)

### CLI tools
- `bin/backup.js`: full backup/restore CLI (all-users, single-user, incremental, compressed)
- `bin/integrity-check.js`: standalone per-user integrity verification (`--user`, `--json`, exit code 0/1)

### pryv-datastore v1.0.2
- Added `exportAll`, `importAll`, `clearAll` to `UserStreams` and `UserEvents` interfaces

### Tests
- 22 unit tests: sanitize, filesystem round-trip, chunking, attachments (single/multi/1MB binary), multi-user, unicode

## Test coverage & dead-code removal

### Coverage tooling (`tools/coverage/`)
- V8-native coverage via `NODE_V8_COVERAGE` + `c8 report` (replaces NYC)
- `collect.js`: bypasses `components-run`, runs mocha from project root via `node` directly
- `pg-early-init.js`: fixes barrel init race — injects PG config before `global.test.js` locks to MongoDB
- `run.sh`: orchestrates 3-engine coverage (MongoDB + PG + SQLite), merged HTML report
- Coverage baseline: 80% statements, 83% branches, 77% functions

### Bug fixes
- Previews-server: `DynamicInstanceManager` (random port), fixed cache cleanup config key, async `getFiles()`, test assertion fix — 15/0 (was process crash)
- WebhooksService: null guard in `activateWebhook()` for PG mode
- Consolidated duplicate `encryption.js` — engines now use `require('utils').encryption`

### Dead code removed
- 6 dead files: JSDoc-only barrels, unused Transform stream, old DeletionModesFields location, serializer shim
- 17 dead test data files: followedSlices, migrated data (0.3.0–0.5.0), structure versions (0.7.1–1.7.0)
- Dead functions: `findStreamed`/`findDeletionsStreamed` stubs (MongoDB + PG), `stateToDB`, `LocalTransaction.commit/rollback`, `Database.findStreamed`, `hasStreamPermissions`, `User.getEvents/getUniqueFields`, `MallUserEvents.getStreamed`, `storage.getDatabase/getDatabasePG`, `pluginLoader.getConfigFor`

## Full PostgreSQL backend

### PG as complete single-core engine
- PostgreSQL now implements all 5 storage types: baseStorage, dataStore, platformStorage, seriesStorage, auditStorage
- Series storage on PG replaces InfluxDB with batch INSERT optimization (up to 5000 rows per statement)
- Audit storage on PG replaces SQLite (optional — SQLite recommended for performance)
- PG integrity checking works out of the box — `DISABLE_INTEGRITY_CHECK` removed from test recipes

### Performance
- PG +8.7% avg throughput vs MongoDB+InfluxDB (12/18 benchmarks faster)
- Batch INSERT for series writes: single-row INSERT → multi-row VALUES (batch10: 2x faster than InfluxDB)
- Composite index on `event_streams(user_id, stream_id, event_id)` for stream-parent queries
- 5 new PG indexes: events (trashed, modified, head_id, end_time), streams (trashed)

### Reliability
- Serialized `DatabasePG.ensureConnect()` with promise guard — fixes `pg_type_typname_nsp_index` race condition when multiple callers initialize concurrently
- Schema DDL runs exactly once via `_initSchemaOnce()` with `_schemaReady` flag
- `connected` flag set only after schema is ready (prevents queries against missing tables)
- Dedicated audit connection pool (default 5 connections) — no longer contends with main pool (default 20)

### Engine tests
- 49 PG engine tests: schema conformance, series CRUD, PlatformDB, audit conformance
- lib-js integration tests pass in PG mode (169 passing)

### Config
- `storages.engines.postgresql.auditPoolSize` — configurable audit pool size (default 5)
- `justfile`: removed `DISABLE_INTEGRITY_CHECK=1` from `test-pg` and `test-pg-parallel` recipes

## Performance tracking

### Benchmark tool (`tools/performance/`)
- Reusable performance test suite — measures throughput, latency, resource usage
- 7 scenarios: events-create, events-get (no-filter/stream-parent/time-range × master/restricted auth), streams-create (flat+nested), streams-update, series-write (batch 10/100/1000), series-read (1K/10K points), mixed-workload
- Two seed profiles based on real accounts: "manual" (perki.pryv.me, 100 streams) and "iot" (demo.datasafe.dev, 50 streams)
- Resource monitoring: tracks master + worker PIDs, aggregated RSS/CPU in results
- Concurrency sweep mode: `--sweep 1,5,10,25,50` produces comparison tables
- Results stored as JSON + markdown with system info, server config, latency percentiles (p50/p95/p99)
- Helper scripts: `perf-clean`, `perf-seed`, `perf-run`, `perf-full`
- Comparison tool: `bin/compare.js` for side-by-side result analysis

## Registration service merged into core (from service-register)

### Config & storage
- Unified config at `config/` (merged from per-component configs)
- Storage config restructured: `storages.{base,platform,series,file,audit}.engine` + `storages.engines.<name>`
- PlatformDB `setUserUniqueFieldIfNotExists()` atomic method (all 4 backends)
- rqlite engine (`storages/engines/rqlite/`) for distributed PlatformDB
- PlatformDB invitation token methods (SQLite + rqlite): create, get, getAll, update, delete

### Registration
- Registration pipeline simplified: `validateOnPlatform → createUser → buildResponse`
- `Platform.js`: removed service-register HTTP client, added `validateRegistration()` with invitation tokens, reserved words, atomic unique field reservation
- Invitation tokens now stored in PlatformDB; config `invitationTokens` seeds on first boot; tokens consumed on registration
- Deleted `service_register.js`, `reserved-words.json` (124K words) copied to platform component
- `repository.js`: renamed `updateUserAndForward` → `updateUser`, removed `skipFowardToRegister` parameter
- Removed `testsSkipForwardToRegister` config key, `isDnsLess` conditionals from registration logic
- Register routes always loaded (no `isDnsLess` guard)

### Multi-core
- Core identity model: `core.id` → FQDN, self-registration in PlatformDB
- rqlite process management in master.js (spawn, readyz wait, graceful shutdown, `-http-adv-addr`)
- PlatformDB user-to-core mapping, core registration, load-balanced core selection
- DNS discovery for rqlite cluster peers via `lsc.{domain}`

### DNS server
- `components/dns-server/` — dns2-based DNS server for `{username}.{domain}` resolution
- Supports A, AAAA, CNAME, MX, NS, SOA, TXT, CAA record types
- Master.js integration: start/stop, IPC handler for worker-driven record updates
- `POST /reg/records` admin endpoint for runtime DNS entry updates

### Legacy routes
- `routes/reg/legacy.js` — backward-compatible service-register endpoints
- Email→username lookup, server discovery (redirect + JSON), admin servers, admin invitations

### Tests
- 17 multi-core acceptance tests (`reg-multicore-seq.test.js`)
- 9 two-core integration tests (`reg-2core-seq.test.js`) — real rqlite + 2 child processes + DNS
- 19 DNS server unit tests (`dns-server.test.js`) — `dns.promises.Resolver` + raw dgram
- 16 gap feature tests (`reg-gap-features-seq.test.js`)
- 16 legacy route + invitation tests (`reg-legacy-seq.test.js`)
- `core-process.js` — child process boot script for integration tests
- Removed all nock mocking for service-register

## Replace GraphicsMagick with sharp

- Replaced `gm` (GraphicsMagick wrapper, requires system binary) with `sharp` (npm-native, bundles libvips)
- Removed `apt-get install graphicsmagick` from Dockerfile — no system image dependencies for previews
- Removed GM availability check from `master.js` — previews worker always starts when enabled
- Removed `bluebird` usage from event-previews.js (sharp is Promise-native)

## Integrate lib-js tests

- Added `components/externals/` — runs lib-js test suite (169 tests) via `just test externals`
- HTTPS proxy (backloop.dev) routes API (:3001) and HFS (:4000) through single endpoint (:3000)
- `public-url.js`: preserve `service.assets` and `service.features` from config in dnsLess mode
- Added `libjs-test-config.yml` for dnsLess + HTTPS + pryv.me assets configuration
- Excluded `external-ressources/` from eslint and source-licenser
- New lib-js tests: Streams CRUD, Accesses CRUD, Account/Password (contributed back to lib-js)

## Consolidated master process (single Docker image)

### Quick wins (inlined RPC & webhooks)
- Inlined metadata updater into HFS server — removed TChannel RPC, `metadata` and `tprpc` components, `tchannel`/`protobufjs` dependencies
- Moved webhooks service in-process within API server — removed separate webhooks container and `build/webhooks/` (Dockerfile + runit)

### Cluster master with API + HFS workers
- Created `bin/master.js` — single master process using Node.js cluster module
- TCP pub/sub broker runs in master; workers connect as clients
- N API workers share port :3000 via cluster (config: `cluster:apiWorkers`, default 2)
- M HFS workers share port :4000 via cluster (config: `cluster:hfsWorkers`, default 1, 0 = disabled)
- Workers auto-restart on crash; graceful shutdown on SIGTERM/SIGINT
- Worker log differentiation via `PRYV_BOILER_SUFFIX` (`-wN`, `-hfsN`)

### Previews worker
- Master forks 0 or 1 previews worker on port :3001 (config: `cluster:previewsWorker`, default true)
- GraphicsMagick availability check at startup — gracefully skips if GM not installed

### Single Dockerfile
- Replaced 3 per-component Docker images (core, hfs, preview) with a single image
- Entry point: `node bin/master.js` — replaces runit-based orchestration
- DB migrations run in master before forking workers (config: `cluster:runMigrations`, default true)
- Removed: `build/core/`, `build/hfs/`, `build/preview/` (Dockerfiles + runit scripts), `Dockerfile.component-intermediate`, `Dockerfile.common-intermediate`
- GraphicsMagick installed in unified image for previews support

### Socket.IO cluster compatibility
- Socket.IO uses WebSocket-only transport in cluster mode (no HTTP long-polling)
- Avoids need for sticky sessions — WebSocket connections are long-lived and stay on one worker
- Single-process mode (tests, dev) retains long-polling fallback

## Removed: `openSource:isActive` flag

- Removed `openSource:isActive` config flag and all gated code — features always enabled: webhooks, HFS/series events, distributed cache sync, email check route
- Removed `isOpenSource` fields and constructor logic from Application, Server, Manager, NamespaceContext classes
- Removed `openSourceSettings` config reads and conditional series creation/integrity/notification logic in events.js
- Changed `isSynchroActive` from `!config.get('openSource:isActive')` to `true` in cache
- Removed early-return gate on HFS deletion in business/auth/deletion.js
- Removed `openSource:` config sections from 5 config files (default, development, test, hfs-server, build/test)
- Removed all test skips and conditional logic based on `openSource` (12 test files)
- Deleted dead code: `www`/`register` package requires in application.js that would crash if ever reached
- Cleaned up unused imports across all modified files

## System streams refactor

### Account store architecture
- Extended `UserAccountStorage` with account field CRUD methods (`getAccountFields`, `setAccountField`, `deleteAccountField`, `getAccountFieldHistory`)
- Created `accountStore` adapter implementing pryv-datastore interface, wrapping baseStorage account operations
- Registered `accountStore` in Mall alongside local + audit stores
- Changed `storeDataUtils.js` routing: `:_system:`/`:system:` prefixes → `account` store (was `local`)
- Removed system stream merge from Mall — handled by store routing
- Added migration 1.9.4: copies account events from local store to account-field storage

### Dead-code removal in system streams
- Removed `forbidSystemStreamsActions()` from streams.js — account store handles rejection
- Removed `filterNonePermissionsOnSystemStreams()` from utility.js — standard permissions apply
- Removed 11 dead serializer methods + 5 static properties
- Removed `ForbiddenAccountStreamsModification` error constant
- Removed pre-1.9.0 migrations (1.7.0, 1.7.1, 1.8.0) + their test files
- Removed debug `console.log('XXXXX')` traps from User.js

### Simplify permissions on system streams
- Removed redundant `isAccountStreamId` hard block from AccessLogic — `includedInStarPermissions` handles it
- Simplified `none` prepend from serializer iterator to single `STREAM_ID_ACCOUNT` constant
- Replaced permission-based account exclusion in eventsGetUtils with direct config-based exclusion

### Decouple tests from SystemStreamsSerializer
- Created `systemStreamFilters.js` in test-helpers for test-only prefix helpers
- Removed redundant `init()` calls from hfs-server tests

### Remove active/unique markers
- Removed `:_system:helpers` stream (parent of `active`/`unique` markers)
- Account events: one event per field, no sibling demotion
- Platform coordination moved to events.js middleware
- Default event queries include both local and account stores
- Account store returns `structuredClone()` to prevent readableTree mutation

### Flatten and reduce serializer
- Flattened SystemStreamsSerializer class to plain eager-init module
- Dropped lodash dependency
- Migrated all 16 production callers to direct data access
- Removed all dead getter functions and helpers
- 639 → 154 lines (76% reduction), 20+ → 13 exports

### Rename and finalize system streams module
- Extracted feature constants to `business/src/system-streams/features.js`, then inlined as plain strings
- Renamed: `SystemStreamsSerializer` → `accountStreams`, `forbiddenStreamIds` → `hiddenStreamIds`, `removePrefixFromStreamId` → `toFieldName`, `addCorrectPrefixToAccountStreamId` → `toStreamId`, `indexedFieldsWithoutPrefix` → `indexedFieldNames`, `uniqueFieldsWithoutPrefix` → `uniqueFieldNames`
- Deleted `serializer.js` — content moved to `system-streams/index.js`

## Cleanup NATS/Axon naming remnants

- Renamed all internal `nats`/`NATS` variable names, function names, comments, and config references to generic `transport`/`Transport` terms
- `NATS_MODE_ALL/KEY/NONE` → `TRANSPORT_MODE_ALL/KEY/NONE` (backward compat aliases kept)
- `initNats()` → `initTransport()`, `isNatsEnabled()` → `isTransportEnabled()`, `setTestNatsDeliverHook()` → `setTestDeliverHook()`
- Removed dead code: `NATS_CONNECTION_URI` in webhooks, `axonMessaging` export alias, `nats:uri` compat fallback
- Removed NATS references from CI, README, .gitignore, .dockerignore, .licenser.yml

## Replace NATS with built-in TCP pub/sub

- Replaced NATS server + `nats` npm package with zero-dependency TCP pub/sub broker using Node.js `net` module
- Created `tcp_pubsub.js`: embedded broker/client — first process binds port, others connect as clients
- Protocol: newline-delimited JSON over TCP with noEcho (sender exclusion via client IDs)
- Updated 6 config files: `nats:uri` → `tcpBroker:port`
- Rewrote 3 test files to use raw TCP clients instead of NATS client library
- Removed NATS from Docker build (Dockerfile, runit/gnats, start-core wait loop)
- Removed `nats-server/` binary directory and `scripts/setup-nats-server`
- Removed `nats` npm dependency
- No changes to PubSub class, constants, or any consumer code

## Remove Axon test messaging

- Replaced axon TCP pub/sub with Node.js built-in IPC for test notification forwarding
- Created `test_messaging.js` (IPC-based EventEmitter + `process.send()`), deleted `axon_messaging.js`
- Updated InstanceManager, DynamicInstanceManager, spawner.js to use IPC instead of axon TCP sockets
- Renamed `axon-*` message names to `test-*` across all test files (~20 files)
- Renamed `axonMsgs`/`axonSocket` variables to `testMsgs`/`testNotifier`
- Removed `axon` npm dependency and `axonMessaging` config sections
- No changes to production messaging (NATS) or caching

## Remove FerretDB support

- Removed FerretDB feature entirely — `ferretDB/` directory, `test-ferret` justfile recipe, `isFerret` config/property, FerretDB connection string, `ferretIndexAndOptionsAdaptationsIfNeeded()`, FerretDB duplicate error handling, FerretDB test guards
- Fixed bug in `Database.isDuplicateError()`: FerretDB branch had missing `return`, causing all errors to be reported as duplicates
- Cleaned: Database.js, localDataStore.js, accesses.js, accesses-personal.test.js, result-chunk-streaming-seq.test.js, database-seq.test.js, 4 migration test files, README-DBs.md

## Engine-agnostic series, deletion, and test fixes

### Engine-Agnostic Series Connections for Tests
- Replaced `produceInfluxConnection()` with async `produceSeriesConnection()` factory in hfs-server and api-server test helpers
- Added `getTimeDelta()` helper to normalize time values across InfluxDB (INanoDate) and PG (numeric)
- Renamed `produceMongoConnection` → `produceStorageConnection` globally across 18 test files
- Updated `store_data.test.js`, `batch.test.js`, `deletion-seq.test.js` to use engine-agnostic series queries/assertions

### PG Series Nanosecond Fix
- Fixed `pg_connection.js` `query()`: changed `delta_time * 1000` → `delta_time / 1e6` (delta_time stores nanoseconds via `InfluxDateType.coerce`, not seconds)
- Fixed field ordering: `time` placed before JSONB fields to match InfluxDB column order
- Fixed `exportDatabase()` and `importDatabase()` for consistent nanosecond↔millisecond conversion

### Engine-Agnostic HF Data Deletion
- `deletion.js` `deleteHFData()` now dispatches to PG or InfluxDB based on storage engine (was hardcoded to InfluxDB)

### Test Infrastructure Fixes
- Separated caching disable (`MOCHA_PARALLEL=1`) from integrity check disable (`DISABLE_INTEGRITY_CHECK=1`) in `helpers-base.js` and `helpers-c.js` — fixes cache tests failing under `just test-pg`
- Fixed `Webhook.test.js` user object to include `id` property — PG requires non-NULL `user_id` for SQL equality comparisons (MongoDB was tolerant of `undefined` via collection naming)

## Fix PG tests, remove FollowedSlices, engine-agnostic cleanup

### FollowedSlices Removal
- Removed FollowedSlices feature entirely (storage backends, API methods, routes, schema, tests, audit, pubsub, deletion cascade)
- Deleted: `FollowedSlices.js`, `FollowedSlicesPG.js`, `followedSlices.js` (methods), `followed-slices.js` (routes), schema files, test file
- Cleaned references from: StorageLayer, storage/index, server.js, application.js, Paths.js, constants.js, pubsub.js, ApiMethods.js, deletion.js, AccessLogic.js, databaseFixture.js, dependencies.js, dynData.js, data.js, helpers-c.js, helpers-base.js, validation.js, usersLocalIndex.js, DatabasePG schema, test list files

### Engine-Agnostic Test Helpers
- `dependencies.js` — always reconfigures via `StorageLayer` (removed `STORAGE_ENGINE` guard)
- `parallelTestHelper.js` — always uses `storage.getStorageLayer()` instead of engine switch
- `test-helpers.js` — `produceConnection()` always returns `StorageLayer`
- `profile-personal.test.js` — uses `storageLayer.profile` instead of engine switch
- Removed all `// CLAUDE:` marker comments

### HFS-Server Engine-Agnostic Fixes
- `application.js` — removed unconditional `storage.getDatabase()` call
- `context.js` — removed `mongoConn` property; constructor no longer requires database connection
- `metadata_cache.js` — `MetadataLoader.init()` no longer takes `databaseConn` param (was unused)

### Integrity Checks
- `integrity-final-check.js` — early return for non-MongoDB engines (uses raw MongoDB cursors)

## Dual storage engine — PostgreSQL backend

### Global Storage PG Backends
- `SessionsPG` — callback-based sessions with JSONB containment for `getMatching`
- `PasswordResetRequestsPG` — callback-based password reset with expiration on read
- `VersionsPG` — async versions with migration runner

### User-Scoped Storage PG Backends
- `BaseStoragePG` — base class providing full UserStorage interface with SQL query building:
  camelCase↔snake_case mapping, JSONB serialization, MongoDB-style query→SQL translation
  ($gt, $ne, $in, $or, $type, $set, $unset, $inc, $min, $max, JSONB dot-notation)
- `AccessesPG` — token generation, integrity hash, integrity-aware delete/updateOne
- `WebhooksPG` — aggressive field unsetting on soft-delete
- `ProfilePG` — JSONB data with key-value set updates
- `StreamsPG` — tree build/flatten via treeUtils, cache invalidation

### Account & Index PG Backends
- `userAccountStoragePG` — password history, key-value store (StoreKeyValueData)
- `usersLocalIndexPG` — username↔userId mapping
- `DBpostgresql` — platform unique/indexed fields

### PG DataStore for Mall (Events + Streams)
- `localDataStorePG` — DataStore factory implementing @pryv/datastore interface
- `localUserEventsPG` — full events API with junction table `event_streams` for stream queries,
  intermediate query format→SQL conversion, streaming support
- `localUserStreamsPG` — streams API with tree building, cache integration
- `LocalTransactionPG` — PG transaction wrapper

### PG Series Connection (InfluxDB Replacement)
- `pg_connection.js` — implements InfluxConnection interface using `series_data` table
- Handles writeMeasurement, writePoints, simplified InfluxQL→SQL query parsing
- Full migration support (exportDatabase, importDatabase)

### Schema Update
- Added `stream_ids JSONB` column to events table for denormalized reads

### Wiring
- `StorageLayer._initPostgreSQL` instantiates all PG backends
- All routing points wired: StorageLayer, index.js, mall, platform, hfs-server
- All PG backend TODOs resolved

## Dual storage engine — configuration & abstraction

### Unified Storage Engine Configuration
- Added `storageEngine` config key ('mongodb' | 'sqlite' | 'postgresql') to `default-config.yml`
- When set, overrides all per-component keys (`database:engine`, `storageUserAccount:engine`, etc.)
- Falls back to per-component keys when absent (full backward compatibility)
- Added `postgresql` connection config block (host, port, database, user, password, max)

### Storage Engine Helper
- New `storage/src/getStorageEngine.js` — unified engine resolution with validation
- Used by all routing points: StorageLayer, index.js, mall, platform, hfs-server

### PostgreSQL Connection Wrapper
- New `storage/src/DatabasePG.js` — connection pooling via `pg`, schema DDL for all tables
- Methods: `ensureConnect()`, `waitForConnection()`, `query()`, `getClient()`, `withTransaction()`, `initSchema()`, `close()`
- Full schema: streams, events, event_streams, accesses, webhooks, profile, sessions, password_resets, versions, passwords, store_key_values, users_index, platform tables, series_data
- Static helpers: `isDuplicateError()`, `handleDuplicateError()` (mirrors MongoDB pattern)

### Engine-Aware Routing
- `StorageLayer.js` — refactored to dispatch to `_initMongoDB`/`_initSQLite`/`_initPostgreSQL`
- `storage/src/index.js` — engine routing for `getUserAccountStorage()`, `getStorageLayer()`; exports `DatabasePG`, `getDatabasePG`, `getStorageEngine`
- `usersLocalIndex.js` — engine routing via `getStorageEngine`
- `mall/src/index.js` — datastore selection by engine
- `platform/src/getPlatformDB.js` — PlatformDB selection by engine
- `hfs-server/src/application.js` — series connection selection by engine

### Dependency
- Added `pg` (node-postgres) to root dependencies

## Parallel test migration

### Enforce interface usage
- Replaced `dropCollection()` with `removeAll()` in `business/src/auth/deletion.js` (interface compliance)

### Move verified Pattern C tests to parallel
- Renamed 3 sequential files to parallel: `webhooks`, `acceptance/accesses`, `login-parallel`
- Evaluated 5 additional candidates; confirmed they must stay sequential (`getApplication()` shared state)

### Deduplicate sequential tests
- Extracted `permissions-seq.test.js` sections AP01, AP02, YE49 → new `permissions.test.js` (Pattern C, parallel-safe)
- Removed 19 duplicate tests from `events-seq.test.js` (covered by `events-patternc.test.js`)
- Removed 18+5 duplicate tests from `streams-seq.test.js` (covered by `streams-patternc.test.js`)
- Added defensive assertions to `events-mutiple-streamIds.test.js` for parallel-mode debugging

### Result
- Parallel pool: 13 → 17 files (+4)
- Sequential: 21 → 13 files
- 58 duplicate tests removed, 0 coverage lost

## Formalize storage interfaces

### User-scoped storage interface (Group B)
- New `UserStorage` interface with `validateUserStorage()` in `storage/src/interfaces/`
- Validates all BaseStorage subclasses: Accesses, Profile, FollowedSlices, Streams, Webhooks
- Added migration methods (`exportAll`, `importAll`, `clearAll`) to `BaseStorage`
- Conformance test suite covering full CRUD + migration lifecycle
- StorageLayer validates all user-scoped storages at construction time

### Global storage interfaces (Group C)
- **Sessions**: `validateSessions()` interface, migration methods (`exportAll`, `importAll`)
- **PasswordResetRequests**: `validatePasswordResetRequests()` interface, migration methods (`exportAll`, `importAll`)
- **Versions**: `validateVersions()` interface, migration methods (`exportAll`, `importAll`)
- Conformance test suites for all three
- StorageLayer validates all global storages at construction time

### Dual-engine storage interfaces

### UserAccountStorage Interface (Group D)
- New interface prototype + `createUserAccountStorage()` factory in `storage/src/interfaces/`
- Wrapped Mongo and SQLite implementations with factory
- Added standardized migration methods: `_exportAll`, `_importAll`, `_clearAll`
- Conformance test suite; existing unit test now delegates to it

### UsersLocalIndexDB Interface (Group E)
- New interface prototype + `validateUsersLocalIndexDB()` validation in `storage/src/interfaces/`
- Added migration methods (`exportAll`, `importAll`, `clearAll`) to Mongo and SQLite classes
- Validation called after construction in `usersLocalIndex.js`

### PlatformDB Interface (Group F)
- New interface prototype + `validatePlatformDB()` validation in `platform/src/interfaces/`
- Added migration methods (`exportAll`, `importAll`, `clearAll`) to Mongo and SQLite classes
- Validation called after construction in `getPlatformDB.js`

### EventFiles Interface (Group G)
- New interface prototype + `createEventFiles()` factory + `validateEventFiles()` in `storage/src/interfaces/`
- Validation called after construction in `getEventFiles.js`

### Series / InfluxDB interface (Group I)
- New `InfluxConnection` interface with `validateInfluxConnection()` in `business/src/interfaces/`
- Added migration methods (`exportDatabase`, `importDatabase`) to `InfluxConnection`
- Conformance test suite [IC01]-[IC09] covering full lifecycle
- Exported via `business.series.interfaces.InfluxConnection`

### Audit / UserSQLite interfaces (Group J)
- New `UserSQLiteStorage` interface with `validateUserSQLiteStorage()` in `storage/src/interfaces/`
- New `UserSQLiteDatabase` interface with `validateUserSQLiteDatabase()` in `storage/src/interfaces/`
- Added migration methods (`exportAllEvents`, `importAllEvents`) to `UserDatabase`
- Conformance test suite [SQ01]-[SQ16] covering Storage manager + Database contract
- Exported via `storage.interfaces.UserSQLiteStorage` and `storage.interfaces.UserSQLiteDatabase`

### Exports & Migration Scripts
- `storage/src/index.js` exports all interfaces under `interfaces` key
- Migration scripts (`switchSqliteMongo/`) simplified using standardized `exportAll`/`importAll`/`clearAll`

## Removed deprecated features from v1

### Trivial cleanup
- Removed commented debug code in `components/audit/src/Audit.js`
- Removed unused `factory.periodsOverlap` error and `ErrorIds.PeriodsOverlap`

### Stream ID prefix backward compatibility
- Removed `backwardCompatibility.systemStreams.prefix` config from all config files
- Removed `isStreamIdPrefixBackwardCompatibilityActive` variable and all guarded code in `events.js`, `streams.js`, `accesses.js`, `eventsGetUtils.js`
- Removed prefix conversion functions from `backwardCompatibility.js`
- Deleted `ChangeStreamIdPrefixStream.js`
- Removed `disableBackwardCompatibility` property and `disable-backward-compatibility-prefix` header from `MethodContext.js`
- Removed `PATTERN_C_BACKWARD_COMPAT` env var handling from test helpers
- Removed backward compatibility collision check in system streams config
- Removed prefix-related tests (BW08-BW16, SD02)

### Remove deprecated `/register/create-user` endpoint
- Removed deprecated `POST /register/create-user` route from `system.js`
- Removed backward-compatibility test `[ZG1L]`
- `passwordHash` parameter kept (still used by standard `POST /system/create-user`)

### Remove `streamId` (singular) backward compatibility
- Removed `streamId` property from event JSON schema (`event.js`)
- Changed schema validation from `anyOf` (streamId or streamIds) to `required: ['type', 'streamIds']`
- Simplified `normalizeStreamIdAndStreamIds` in `events.js` — removed `BOTH_STREAMID_STREAMIDS_ERROR` and all `event.streamId = event.streamIds[0]` assignments
- Deleted `SetSingleStreamIdStream.js` (no longer needed to add `streamId` to output)
- Removed `SetSingleStreamIdStream` pipe from `eventsGetUtils.js`
- Removed `event.streamId` assignment from `SetFileReadTokenStream.js`
- Updated tests across api-server and webhooks components

### Remove tags backward compatibility
- Deleted `backwardCompatibility.js`, `AddTagsStream.js`
- Removed `backwardCompatibility.tags` from all config files
- Removed all tag conversion logic from `events.js` (replaceTagsWithStreamIds, putOldTags, createStreamsForTagsIfNeeded, cleanupEventTags, migrateTagsToStreamQueries)
- Removed tag permission methods from `AccessLogic.js`
- Simplified permission checks: removed WithTags variants, callers use stream-only methods
- Removed `tags` from event schema and events.get query params
- Removed tag migration code from `1.7.0.js`
- Fixed `previews-server/event-previews.js` to use `canGetEventsOnStream` instead of removed `canGetEventsOnStreamAndWithTags`
- Deleted tag backward compatibility tests, updated all test files
- Removed `permissions-tags.test.js` from test lists

### Final cleanup
- Removed deprecated `/service/infos` route duplicate
- Cleaned stale deprecated JSDoc from Event typedef (removed streamId, tags)
- Fixed typo: `newSreamIds` → `newStreamIds` in events.js
- Fixed double `await` in repository.js
- Updated stale TODO comments about system.createUser
