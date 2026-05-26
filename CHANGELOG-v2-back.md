# Changelog - Internal (no API impact)

## fix(system): make `DELETE /system/users/:username` error message self-documenting

The admin endpoint refuses calls without `?onlyReg=true` because it only deletes the user's *platform-side* fields (uniqueFields like email + indexedFields) — it does NOT cascade through base storage (events, streams, attachments) or the audit log. Previous error text "This method needs onlyReg=true for now (query)" said nothing about *why* — operators ran into it, assumed the endpoint was broken, then either gave up (orphan test users on shared hosts) or filed bug reports. New error text spells out the partial-delete semantic + points at `?dryRun=true` for preview. Closes B-2026-05-14-5 (workspace BUGS.md). Endpoint behaviour unchanged. Existing `[GF30]`–`[GF33]` tests still green (6/0 in `npx mocha --grep GF3`).

## fix(storages): drop `platformStorage` from postgresql/mongodb manifests + fail fast on engine/storageType misdeclaration

Plan 25 made rqlite the only platform engine in production: `default-config.yml` ships `storages.platform.engine: rqlite`, and the PG / Mongo `PlatformDB` implementations are intentionally incomplete (missing the Plan-27 DNS-records methods, the Plan-55 access-state methods, the Plan-35 LE TLS-cert + ACME-account methods, the Plan-38 observability-secrets methods — see workspace BUGS B-2026-05-21-1). Their manifests nevertheless declared `"platformStorage"`, which made `pluginLoader.getEngineFor('platformStorage')` happily return `postgresql` when a test config quirk set it that way — only to fail much later via the `validatePlatformDB` interface validator with a cryptic `PlatformDB implementation missing method: <X>` and no hint that the root cause was the engine selection.

Two-part fix:

- **Manifests** — `storages/engines/postgresql/manifest.json` and `storages/engines/mongodb/manifest.json` no longer declare `"platformStorage"`. Their `createPlatformDB` exports remain (legacy, unused) but the manifest now matches the Plan-25 reality.
- **Loader fail-fast** — `storages/pluginLoader.ts` `resolveConfig` now throws when a configured engine doesn't declare the requested storageType, e.g.:

  ```
  Configured engine "postgresql" for storages.platform.engine but engine
  manifest does not declare storageType "platformStorage". Engines
  declaring "platformStorage": rqlite
  ```

  This surfaces a misconfigured engine selection at init time with a clear message, instead of letting it fall through to the interface validator's missing-method error.

`tools/coverage/pg-early-init.js` had `platform: { engine: 'postgresql' }` left over from before Plan 25 / before the PlatformDB scope grew — corrected to `rqlite`.

New test `[PLUG-RESOLVE-MISDECLARE]` in `storages/test/pluginLoader.test.js` (48 passing). Component smoke tests `just test business` (374/0), `just test mall` (22/0), `just test storages` (48/0) all green.

## fix(justfile): `clean-test-data` falls back to system `dropdb`/`createdb`/`mongosh` when local `var-pryv/<engine>-bin/` is absent

The `clean-test-data` + `clean-test-data-parallel` recipes hardcoded `./var-pryv/postgresql-bin/bin/dropdb` etc. — if that local install was absent (e.g. on a Darwin dev box where the operator uses Homebrew / Postgres.app instead of running `storages/engines/postgresql/scripts/setup`), the recipes swallowed the binary-not-found failure as `... not reachable (skipping ...)` and silently left the prior run's PG/Mongo state in place. Tests then tripped on stale residue (e.g. webhook-lifecycle `[WH01]` flakes documented in workspace memory).

Both recipes now resolve `DROPDB`/`CREATEDB`/`MONGOSH` by preferring the local Plan-41 install if present, otherwise falling back to whatever is on PATH (`command -v dropdb` etc.). The skip-message path is preserved but now distinguishes "binary not found" from "server not reachable" so operators see the real cause.

Verified on Darwin: local bin present → unchanged behaviour; local bin hidden + system bin on PATH → fallback invoked correctly; both missing → clear "not found" message instead of misleading "not reachable".

## fix(cmc): auto-provision per-app appScope roots on `accesses.create` / `accesses.update`

The 5 reserved parents under `:_cmc:*` are pre-provisioned at user creation by [`components/cmc/src/provisioning.ts`](components/cmc/src/provisioning.ts). Per-app sub-trees under `:_cmc:apps:<app-code>` were historically created on-demand at CMC-acceptance time (`provisioning.ts:21-26`) — but the OAuth-grant flow used by `doctor-dashboard` (via `app-web-auth-3`) never reaches an acceptance event before the first invite, leaving the per-app *root* `:_cmc:apps:<app-code>` missing. Downstream `streams.create` for a child of the leaf then failed with `unknown-referenced-resource` ("Unknown referenced unknown Stream"). Bridge-onboarded doctors escape this because their onboarding flow uses a personal token to pre-create the stream — OAuth-onboarded ones cannot.

New `createAccessProvisionAppScopeHook` in `components/cmc/src/hooks.ts`, exported via `index.ts`, wired post-`createAccess` in `accesses.create` and post-`snapshotAndApplyUpdate` in `accesses.update` (`components/api-server/src/methods/accesses.ts`). Scans `result.access.permissions` for any `streamId` resolving via `C.getAppCode()` to a valid app-code (matches `/^[a-z0-9-]+$/`, excludes reserved `chats`/`collectors` segments), and lazy-creates the leaf `:_cmc:apps:<app-code>` as a child of `:_cmc:apps` via `mall.streams.create` — same bypass pattern as `provisionUserStreams` so the reserved-root hook doesn't reject our own provisioning. Provisioning failures are logged but don't fail the access response (the access is already stored; surfacing here would confuse the caller — if the stream truly can't be created, the user's first child `streams.create` will surface the same downstream error). Deep app sub-trees (`:_cmc:apps:<app>:chats:*` / `:_cmc:apps:<app>:<...>:collectors:*`) keep their on-demand-at-acceptance-time behaviour — this hook only provisions the leaf root.

NEW `[CMCHS-AP-PER-APP]` describe in `components/api-server/test/cmc-handshake.test.js` (4 tests, positioned after the existing `[CMCHS-AP]` block from `cad7627`):
- `[PA01]` — `accesses.create` with a `:_cmc:apps:<new-app>` perm auto-provisions the leaf (verified by re-attempting the leaf create and asserting `item-already-exists`).
- `[PA02]` — `accesses.create` referencing a pre-existing leaf perm returns 201 (idempotent on the provisioning side).
- `[PA03]` — `accesses.update` that *adds* a per-app perm provisions the new leaf. (Send bare `{level, streamId}` perms in the update body — `accesses.update` rejects the lenient `accesses.create` shape per the documented permissions-shape asymmetry.)
- `[PA04]` — `accesses.create` with a deep `:_cmc:apps:<app>:chats:*` perm also provisions the leaf, since any descendant create requires it.

`just test cmc` 396/0; `just test api-server` 1060/2 (the 2 failures are pre-existing `[WH01]` webhook lifecycle flakes from stale DB residue, documented in workspace memory, unrelated to this change).

## test(parallel): stabilize the parallel-mode test matrix on high-core dev boxes

Closes a long-running internal effort to make `just test-parallel all` (the local-dev productivity tool) survive 14-worker concurrency on a 15-core dev box. Matrix went from a broken 1654/79 baseline (with ~480 tests silently hidden) to 2248/68/3 in ~2:06 wall — and the remaining 3 failures are Pattern A cold-start flakes that don't reproduce at CI's 2-worker scale. CI continues to run the sequential PG matrix (`just clean-test-data && just test all`) as the matrix-of-record because parallel mode disables integrity checks, the caching layer, and `cluster_kv` IPC fallback semantics — three production-relevant verifications that the sequential mode exercises.

Key fixes that landed:

- `clean-test-data-parallel` auto-derives `WORKERS` from `MOCHA_JOBS` / `cpus-1` (was hardcoded `'8'`, hiding workers w8..w13 on 15-core boxes).
- Adaptive `computePgPoolMax()` in `parallelWorkerSetup.ts` + bumped `var-pryv/postgresql-data/postgresql.conf` `max_connections` 50 → 300; also bumped in fresh-install `storages/engines/postgresql/scripts/setup`.
- `DynamicInstanceManager.start()` force-pins per-worker DB names into the spawned api-server's tempfile config, defending against mid-suite boiler-config reverts.
- Per-worker `mochaHooks` coverage extended to `webhooks/`, `previews-server/`, `storages/engines/postgresql/`. New `storages/engines/rqlite/.mocharc.cjs` so engine tests don't inherit a non-applicable `test/hook.js`.
- `business/` mocharc + hook now chain `helpers.dependencies.init()` into `beforeAll` so every parallel worker initialises the StorageLayer proxies — fixes the `[WHBK] Repository.insertOne` hang.
- `[XS12]` accessState clear routed through cluster.request(0, 'clear') because parent test process doesn't init storages.
- `[ACMEINT]` `acme-integration.test.js` now uses per-worker rqlite URL (via boiler env-mirror) — eliminates the worker-0 leader-election 503 race.
- `setupParallelWorker` pre-inits the per-worker rqlite `keyValue` table (closes `[PCRO]`/`[RGLG]` "no such table" race).
- Integrity-check `beforeEach`/`afterEach` (sequential mode) now gated on `storages.storageLayer` being initialised — closes the historical Darwin Mongo `[EVNT]` crash where `ensureBarrel()` early-init locked pluginLoader to the wrong engine before `injectTestConfig` could apply the override.
- Cross-component HttpServer port collision on 6123 between `api-server/test/support/httpServer.js` and `business/test/acceptance/webhooks/support/httpServer.js` resolved by per-worker port shift (`6123 + MOCHA_WORKER_ID*10`) + a proper `await listen()` Promise wrapping `'listening'`/`'error'`.

Remaining flakes (3 tests in api-server: `[ACCO]`×2, `[SYRO]`) + 4 deferred follow-ups (hfs-server SpawnContext migration, port-collision proper fix shifting `RQLITE_HTTP_BASE` 4001→4011, harness cleanup, two non-api-server `-seq` files) tracked outside this repo for a future pass. A new `test-parallel-all.sh` wrapper (in the orchestration workspace) runs pre-checks (stops host rqlited, ensures PG + InfluxDB up) then `clean-test-data-parallel + test-parallel all`.

## fix(api-server/accesses): skip auto-create for `:_cmc:*` permissions

Implementation detail for the user-visible behaviour documented in `CHANGELOG-v2.md`. `accesses.ts::createDataStructureFromPermissions::ensureStream` now early-returns when `permission.streamId.startsWith(':_cmc:')` — the local-store streamId-validity regex (`^[a-z0-9-]{1,100}`) was rejecting valid CMC-plugin stream-ids like `:_cmc:inbox` and `:_cmc:apps:<app>`. The skip is intentionally narrow: the existing `:_system:` / `:system:` path is untouched (parses to `account` store, not `local`), and any non-CMC local streamId with forbidden characters is still rejected with the same `invalid-request-structure` error.

Also fixes the `chartacter` → `character` typo at the three sites that share the error wording (`accesses.ts`, `helpers/commonFunctions.ts`, `helpers/streamsQueryUtils.ts`).

NEW `[CMCHS-AP]` describe in `components/api-server/test/cmc-handshake.test.js` (3 tests):
- `[AP01]` — `accesses.create` with `:_cmc:apps:<app>` + `:_cmc:inbox` perms returns 201 + preserves perms.
- `[AP02]` — full doctor-dashboard / app-web-auth-3 shape (local app stream + two `:_cmc:*` perms in one call).
- `[AP03]` — regression-pin: truly invalid local streamIds still get rejected with `invalid-request-structure` + the fixed `forbidden character(s)` message.

Positioned LAST in the file for the same ordering reason CN14 is — extra alice-side `:_cmc:*` accesses confuse the `(username, host, appCode)`-keyed back-channel matcher used by CMCHS-IDEMP / CMCHS-EXT / CMCHS-SU.

Matrix at close: `just test api-server` (PG) 1058/0/7.

## build(influxdb): self-contained engine setup, drop apt-based install

`storages/engines/influxdb/scripts/setup` rewritten to mirror the PG / rqlite pattern — self-contained, no system packages, no sudo. Pins InfluxDB 1.8.10 (matches the `influx` 1.x npm client; 2.x is API-incompatible per `influx_connection.ts`). OS/arch detection covers Linux amd64 + Darwin amd64 (via Rosetta on Apple-Silicon since upstream has no darwin-arm64 1.x release). Binary in `bin-ext/influxdb/`, data + logs + config in `var-pryv/`, idempotent, generates `influxdb.conf` with paths pinned. Rosetta-presence check on Apple Silicon catches `Bad CPU type in executable` with a clear install instruction. New companion `storages/engines/influxdb/scripts/start` (mirrors rqlite start: pidfile, background-default, foreground via `DEVELOPMENT=true`). Unblocks fresh-clone dev setup on macOS arm64 + on any non-Debian Linux.

## fix(storage/pg): parse InfluxQL time literals as UTC in series query

`storages/engines/postgresql/src/pg_connection.ts::parseInfluxSelect` appends `'Z'` to the captured time literal before `new Date()`, so JS interprets it as UTC (matching InfluxDB's own semantics and `series.ts:timestampToDateString`'s intent).

Latent bug: `series.ts:timestampToDateString` emits InfluxQL literals like `'1970-01-01 00:00:01.000000000'` (no TZ marker — InfluxDB treats these as UTC). JS `new Date()` without TZ parses as LOCAL time. On a non-UTC dev machine (e.g. CEST/UTC+2) the literal became `-3,599,000 ms` instead of `1000 ms`; the resulting nanos range matched zero rows in PG `series_data`, so any HFS read with a deltaTime offset returned `[]`. Linux CI + Dokku production are UTC, so users were unaffected.

Verified: `just test hfs-server` 60/0 (was 59/1, `[SDHF] [KC15]` now passing); full PG matrix `just test all` 2312/0/8.

## fix(cmc): handleAccept reads `content.features` (was `content.extra`) — features-negotiation contract drift

One-line fix in `components/cmc/src/handleAccept.ts:94` paired with the `@pryv/cmc@1.1.1` lib-js patch. The user-visible behaviour change (data-grant access now carries non-null `clientData.cmc.features` reflecting the negotiated offer features) is documented in `CHANGELOG-v2.md`. This entry covers the unit-test additions that pin the fix:

- **NEW** `[HA01F]` — `handleAccept` reads features from `triggerEvent.content.features` and stamps them on the data-grant; `content.extra` decoy is ignored.
- **NEW** `[HA01G]` — when `content.features` is absent the data-grant's `clientData.cmc.features` stays `null` even if `content.extra` is set (compat with legacy SDK callers).

## feat(cmc): Phase 4 security hardening + Phase 1.1/2.1/2.2/3.1/3.2 fixes (Plan 68 Phase 2)

Wire-up + tests for the API-facing changes documented in `CHANGELOG-v2.md` (CMC security hardening). Adds:

- `components/cmc/src/hooks.ts`: four new middleware factories — `createAccessCreateForgePreventionHook`, `createAccessUpdateForgePreventionHook`, `createStreamDeleteReservedRootHook`, `createCounterpartyFromStampingHook`, `createEventsGetInternalGuardHook`, `createEventGetOneInternalGuardHook`, `createStreamsGetInternalGuardHook`. All follow the pure-factory pattern (no api-server deps, unit-testable with fake deps).
- `components/cmc/src/constants.ts`: new `isCmcInternalStreamId(streamId)` predicate.
- `components/cmc/src/errorIds.ts`: new `CLIENTDATA_CMC_FORBIDDEN` (cmc-clientdata-cmc-forbidden) + reused `CHAT_NO_REMOTE_APIENDPOINT` semantics.
- `components/api-server/src/methods/accesses.ts`: wires forge-prevention hook into accesses.create + accesses.update.
- `components/api-server/src/methods/events.ts`: wires from-stamping + events.get/getOne internal guards.
- `components/api-server/src/methods/streams.ts`: wires streams.delete reserved-root + streams.get internal guard.

Earlier Phase 2 phases (1.1, 2.1, 2.2, 3.1, 3.2) shipped on the same `feat/cmc-phase-2-hds-readiness` branch:

- **Phase 1.1** (inviteEventId stamping) — `handleIncomingAccept` looks up the capability access once, stamps `inviteEventId` on the inbox mirror from `capabilityAccess.clientData.cmc.requestEventId`. Closes `cmc.revokeRelationship({inviteEventId})` doctor-side convenience path. lib-js: `[CMCL1RC]` + `[CMCL1RD]` cover the post-stamping lookup contract.
- **Phase 2.1** (TTL configurable per-invite) — `capabilityMintHook` reads `event.content.request.expiresAt`, bounds-checks to `[60s, 30d]`, rejects out-of-range with `cmc-capability-ttl-out-of-range`. Default unchanged (7d when `expiresAt` omitted).
- **Phase 2.2** (features gating) — `handleChat` / `handleSystem` consult `clientData.cmc.features.{chat, systemMessaging}` on the counterparty access at send time. Reject with `cmc-chat-disabled` / `cmc-system-messaging-disabled` when explicitly `false` (default-permit on omission).
- **Phase 3.1** (scope-update suppression) — verified `accessesUpdateHook` runs `accesses.update` inside `runWithSuppression` so the post-hook doesn't double-fire the peer notification.
- **Phase 3.2** (`requestEventId` real-flow) — new `createCapabilityPostCreateHook` middleware runs AFTER `createEvent` assigns the trigger's real id, calls `capability.setRequestEventIdOnAccess(...)` to stamp it on the capability access's `clientData.cmc.requestEventId`. Pre-fix the mint hook fired pre-persist when `event.id === null` so `requestEventId` was always null in production (HDS-reported).

Test deltas (Plan 68 Phase 2 cumulative):

| Layer | Pre-Phase-2 | Post-Phase-2 | Delta |
|---|---|---|---|
| open-pryv.io cmc | 340 | 394 | +54 |
| open-pryv.io api-server | 1050 | 1055 | +5 (CN12/13/15/16/17) |
| lib-js pryv-cmc | 44 | 55 | +11 |

Plus 4 new deployed-infra validation scripts in `_plans/68-cmc-datastore-atwork/tests/` (04-extended-messaging, 05-scope-update, 07-recapture, 08-sdk-handshake) — release-blocking gates before npm publish per Plan 68 Phase 6.

## docs: storage-isolation keys for parallel tests

New `docs/storage-isolation-for-parallel-tests.md` enumerates every config key that a parallel-test fixture must override per mocha worker to avoid cross-worker collisions on shared PG databases, SQLite paths, ports, and rqlite endpoints. Audit confirmed every relevant key is reachable via `config.set()` and respected by its consumer — no code change needed; the doc is the canonical input for the per-worker test-helper that Plan 61 will ship.

Hardcoded fallbacks in `bin/master.js` (rqlite URL `http://localhost:4001`, raftPort `4002`, dataDir `var-pryv/rqlite-data`) and `components/api-server/src/server.ts` (`http:hfsPort` default `4000`) and `components/messages/src/tcp_pubsub.ts` (`tcpBroker:port` default `4222`) are intentional for single-core production deploys; the per-worker fixture overrides them explicitly before `ready()` resolves. The doc pins the convention: code touching these keys must read through `config.get()` without an in-code literal fallback that would mask a missing config — let REQUIRED_WHEN catch it at boot.

## feat(config): lazy-getter sweep across factories + helpers (plan 70 §2C)

Replace `const x = config.get('slice')` factory captures with lazy getters across `components/api-server/src/methods/*.ts` + the helpers that consumed captured slices (`commonFunctions.getTrustedAppCheck`, `commonFunctions.catchForbiddenUpdate`, `eventsGetUtils.findEventsFromStore`). After this commit, `config.set()` / `injectTestConfig()` / a future async config source reach every per-request callsite without a restart, and the PR-71-class bug shape (factory slice frozen at module init, missing a value populated later by override / plugin / extraConfig) is structurally impossible.

- **CHANGE** `methods/account.ts`: replace `authSettings`/`servicesSettings` captures with `getAuth`/`getEmail` getters. Drop the PR-71 request-time fallback (`auth.passwordResetPageURL` re-read + warn) — the §2A REQUIRED_WHEN check now guarantees the key is populated at boot. The `RESET_LINK` Pug substitution stays because it's a real ergonomics improvement.
- **CHANGE** `methods/auth/login.ts`: `getAuth` getter alongside the pre-existing `getMfaConfig`.
- **CHANGE** `methods/auth/register.ts`: pass a getter function to `new Registration()`.
- **CHANGE** `methods/events.ts`: `getAuth` + `getUpdates` getters. The `filesReadTokenSecret` HMAC seed and `updates.ignoreProtectedFields` validator gate are the highest-severity audit rows — every attachment file-read token and every `events.update` validator depends on them.
- **CHANGE** `methods/streams.ts`, `methods/system.ts`, `methods/webhooks.ts`: lazy getters for `updates`, `services`, `webhooks` respectively.
- **CHANGE** `methods/helpers/commonFunctions.ts::getTrustedAppCheck`: signature changes from `(authSettings)` to `(getAuthSettings)`. The closure-cached `trustedApps` list is dropped — re-parsed per-request from the fresh slice. Negligible cost; strictly more correct.
- **CHANGE** `methods/helpers/commonFunctions.ts::catchForbiddenUpdate`: second arg `ignoreProtectedFieldUpdates` → `ignoreOrGetter` (back-compat: accepts literal OR function via `typeof === 'function'` branch).
- **CHANGE** `methods/helpers/eventsGetUtils.ts::findEventsFromStore`: first arg `filesReadTokenSecret` → `secretOrGetter` (same back-compat shape).
- **CHANGE** `business/src/auth/registration.ts`: constructor stores `getServicesSettings` (function); accepts literal OR getter. Welcome-mail send path reads `this.getServicesSettings()?.email` per-call.

## feat(boiler): config.ready() accessor + factory sweep (plan 70 §2B)

New `ready()` export on `@pryv/boiler` — the stronger-contract sibling of `getConfig()`. Documents the "config is ready to trust" contract at the call site: by the time it resolves, sync + async init has completed AND any registered boot-time validators (today: the `config-validation` plugin's REQUIRED_WHEN + REPLACE-sentinel walk, which `process.exit(1)`s on problems) have run. Future Wave 2 work (PlatformDB-backed config, remote-file refresh) will extend the gate without touching every consumer.

- **NEW** `ready()` in `components/boiler/src/index.ts`. On the current codebase semantically equivalent to `getConfig()` — the value-add is the documented contract + the hook point for Wave 2.
- **CHANGE** 14 factory call sites under `components/api-server/src/methods/*.ts` (account, mfa, service, system, utility, auth/delete, auth/register, helpers/setCommonMeta, events, streams, trackingFunctions, webhooks, auth/login, helpers/updateAccessUsageStats) now use `await ready()` instead of `await getConfig()`. `getConfig()`, `getConfigSync()`, `getConfigUnsafe()` remain exported and unchanged for non-factory consumers.
- **NEW** `components/api-server/test/boiler-ready-seq.test.js` — `[CONFIG-RDY]` describe block. Six unit tests pin the exported shape, the identity with `getConfig()` / `getConfigSync()`, the resolved test-config values, idempotency, and the key contract that Plan 70 §2C + Plan 61 both depend on: **`config.set()` after `ready()` resolves is visible to the next `.get()` call**.

## feat(config): boot-time REQUIRED_WHEN validation

`config/plugins/config-validation.js` now refuses to boot when a feature-gated config key is missing or unset. Previously, a missing key silently degraded a downstream consumer at request time — the trigger for this work was PR #71, where `auth.passwordResetPageURL` could be absent at runtime when a deployment had the password-reset email feature enabled. The Pug template then rendered a broken href that some mail clients silently dropped.

- **NEW** `REQUIRED_WHEN` table in [config/plugins/config-validation.js](config/plugins/config-validation.js). Each entry pairs a colon-separated config path with a `when(config)` gating predicate. When the predicate is truthy, the key must resolve to a non-empty, non-sentinel value (`REPLACE …`, `${VAR}` env placeholders, `null`/`undefined`, empty string all fail) — otherwise the existing `process.exit(1)` path fires after logging every problem in one pass.
- **Initial seed**: `auth:passwordResetPageURL` (when reset-password email is enabled — mirrors the runtime gating in `methods/account.ts:174` against `services.email.enabled`), `auth:adminAccessKey` (always), `auth:filesReadTokenSecret` (always; the multi-core bootstrap bundle already enforces this — single-core deploys had no equivalent guard), `letsEncrypt:atRestKey` + `letsEncrypt:email` (when `letsEncrypt:enabled === true`).
- **NEW** exports: `validate`, `checkRequiredWhen`, `isMissingOrSentinel`, `REQUIRED_WHEN`. Lets the new `[CV-REQ]` unit-test suite exercise the validator with a fake config object without booting the boiler init lifecycle.
- **NEW** `components/api-server/test/config-validation-required-when-seq.test.js` — `[CV-REQ]` describe block. Twelve unit tests cover the predicate matrix (enabled-missing / enabled-present / disabled), the `isMissingOrSentinel` classifier, and the shape of `REQUIRED_WHEN`. `-seq` because the api-server mocha hooks run a Platform DB integrity check around tests; the validator tests themselves do not touch storage.
- **CHANGE** `config/test-config.yml` adds `auth.passwordResetPageURL: http://test.pryv.local/reset-password` so tests that override `services.email.enabled = true` (e.g. `[G1VN]`, `[HZCU]` in `account-seq.test.js`) pass the new REQUIRED_WHEN check. The URL itself is not used by the test (the SMTP transport is mocked) but the key must be present to satisfy the boot validator.

Side-note on the `services.email.enabled` config shape: today it's an object (`{ welcome: true, resetPassword: true }`), inconsistent with the rest of v2's flat boolean feature-gate convention. The REQUIRED_WHEN predicate for `auth:passwordResetPageURL` mirrors the existing runtime gating in `methods/account.ts:174` to stay consistent during this change. Flattening the schema is a focused follow-up — see `_plans/XXX-Backlog/SERVICES-EMAIL-FLATTEN.md` in the macroPryv workspace.

## docs(cmc): fix wrong Monitor API in IMPLEMENTERS-GUIDE + README

The CMC docs (since Plan 68 first published IMPLEMENTERS-GUIDE.md in
commit `02b6d94`) used a `monitor.subscribe(streamId, callback)` API
that doesn't exist on `@pryv/monitor`. The actual Monitor API is:

```js
const monitor = new pryv.Monitor(connection, { streams: [...] });
monitor.on('event', (event) => { ... });
await monitor.start();
```

Key semantic differences callers must understand (and the prior docs
hid):

- **Scope is fixed at construction.** You can't add/remove streams
  after `start()` — to watch a different scope, construct another
  Monitor (each shares the underlying socket.io connection via the
  `@pryv/socket.io` add-on).
- **One `'event'` callback per Monitor.** Branch on `event.type` /
  `event.streamIds[0]` inside the callback.

This commit sweeps all 14 occurrences in IMPLEMENTERS-GUIDE.md + 1
in README.md and replaces them with the correct pattern. The
"bridge multi-tenant subscription" section gets a more accurate
representation: one Monitor with a broad scope routes by streamId,
OR two Monitors share the same underlying socket — either way it's
one WebSocket per bridge backend. Pure docs; zero behavior change;
zero code change in CMC itself.

## docs(cmc): bridge multi-tenant subscription = standard one-socket pattern

HANDOVER Q6 asked whether bridges managing thousands of patients
need a new multi-tenant socket.io push channel ("inboxArrived") to
avoid opening N WebSocket connections. After working through it: the
concern is a misread of CMC's data direction. CMC traffic from a
counterparty lands on YOUR streams, not on theirs:

- Patient sends chat-cmc → arrives on bridge's `:_cmc:apps:bridge-app:chats:<patient-slug>`.
- Patient sends notification/ack → arrives on bridge's collectors stream.
- Patient writes revoke / accept → arrives on bridge's `:_cmc:inbox`.

So the bridge opens ONE socket.io connection on its OWN token, with
the SAME standard `monitor.subscribe(':_cmc:inbox', ...)` pattern
already documented, and receives push for every event from every
patient over that single connection. The counterparty slug in the
streamId identifies the patient. No new socket.io channel needed,
no new auth model.

The only N-connection concern is reading patient DATA streams (e.g.
real-time vitals push per data-grant) — that's a Pryv API surface
question outside CMC's scope.

Added a "Bridge / multi-tenant subscription" section to
IMPLEMENTERS-GUIDE.md's Socket.io reference making this explicit.
Zero code change. Closes HANDOVER Q6.

## docs(cmc): "no new HTTP route namespace" pinned as a design pillar

HANDOVER Q5 asked whether the doctor's "did patient X click my
invite yet?" UX needs a dedicated `GET /cmc/capability/<id>/status`
endpoint. The answer is no — after the Q1 Phase 1 lifecycle the
same data lives on the capability access (`clientData.cmc.capability.state`),
reachable via the existing `accesses.get`. Documented two query
paths in IMPLEMENTERS-GUIDE.md ("dashboard render" via
`accesses.get` + "real-time" via socket.io monitor on `:_cmc:inbox`).

Pinned the "**no `/cmc/*` route namespace**" rule as a fourth design
pillar in `components/cmc/README.md` (alongside "plugin, not storage
engine" + "zero new storage primitives"). Keeps the plugin a true
plugin — no API-surface ownership. Future CMC needs go via clientData
filters, trigger-event queries, or socket.io patterns, never via a
dedicated `/cmc/*` route.

## CMC dispatch — structural loop avoidance via `event.createdBy`

The chat / system / scope-update / revoke handlers POST outbound to
the peer via the counterparty access. Without a structural guard, a
peer-delivered event would re-trigger dispatch on the receiving side
and POST right back — the classic A→B→A→B ping-pong. Previously the
rate-limiter (`rateLimit.ts`, 100/60s per `(source, recipient)`) was
the only thing cutting the loop, at the cost of a defensive ceiling
that doubles as both abuse defence and runaway-control.

This change splits the concerns:

- **`components/cmc/src/dispatch.ts`** — new `OUTBOUND_LOOPABLE_TYPES`
  set + `isPeerDeliveredEvent` helper. Before invoking a handler for
  one of those types, the dispatch resolves `event.createdBy` to its
  access on this mall; if the access has
  `clientData.cmc.role === 'counterparty'` the event arrived from a
  peer's POST → return `{ status: 'skipped', reason: 'cmc-incoming-from-peer' }`,
  no outbound. The rate-limiter remains as defence-in-depth for
  abuse / quota.
- Lifecycle handlers (accept / refuse / back-channel / request) are
  exempt — their dispatch is direction-aware via `isOnInbox`, and
  the incoming variants do real protocol work.
- IMPLEMENTERS-GUIDE.md gains a "Reference — Loop avoidance" section
  documenting the two-layer defence.
- `[CMCDISP-LOOP]` test block — 9 new tests: 6 outbound types ×
  skip-when-counterparty, plus non-counterparty-passes, missing-
  createdBy-passes, lifecycle-type-exempt.

cmc 327 → 336 (+9). CMCHS handshake 3/3 unchanged (the chat
round-trip in CN13 now exits cleanly on the peer side instead of
relying on the rate-limiter to cut the loop).

Per-app-code rate-limit override (the original HANDOVER Q4 ask) is
captured as a separate backlog plan — operationally useful for
high-volume collector apps, but no urgency now that loop defence
sits at the right structural layer.

## CMC scope-update auto-merges CMC-machinery permissions

`handleSystemScopeUpdate`'s local-apply branch (the path that
synchronously updates the local data-grant before delivering the
peer notification) previously wrote `newPermissions` verbatim. If the
caller's `newPermissions` omitted the CMC-machinery streams
(`:_cmc:inbox` create-only, the per-peer `:_cmc:apps:*:chats:<slug>`
and `collectors:<slug>` contribute permissions), those plugin-owned
permissions silently disappeared — and chat / system delivery from
this peer broke until the next handshake.

Auto-merge now reads the current access via `mall.accesses.get`,
identifies the existing `:_cmc:*` permissions as machinery, filters
the caller's `newPermissions` to user-facing only, and overlays the
machinery back. Caller can include `:_cmc:*` perms — they're
filtered out; the plugin owns those.

- `components/cmc/src/handleSystem.ts` — local-apply branch updated.
  ~20 lines change.
- `[HS28a]` + `[HS28b]` tests cover both the auto-merge happy path
  and the caller-supplied-CMC-perm filtering.
- IMPLEMENTERS-GUIDE.md scope-update section gains a paragraph
  documenting the auto-merge contract.
- cmc 325 → 327 (+2).

## CMC capability lifecycle — Phase 1 (single-use state machine)

Builds on the typed error-id catalogue: introduces a real two-state
lifecycle on the capability access (`open` → `consumed` /
`invalidated`) so re-clicks on an already-accepted single-use invite
are rejected at events.create time with a typed `cmc-capability-consumed`
error.id instead of silently re-running `handleIncomingAccept` (and
relying on the bug #12 duplicate-name fix to avoid a duplicate
back-channel mint).

- **API surface** — `consent/request-cmc.content.capability.mode`
  (optional, default `'single-use'`): `'single-use'` enforces the
  state-flip, `'open-link'` mints with mode set but state stays
  `'open'` until Phase 2 lands (lifecycle enforcement for open-link
  is the [backlog plan](https://github.com/pryv/macroPryv/tree/main/_plans/XX-cmc-capability-open-link-later)).
- **`components/cmc/src/errorIds.ts`** — rename `CAPABILITY_UNKNOWN`
  → `CAPABILITY_INVALID` (BC: the prior name only existed on the
  Plan 68 reopen branch, never on master). New constants
  `CAPABILITY_CONSUMED` + `CAPABILITY_INVALIDATED`. `cmc-capability-invalid`
  covers "never existed + expired past TTL"; `cmc-capability-consumed`
  is the new state-flip rejection.
- **`components/cmc/src/capability.ts`** — `mintCapability` accepts
  an optional `mode` param (defaults to reading
  `triggerEvent.content.capability.mode` if present, else
  `'single-use'`) and stamps `clientData.cmc.capability = { mode,
  state: 'open', stateChangedAt }` on the access. Two new exports:
  `findCapabilityAccess(userId, capabilityId)` and
  `markCapabilityConsumed(userId, capabilityId)`. The pre-existing
  legacy `singleUse: true` advisory flag is preserved.
- **`components/cmc/src/capabilityResponseHook.ts`** (new) —
  events.create middleware that gates writes to
  `:_cmc:_internal:responses:<capId>` by the capability access's
  state. `'consumed'` → typed error `cmc-capability-consumed`;
  `'invalidated'` → `cmc-capability-invalidated`. Legacy capabilities
  (minted before this lifecycle field existed) and `'open'` state
  pass through.
- **`components/cmc/src/handleIncomingAccept.ts`** — after a
  successful accept-arrives flow (back-channel access minted), calls
  `markCapabilityConsumed` to flip state. Open-link mode capabilities
  skip the flip (state stays `'open'`). Best-effort; the back-channel
  is already minted so the relationship is established even if the
  state-flip fails (only the next re-click would mint a duplicate
  back-channel — same as today's behaviour).
- **`components/api-server/src/methods/events.ts`** — wires the new
  hook into the events.create chain right after
  `cmcInboxWriteHook`, before the persist step.
- **IMPLEMENTERS-GUIDE.md** — Error id catalogue updated; the gaps
  list narrows (the formerly-distinct `cmc-capability-stale` is
  collapsed into `cmc-capability-invalid`; tombstone-based finer
  discrimination is the explicit backlog work).
- **Tests**: `[CMCCAP-LF]` 7 new in `capability.test.js` covering
  mint-time field stamps, find/markConsumed primitive, idempotency.
  `[CMCCRH]` 6 new in `capabilityResponseHook.test.js` covering
  passthrough + rejection paths. cmc total 312 → 325 (+13).
  CMCHS handshake 3/0 unchanged.

## boiler: skip `override-config.yml` under `NODE_ENV=test`

`config/override-config.yml` is `.gitignore`d and intended only for
`NODE_ENV=development node bin/master.js` local iteration. When a developer
left it on disk, the boiler config loader (priority slot .1, above
everything else) merged it on top of `test-config.yml` for `just test`
runs as well, shifting `service.api` / `auth.adminAccessKey` / etc. out
from under tests that hardcode the canonical test expectations. Three
tests (`[SVIF] config: serviceInfo`, `[RGRC] register-records-admin`,
`[SYRO] system route`) plus the MFA-DELETE subroutes broke this way for
local development; CI never saw it because the file isn't committed.

- `components/boiler/src/index.ts` + `src/config.ts` — new
  `skipOverrideConfig` option on `boiler.init()`. When `true`, the
  override-config.yml load is skipped; the rest of the chain (memory →
  test → argv → env → `${NODE_ENV}-config.yml` → extras → default-config)
  is unchanged.
- Default behaviour: `skipOverrideConfig` defaults to `true` under
  `NODE_ENV === 'test'` and to `false` otherwise. Production and
  development runs continue to load `override-config.yml`. Callers
  can still pass `skipOverrideConfig: false` to force-load.
- `components/test-helpers/src/api-server-tests-config.ts` passes the
  flag explicitly for documentation; child processes spawned by
  `SpawnContext` inherit `NODE_ENV=test` and therefore get the
  default skip without each spawn-target having to know about it.

## CMC typed error-id catalogue (HANDOVER BLOCK-1)

Surfaces the stable kebab-case `error.id` strings the plugin emits via
`content.failure.reason` on failed trigger events as a single
authoritative catalogue. hds-macro Plan 59 Phase 5a's per-outcome UX
can now pattern-match on these constants instead of parsing English
`error.message`.

- **New** `components/cmc/src/errorIds.ts` — `CmcErrorIds` constants
  object (`as const`) enumerating 22 stable ids across capability
  lifecycle, trigger content, handler routing, counterparty
  resolution, access mint, outbound delivery, and chat/system
  handler outcomes. Type-export `CmcErrorId` for TS consumers.
- **New** typed detection: `readOfferViaCapability` in
  `acceptOrchestration.ts` now stamps `CmcErrorIds.CAPABILITY_UNKNOWN`
  (`cmc-capability-unknown`) on HTTP 401 responses. Previously these
  collapsed into the generic `cmc-handler-offer-read-failed`. Covers
  three runtime cases that look identical from the client today —
  token never existed, token expired (past TTL, plugin-GC'd), token
  already consumed. Finer discrimination (`cmc-capability-stale`,
  `cmc-capability-already-accepted`) requires capability tombstones
  — design call deferred pending the [07-recapture probe](https://github.com/pryv/macroPryv/blob/main/_plans/68-cmc-datastore-atwork/tests/07-recapture.js) outcome.
- **No rename** of existing reasons. Pre-existing `cmc-handler-*`
  strings in `handleAccept.ts` stay as-is for back-compat with any
  client matching on `content.failure.reason`. `errorIds.ts` exposes
  them under semantic names but value-strings are unchanged.
- **Exported via `cmc` index**: `cmc.CmcErrorIds` + the namespace
  `cmc.errorIds` (matches the existing `cmc.constants` / `cmc.slug`
  pattern).
- **Documented**: IMPLEMENTERS-GUIDE.md gains a new "Reference —
  Error id catalogue" section listing every id, when it fires, and
  the gaps that need a design call.
- **Test**: `[AO04B]` asserts the 401 → `cmc-capability-unknown` mapping.
  cmc 311 → 312 (+1).

## Plan 68 reopen — CMC test surface hardening

Follow-up to the Plan 68 TEST-GAP-DEBRIEF: Plan 68 shipped with
309 cmc unit tests + 1018 api-server tests but the real-deploy
validation suite still found 18 production-only code bugs +
3 fixture issues + 4 CI-only issues. The unit fakes accepted any
wire shape, and no test exercised the two-user handshake end-to-end.
This reopen closes the two highest-leverage gaps (debrief Phase 1 +
Phase 2). Phase 3 (deploy-smoke CI) is parked in the
`_plans/XXX-Backlog/cmc-acceptance-harness/` backlog.

- **Phase 1 — Unit-test fakes pin the wire contract.** New shared
  helper `components/cmc/test/_fake-assertions.cjs` exports
  `assertEventUpdateShape` (rejects `{ id, update: {...} }` — Plan 68
  bug #1) and `assertOutboundUrl` (whitelists Pryv API paths +
  permitted query params; rejects `?streamIds=` — bug #2). Wired into
  every `fakeMall.events.update` site (4 files) and every `fakeFetch`
  site (7 files; `outbound.test.js` deliberately skipped since it
  IS the URL builder under test).
- **Phase 2 — In-process two-user handshake.** New file
  `components/api-server/test/cmc-handshake.test.js` exercises the
  full request → accept → back-channel → chat handshake between two
  real users on the in-process api-server. Three tests: `[CN12]`
  happy-path handshake; `[CN13]` chat round-trip; `[CN14]` accept
  re-delivery idempotency (regression for bugs #12 + #13). Transport:
  a fetch shim that routes URLs whose host matches `127.0.0.1:3000`
  / `localhost:3000` (the test override-config's `service.api`)
  through `coreRequest` (the in-process supertest agent); pass-through
  for any other host (data-types `flat.json`, rqlited at `:4001`).
- **Supporting change** `components/api-server/src/methods/events.ts` —
  the cmc plugin deps now capture `globalThis.fetch` lazily via
  `(url, init) => globalThis.fetch(url, init)` instead of
  `fetch: globalThis.fetch`, so a test that installs a fetch shim
  after middleware registration is picked up by the dispatch loop.
  Production: one extra closure indirection per call. Two call sites
  tweaked (`cmcDispatchMiddleware` deps + the opt-in
  `startRetryLoopIfEnabled` deps).
- **Test counts**: `just test cmc` 309/0 unchanged. `just test
  api-server` +3 from `[CMCHS]` (baseline preserved at 1018 → 1021
  combined with the boiler skipOverrideConfig fix above).

## CMC plugin component — internals (Plan 68)

The `:_cmc:` namespace + write-hooks + orchestration handlers ship as a new top-level component `components/cmc/`. The plugin is loaded by the api-server like other components (event-content validation, capability-mint, inbox write-hook, dispatch middleware) plus a post-hook on `accesses.update`. No new storage engine — the entire plugin runs on standard per-user storage (PostgreSQL / MongoDB) + the existing pubsub layer.

- **NEW component** `components/cmc/` with module surface:
  - `src/constants.ts` — namespace + event-type constants; reserved-parent tree; classification predicates (`isCmcStreamId`, `isAppNestedPluginStream`, `getAppCode`); stream-id builders.
  - `src/slug.ts` — `counterpartySlug` + `parseCounterpartySlug` (load-bearing `--` separator).
  - `src/validators.ts` — hand-rolled per-type content schemas for the 9 cmc/* event types.
  - `src/hooks.ts` — content-validation hook + reserved-root rejection hook.
  - `src/inboxWriteHook.ts` — `:_cmc:inbox` write-hook (role check + content.from stamping).
  - `src/capability.ts` — single-use capability access mint + GC (creates real per-capability offer/responses streams + a shared access; cleaned up on consumption or TTL).
  - `src/capabilityMintHook.ts` — fires on `consent/request-cmc` events.create.
  - `src/outbound.ts` — federated HTTPS client (postToPeer + DeliverResult discriminated union; classify network/timeout/4xx/5xx).
  - `src/acceptOrchestration.ts` — read offer via capability, build data-grant payload, deliver accept-via-capability.
  - `src/anchorStreams.ts` — shared `provisionAnchorStreams` used by both sides at acceptance time.
  - `src/handleAccept.ts` — accepter-side: creates data-grant + provisions anchors + delivers accept via capability + rollback on 4xx.
  - `src/handleRefuse.ts` — accepter-side refuse delivery.
  - `src/handleIncomingAccept.ts` — requester-side: mints back-channel access + provisions anchors when a consent/accept-cmc lands on the requester's `:_cmc:inbox`.
  - `src/handleChat.ts`, `src/handleSystem.ts`, `src/handleRevoke.ts` — per-type orchestration handlers.
  - `src/dispatch.ts` — `dispatch(...)` type-router + `createDispatchMiddleware` (fire-and-forget). Auto-enqueues retryable failures.
  - `src/accessesUpdateHook.ts` — `createAccessesUpdatePostHook(deps)` + `runWithSuppression(fn)` (AsyncLocalStorage-backed double-fire suppression).
  - `src/rateLimit.ts` — per-worker sliding-window rate limiter (100 events / 60s window per (source, recipient) pair).
  - `src/retryQueue.ts` — events-in-`:_cmc:_internal:retries` retry mechanism with exponential backoff + reason-based retryability classifier.
  - `src/retryScheduler.ts` — `RetryScheduler` class wrapping the loop on an interval; operator-supplied `userIdsProvider`.
- **NEW mall routing** — `:_cmc:*` stream-ids route to `LOCAL_STORE_ID` passthrough (mirrors `:_system:*` precedent). Patched in `components/mall/src/helpers/storeDataUtils.ts`.
- **NEW api-server wiring** — `components/api-server/src/methods/events.ts` registers the three CMC write-hooks before `createEvent` + the dispatch middleware after `notify`. `components/api-server/src/methods/accesses.ts` registers `cmcAccessesUpdatePostHook` after `emitUpdateNotifications`. Both are fire-and-forget.
- **NEW slugify-skip** — `events.ts` and `streams.ts` skip slug normalization for ids starting with `:_cmc:` (otherwise colons would be munged and the path-style namespace destroyed).
- **TEST COVERAGE** — 285 cmc unit tests across `components/cmc/test/`; api-server matrix at 1018 passing / 14 pending / 0 failing (PG default).
- **Known follow-up**: reserved-parent auto-provisioning at user-creation time is currently no-op due to a state-dependent regression in `account-seq.test.js [AC04 6041]` (cumulative AC0X cycles + provisioning invalidate the test's stored personal-access token). Workaround: lazy creation at first `:_cmc:*` write + at acceptance time (handleAccept + handleIncomingAccept use `provisionAnchorStreams`). Documented as TODO in `business/src/users/repository.ts`.

## Surface skipped migrations at boot (Plan 69)

A demo deploy on 2026-05-13 hit a ~20 min outage when new code shipped against an unmigrated schema: the operator's `override-config.yml` carried `migrations: { autoRunOnStart: false }` and `bin/master.js` skipped the migration block in total silence — no log line at all. Every API call against the schema-dependent endpoints returned `unexpected-error: column "head_id" does not exist`.

The opt-out itself is intentional (operators want manual review on prod). The bug was the silent skip. master.js now always consults the runner.

- **NEW** `storages/interfaces/migrations/applyOrAnnounce.ts` — small policy helper. With `autoRun=true` it applies pending migrations (current behaviour byte-for-byte). With `autoRun=false` and pending migrations, it logs a top-line WARNING naming the count, the affected engine count, and a remediation hint (`Run \`node bin/migrate.js up\` to apply.`), followed by per-engine WARNING lines listing the pending filenames and current version. With `autoRun=false` and nothing pending, a single info line confirms the runner was consulted.
- **CHANGE** `bin/master.js` — replace the inline migration block with a single `applyOrAnnounce` call. Adds a `warn(msg)` closure mirroring the existing `log(msg)` so warnings hit both the boiler logger (`logger.warn`) and stdout (`console.warn`) with a `[master] WARNING:` prefix.
- **NEW** `components/api-server/test/migrations-skip-warn-seq.test.js` — `[MIGSKIP]` describe block. Five pure unit tests (`[MS01]`–`[MS05]`) against fake runner + fake logger cover the run-applied / no-pending / skipped-no-pending / skipped-one-pending / skipped-many-pending-across-engines cases. Pin the exact info/warn line counts and message templates so the deploy-warning contract can't regress silently.

Behaviour matrix:

| autoRunOnStart | pending migrations | log level | shape                                              |
|----------------|---------------------|-----------|----------------------------------------------------|
| true (default) | any                 | info      | unchanged from previous releases                   |
| false          | none                | info      | 1 info line: `Migrations skipped …; no pending …`  |
| false          | ≥ 1                 | warn      | WARNING summary + per-engine WARNING line per row  |

## Access versioning — tests + storage hardening (Plan 66 Phase F)

The `[ACUP]` test family validates Plan 66 end-to-end and uncovered several storage-path issues that needed fixing.

- **NEW** `components/api-server/test/accesses-update.test.js` — 17 tests across 7 sub-describes covering: composite-id bare-vs-versioned semantics, 409 stale-resource on update/delete, canUpdateAccess matrix (personal immutable, no self-update, app-can-update-managed-shared), Rule A/B/D (shared scope ⊆ managing app, narrowing parent rejects with `offendingChildren`, expiry chain on update + create), soft-deleted → unknownResource, accesses.getOne with current head / obsolete composite / unknown id / `?includeHistory=true`, pubsub coarse + fine-grained notifications, and `checkApp` head-only semantics.
- **CHANGE** `storages/engines/postgresql/src/user/BaseStoragePG.ts:DEFAULT_COLUMN_MAP` — added `createdBySerial → created_by_serial` and `modifiedBySerial → modified_by_serial`. Without these, PG lowercased the unmapped camelCase identifier and raised `column "modifiedbyserial" does not exist` on the first `accesses.update`.
- **CHANGE** `snapshotHead` rewrites on both engines — route the history-row insert through the standard `insertOne` path so `applyDefaults`'s integrity-recompute fires against the snapshot row's actual fields. The original approach copied the head's integrity hash verbatim, which never matched the snapshot row's (fresh `_id` + new `headId`) shape and the periodic `integrity-final-check` rejected every snapshot. Side effect: `snapshotHead` is now callback-based to fit BaseStorage's existing callback API.
- **CHANGE** dropped the storage-layer `headId` strip (PG `AccessesPG.rowToItem` `delete item.headId` + Mongo `stripHeadId` converter). The integrity hash was including `headId` at insert and the strip at re-read made every recompute miss. The strip moved to `composeWireAccess` (api-server seam) so the hash is consistent inside storage AND `headId` still never appears on the wire.
- **CHANGE** `composeWireAccess` now also strips `headId`, alongside the internal serial fields.
- **CHANGE** `components/test-helpers/src/dependencies.ts:init` runs the Plan 32 migration runner so the test DB matches the deployed shape. `bin/master.js` calls it in production; the test harness used to skip it, leaving the unique-token index without the new `head_id IS NULL` predicate and causing Plan 66's first `accesses.update` to hit a duplicate-token violation.
- **CHANGE** `components/api-server/test/migrations-runner-seq.test.js:beforeEach` resets each engine's `schema_migrations` tracking state before every test. The Phase F migration-runner invocation in `dependencies.init` would otherwise leave the tracker at v1 and trip [MR01]'s "fresh engines report v0" assertion.

## Audit + socket.io plumbing for versioned accesses (Plan 66 Phase E)

- **CHANGE** `audit/src/Audit.ts:buildDefaultEvent` — reads `context.access.serial` (set by `AccessLogic`'s `deepMerge(this, access)` from the storage row). When non-null, the event's `streamIds` array now carries both `access-<base>` and `access-<base>:<serial>` followed by the existing `action-<methodId>`. When null, behaviour is identical to before (single `access-<base>` entry). Cost: ~30 bytes per audit row on versioned-access activity. No schema change.
- **CHANGE** `api-server/src/socket-io/Manager.ts:messageFromPubSub` — handles both legacy string payloads (event-name only, used by `eventsChanged` / `accessesChanged` / `streamsChanged`) and the new structured object payloads (`{ type, …data }`). For structured payloads, looks up the socket event name by `payload.type` and forwards the entire payload as the socket.io message argument. Backwards-compatible: existing listeners that subscribe to `'accessesChanged'` keep receiving arg-less calls.
- **CHANGE** `messageMap[pubsub.ACCESS_UPDATED] = 'accessUpdated'` added — without this entry the structured payload would log `XXXXXXX Unknown structured payload` and silently drop.
- **CHANGE** `methods/accesses.ts:emitUpdateNotifications` — restructures the second emission so the payload is the entire structured object (`{ type, accessId, serial }`) rather than a 3rd arg to `pubsub.emit` (which only takes `(eventName, payload)` and would silently drop the data). The first emission stays as a string `USERNAME_BASED_ACCESSES_CHANGED` for the legacy `accessesChanged` socket event.

## Access versioning — read API + composite-id serialization (Plan 66 Phase D)

Internal plumbing for the new `accesses.getOne` and the composite-id wire format (see `CHANGELOG-v2.md`).

- **NEW** `composeWireAccess(row, historyOfBase?)` in `business/src/accesses/refs.ts`. Takes a storage row and emits the wire-format access object: composes the composite `id` / `createdBy` / `modifiedBy` from the row's bare `<col>` + sibling `<col>Serial` columns, and strips the now-redundant `serial` / `createdBySerial` / `modifiedBySerial` fields so the response stays inside the schema's `additionalProperties: false` whitelist. When `historyOfBase` is passed (history-row case), the wire `id` uses that base instead of the storage's fresh history-row id — so `<base>:<serial>` always means "this version of base."
- **NEW** `composeStoredRef(storedRef, serial)` helper inside `refs.ts`. Handles the `<base> <callerId>` tracking-author format: splices the `:<serial>` into the access-id slice and preserves the space-separated caller tail. (MethodContext.ts already parses callerId from the first space, so this round-trips cleanly.)
- **NEW storage** `Accesses.findHistory(userOrUserId, baseId)` on both engines. Returns history rows where `headId === baseId`, sorted by `modified` ASC (oldest first). PG uses `WHERE user_id = $1 AND head_id = $2`; Mongo uses `{ userId, headId: baseId }.sort({ modified: 1 })`. Each engine's existing `rowToItem` / `applyItemFromDB` pipeline strips `headId` before returning — the caller (composeWireAccess) gets the base from the query parameter.
- **NEW** `accesses.getOne` method handler `findOneAccess` in `methods/accesses.ts`. Parses composite id, looks up the head by base, applies visibility check (app callers see only self + their managed shareds, by base), then either (a) returns the head when bare/serial matches, (b) returns the historical snapshot + `current` hint when serial < head's, or (c) `unknownResource` for never-existed serials. `?includeHistory=true` appends the full chronological history.
- **NEW** `methodsSchema.getOne` entry — `params: { id, includeHistory? }`, `result: { access, current?, history?: [...] }`.
- **NEW route** `GET /accesses/:id` → `accesses.getOne`, with `tryCoerceStringValues` on `includeHistory` so the boolean comes through correctly from query string.
- **`AccessLogic.can('accesses.getOne')`** — added to the switch, returns `!isShared()` (same gate as `accesses.get`).
- **`accesses.getOne` registered in audit `ALL_METHODS`** (`audit/src/ApiMethods.ts`) — without it, `API.register` throws at boot and every api-server test that initializes the API crashes in the `before all` hook. (First Phase D test run had 298 failures from this single oversight.)
- **`composeWireAccess` applied to**: `accesses.get` (list), `accesses.get` deletions, `accesses.create` result, `accesses.update` result (replacing the ad-hoc id rewrite from Phase C), `accesses.checkApp` (matching + mismatching). Audit-driven and storage-driven internals continue to operate on the raw `(base, serial)` columns — composition is purely a presentation-layer concern.
- **Phase C's `snapshotAndApplyUpdate`** rewritten to delegate id composition to `composeWireAccess` instead of building the composite string in-place. Behaviour identical; less duplication.

## Access versioning — update handler + storage snapshot (Plan 66 Phase C)

Wire-up for the revived `accesses.update` (see `CHANGELOG-v2.md`). Internal-only plumbing notes:

- **NEW** `Accesses.snapshotHead(userOrUserId, baseId)` on both engines. Reads the current live head row by base, clones every column/field, replaces `id`/`_id` with a freshly-minted cuid and sets `head_id`/`headId` to the original base. The unique-token partial filters (`WHERE deleted IS NULL AND head_id IS NULL` in PG; `partialFilterExpression: { deleted: $type null, headId: $type null }` in Mongo) exclude the new history row, so the head and snapshot can share a token without violating uniqueness.
- **Handler chain** (`api-server/src/methods/accesses.ts`): `basicAccessAuthorizationCheck → schema-validate → loadAccessForUpdate → enforceUpdateChainRules → snapshotAndApplyUpdate → emitUpdateNotifications`. `loadAccessForUpdate` parses the composite id, conflict-checks `serial`, treats soft-deleted as `unknownResource`, and gates on `AccessLogic.canUpdateAccess`. `enforceUpdateChainRules` resolves `expireAfter → expires` and applies Rules A/D for shared targets + Rules B/C/D for app targets (iterating the user's live shareds, matching by `base`).
- **`AccessLogic.can('accesses.update')`** — added to the switch, returns `!isShared()`. Without this, `basicAccessAuthorizationCheck` threw on the unknown methodId and the handler crashed with `unexpected-error`.
- **Tracking fields** — `update.modifiedBy` is set by the standard `MethodContext.updateTrackingProperties` (caller's bare base). `update.modifiedBySerial` is set explicitly from `context.access.serial` (null today since AccessLogic doesn't yet carry serial — Phase D will plumb it). `update.serial` is set to `(prev || 0) + 1`.
- **NEW error** `stale-resource` (`ErrorIds.StaleResource`, 409) added to `errors/{ErrorIds.ts,factory.ts}`. Used by `accesses.update` and `accesses.delete` on composite-id mismatch.
- **`accesses.delete` composite-id check** — `checkAccessForDeletion` parses the composite, conflict-checks the serial against the head, then rewrites `params.id` to the bare base for downstream stages (`findRelatedAccesses`, `deleteAccesses`) which all expect bare ids.
- **Schema** — `accessesMethods.ts` gains `__ex_update = { params: { id, update: access(Action.UPDATE) }, result: { access: access(Action.READ) } }`. The UPDATE-action `access` schema already exists (Action.UPDATE branch) with the mutable-fields whitelist.
- **Test updates** — 4 pre-Plan-66 "endpoint is gone" tests refreshed to assert the new behavior: `[11UZ]` app-cannot-update-sibling-app → 403, `[U04A]` unknown-id-on-PUT → 404, `[1WXJ]` create-only-shared-cannot-update → 403, `[OS36]` `deleted` in update body → `invalid-parameters-format`. Test IDs preserved; assertions and descriptions updated in place.
- **Race safety** — no transaction (accesses storage has no transactional API). The composite-id check at entry catches the common stale-caller case; the read-then-snapshot-then-update window is narrow enough that genuine concurrent updates are rare. Plan 66 Q12.5=a explicitly accepts no-locking; honest audit captures the version that handled each request.

## Access versioning — business primitives (Plan 66 Phase B)

Internal-only utilities that the upcoming `accesses.update` (Phase C) will consume. No behavior change today besides the Rule D retrofit on `accesses.create` (see `CHANGELOG-v2.md`).

- **NEW** `components/business/src/accesses/refs.ts` — `parseAccessRef(ref)` and `serializeAccessRef({ base, serial })`. Wire format is bare cuid when no serial, `<base>:<serial>` otherwise; separator is `:` (URL-safe, never appears inside a cuid/cuid2 id). Throws on malformed input.
- **NEW** pubsub constant `ACCESS_UPDATED = 'access-updated'` (`components/messages/src/constants.ts` + `index.ts`). Payload shape (set when Phase C fires it): `{ accessId: '<base>:<serial>', serial: number }`. Companion to the existing `USERNAME_BASED_ACCESSES_CHANGED` event so fine-grained subscribers can act on a specific update without refetching.
- **NEW** `AccessLogic.canUpdateAccess(target)` — encodes the §3 caller-vs-target matrix from the plan: no self-update (parses both ids so a future composite ref still matches the caller's bare base), personal-immutable, personal-can-update-non-personal, app-can-update-only-shared-it-manages (chain match by `base` via `parseAccessRef(target.createdBy).base === this.id`), shared-cannot-update-anything. `canUpdateAccess` is the gate; chain-rule application (A/B/C/D on changes) is enforced by the call path in Phase C.

## Access versioning — storage primitives (Plan 66 Phase A)

Lays the schema and storage-layer plumbing for the upcoming `accesses.update` revival. No API surface change yet (the wire-format composite id `<base>:<serial>` and the revived method land in later phases). Both `baseStorage` engines (PostgreSQL, MongoDB) get the same treatment; engines that don't store accesses (sqlite, rqlite, filesystem, influxdb) are untouched.

- **NEW PG columns** on `accesses` table: `serial INTEGER`, `head_id TEXT`, `created_by_serial INTEGER`, `modified_by_serial INTEGER` — all nullable. Added via the new migration `storages/engines/postgresql/migrations/20260512_132200_access_versioning.js` (Plan 32 framework). Same migration tightens the two unique indexes (`idx_access_token`, `idx_access_name_type_deviceName`) to predicate `AND head_id IS NULL` so future history rows don't collide on token/(name+type+deviceName) uniqueness, and adds a new partial index `idx_access_head_id ON accesses(user_id, head_id) WHERE head_id IS NOT NULL` for history-lookup queries. `SCHEMA_SQL` in `DatabasePG.ts` keeps the pre-Plan-66 index predicates because `CREATE TABLE IF NOT EXISTS` is a no-op on existing installs — fresh installs converge once the migration runs at boot.
- **PG migrations directory CJS scope** — added `storages/engines/postgresql/migrations/package.json` with `{ "type": "commonjs" }` so migration files keep the README's `module.exports = { async up () {} }` shape despite the engine package being `"type": "module"`. Without this scope-override the runner's `require()` failed with `module is not defined in ES module scope`.
- **PG `AccessesPG`** — `hasHeadIdCol = true`. `rowToItem` strips `headId` from the returned item (internal storage marker, never on the wire). `BaseStoragePG.findOne` now adds `query.headId = null` when `hasHeadIdCol` is true so the auth-by-token path and `findOne({ id })` can never return a history row.
- **Mongo `Accesses`** — both unique indexes' `partialFilterExpression` extended with `headId: { $type: 'null' }`; new non-unique `{ headId: 1 }` partial index for history queries. New `setHeadIdNullIfMissing` converter forces live-row inserts to set `headId: null` explicitly (the `$type: 'null'` partial filter only matches BSON null, not missing fields). New `stripHeadId` converter on `itemFromDB` keeps `headId` off the wire. New `bootstrap()` method drops the pre-Plan-66 unique indexes (`token_1`, `name_1_type_1_deviceName_1`) and backfills `headId: null` on legacy rows so they re-enter the new unique-token set; idempotent over fresh DBs (`NamespaceNotFound`/`IndexNotFound` are silent successes).
- **Mongo `BaseStorage.findOne`** — adds `query.headId = null`. Equality-null in Mongo matches both missing-and-null fields, so this is a no-op for tables without a `headId` field.
- **`initStorageLayer` is now async** — Mongo's flavor awaits `storageLayer.accesses.bootstrap()` after construction; PG's stays sync (returns `undefined`). `StorageLayer.init` adds `await` accordingly.
- **Behavior unchanged today.** No history rows are written yet (Phase C lands `accesses.update` and the snapshot logic); no composite-id format on the wire yet (Phase D); `accesses.update` still returns `goneResource`. The schema and storage just sit ready.
- **Tests:** full PG matrix at close: **1873 passing, 0 failing, 7 pending** (Plan 67 close baseline ~1872, +1 within noise). Mongo matrix not re-run in this phase — schema-only change paired with engine-specific `bootstrap` test coverage; full Mongo re-run gated on Phase C when behavior actually diverges.
- **Integrity hash — no format-version bump.** Plan 66 §6 called for adding `serial` and `headId` to the canonical-fields list and rolling the integrity-format version. In practice no bump was needed: `@pryv/stable-object-representation/access.js:stringifyAccess0` already serialises every field on the access object (deep-clone + strip known volatile fields like `integrity` / `lastUsed` / `calls` / `apiEndpoint`). New nullable fields `serial` / `head_id` simply roll into the hash automatically — never-updated accesses have absent values (no hash change), versioned accesses include `serial: <N>`, and history rows include both `serial` (frozen) and `headId` (base). The `ACCESS:0:` prefix stays as-is. If we ever want a tamper-detection guarantee that REJECTS a serial removal (vs just detecting an integrity mismatch), bumping to `ACCESS:1:` becomes warranted then; current behavior is detection-via-mismatch.

## Default `storages.series.engine` flipped from `influxdb` to `postgresql`

- **CHANGE** `config/default-config.yml`: `storages.series.engine: influxdb → postgresql`. Operators who want influxdb-backed series storage must now set `storages.series.engine: influxdb` explicitly in override-config.yml (and run a reachable influxd on `http.ip:storages.engines.influxdb.port`).
- **CHANGE** `config/test-config.yml`: pins `series.engine: influxdb` explicitly. Test matrix behavior preserved — series tests still run against influxdb. Pin can be removed once the matrix is re-validated against postgresql series.
- **Why**: raw deploys (the now-canonical install shape per Plan 67's ingress dispatcher) rarely ship influxd. Setting `cluster.hfsWorkers > 0` with the inherited influxdb default produced a silent footgun: HFS workers came up, requests reached the worker, but every write hit a missing backend. PostgreSQL seriesStorage has been first-class since Plan 19. Flipping the default removes the trap for fresh installs.
- **Migration**: existing deploys with `engine: influxdb` set explicitly are unaffected. Deploys without an override that have an actual influxd running need to either keep it running (and add the explicit override) or migrate any existing series data — note: PG and influxdb series stores are NOT cross-compatible, this is a forward-going default.

## In-process HFS ingress dispatcher (api-server)

- **NEW** `components/api-server/src/hfsIngress.ts` — `buildHfsIngress({ hfsHost, hfsPort, logger })` factory returns a `(req, res, fallback) => void` dispatcher.
- **CHANGE** `components/api-server/src/server.ts` now constructs `https.createServer(opts, requestHandler)` where `requestHandler` is a wrapper that calls the HFS dispatcher first, then falls through to `app.expressApp`. The fall-through preserves the prior behavior for all non-HFS paths.
- **Routes:** `^/<user>/events/<id>/series` and `^/<user>/series/batch` are forwarded via `http.request` to `http.ip:http.hfsPort` (default `127.0.0.1:4000`), streaming both request and response bodies. JSON-shaped 502 on upstream unreachable.
- **Tests:** 6 `[HFSI]` cases in `components/api-server/test/hfs-ingress.test.js` cover regex matching, dispatch, fallback, and 502.
- **Note on extraction.** The dispatcher lives inside api-server today because it was the minimum-viable shape for a single dispatcher. When more in-process dispatch lands (previews, mail-templates UI, etc.) or someone needs a clean nginx-swap story, the right shape is to extract the public listener + TLS + dispatcher into a dedicated `components/ingress/` component — filed at `_plans/XXX-Backlog/EXTRACT-INGRESS-COMPONENT.md`.

## boiler config getters — `getConfigSync()` companion; defer module-top reads

- **NEW** `@pryv/boiler` exports `getConfigSync()` — sync access to the fully-loaded config. Throws if `init()` hasn't been called or if async config-loading is still pending. Use anywhere a sync read is needed at request/test time post-init.
- **CHANGE** `getConfigUnsafe(warnOnly)` retained as the documented escape hatch for genuine pre-init reads (returns partial config; with `warnOnly: true` warns instead of throws). Two production sites remain on it after the cleanup: `components/business/src/integrity/integrity.ts:9` (module-top capture; preserves cross-process symmetry between mocha-parent and api-server forked-child that the fixture-time hash compute relies on) and `components/storage/src/index.ts:_ensureMongoDatabase` (test-helpers/dependencies lazy-loads MongoDB at module-load). Plus 3 test-helpers fixture files (`data.ts`, `dynData.ts`, `dependencies.ts`) which run pre-init by lifecycle.
- **CHANGE** Deferred 4 module-top `getConfigUnsafe(true)` reads into function bodies:
  - `components/cache/src/index.ts` — `loadConfiguration()` is now `async` and awaits `getConfig()`. Module-bottom auto-call becomes fire-and-forget with stderr log on misconfig; cache stays inactive on failure instead of killing the worker. Cache ops short-circuit on `!isActive` so the brief async window matches legacy partial-config behavior.
  - `components/previews-server/src/attachmentManagement.ts` — module-top `previewsDirPath` capture → lazy-memoized `getPreviewsDirPath()`. All 3 callers run at request/test time.
  - `components/previews-server/src/runCacheCleanup.ts` — module-top sync config reads → async IIFE that awaits `getConfig()` before constructing `Cache`. Strictly safer than the legacy race against partial config.
  - `components/api-server/src/routes/register.ts` — drops `(true)` warnOnly; caller is express bootstrap post-`await getConfig()`.
- **CHANGE** `components/test-helpers/src/data/events.ts` — module-top `Array.map` calling `integrity.events.set(event, false)` synchronously at module-load → idempotent `ensureIntegrity()` helper. Called from `resetEvents()` and from `helpers-base.ts beforeAll`. Decouples fixture integrity from module-load timing.
- **CHANGE** Renamed `getConfigUnsafe()` (no warnOnly) → `getConfigSync()` at 7 production sites: `api-server/{API,middleware/errors,routes/auth/login,routes/register}.ts`, `business/src/accesses/AccessLogic.ts`, `previews-server/src/attachmentManagement.ts`, `utils/src/api-endpoint.ts`.
- **NOTE** Test matrices at close: PG `1857/1` (only pre-existing `[ASTE]` flake), Mongo `1849/2` (pre-existing `[ASTE]` + `[3TMH]` timing-sensitive webhooks test that passes on standalone re-run).

## ESM flip — components + tests + storages (Plan 57 Phase 5c.2 → 5f close)

- **CHANGE** All 22 production sources flipped to ESM. Every `package.json` for components + storages + engines now has `"type": "module"`; every `.ts` source file uses `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` to keep its existing CJS-style internal `require()` calls working under the ESM module loader. Default exports use `export default X`; named exports use `export { X }` or `export const X = ...`. Sub-package.json `{"type":"commonjs"}` overrides drop `bin/server` (each component's CJS fork target), three `test/helpers/` directories that use the `module.exports = { ...require('test-helpers') }` spread-mutation pattern, and a few CJS-only fixture/test-engine subtrees.
- **CHANGE** All 13 test directories flipped to ESM same way. `.mocharc.cjs` files stay CJS as Node requires (mocha config is loaded via CJS); the `_ts-register` shim is loaded via `require:` from the base mocha config.
- **CHANGE** `components/middleware/src/project_version.ts` — added an ESM-safe fallback for `readStaticVersion()` that walks upward from the file's own `__dirname` looking for `.api-version`. Fixes a regression that surfaced once forked children (HFS test-helpers, accessStateWorker, etc.) became ESM: `process.mainModule` and `require.main` both went undefined, the function returned null, and the api-version header fell through to the git-describe stamp — breaking every consumer that asserted `/^\d+\.\d+\.\d+/` on it.
- **CHANGE** `components/test-helpers/src/helpers-base.ts:121-128` — the dynamic `for (const method of methods) { const loaded = require('api-server/src/methods/' + method); if (typeof loaded === 'function') { ... } }` loop was silently skipping every method registration once api-server became ESM (Node 24 `require(esm)` returns the namespace object, not the function). Fixed: unwrap `loaded.default` first. This single fix turned a "119 failing" intermediate api-server run into 978/0.
- **CHANGE** Storages barrel (`storages/index.ts`) exposes `database`, `databasePG`, `connection`, `storageLayer`, `userAccountStorage`, `usersLocalIndex`, `platformDB`, `auditStorage`, `seriesConnection`, `dataStoreModule` as live-bound `let` exports updated by `_refreshExports()` after `init()` and `reset()`. New test-only `_setPlatformDBForTest(db)` setter replaces the now-incompatible `Object.defineProperty(storages, 'platformDB', ...)` pattern (ESM module namespace properties are non-configurable).
- **CHANGE** Business `system-streams/index.ts` — top-level `let` bindings replace the previous `module.exports = X; X.foo = Y` mutation pattern; live-bound exports propagate state changes (e.g. `accountChildren` reassignment in `initializeState()`) to all consumers without breaking the namespace.
- **CHANGE** Storages PG engine: `storages/engines/postgresql/test/{global,audit-conformance}.test.js` had a pre-existing `_internals.getLogger = X` direct assignment that was always wrong (the export defines `getLogger` as a get-only property; CJS plain-object assignment silently shadowed the getter, ESM frozen namespace throws `Cannot add property getLogger`). Fixed by destructuring `{ _internals }` and using the proper `_internals.set('getLogger', X)` API.
- **CHANGE** Several `module.exports = ClassName` default-exports in test fixtures (`HttpServer` in business + api-server, `SyslogWatch`, `InfluxConnection.test.js`'s `conformanceTests` factory) became `export default ClassName`, with consumers patched to `.default`-unwrap.
- **CHANGE** `bin/_ts-register.js` is retained — its `require.extensions['.ts'] = require.extensions['.js']` mutation is still load-bearing for the three CJS helper subdirectories and the forked CJS `bin/server` targets that do extensionless deep `.ts` requires (e.g. `require('test-helpers/src/helpers-base')`, `require('messages/src/cluster_kv')`). Phase 5g experiment (commenting out the line) regressed the matrix; full removal moves to backlog.
- **NOTE** Test matrices: PG `1857/3`, Mongo `1852/1` — failures are pre-existing flakes (`[ASTE]` audit matrix-state, `[3TMH]` webhook timeout, occasional webhook DELETE app-token race with stale DB residue). No ESM regressions; both engines are correctness-equivalent to the pre-5f baselines (1858/2 and 1853/0).
- **NOTE** Top-level `await` is now syntactically available in any `.ts` file. The storages barrel still uses `async init()` (consumer-compatible with Node 24 `require(esm)` interop); switching it to TLA is the unblocker for `XX-finalize-storages-plugin-later` and is left as a follow-up.

## TypeScript conversion — storages/ top-level + shared + datastores (10 files, Plan 57 Phase 5c.1)

- **CHANGE** `.js → .ts` for the 10 production source files in `storages/` that Phases 1–3 left untouched (they were outside the `storages/interfaces/*` and `storages/engines/*` scope): `storages/{index,internals,manifest-schema,pluginLoader}.ts`, `storages/shared/{DeletionModesFields,treeUtils,localStoreEventQueries}.ts`, `storages/datastores/account/{index,AccountUserEvents,AccountUserStreams}.ts`. Added module markers + two minor TS-narrowing fixes: optional positional args on `fieldToEvent (fieldName, value, streamConfig, time?, createdBy?)` and `const engines: Record<string, any> = {}` in pluginLoader.
- **NOTE** `components/` + `storages/` production source is now **100% TypeScript**. Only `.mocharc.js` test-config files in `storages/engines/*` remain `.js` (intentional — mocha config). Runtime is still source-loaded via `bin/_ts-register.js` shim. Sets up Phase 5c.2 (rewrite source `require()` → `import`).

## tsconfig: `module/moduleResolution: nodenext` (Plan 57 Phase 5b)

- **CHANGE** `tsconfig.json` — `module: commonjs` → `nodenext`, `moduleResolution: node` → `nodenext`. Under `nodenext`, tsc decides per-file CJS-vs-ESM emit based on the closest enclosing `package.json` `"type"` field. Since no package.json declares `"type": "module"` yet, all files still emit CJS — no runtime change. Validates the toolchain switch in isolation; per-file emit format flips in Phase 5c onwards as packages opt into `"type": "module"`.
- **NOTE** Build verification: `dist/components/api-server/src/server.js` still has `Object.defineProperty(exports, "__esModule")` + `require()` (CJS shape). PG matrix 1860/0 unchanged.

## Pre-flight characterization tests for ESM flip (Plan 57 Phase 5a)

- **NEW** `storages/test/barrel-init-order.test.js` — 5 `[BIO]` cases pinning the current CJS barrel contract: pre-init getter access returns `undefined` (does not throw), `pluginLoader` is exposed regardless, `init()` is idempotent, `reset()` returns to pre-init state. ESM with top-level `await` in the barrel would fundamentally change pre-init semantics — without this pin a regression direction (silent vs throw) lands undetected on `feat/ts-esm`.
- **NEW** `components/messages/test/worker-fork-ts-loading.test.js` + `fixtures/wftl-worker.js` — 2 `[WFTL]` cases pinning the Phase 1 NODE_OPTIONS-shim mechanism: parent process has `NODE_OPTIONS=--require=…/_ts-register`, forked children inherit it and can `require()` a `.ts` source file without explicit shim load. Phase 5e drops the shim — must remain functionally equivalent under native ESM `.ts` loading or every `child_process.fork()` target (cluster_kv master, accessStateWorker, hfs background) breaks.
- **NEW** `storages/test/engine-runtime-contract.test.js` — 33 `[ERC]` cases, one per (engine × required export) combination across all 6 engines (filesystem, mongodb, postgresql, sqlite, rqlite, influxdb). Asserts each engine's loaded module exports the methods that `pluginLoader.REQUIRED_EXPORTS` demands for each storageType in its manifest. ESM `export { foo }` vs CJS `module.exports = { foo }` typically shifts exports under a `default` namespace — without this pin the silent shape change crashes consumers at deferred runtime, not at compile time.
- **NOTE** All 40 tests run against the current CJS state. Their value is in pinning behavior so Phase 5b–5g regressions are loud at unit-tier instead of surfacing in production.

## TypeScript conversion — api-server component (82 source files)

- **CHANGE** `.js → .ts` for every source file under `components/api-server/src/` across 8 sub-folders: top-level (5: `API`, `Result`, `application`, `expressApp`, `index`, `server`), `methods/` (12), `methods/auth/` (3), `methods/helpers/` (6), `methods/streams/` (5), `middleware/` (3), `routes/` (15 incl. `routes/auth/` + `routes/reg/`), `schema/` (22), `socket-io/` (2). Total: **82 source renames**. Plus the established Phase 4 fix-up patterns: module markers, `: any` casts on mutable response/options/query objects (e.g. `routes/reg/access.ts` response, `methods/accesses.ts` query, `routes/events.ts` params, `schema/{stream,user,access}.ts` mutable schema base), class field declarations (`Server.isAuditActive`), Promise<void> typed on void-resolving constructors (`server.ts` https-options ack), optional positional args (`?:`) on `nextElement`/`runNextMethod`/`isAccessExpired`/`nextPermission`, `Object.entries`/`Object.values` casts for nested config iteration in `methods/auth/register.ts` regions/zones/hostings, one `as any` cast on `system.ts` user-list entry that gets a `.core` mutated.
- **CHANGE** `components/api-server/package.json` `main` bumped `src/index.js → src/index.ts`.
- **FIX** `application.ts:259` — pre-existing typo `this.customAuthStep` (undefined) at logger.debug 2nd arg, masked the latent crash where passing a function to boiler's `inspectAndHide` throws `JSON.parse('undefined')` (`JSON.stringify(fn) === undefined`). Removing the 2nd arg entirely (the boolean is already in the message string) preserves the log information without crashing the worker on any test that exercises `getCustomAuthFunction()`.
- **PLAN57-FIXUP** `methods/accesses.ts:362-368` — pre-existing operator-precedence bug since `685034dd` (2023-10-13): `if (!accessToDelete.type === 'personal')` always evaluates to false (precedence: `!` before `===`), so the early-return branch is dead and `findRelatedAccesses` runs for every access type. Preserved current observed behavior with a defensive cast and a marker comment; tracked at `_plans/XXX-Backlog/ACCESSES-FIND-RELATED-PRECEDENCE-BUG.md`.
- **NOTE** Runtime is still source-loaded via the `bin/_ts-register.js` shim from Phase 1; deployability invariant preserved. **All `components/` + `storages/` source code is now 100% TypeScript** — Phase 5 (ESM flip + drop the shim) is unblocked.

## TypeScript conversion — business component (67 source files)

- **CHANGE** `.js → .ts` for every source file under `components/business/src/` across 14 sub-folders: top-level (2), `accesses/` (2), `acme/` (12), `auth/` (2), `backup/` (3), `bootstrap/` (10), `integrity/` (4), `mfa/` (7), `observability/` (6), `series/` (8), `system-streams/` (1), `types/` (5), `users/` (5), `webhooks/` (2). Total: **67 source renames**. Module markers added (`import type {} from 'node:fs'`), class field declarations (`foo: any;`) added wherever `this.foo = ...` was set in constructor, static class members declared (`static PERMISSION_LEVEL_*` on `AccessLogic`, `static replaceAll`/`replaceRecursively` on `mfa/Service`), destructure-default opts annotated `{ x, y }: any = {}`, mutation-after-`new Error(...)` patterns annotated `const err: any = new Error(...)`, `Object.entries(map)` widened with `as Array<[string, any]>` casts at iteration sites, `Object.values(map)` casts to `as any[]`, `Promise<void>` typed on void-resolving constructors, optional positional args `?:` on `_restoreSingleUser`/`_verifyEventIntegrity`/`setUserPassword`/`#issue`. One existing-bug callout: `IntegrityStream` constructor cast `as any` because the upstream type signature lacks the algorithm arg.
- **CHANGE** `components/business/package.json` `main` bumped `src/index.js → src/index.ts` so the workspace symlink resolution + `bin/_ts-register.js` shim resolve `.ts` first.
- **NOTE** Runtime is still source-loaded via the `bin/_ts-register.js` shim from Phase 1; deployability invariant preserved.

## TypeScript conversion — middleware, audit, hfs-server, test-helpers (74 source files)

- **CHANGE** `.js → .ts` for every source file under `components/middleware/src/` (15), `components/audit/src/` (16), `components/hfs-server/src/` (16), and `components/test-helpers/src/` (26 — 21 top-level + 5 in `data/`). Total: **74 source renames** plus `components/api-server/.mocharc.js` `require: 'test-helpers/src/helpers-c.js' → '…/helpers-c.ts'`. Module markers added (`import type {} from 'node:fs'`) on every renamed file (script-vs-module disambiguation), default-arg objects annotated `: any` on consumers that mutate them, `Promise<void>` typed on void-resolving constructors, optional callback params (`?:`) on tail-call recursive helpers, `super_` accesses on `util.inherits` classes cast `(SubClass as any).super_`, variadic `arguments` rewritten as `...rest: any[]`, and one `errorlogger` → `errorLogger` typo fix on `Server` (lowercase declaration was inconsistent with assignment + use sites).
- **CHANGE** `package.json` `main` bumped `src/index.js → src/index.ts` (or `src/server.js → src/server.ts` for hfs-server) on each touched component so the workspace symlink resolution + `bin/_ts-register.js` shim resolve `.ts` first.
- **NOTE** Runtime is still source-loaded via the `bin/_ts-register.js` shim from Phase 1; deployability invariant preserved.

## TypeScript toolchain — direct dep + emit pipeline (no source changes yet)

- **CHANGE** `package.json` — `typescript ^5.9.3` and `@types/node ^24.0.0` added to `devDependencies`. TypeScript was previously pulled transitively via `neostandard`; now it's pinned directly so the build pipeline doesn't break when neostandard updates.
- **CHANGE** `tsconfig.json` — reshape from a JSDoc-only checker config to an emit-capable config: `target: es2022`, `module: commonjs`, `outDir: ./dist`, `rootDir: .`, `esModuleInterop: true`, `skipLibCheck: true`. `checkJs` flipped to `false` — the previous `checkJs: true` baseline accumulated 7,200+ silent errors that nobody enforced; quality going forward is gated through new `.ts` conversions instead. `allowJs: true` remains so the codebase keeps building during incremental conversion. Includes broadened to cover `components/`, `storages/`, and `bin/` (was `components/` + `test/` only).
- **NEW** `justfile` recipes — `just typecheck` (tsc --noEmit) and `just build` (tsc emit to ./dist).
- **CHANGE** `.gitignore` — `/dist` ignored.
- **NOTE** Runtime is unchanged. `bin/master.js` still loads from source under `components/` + `storages/`; `dist/` is informational until later phases convert sources to `.ts` and flip the runtime entry. The deployability invariant — every commit on this branch keeps `bin/master.js` runnable from source — is preserved.

## PG `$inc` JSONB-path collision — `multiple assignments to same column`

- **FIX** `storages/engines/postgresql/src/user/BaseStoragePG.ts` — `_buildUpdateClauses` `$inc` loop emitted one `SET col = jsonb_set(...)` clause per dotted-path entry. When a single update contained ≥2 entries sharing the same top-level column (e.g. `$inc: { 'calls.events:get': 1, 'calls.accesses:get': 1 }`, produced by every batched API call when `accessTracking.isActive: true`), Postgres rejected the UPDATE with `multiple assignments to same column "calls"`. Per-method counters were silently dropped (the storage error was caught + logged by `updateAccessUsageStats.js` after the API response had already returned 200). Fix groups dotted-path `$inc` entries by top-key and emits ONE nested `jsonb_set(jsonb_set(..., k1, v1), k2, v2)` clause per column. Each nested call reads the original column value (`col->>$key`), preserving Mongo `$inc` disjoint-paths semantics.
- **TEST** new `[BTRK]` regression in `components/api-server/test/root-seq.test.js`: issues a real batched `POST /<username>` with `events.get` + `accesses.get` and asserts both per-method counters move (and by the same delta). Pre-fix the assertion fails because the SQL crashes and counters stay at baseline.

## Audit syslog transport — error listener prevents worker crash on missing socket

- **FIX** `components/audit/src/syslog/Syslog.js` — the `winston-syslog` transport's underlying `unix-dgram` socket emits `'error'` on the first send when the configured socket path doesn't exist (typical containerized deploy with no `/dev/log`). `winston-transport` extends `stream.Writable`, and `Writable.emit('error', err)` with no listener throws synchronously → worker exits code 7 → cluster master recycles → user-visible: registration row landed in `users_index` but the auth poll on `core-<id>.<domain>/reg/access/<key>` times out with no token issued. Now `transport.on('error', err => logger.warn('audit syslog dropped', err))` so audit emits become best-effort observability instead of a load-bearing path.
- **CHANGE** `config/default-config.yml` — `audit.syslog.active: false` (operator-facing, in `CHANGELOG-v2.md`). Defense in depth: even if the listener regresses, the gate at `audit/src/syslog/index.js:18` still short-circuits the whole code path.

## Bootstrap bundle schema — v2 (forward-compat-friendly)

- **CHANGE** `components/business/src/bootstrap/Bundle.js`: `BUNDLE_VERSION`
  bumped `1` → `2`. v2 adds an optional
  `platformSecrets.letsEncrypt.atRestKey` field carrying the cluster-wide
  AES-GCM key used by `AtRestEncryption`.
- **CHANGE** `Bundle.validate()` accepts any version in `1..BUNDLE_VERSION`
  (was strict equality on the current version). Producers always emit the
  latest version; consumers reject only forward-compat unknown versions or
  `version <= 0`. Restores graceful upgrade across mixed-version clusters
  during the rolling-out window.
- **CHANGE** `Bundle.assemble()` only emits `platformSecrets.letsEncrypt`
  when the input supplies an `atRestKey` — keeps v2 bundles minimal when
  the issuing core has no LE secret to ship. Bundle version stays `2`
  regardless.
- **CHANGE** `applyBundle.writeOverrideConfig()`: when the bundle ships
  `platformSecrets.letsEncrypt.atRestKey`, write it under
  `letsEncrypt.atRestKey` in the joiner's `override-config.yml`.
- **CHANGE** `cliOps.newCore()` accepts `secrets.letsEncryptAtRestKey`;
  forwards to `Bundle.assemble`. `bin/bootstrap.js` reads
  `config.get('letsEncrypt:atRestKey')` and threads it through (only when
  it's a real value — `REPLACE ME` placeholder is filtered out by
  `isUsableSecret`).
- **TESTS** `[BUNDLE]` +6 cases (omits/carries `letsEncrypt`, accepts v1
  shape, accepts v2 shape, rejects version 0, rejects malformed
  `letsEncrypt`); `[APPLYBUNDLE]` +1 case (writes
  `override.letsEncrypt.atRestKey`); `[BOOTSTRAPE2E]` +1 case (issuer →
  consumer round-trip of `atRestKey`). `just test business`: 363/0 (was
  354).

## Cluster-mode state fixes — accessState on PlatformDB + `cluster_kv` primitive

A class of bugs where module-scope `new Map()` looks fine in single-process
tests but breaks under `cluster.fork()` because each worker holds its own
copy. Surfaced in production as a 50 % auth-poll failure rate
(`/reg/access/:key` polls round-robin across workers; the second poll lands
on a worker whose Map is empty).

- **FIX** `components/api-server/src/routes/reg/accessState.js` — replaces
  the in-memory `new Map()` with PlatformDB-backed storage (rqlite
  `keyValue` rows under `access-state/<key>`). API turned async; the route
  in `routes/reg/access.js` is now async with try/catch wrappers. POST
  splits into `buildState()` → URL decoration (`pollUrl`/`authUrl`) →
  `persist()` so the URLs computed from per-core routing land in the
  stored state without an extra round-trip. Cluster-wide AND
  restart-survivable for free; the lazy expire on `get` matches the
  existing `tls-cert/*` posture.
- **NEW** `storages/interfaces/platformStorage/PlatformDB.js` — four new
  methods on the interface: `setAccessState(key, value, expiresAt)`,
  `getAccessState(key)`, `deleteAccessState(key)`,
  `sweepExpiredAccessStates(now?)`. rqlite engine implements them;
  `[ACCESSSTATE]` 8 conformance cases.
- **NEW** `components/messages/src/cluster_kv.js` — master-held key/value
  store + worker IPC primitive for the ephemeral cross-worker state
  class (single-core scope only; cross-core state goes to PlatformDB).
  Wire format `kv:get/set/delete/clear` with namespaced replies. Lazy
  expire on `get` + 60 s sweeper. In-process fallback when `process.send`
  isn't available (single-process tests, CLI tools). Wired in
  `bin/master.js` after `tcpPubsub.init()`. 14 unit cases under
  `[CLUSTERKV]`.
- **FIX** `components/business/src/mfa/SessionStore.js` +
  `components/business/src/mfa/index.js` — MFA session store backed on
  `cluster_kv` instead of a per-instance `Map`. API turned async
  (`create`/`has`/`get`/`clear`/`clearAll`). Same bug family as the
  accessState §12: login lands on worker A, verify hits worker B → "MFA
  session not found". The header comment that said "single-core only"
  reworded — under `cluster.fork()` "process-wide" is per-worker, not
  per-core. `[MT5A]` cross-worker case added.
- **NEW** `components/test-helpers/src/clusterFixture.js` +
  `components/api-server/test/clusterWorkers/accessStateWorker.js` +
  `components/api-server/test/access-state-cluster-seq.test.js` —
  multi-worker test fixture (forks N children via `child_process.fork`,
  JSON-RPC over IPC, ready handshake on boot). `[XS12A/B/C]` regression
  cases would fail against the pre-Plan-55 in-memory Map.

## Post-deps-bump fix-ups — uuid call sites + backloop.dev lazy require

Two follow-ups missed when the deps bump landed; both crashed the production
Docker image at boot before any config was read.

- **FIX** `components/business/src/mfa/Profile.js` +
  `components/business/src/mfa/SessionStore.js` — swap
  `const { v4: uuidv4 } = require('uuid')` →
  `const { randomUUID: uuidv4 } = require('node:crypto')`. Same alias, no
  call-site churn. The `uuid` package was dropped from `package.json` in the
  earlier deps bump but these two MFA files still required it; first MFA-
  touching require chain (`api-server/methods/auth/login → mfa`) crashed
  `MODULE_NOT_FOUND`. RFC-4122 v4 byte-equivalent.
- **FIX** `components/api-server/src/server.js` — move
  `require('backloop.dev').httpsOptionsAsync` from top-level into the
  `if (config.get('http:ssl:backloop.dev'))` block. `npm install --omit=dev`
  skips `backloop.dev` because workspace promotion marks it `"dev": true`
  in the lockfile, so the production image has no copy on disk; lazy-require
  keeps the dev-loop path working while letting prod boot.

## Deploy hardening — single-core LE first-boot, embedded DNS, Dockerfile

A bundle of five fixes surfaced by a fresh single-core Dokku deploy with
`letsEncrypt.enabled: true` + embedded DNS + ACME DNS-01 wildcard.

- **NEW** `components/business/src/acme/selfSignedPlaceholder.js` — when
  `letsEncrypt.enabled` is on and the configured `http.ssl.keyFile` doesn't
  exist yet, master writes a 1-day self-signed RSA-2048 cert at the
  configured paths *before forking workers*. Workers' `https.createServer`
  ENOENT-races would otherwise restart-loop the cluster until ACME issued
  the first cert. Real cert hot-swaps via `setSecureContext` when ACME
  completes (existing `acme:rotate` IPC + `reloadTls()` path). CN + SAN
  derived from `deriveHostnames()` — same hostname the eventual ACME cert
  carries. Pure node-forge (already a transitive of acme-client; no new
  dep).
- **CHANGE** `storages/engines/rqlite/src/rqliteProcess.js` — `-disco-mode
  dns` + `-bootstrap-expect 1` flags now gated on a new
  `cluster.discoveryEnabled: true` opt instead of unconditionally on
  `dnsDomain != null`. Single-core deploys with `dns.domain` set (so the
  embedded DNS can serve `<coreId>.<domain>`) no longer have rqlited block
  for 30 s waiting for `lsc.<domain>` peers via the embedded DNS that only
  starts *after* rqlited is ready.
- **CHANGE** `components/business/src/bootstrap/applyBundle.js` — bootstrap
  bundle now writes `cluster.discoveryEnabled: true` into the joiner's
  `override-config.yml` when the bundle ships a `cluster.domain` (DNS-based
  multi-core). DNSless multi-core deliberately leaves the flag unset —
  peers find each other via explicit `core.url` instead.
- **CHANGE** `components/dns-server/src/DnsServer.js` — embedded DNS now
  resolves `<coreId>.<domain>` from PlatformDB. Previously such queries
  fell into the `#answerUsername` path → NXDOMAIN, leaving the hostname
  advertised in `hostings.*.availableCore` (and used for inter-core HTTP
  routing) unreachable unless the operator pre-populated
  `dns.staticEntries`. New private branch consults
  `platform.getCoreInfo(prefix)` between `staticEntries` and the username
  fallback; record-emission tail extracted into `#emitCoreInfoRecords` and
  shared with `#answerUsername`. Operator overrides via `dns.staticEntries`
  still win.
- **CHANGE** `components/platform/src/Platform.js` — `coreIdToUrl()` now
  returns slash-terminated URLs in all branches (cache hit, derived,
  dnsLess fallback). Centralized via a small `withTrailingSlash()` helper.
  Three downstream consumers that did `coreUrl + '/something'` updated to
  drop the leading slash and avoid double-slash:
  `business/src/auth/registration.js` cross-core forward POST,
  `api-server/src/routes/reg/legacy.js` `?username=` redirect,
  `api-server/src/routes/reg/access.js` `pollBase` (defensive — operator
  may supply `core:url` with or without slash). Two `register.js` sites
  that bypass `coreIdToUrl()` (the `coreUrl || ApiEndpoint.build('', null)`
  fallbacks for the unknown-email and single-core/unconfigured branches)
  wrapped at the call site.
- **CHANGE** `Dockerfile` — `EXPOSE` now declares `80 443 3000 3001 4000
  53/udp` (was just `3000`). Dokku's `dokku ports:add` only publishes ports
  the Dockerfile exposes, so native HTTPS + embedded DNS deployments needed
  an explicit `docker-options:add` workaround. EXPOSE is informational
  only — no port is actually bound until the operator publishes it.
  `INSTALL.md` Dokku section gained a paragraph about
  `dokku ports:add http:80:80 https:443:443`.
- Local validation: PG `business` 354/0 (was 346, +8 new `[SSPL]` for the
  self-signed placeholder); PG `dns-server` 29/0 (was 26, +3 new `[DN35]`
  `[DN36]` `[DN37]` for the PlatformDB-resolved `<coreId>.<domain>` branch);
  rqlite-engine `[RQARGS]` 18/0 (was 15, +3 covering single-core /
  no-domain / discovery-without-domain); api-server PG full 967/0. Full
  `just test all` (PG) and `just test-mongo all` matrix at plan close.

## `z-schema` → `ajv` (with z-schema-shaped error wrapper)

- **DEP** `z-schema` removed from `package.json` `dependencies`. Replaced with `ajv@^8` + `ajv-draft-04` (our schemas use the draft-04 `id:` keyword) + `ajv-formats`.
- **NEW** `components/utils/src/jsonValidator.js` — backed by ajv-draft-04, exposes the slice of the legacy z-schema API that callers depend on (`validate(data, schema, callback?)` either sync-returning-bool or async-via-callback, `validateSchema(schema)`, `getLastError()` / `getLastErrors()` / `lastReport`). Errors are reshaped to z-schema's wire format: `{ code, params: [], message, path }` with z-schema-style codes (`PATTERN`, `OBJECT_MISSING_REQUIRED_PROPERTY`, `INVALID_TYPE`, `MIN_LENGTH`, `MAX_LENGTH`, etc.) so `commonFunctions._addCustomMessage` and the `messages: { CODE: { code, message } }` blocks in schema files keep working unchanged. `required`-error paths end with `/` (e.g. `#/`) to match z-schema's exact shape so paramId fallback in `_addCustomMessage` resolves correctly.
- **CHANGE** wrapper uses **per-schema fresh ajv instances**. Pryv schemas build new schema objects per request (e.g. `access.permissions(action)` returns a fresh top-level object each call, with nested `id: 'streamPermission'`); a shared registry would error with "reference resolves to more than one schema" on the second compile.
- **CHANGE** wrapper pre-processes each schema with `stripUnreferencedIds` — drops schema-level `id` strings whose values aren't `$ref`-targeted from anywhere in the schema. Distinguishes schema-level `id: 'foo'` (drop if unused) from data-property-named `id: { type: 'string' }` (always keep). Top-level id is preserved so self-references (e.g. `systemStreamsSchema → $ref: 'systemStreamsSchema'`) keep resolving.
- **CHANGE** `components/api-server/src/schema/event.js` — `id`-pattern regex replaced `\\:` (escaped colon) with plain `:`. ajv compiles `pattern` strings with the `u` (unicode) flag, which rejects unnecessary escapes; the colon is not a regex metacharacter and works in both modes.
- **CHANGE** `components/api-server/src/schema/methodError.js` — `subErrors.items.$ref: '#error'` (id-fragment) replaced with `$ref: '#'` (root self-reference). ajv-draft-04 doesn't auto-treat top-level `id: 'error'` as an in-document anchor; root self-ref is the portable form across both validators.
- **CHANGE** Three production callers migrated from `require('z-schema')`: `components/api-server/src/schema/validation.js` (the API method validator entry point), `components/business/src/types.js` (TypeRepository for event-type validation; both the lazy `TypeValidator.validateWithSchema` and the eager `TypeRepository._validator`), `components/api-server/test/helpers/validation.js` (test-side response-shape assertions). Callers consume the wrapper via `const { jsonValidator } = require('utils'); const v = jsonValidator()`.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0 (PG-pool exhaustion flake during cross-engine matrix runs cleared after `pg_ctl restart` — environmental, not from this slice).

## `mongodb` driver 4.17 → 7.2 bump

- **DEP** `mongodb` bumped from `^4.11.0` to `^7.2.0`. Three majors of driver: v5 removed callback-style APIs entirely (Promise-only), v6 dropped legacy `findOneAndUpdate` `{ value: doc }` wrapper (returns the doc directly), v7 ships BSON v7 + new connection-string parser + `@mongodb-js/saslprep`.
- **CHANGE** `storages/engines/mongodb/src/Database.js` — every collection method (`findOne`, `find().toArray()`, `insertOne/Many`, `updateOne/Many`, `findOneAndUpdate`, `deleteOne/Many`, `countDocuments`, `drop`, `listIndexes`, `dropDatabase`) wrapped via two new local helpers `p2c(promise, callback)` / `p2cWithDup(promise, callback)`. The Database class still exposes its callback-shaped public API to consumers (storages/business/api-server) — only the driver-facing internals changed. `findOneAndUpdate` now returns the doc directly: dropped the `r && r.value` indirection. The connection bootstrap no longer issues `db('admin').command({ setFeatureCompatibilityVersion: '6.0' })` — server FCV is an operator concern, not application init (and v7's `confirm: true` requirement breaks against older servers).
- Connection options (`connectTimeoutMS`, `socketTimeoutMS`, `writeConcern: { j, w }`, `appname`) all forward-compatible.
- `mongodb-core` was a stale `devDependency` with zero consumers — left in the file for now (separate cleanup if anyone touches it).
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0 (one PG-pool exhaustion flake during the cross-engine run sequence, not a regression — cleared after a `pg_ctl restart -m fast`).

## Drop `bluebird` from production runtime

- **DROP** `bluebird` from root `package.json` `dependencies`. 26 production files migrated. Pass 1 (8 sites) replaced `bluebird.try` / `bluebird.all` / `bluebird.map` / `bluebird.mapSeries` with native equivalents (`Promise.all`, `Promise.all(arr.map(fn))`, for-of + await). Pass 2 (74 sites) replaced `bluebird.fromCallback((cb) => fn(args, cb))` with a tiny in-tree helper `fromCallback` exposed from `components/utils/`.
- **NEW** `components/utils/src/fromCallback.js` — 9-line wrapper that turns a `(cb) => ...` thunk into a Promise resolving with the callback's value (or rejecting with the callback's err). Identical semantics to bluebird's `fromCallback`. Exported as `utils.fromCallback`.
- **MOVE** `bluebird` from `dependencies` to `devDependencies` — three test files (`components/storage/test/hook.js`, `components/hfs-server/test/support/child_process.js`, `storages/engines/mongodb/test/hook.js`) still import it for legacy promise wiring; migrating them is a test-infra refactor for later (or folds into TS+ESM). `npm ls bluebird --omit=dev` shows no direct production dep; `bluebird@3.7.2` survives only via `email-templates → consolidate` (out of our control).
- **CHANGE** `components/test-helpers/src/helpers-base.js` — dropped the no-op `bluebird: require('bluebird')` re-export. Zero consumers grep-confirmed.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0 (one transient `[WHBK] [BLNP]/[1VIT]` webhook-retry-state flake on a single matrix run, cleared on re-run — same family as the documented `[WH01]` flakes; not caused by this slice).

## Drop `async` (callback control-flow lib) from production runtime

- **CHANGE** 9 production files migrated from `async.series` / `forEachSeries` / `forEachOfSeries` / `until` to native `async`/`await` + for-of/while loops. Affected: `components/api-server/src/API.js` (forEachSeries → manual `runNextMethod` chain to preserve tracing+error semantics), `components/api-server/src/Result.js` (forEachOfSeries → `nextElement` chain), `components/api-server/src/methods/accesses.js` (forEachSeries + nested series → IIFE async/await), `components/api-server/src/methods/events.js` (series → linear async/await), `components/api-server/src/methods/profile.js` (series → callback chain), `components/hfs-server/src/metadata_cache.js` (series of mixed sync+promise → linear async/await; deleted unused `toCallback` helper), `components/test-helpers/src/{InstanceManager,DynamicInstanceManager}.js` (until → while loop), `components/test-helpers/src/data.js` (5 series sites → IIFE async/await; introduced tiny `runSeries` helper for `dumpCurrent`/`restoreFromDump` which mix callback-style step lists).
- **MOVE** `async` from `dependencies` to `devDependencies`. Several `*-seq.test.js` files still use `async.series` / `async.eachSeries`; migrating those is a test-infra refactor we can do alongside the TS+ESM conversion.
- `npm ls async --omit=dev` shows no direct dep; `async@3.2.6` remains as a transitive of `nconf` (boiler) and `winston` — out of scope here.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0.

## `cuid` → `@paralleldrive/cuid2` for production ID minting

- **DEP** Added `@paralleldrive/cuid2@^3.3.0` to `dependencies`. Moved `cuid@^2.1.8` from `dependencies` to `devDependencies` — test-helpers still uses `cuid.slug()` (cuid2 has no `.slug()` equivalent) so cuid is kept as a dev-only dep.
- **CHANGE** 17 production files migrated from `require('cuid')` to `const { createId: cuid } = require('@paralleldrive/cuid2')` (or `createId: generateId` where the local alias was `generateId`). All call sites already use `cuid()` (default 24-char form) — cuid2's `createId()` is a clean drop-in.
- **CHANGE** `components/api-server/src/schema/event.js` — id-format pattern broadened to accept three alternatives: system-stream id (`:scope:name`), legacy cuid v1/v2 (`^c[a-z0-9-]{24}$`), and cuid2 (`^[a-z][a-z0-9]{23}$`). The legacy pattern stays because existing IDs in databases are still cuid v1/v2 strings; the new pattern is required because cuid2 IDs don't share the `c…` prefix.
- **NOTE — externally visible format change**: every newly minted event/stream/access/webhook/session/password-reset ID will be **24 lowercase alphanumeric chars without a `c` prefix** (cuid2 format), versus the prior `c[a-z0-9-]{24}` (25 chars total) cuid v1/v2 format. Existing IDs in production databases remain valid (string columns; no migration). Clients that regex-validate IDs against the legacy `^c[…]` pattern will need updating; the relaxed schema regex above accepts both.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0.

## `lru-cache` 7.14 → 11.0; `cron` 2.4 → 4.4

- **DEP** `lru-cache` bumped from `^7.14.1` to `^11.0.0`. The default export is now `{ LRUCache }` (renamed in v8). Six call sites updated with the alias trick `const { LRUCache: LRU } = require('lru-cache')` so the existing `new LRU({ … })` constructions stay verbatim. Affected: `components/cache/src/index.js`, `components/hfs-server/src/metadata_cache.js`, `components/hfs-server/src/web/op/store_series_batch.js`, `storages/engines/postgresql/src/AuditStoragePG.js`, `storages/engines/sqlite/src/userAccountStorage.js`, `storages/engines/sqlite/src/userSQLite/Storage.js`. Constructor options (`max`, `ttl`, `dispose(value, key)`) are forward-compatible.
- **DEP** `cron` bumped from `^2.4.4` to `^4.4.0`. v4 changed the constructor: `new CronJob({ cronTime, onTick })` no longer works (the constructor is positional in v4); use `CronJob.from({ cronTime, onTick })` instead. Single call site updated in `components/previews-server/src/routes/event-previews.js`. Cron pattern format unchanged (6-field with seconds slot still supported).
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0.

## Tracing as a no-op shim; drop jaeger-client + cls-hooked + opentracing

- **CHANGE** `components/tracing/src/Tracing.js` — collapsed to a single `DummyTracing` no-op class. The exported `Tracing` and `DummyTracing` symbols both now point at the same no-op. The architectural slot is preserved so a future tracer (e.g. an OpenTelemetry adapter) can plug in here without touching consumers.
- **CHANGE** `components/tracing/src/index.js` — dropped the `isTracingEnabled` / `launchTags` config branches; `initRootSpan` always returns a `DummyTracing` instance. `tracingMiddleware` simplified to `(req, res, next) => { req.tracing ??= new DummyTracing(); next(); }`.
- **CHANGE** `components/tracing/src/databaseTracer.js` — replaced the Jaeger-driven monkey-patcher with `module.exports = function patch () {};`. Callers in `components/storage/src/index.js` and `storages/index.js` need no edits.
- **CHANGE** `components/tracing/src/HookedTracer.js` — replaced with a no-op `HookedTracer` class.
- **CHANGE** `components/hfs-server/src/tracing/cls.js` — replaced with a no-op `Cls` class. `setRootSpan`/`getRootSpan`/`startExpressContext` all return null or pass through.
- **CHANGE** `components/hfs-server/src/tracing/middleware/trace.js` — passthrough that calls `next()`.
- **CHANGE** `components/hfs-server/src/application.js` — dropped `opentracing` and `jaeger-client` imports; `produceTracer` removed; replaced with an inline `NoopTracer` / `NoopSpan` minimal stub used by `Context#childSpan`.
- **CHANGE** `components/hfs-server/src/server.js` — removed the `if (traceEnabled)` block that registered the trace+cls middleware. The `traceEnabled` config flag and the `clsWrapFactory` / `tracingMiddlewareFactory` imports are gone.
- **CHANGE** `components/hfs-server/src/web/controller.js` — `storeErrorInTrace` no longer reads `opentracing.Tags.ERROR`; it tags the root span (now always null) with the literal string `'error'`. With cls returning null, the function early-returns; behaviour is unchanged from the prior `trace.enable: false` default.
- **DROP** from `package.json` `dependencies`:
  - `jaeger-client`
  - `cls-hooked`
  - `opentracing`
  - `shimmer`
- `npm ls jaeger-client opentracing cls-hooked shimmer --omit=dev` is empty.
- **AGENTS.md** truth #6 rewritten to describe the slot-shim model and direct future tracer authors to `components/tracing/src/Tracing.js`.
- New Relic APM (Plan 38) is the active observability path and runs in parallel, not through `components/tracing/`. Operators using New Relic see no change. Operators relying on `trace.enable: true` (none we're aware of) will find the flag is now ignored — Jaeger is gone.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0.

## Dependency cleanup batch — Plan 52 Phase 4

- **DROP** `hjson` from `package.json`. Zero call sites in the entire repo (production or test).
- **DROP** `url` from `package.json`. The single `require('url')` site in `components/test-helpers/src/spawner.js` resolves to the Node 24 built-in `url` module (same name) — the npm package was a no-op shadow.
- **DROP** `mkdirp` from `package.json`. Replaced 8 call sites across 6 production files + 1 test-helper file with `fs.mkdir(path, { recursive: true })` / `fs.mkdirSync(path, { recursive: true })` (Node ≥ 10). Affected: `components/business/src/integrity/MulterIntegrityDiskStorage.js`, `components/previews-server/src/attachmentManagement.js`, `components/storage/src/userLocalDirectory.js`, `storages/engines/filesystem/src/EventLocalFiles.js`, `storages/engines/sqlite/src/usersLocalIndex.js`, `storages/engines/rqlite/src/rqliteProcess.js`, `components/test-helpers/src/data.js`.
- **DROP** `body-parser` from `package.json`. Replaced 3 production sites + 3 test sites with the express-built-in equivalents (`express.json()` / `express.urlencoded()`) — Express 4.16+ ships them. Affected: `components/api-server/src/expressApp.js`, `components/hfs-server/src/server.js`, `components/previews-server/src/expressApp.js`, plus three local-`HttpServer` test mocks.
- **MOVE** `awaiting`, `fs-extra`, `backloop.dev`, `msgpack5` from `dependencies` to `devDependencies`:
  - `awaiting` is required by 3 acceptance test files and zero production files.
  - `fs-extra` is required by 1 storage test file and zero production files.
  - `backloop.dev` is loaded only behind the `http:ssl:backloop.dev` config flag in `components/api-server/src/server.js`, a local-dev convenience; production runs use ACME (Plan 35) or operator certs.
  - `msgpack5` is required by `components/test-helpers/src/{child_process,spawner}.js` only.
- **AGENTS.md**: added architectural truth #6 documenting that `components/tracing/` remains a real production dependency (8 hot-path call sites) even when Jaeger is disabled, and that `trace.enable: false` only short-circuits the `Tracing` body — wiring is hot-path. Future deletion of `components/tracing/` requires touching all 8 callers in the same patch (filed as `XXX-Backlog/PLAN52-PHASE4-TRACING-RIPOUT.md`).
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → matches Plan 52 Phase 3.S.2 baseline.
- Out of scope (filed for follow-up): drop `async` callback-control-flow lib (`XXX-Backlog/PLAN52-PHASE4-ASYNC-CALLBACK-DROP.md`), drop `bluebird` (recommended to fold into TS+ESM migration), replace `unix-timestamp`'s duration DSL, major bumps for `lru-cache` / `cron` / `slug` / `email-templates` / `nodemailer` (`_plans/XX-deps-major-bumps-later/PLAN.md`), `mongodb` 4→7 (own plan TBD), `z-schema` → `ajv` (own plan TBD), `cuid` → `cuid2` (own plan TBD).

## `superagent` → native `fetch` complete; `superagent` moved to `devDependencies`

- **CHANGE** `components/api-server/src/methods/helpers/mailing.js` — `_sendmail()` uses native `fetch`. Callback contract preserved (`cb(err, res)`); `parseError()` now also matches `ENOTFOUND`/`ECONNREFUSED` in the unreachable-endpoint branch since native fetch's reject messages differ from superagent's.
- **CHANGE** `components/business/src/mfa/Service.js` — `_makeRequest()` uses native `fetch`, JSON-encoding non-string POST bodies and explicitly throwing on `!res.ok` so the existing `try/catch → invalidOperation('mfa-sms-provider-error')` translation still fires. Consumers (`SingleService`, `ChallengeVerifyService`) `await` without reading the response body, so the swap is transparent at call sites.
- **DEP** `nock` bumped from `^13.2.9` to `^14.0.13` (latest stable). v14's headline feature is native `fetch` interception via `@mswjs/interceptors`, which is what unblocked the two swaps above. Engine constraint `>=18.20.0 <20 || >=20.12.1` is satisfied by Node 24. No test API surface change required — `nock(host).post(...).reply(...)` chain works identically.
- **FIX** `components/api-server/test/mfa-seq.test.js` — `nock.enableNetConnect('127.0.0.1')` widened to `enableNetConnect(/127\.0\.0\.1|localhost/)`. nock v14 intercepts native `fetch` too, and the rqlite client (`DBrqlite.query`/`execute`) connects to `localhost:4001` — `'127.0.0.1'` and `'localhost'` are not aliased by the allowlist.
- **DEP** `superagent` moved from `dependencies` to `devDependencies` (still needed by `components/test-helpers/src/{request,parallelTestHelper}.js`). Production runtime no longer pulls `superagent` — and therefore no longer pulls its transitive `formidable@2.1.5`. `npm ls formidable --omit=dev` is now empty; `formidable` survives only via the test surface.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1734 / 0 (one pre-existing flake `[AUTH] [AU01] [FMJH]` on concurrent login race, not caused by this slice — re-runs cleanly).
- Closes Plan 52 Phase 3.S.2 (combined with the previous Phase 3.S.1 commit, all four production `superagent` call sites are now on native `fetch`). Phase 3.F (formidable cleanup) auto-closed: production dep graph is `formidable`-free.

## `superagent` → native `fetch` for `business/types.js` and `business/webhooks/Webhook.js`

- **CHANGE** `components/business/src/types.js` — `TypeRepository.tryUpdate()` now fetches the remote event-types definition via Node's native `fetch` instead of `superagent`. Throws an explicit `Error("Event types fetch failed: HTTP <status> <statusText>")` on non-2xx so the existing `try/catch → unavailableError(err)` path still triggers. No behavior change at the call sites.
- **CHANGE** `components/business/src/webhooks/Webhook.js` — `makeCall()` uses native `fetch`. To preserve the prior superagent semantics consumed by `runOnce()` and the `webhooks.test` API method, `makeCall()` now explicitly throws on `!res.ok` with `err.response = { status }` attached; native `fetch` does not throw on 4xx/5xx by default. Removed the unused `request = require('superagent')` import.
- **NOT IN THIS SLICE**: `components/api-server/src/methods/helpers/mailing.js` and `components/business/src/mfa/Service.js` still use `superagent`. Both call sites are exercised by tests that intercept HTTP via `nock@^13.5.6`, which does not intercept Node 24's native `fetch` (Undici dispatcher). Migrating these two requires either upgrading to `nock@^14` (native fetch interceptor) or switching the affected tests to a real local HTTP server. Tracked in the next Phase 3.S.2 slice; out of scope here.
- `superagent` therefore stays in runtime `dependencies` for now. The two completed swaps still reduce the production runtime's reliance on it.
- Local validation: PG `just test all` → 1742 / 0; Mongo `just test-mongo all` → 1735 / 0 (both match Phase 3.L baseline).

## `@pryv/boiler` vendored as an in-tree workspace package

- **NEW** `components/boiler/` workspace package — exact copy of the `@pryv/boiler@1.2.4` source tree (8 files, 4 src/ files + lib/nconf-yaml + README + LICENSE + package.json). Resolves under the existing npm-workspace symlink at `node_modules/@pryv/boiler` so every `require('@pryv/boiler')` call site continues to work unchanged.
- `package.json` — `@pryv/boiler` removed from runtime `dependencies`; the workspace package now satisfies the import. No longer pulls boiler from the upstream `pryv/pryv-boiler.git#semver:^1.2.4` git URL at install time.
- `package-lock.json` — boiler's transitive deps (`debug`, `js-yaml`, `nconf`, `superagent`, `winston`, `winston-daily-rotate-file`) now resolve against the in-tree workspace; root-level entries unchanged in production behaviour.
- Local validation: `just test all` (PG default) → 1742 / 0 (matches pre-vendoring baseline).
- Why: this is the first slice of a phased removal. With boiler in-tree we can drop the remote-config `superagent` path, the unused `notifyAirbrake`/airbrake stubs, and the `pluginAsync` ordering surface in follow-up commits without coupling those changes to a `package.json` dep change. Each simplification step is a standalone commit with its own test pass.

## CI back to fully green; PostgreSQL-only test job

- **FIX** `storages/engines/rqlite/scripts/setup` — replaced `$0` with `${BASH_SOURCE[0]}` for `SCRIPT_FOLDER` resolution. The script is sourced (not exec'd) from `scripts/setup-dev-env`, which made `$0` resolve to the parent script's directory. As a result `REPO_ROOT=$SCRIPT_FOLDER/../../../..` landed one parent above the actual repo root, and `bin-ext/rqlited` was installed outside the repo. The start script (which uses its own correct path resolution) then could not find the binary, rqlited never came up, and every test that touches PlatformDB failed with `TypeError: fetch failed → ECONNREFUSED` against `localhost:4001`. Masked since 2026-04-14 by `continue-on-error: true` on the test jobs.
- **FIX** `storages/engines/mongodb/scripts/setup` — same one-line fix for consistency. The latent bug did not manifest for mongo because mongo's setup uses `$VAR_PRYV_FOLDER` (exported correctly by the parent) for path computation rather than `SCRIPT_FOLDER`.
- **FIX** `storages/engines/postgresql/src/userAccountStorage.js` — `getPasswordHash()` now returns `undefined` (not `null`) when no password row exists, matching the conformance contract and the MongoDB engine. `getCurrentPasswordTime()` now throws `Error("No password found in database for user id ...")` when no row exists, matching the MongoDB engine's behaviour. Closes the three pre-existing PG-side `[UAST]` conformance failures (`[V54S]` + the `clearHistory()` and `_clearAll()` round-trip checks).
- `.github/workflows/ci.yml` — `test-mongo` job removed. PostgreSQL is the default baseStorage engine since 2026-04-24; MongoDB is opt-in (`just test-mongo all`) and validated locally rather than in CI. `continue-on-error: true` stopgap removed from `test-postgres`; the job is fully blocking again. `docker` job depends only on `test-postgres` + `lint`.

## AGENTS.md — orientation doc for LLM coding agents

- **NEW** `AGENTS.md` at repo root — fast-orientation guide for LLM coding agents (Claude Code, Cursor, Copilot, etc.) bootstrapping against open-pryv.io v2. Covers the "single-binary codebase" framing, annotated repo map, local-run + test commands, five architectural truths (master.js lifecycle, native TLS, wildcard certs via `deriveHostnames`, pluggable storage engines, cluster CA lifecycle), common pitfalls, config precedence, and a curated block of in-repo + pryv.github.io links.
- `README.md` — "For LLM coding agents" paragraph at the bottom points at `AGENTS.md`.
- The draft that preceded this entry had drifted against the tree (non-existent `just dev` / `just test-postgres` recipes, wrong engine-config YAML keys, stale meta-repo framing, outdated `README-DBs.md` warning). All such issues fixed; file length 218 lines, under the 250-line soft cap.

## In-process mail component (services.email.method = 'in-process')

- **NEW** `components/mail/` workspace package — ports `Sender` / `Template` / `errors` from the standalone service-mail repo; adds `TemplateRepository` against an injected `templateExists` (so the backing store can be tmp-dir, disk or PlatformDB) and a tmp-dir-materialize `emailTemplatesDelivery` adapter around the `email-templates` npm module. Façade `init()` / `isActive()` / `send()` / `refresh()` / `close()` with silent no-op before init so callers don't need to guard.
- **NEW** `components/mail/src/TemplateSeeder.js` — idempotent `seedIfEmpty({platformDB, templatesRootDir})`. Walks `<root>/<type>/<lang>/*.pug` and populates PlatformDB only when zero `mail-template/*` rows already exist.
- **NEW** master-boot wiring — invokes the seeder after `storages.init()` when `services.email.method === 'in-process'`. Try/catch guard: a malformed `templatesRootDir` never blocks master startup.
- **NEW** PlatformDB interface methods — `setMailTemplate` / `getMailTemplate` / `getAllMailTemplates` / `deleteMailTemplate(type, lang, part?)`. Keyspace `mail-template/<type>/<lang>/<part>` on the existing rqlite `keyValue` table. `deleteMailTemplate(type, lang)` with no `part` wipes both html + subject scoped to that `<type>/<lang>/` prefix only.
- **NEW** `components/api-server/src/methods/helpers/mailing.js` — new `'in-process'` case in the `method` switch. First call in a worker lazy-inits the `mail` façade with `storages.platformDB.getAllMailTemplates` + the per-core SMTP config. Callback contract preserved — existing callers (`registration.js::sendWelcomeMail`, `account.js` reset-password flow) don't need any edit.
- **NEW** admin surface — `bin/mail.js` CLI + `/system/admin/mail/*` routes (see `CHANGELOG-v2.md`). Write routes emit `process.send({type:'mail:template-invalidate'})` so master broadcasts the nudge to every sibling worker (including the originating one is skipped); each worker's `components/mail/src/index.js` subscribes via `process.on('message', …)` in `init()` and calls `refresh()` on receipt.
- **NEW** master IPC handler — `cluster.on('message', …)` case for `mail:template-invalidate`; broadcasts to all workers except the originator.
- **DEPS**: `email-templates@^10.0.1`, `nodemailer@^6.9.16`, `pug@^3.0.4` added as production deps on the root `package.json`. No transitive conflicts with the existing stack.
- **TESTS**:
  - `[MAILTMPL]` 7 cases on `components/platform/test/conformance/PlatformDB.test.js` — round-trip, null-absent, overwrite, bulk decode, single-part delete, lang-wide delete scoped, namespace isolation from `dns-record/*` / `user-core/*` / `observability/*`.
  - `[MAILSEND]` / `[MAILTMPL]` / `[MAILREPO]` / `[MAILADAPT]` / `[MAILFCD]` / `[MAILSEED]` — 21 unit tests under `components/mail/test/`.
  - `[MLIP]` 2 cases on `components/api-server/test/methods/helpers/mailing.test.js` — end-to-end Pug render + nodemailer jsonTransport dispatch via the helper.
  - `[MAILCLI]` 9 subprocess cases + `[MAILADM]` 9 HTTP cases on `components/api-server/test/`.

## Docker image layout: rqlited moved to `/app/bin-ext/`

- `Dockerfile` — rqlited binary relocated from `/app/var-pryv/rqlite-bin/rqlited` → `/app/bin-ext/rqlited`. Operators who bind-mount `/app/var-pryv` (intending to persist rqlite data) no longer shadow the baked-in binary. The only persistent path docker operators need is `/app/var-pryv/rqlite-data`, now declared as `VOLUME`.
- Dev layout aligned: `var-pryv/rqlite-bin/rqlited` → `bin-ext/rqlited` in the setup script, start script, rqlite manifest default, bin/master.js fallback, and two test files that hard-coded the path. `.gitignore` covers the new location.
- Operators who override `storages.engines.rqlite.binPath` in `override-config.yml` are unaffected either way.
- `INSTALL.md` — new "Docker / Dokku deployment" section with a "What to persist" checklist, Dokku-specific storage mount commands, and an explicit note about `dokku ps:restart` requiring `dokku proxy:build-config <app>` afterward (nginx upstream caching bug that doesn't refresh on restart). Also documents the `DATABASE_URL`-not-auto-consumed caveat and the UDP/53 docker-options workaround for DNS-active multi-core on Dokku.

## Default baseStorage engine: PostgreSQL

- `config/default-config.yml` — `storages.base.engine` is now `postgresql` (was `mongodb`). Mongo remains fully supported; set `storages.base.engine: mongodb` in `override-config.yml` (or export `STORAGE_ENGINE=mongodb` for tests) to pick it explicitly. Deployments that pin the engine in `override-config.yml` are unaffected.
- `justfile` — `just test` + `just test-parallel` + all other `test-*` recipes run PG by default. New `just test-mongo` / `just test-mongo-parallel` recipes for the Mongo path. Removed: `test-pg`, `test-pg-parallel` (now redundant).
- `.github/workflows/ci.yml` — `test-postgres` job runs `just test all`, `test-mongo` job runs `just test-mongo all`.

## Optional observability — internal shape

- **New module** `components/business/src/observability/` — provider-agnostic façade. `isActive() / setTransactionName / recordError / recordCustomEvent / startBackgroundTransaction`. Every provider call wrapped in try/catch so observability can never break a request.
- **New module** `components/business/src/observability/logForwarder.js` — wraps a boiler logger to mirror its level methods into `observability.recordError / recordCustomEvent`. Errors always go to the provider's Error inbox regardless of log level; warn/info/debug become `PryvLog` custom events queryable via NRQL.
- **New module** `components/business/src/observability/providers/newrelic/{boot,adapter,newrelic.config.template}.js` — thin wrapper over the `newrelic` npm package. Agent config is driven entirely by env vars the master process populates, so no on-disk config edits are required per deployment.
- **New shim** `bin/_observability-boot.js` — must be `require()`d first in every entrypoint. Bypasses in `NODE_ENV=test` or when `PRYV_OBSERVABILITY_PROVIDER` is unset; otherwise dispatches to the provider's boot module so the underlying agent loads before `http` / `express` / `pg` / etc.
- **PlatformDB surface**: new `setObservabilityValue / getObservabilityValue / getAllObservabilityValues / deleteObservabilityValue`. Keyspace `observability/<key>` in the existing rqlite `keyValue` table — no schema change.
- **Platform surface**: new `getObservabilityConfig()` merges local YAML override + PlatformDB rows + derived fields (hostname from `new URL(core.url).hostname`, appName fallback). Local `observability.enabled: false` always wins; otherwise PlatformDB is authoritative. Secret rows decrypted on demand via `AtRestEncryption` with HKDF-derived keys (source: `auth.adminAccessKey`, per-key purpose label).
- **Master wiring**: reads `platform.getObservabilityConfig()` before forking workers, builds a shared `observabilityEnv` object, and spreads it into every `cluster.fork({...})` call (api / hfs / previews). Environment variables include `PRYV_OBSERVABILITY_PROVIDER`, `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_APP_NAME`, `NEW_RELIC_PROCESS_HOST_DISPLAY_NAME`, `NEW_RELIC_LOG_LEVEL`, `NEW_RELIC_HIGH_SECURITY=true`, `NEW_RELIC_HOME`.
- **Admin CLI** `bin/observability.js` — `storages` barrel directly, no HTTP. Parses `--help` before boiler init (same pattern as `bin/dns-records.js`).

### Tests
- `storages/engines/rqlite/test/platformdb-conformance.test.js` — 6 new `[RQPF]` cases under the shared `components/platform/test/conformance/PlatformDB.test.js`: round-trip, overwrite/rotation, bulk read, delete, namespace isolation vs `dns-record/*` and `user-core/*`.
- `components/api-server/test/observability-seq.test.js` — `[OBS]` suite (9 cases): Platform round-trip with encryption, local `enabled:false` override wins, appName fallback, hostname derivation, façade no-op when no provider, shim `NODE_ENV=test` bypass, shim unset-env no-op, logForwarder errors-only default, logForwarder `warn` level forwards errors + warns.

## Multi-core registration, service-info, and auth-popup fixes

Surfaced during pryv.me v2 rollout. The items below make cross-core registration atomic, expose the SDK-expected shape of `/service/info` + `/reg/access`, and fix several subtle multi-core plumbing bugs that appeared once a real two-core deployment hit a freshly-delegated domain.

### Cross-core registration: transparent HTTPS forward

Previously, a POST `/users` landing on a core whose `core.id` didn't match the user's chosen hosting would call `Platform.validateRegistration`, which **reserved unique fields + wrote `user-core/<username>`** in PlatformDB, then returned `{core: {url: targetCoreUrl}}` for the client to re-POST. Non-compliant SDKs silently swallowed the redirect, stranding orphaned `user-core` rows and empty PG on the target core.

- `components/business/src/auth/registration.js` — new `forwardIfCrossCore` step inserted into the `auth.register` chain between `prepareUserData` and `validateOnPlatform`. Calls `platform.selectCoreForRegistration(hosting)`; if target ≠ self, HTTPS-POSTs the original body to `{targetUrl}/users` (the target's own `forwardIfCrossCore` is idempotent when target == self). Target's response (minus its own `meta` block) is merged into `result.forwarded`. Atomic on the target: unique-field reservation, user-core assignment, user insert, welcome mail all on one core.
- `validateOnPlatform`, `createUser`, `buildResponse`, `sendWelcomeMail` all short-circuit on `result.forwarded` — no duplicate work, no duplicate mail.
- `components/platform/src/Platform.js` — `validateRegistration(username, invitationToken, uniqueFields, hosting)` now takes + honours the caller-provided hosting. Previously it always called `selectCoreForRegistration()` without the hosting filter, so with a least-users tiebreak a new aws-us-east-1 registration could leak to aws-eu-central-1 just because the latter had fewer users.
- `components/api-server/src/methods/auth/register.js` — wires `forwardIfCrossCore` into the `auth.register` method chain.

### `/service/info` multi-core shape

- `components/api-server/src/schema/service-info.js` — added optional `version` field.
- `components/api-server/src/methods/service.js` — populates `version` from `getAPIVersion()`. `lib-js` + `app-web-auth3` gate on `version >= 1.6.0` to pick the direct-core `/users` registration endpoint. Before this, our `/service/info` had no version → SDKs fell back to the legacy `/reg/user` via reg.{domain} round-robin, which (before the forward fix) compounded the orphaned-user-core bug.
- `config/plugins/public-url.js` — in multi-core (`dnsLess.isActive: false`) mode, `register: https://reg.{domain}/` and `access: https://access.{domain}/access/` instead of the old `register: https://core-{id}.{domain}/reg/`. The reserved-subdomain URLs are core-symmetric and match the v1 Pryv.io URL shape; `regSubdomainPathMap` middleware (below) handles the `/reg` prefix inside the core.
- `config/plugins/config-validation.js` — new `REQUIRED_SERVICE_FIELDS = ['name', 'serial', 'home', 'support', 'terms', 'eventTypes']` check. Master fails fast with a clear error instead of starting into an api-server crash-loop when operators forget the `service:` block.
- `bin/master.js` — added `config-validation` plugin to master's boiler init (previously only in api-server's `application.js`), so the service-required-fields check triggers on master bring-up too.

### Distribution-reserved DNS subdomains

- `components/dns-server/src/DnsServer.js` — new `RESERVED_SERVICE_NAMES = ['reg', 'access', 'mfa']`. The embedded DNS auto-resolves these three subdomains to every available core's IP (via `getAllCoreInfos()`), no `dns.staticEntries` required. Operators still own `sw`, `mail`, etc. via staticEntries; documented in `config/default-config.yml`.
- `components/api-server/src/expressApp.js` — two multi-core-only middleware additions:
  1. `subdomainToPath`'s `ignoredSubdomains` list now includes `reg`, `access`, `mfa`, and every key from `dns.staticEntries`. Without this, `access.pryv.me` (6 chars, matches the username regex) was rewritten to `/access/…` and fell into the username router.
  2. New `regSubdomainPathMap` middleware: when `Host: reg.{domain}` (or `access.` / `mfa.`), prepend `/reg` to `req.url` before route matching. Lets clients use rootless v1-style URLs (`reg.pryv.me/perki/server`, `reg.pryv.me/service/info`) while the internal routing stays under `/reg/*`. Idempotent — skips when the path already starts with `/reg/`.
- `components/api-server/src/routes/register.js` — when `dnsLess.isActive: false`, also expose `GET /service/info` at the root (alias for `/reg/service/info`). Lets SDKs bootstrap from `https://reg.{domain}/service/info` directly.
- `components/api-server/src/routes/reg/legacy.js` — `GET` + `POST /reg/:uid/server` now look up the core via `platform.getUserCore()` (PlatformDB, replicated) instead of `usersRepository.usernameExists()` (per-core SQLite index). Without this, round-robin DNS on reserved subdomains caused 50 % 404s because only the user's home core had them in its local index. `getCoreUrlForUser` returns `null` when no mapping exists so the handler 404s cleanly.

### `/reg/access` (auth popup) shape

- `components/api-server/src/routes/reg/access.js` — POST `/reg/access` response now includes:
  - `authUrl` (primary) — built from `access.defaultAuthUrl` + query params (lang, key, requestingAppId, poll, poll_rate_ms, serviceInfo). SDKs open this URL in the sign-in popup.
  - `url` (deprecated) — same value, kept for v1 SDK compatibility.
  - `poll` — **core-affine URL built from `core.url`**, not the cluster-wide `service.register`. The poll state is in-memory per core, so a poll GET must pin to the same core that served the POST; using `service.register` round-robined across cores and caused `unknown-access-key` on half the polls.
  - `lang`, `returnURL` + `returnUrl` (camelCase lib-js expects), `serviceInfo` (v1-compatible — SDKs re-hydrate from the body).
- GET `/reg/access/:key` NEED_SIGNIN response now mirrors the same fields (poll, authUrl, url, lang, returnUrl/returnURL, serviceInfo) so `app-web-auth3`'s `context.init() → setServiceInfo(accessState.serviceInfo)` doesn't crash with "Cannot read properties of undefined (reading 'name')" and clients re-hydrating state from the poll body see the poll URL.
- `state.pollUrl` + `state.authUrl` are stashed on the in-memory access state at POST time so the subsequent GETs echo them verbatim.

### Multi-core plumbing

- `bin/master.js` — `cluster.setupPrimary({ args: process.argv.slice(2) })` before forking workers. `cluster.fork()` by default runs the worker with only `[node, master.js]` — argv after the script name is silently dropped. Deployments that layered `--config host-config.yml` had their workers fall back to `NODE_ENV`-based config and silently use the wrong storage engine / ports.
- `components/middleware/src/project_version.js` — `process.mainModule || require.main || module` fallback. `process.mainModule` was deprecated and can be `undefined` in Node 22 when the entrypoint is loaded via a wrapper or cluster fork; the old code threw `TypeError: Cannot read properties of undefined (reading 'paths')` which was swallowed by boiler's file logger and surfaced as silent api-server worker crash loops.
- `components/api-server/bin/server` — catch-block mirrors fatal errors to `process.stderr`. Master's `api worker died (code=1, signal=null)` now always has an actionable cause attached instead of being silent.
- `components/business/src/acme/CertRenewer.js` + `AcmeOrchestrator.js` + `bin/master.js` — `PlatformDBDnsWriter` accepts an optional `dnsServer` and calls `dnsServer.refreshFromPlatform()` immediately after writing `_acme-challenge.<zone>` TXT to PlatformDB. Previously relied on the DnsServer's 30 s periodic refresh, so LE's DNS-01 validator often failed with "No TXT records found". `AcmeOrchestrator.build()` threads `dnsServer` through; `bin/master.js` passes it. Real LE wildcard issuance on a fresh cluster now succeeds on the first attempt instead of 15–30 min after rqlite caught up.
- `components/business/src/auth/registration.js::sendWelcomeMail` — guards against missing `services.email` in config (fresh bundle-bootstrapped cores have no default) and against forwarded registrations (target core already sent the mail). Before, a missing `services.email` threw `Cannot read properties of undefined (reading 'enabled')` AFTER `createUser` had already persisted the user, leaking a 500 response to the client even though the registration had technically succeeded.

### systemStreams plugin: sync → pluginAsync

Latent bug since the v2 snapshot — only visible on a cluster that runs under `NODE_ENV=production` with a `production-config.yml` that does not re-declare `custom:systemStreams:account`. On the pryv.me cluster this surfaced as welcome-mail failing with `recipient.email = undefined` despite `POST /users` carrying `email` in the body and returning 201.

Root cause: `@pryv/boiler` loads `default-config.yml` AFTER running **synchronous** plugin extras, but BEFORE awaiting `pluginAsync` extras (via `config.initASync()`). The `systemStreams` plugin reads `config.get('custom:systemStreams:account')` and builds `accountMap` + `accountFields`. When registered as `plugin` (sync), it ran against a config that still had no `custom.*` block, so `accountMap` was missing `:system:email`, `User.loadAccountData` never copied `params.email → user.email`, and `registration.js::sendWelcomeMail` saw `undefined`. In dev/test this was hidden because `{development,test}-config.yml` declare `custom.systemStreams.account` in the base scope (loaded before sync plugins).

Fix: 16 occurrences of `{ plugin: require('.../config/plugins/systemStreams') }` changed to `{ pluginAsync: require(...) }`. `pluginAsync.load(config)` is awaited in `initASync()` (boiler `config.js:220`), after `default-config.yml` loads at line 156. All downstream code that reads `config.get('systemStreams')` (notably `accountStreams.init()` via `await getConfig()` in `components/business/src/system-streams/index.js`) already awaits `configInitialized`, so no race.

Files touched: `bin/{master,bootstrap,migrate,backup,dns-records,integrity-check}.js`, `components/api-server/src/application.js`, `components/webhooks/src/application.js`, `components/hfs-server/src/application.js`, `components/previews-server/src/{server,runCacheCleanup}.js`, `components/api-server/test/helpers/core-process.js`, `components/test-helpers/src/api-server-tests-config.js`, `components/test-helpers/scripts/dump-test-data.js`, `components/webhooks/test/test-helpers.js`, `components/hfs-server/test/acceptance/test-helpers.js`.

Test matrix re-verified after the switch — PG 1654/0, Mongo 1676/0. No test asserts a specific `accountFields` order that would have flipped with the new merge behaviour.

### Config validation: fail fast on unresolved `${VAR}` placeholders

`production-config.yml` uses shell-style `${PRYV_LOGSDIR}` / `${PRYV_DATADIR}` placeholders in path values, but nothing in the boiler/nconf stack actually expands them. When the env var was unset at `NODE_ENV=production` (e.g. a stray `bin/server` run during live debugging), Winston's file transport treated the literal string as a path and created a directory named `${PRYV_LOGSDIR}` on disk.

Fix: `config/plugins/config-validation.js::checkIncompleteFields` now matches `\$\{([A-Z_][A-Z0-9_]*)\}` in every string value alongside the existing `REPLACE` sentinel scan. Unresolved placeholders fail startup with a clear error naming the missing env var. Same `active: false` / `enabled: false` block-skip rules apply. `.gitignore` also picks up the literal `${PRYV_LOGSDIR}` / `${PRYV_DATADIR}` names so an accidental stray dir doesn't pollute `git status`.

### v1→v2 restore: `user-core/*` rows from register/servers.jsonl.gz

- `storages/interfaces/backup/FilesystemBackupReader.js` — new `readServerMappings()` method that streams `{username, server}` rows from `register/servers.jsonl[.gz]`. No-op when the register/ subdir is absent (open-pryv.io v1.9 or v2→v2 backups).
- `storages/interfaces/backup/BackupReader.js` — default `readServerMappings()` on the base interface yields an empty async iterator, so sources without register data (any reader that doesn't override it) inherit a safe default.
- `components/business/src/backup/RestoreOrchestrator.js` — `_restorePlatform` now also iterates `readServerMappings()`; for each mapping, writes a `user-core/<username>` row to PlatformDB. Maps the v1 server hostname (e.g. "co1.pryv.me") to whichever core is the SOLE available core on the destination — the common case for single-core restore. Multi-core destinations with more than one available core are left as a no-op for now; a future pass can accept a `--core-map` option. Previously v1→v2 restores left every user's DNS resolution broken until the operator manually INSERTed `user-core/*` rows.

### Tests

- `components/api-server/test/reg-multicore-dnsless-false-seq.test.js` (new) — regression suite covering the cross-core forward, `/reg/access` POST+GET shape, `/service/info` required fields + version + reserved subdomains, and the v1→v2 register-mappings restore path. Uses a targeted `global.fetch` interceptor (passes through to real `fetch` except for the inter-core forward URL) so the rqlite HTTP client keeps working during the test.
- `components/api-server/test/reg-multicore-seq.test.js` `[MC01A/B]` — rewritten from "must return redirect" to "HTTPS-forwards POST to target + atomic on failure" to match the new behaviour; same targeted-fetch interceptor.
- `components/api-server/test/service-info.test.js` `[FR4K]` — tolerates the new `version` field and the response-envelope `meta` block.
- `components/dns-server/test/dns-server.test.js` `[DN11]` — asserts reserved subdomain `reg.{domain}` resolves to A records (all core IPs), not CNAME.
- `components/cache/test/acceptance/cache.test.js` `[FELT]` — `this.retries(3)` on the 15%-cache-gain timing assertion. The thresholded comparison was flaky under scheduler noise on shared dev VMs (5–15 % gain range); retries turn transient noise into eventual success without weakening the signal.

## Validator + service-info method: fixes unearthed by the full test matrix

Surfaced when running the full matrix against the distribution changes above. Changes are small, isolated, and carry no API behaviour impact.

- `config/plugins/config-validation.js` — `checkIncompleteFields` now skips the `REPLACE` sentinel scan on any block where `active === false` or `enabled === false`. Fixes dead-code `if (obj.active && !obj.active) return` (always false). Unblocks default-config placeholders like `letsEncrypt.email: 'REPLACE ME'` / `letsEncrypt.atRestKey: 'REPLACE ME'` (operators only set these when `letsEncrypt.enabled: true`) from tripping startup in vanilla config.
- `components/api-server/src/application.js` — `config-validation` is now registered as `pluginAsync` (previously `plugin`). Required because `serviceInfo` (scope loaded from `serviceInfoUrl`) is itself async; the validator's required-service-fields check would otherwise fire before `service.*` was populated and always fail-fast with "service fields missing".
- `components/api-server/src/methods/service.js` — removed the first-call `this.serviceInfo` cache. Service info is now read live from config every request. The cache leaked state between tests sharing a single api-server and would also prevent future runtime `service:` updates (e.g. admin-API edits) from being visible without a restart.
- `components/api-server/src/routes/reg/legacy.js` — `getCoreUrlForUser` in single-core mode now verifies the user exists (`usersRepository.usernameExists()`) before returning the core URL. Previously any arbitrary username would resolve to the local URL, shadowing the 404 the `/reg/:uid/server` routes are supposed to emit for unknown users.

## Engine-agnostic schema migration runner

### New primitive
- `storages/interfaces/migrations/` — contracts + conventions for forward-only, timestamp-ordered schema migrations. `migration.d.ts` defines the `{ up, down? }` shape; `MigrationRunner.d.ts` defines the runner + `MigrationCapableEngine` contract; `README.md` captures the model (integer version +1 per migration, `YYYYMMDD_HHMMSS_<slug>.js` filenames, idempotency requirement, per-engine `schema_migrations` storage).
- `storages/interfaces/migrations/MigrationRunner.js` — runtime. `discoverMigrations()` walks an engine's `migrations/` dir and lex-sorts; `status()` reports per-engine `{ currentVersion, pending }`; `runAll({ targetVersion, dryRun })` applies `up()` in order and bumps version via the engine's `setVersion()`. `createMigrationRunner()` auto-wires from the active storages barrel, iterating engines that export `getMigrationsCapability()`.
- Per-engine tracking:
  - `storages/engines/postgresql/src/SchemaMigrations.js` — lazy `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, updated_at TIMESTAMPTZ ...)`; current version = `MAX(version)`.
  - `storages/engines/rqlite/src/SchemaMigrations.js` — JSON row in the existing `keyValue` table under key `migrations/version`.
  - Mongo does not participate in the v2 scheme — it has no schema evolution pressure in v2.

### Legacy removed
- Deleted `storages/engines/mongodb/src/Versions.js`, the entire `storages/engines/mongodb/src/migrations/` directory (`1.9.0.js`..`1.9.4.js`, `MigrationContext.js`, `index.js`), `storages/engines/mongodb/test/migrations/` (old test fixtures), `storages/engines/postgresql/src/VersionsPG.js`, `storages/interfaces/baseStorage/Versions.{js,d.ts}`, `storages/interfaces/baseStorage/conformance/Versions.test.js`.
- Removed `versions` table DDL from `DatabasePG.js` (it was unused and never populated anyway — `_internals.migrations` was never registered).
- Removed `migrations` / `MigrationContext` / `softwareVersion` from both engine `_internals.js` and the barrel's `registerInternals()`.
- Updated both engine manifests (`storages/engines/{mongodb,postgresql}/manifest.json`) to drop the three dead `requiredInternals`.
- `StorageLayer` no longer carries a `versions` field; `components/test-helpers/src/dependencies.js` + `data.js` + `databaseFixture.js` no longer reference it.
- v1 → v2 migration is now explicitly an export-via-`dev-migrate-v1-v2` → `bin/backup.js --restore` operation. No code path in v2 reads pre-v1.9.3 shapes.

### Wiring
- `bin/master.js` — replaced `storageLayer.versions.migrateIfNeeded()` with `createMigrationRunner().runAll()` gated by `migrations.autoRunOnStart` (default true). Renamed from `cluster.runMigrations` in `config/default-config.yml`.
- `bin/migrate.js` (new) — standalone CLI: `status` / `up [--target N] [--dry-run]`. Opens storages barrel directly; no HTTP; works whether master is running or not.
- Each engine's `index.js` now exports `getMigrationsCapability()` returning `{ id, migrationsDir, getVersion, setVersion, buildContext }` or `null` when the engine is inactive. The runner auto-discovers capabilities across all loaded engines.

### Tests
- `components/api-server/test/migrations-runner-seq.test.js` — `[MIGRUN]` suite (9 cases): fresh state, single migration, ordered multi-migration, dry-run, target version, idempotent re-run, engine-switch independence (two in-memory engines), failure-stops-run, live-barrel wiring.
- Legacy conformance `storages/interfaces/baseStorage/conformance/Versions.test.js` removed.
- All pre-existing suites green in both engines: `storage` 13/13, `business` 126/126, `api-server` 908/908 (+9 new `[MIGRUN]` cases).

## Persistent DNS records — admin surface

- `components/api-server/src/routes/reg/records.js`: added `DELETE /reg/records/:subdomain`. Path refactored to share auth + IPC-nudge helpers with the existing POST handler.
- `bin/dns-records.js` (new): standalone Node CLI — subcommands `list`, `load <file>`, `delete <subdomain>`, `export [file]`. Reads/writes PlatformDB directly via `storages` barrel (no HTTP dependency). Uses `js-yaml` (already transitively present; no new dependency). Parses `--help` before boiler init to avoid boiler's yargs swallowing it.
- `components/api-server/test/dns-records-cli-seq.test.js` (new, `[DNSCLI]`): spawns the CLI as a subprocess and round-trips `list` / `load` (including `--dry-run` and `--replace`) / `export` / `delete`, plus error paths (missing subdomain, malformed file).
- `components/api-server/test/reg-records-seq.test.js`: `[RR10]`-`[RR12]` cover the DELETE route happy path, missing-auth rejection, and unknown-subdomain 404.

Context: end-to-end persistence of runtime DNS records (PlatformDB interface, rqlite backend, `DnsServer` load-on-start + 30 s refresh + write-through, `POST /reg/records` persistence, existing `[RGRC]` test) was shipped earlier in the 2.0.0-pre line. This change adds the DELETE symmetry and the offline-capable admin CLI — the remaining gap for operating DNS records in production without depending on the HTTP API being healthy.

## Auto-renewed public TLS certificates (Let's Encrypt)

Green-field installs previously needed separate DNS + ACME + reverse-proxy setup before serving a single HTTPS request; multi-core wildcards required a DNS plugin plus manual cert copies across every node. Opt-in `letsEncrypt.*` folds all of that into the core: issuance, renewal, cluster-wide distribution, hot-swap on rotation.

### New module `components/business/src/acme/` (8 files)
- `AtRestEncryption.js` — HKDF-SHA256 key derivation + AES-256-GCM envelope. Source-agnostic (caller supplies the byte-string + purpose label). 22 `[ATRENC]` tests.
- `AcmeClient.js` — stateless wrapper over `acme-client@5.4.0`: `createAccount()` + `issueCert()`. Parses leaf-cert validity from the returned PEM so callers get `{certPem, chainPem, keyPem, issuedAt, expiresAt}`. Injectable `acmeLib` for unit tests. 9 `[ACMECLIENT]` tests.
- `certUtils.js` — `splitCertChain(pem)` (leaf vs. chain), `parseValidity(pem)` (via `node:crypto X509Certificate`), `hostnameToDirName('*.x.com')` → `'wildcard.x.com'`. 8 `[CERTUTILS]` tests.
- `CertRenewer.js` — glues AcmeClient + AtRestEncryption + PlatformDB. `ensureAccount()` (idempotent; persists encrypted ACME account), `renew({hostname, dnsWriter})` (issues + encrypts + persists + returns metadata), `getCertificate(hostname)` (decrypted). Strips wildcard prefix in challenge record names. 15 `[CERTRENEWER]` tests.
- `PlatformDBDnsWriter` — default DNS-01 writer for multi-core with embedded DNS. `setDnsRecord` appends to existing TXT values so apex + wildcard challenges coexist; propagation wait default 15 s.
- `FileMaterializer.js` — per-core polling loop. SHA-256 fingerprint-based change detection; atomic disk writes; `onRotate` fire-and-log semantics. `runRotateScript` spawns an operator-supplied absolute-path script with `PRYV_CERT_*` env vars; SIGKILL-timeouts at 30 s with exitCode 124. 11 `[FILEMAT]` tests.
- `deriveHostnames.js` — topology → `{commonName, altNames, challenge}` in priority order: `dnsLess.publicUrl` → HTTP-01 single host · `core.url` → HTTP-01 single host · `dns.domain` → DNS-01 wildcard + apex. Throws on missing with actionable error. Treats `REPLACE ME` placeholder as unset. 8 `[DERIVEHOSTS]` tests.
- `AcmeOrchestrator.js` — intervals and start/stop. Materialize tick (every core, default 60 s) + renew tick (only on the CA-holder core with `letsEncrypt.certRenewer: true`, default 24 h). Both prime on start(). `build({config, platformDB, atRestKey, onRotate})` is the operator-facing factory that `bin/master.js` calls. 10 `[ACMEORCH]` tests.

### PlatformDB primitives
- `storages/interfaces/platformStorage/PlatformDB.{js,d.ts}` — six new methods: `setAcmeAccount/getAcmeAccount` (singleton) + `setCertificate/getCertificate/listCertificates/deleteCertificate` (per hostname, wildcard keys stored as literals e.g. `tls-cert/*.mc.example.com`).
- `storages/engines/rqlite/src/DBrqlite.js` — impl. Keys: `tls-acme-account`, `tls-cert/<hostname>`.
- `components/platform/test/conformance/PlatformDB.test.js` — 9 new cases (`setAcmeAccount` / `getAcmeAccount` singleton + overwrite; `setCertificate` / `getCertificate` round-trip + null + overwrite + wildcard keys; `listCertificates` metadata-only contract; `deleteCertificate`; namespace isolation between tls-cert / dns-record / user-unique).

### Wiring
- `config/default-config.yml` — new `letsEncrypt:` block (9 keys: `enabled`, `email`, `atRestKey`, `renewBeforeDays`, `staging`, `tlsDir`, `certRenewer`, `onRotateScript`, `directoryUrl`). `atRestKey` is operator-sync responsibility (same shape as `auth.adminAccessKey`).
- `bin/master.js` — when `letsEncrypt.enabled`, decode `atRestKey` (base64 → 32 bytes), call `buildAcmeOrchestrator()`, start it. Shutdown path (SIGTERM/SIGINT) calls `.stop()`. Misconfig logs but doesn't take down master. `onRotate` callback broadcasts `acme:rotate` cluster IPC to every live worker.
- `components/api-server/src/server.js` — keeps `this.httpsServer` reference; new `reloadTls()` re-reads `http.ssl.{key,cert,ca}File` from disk and calls `setSecureContext()`. Extracted `buildHttpsOptions()` helper.
- `components/api-server/bin/server` — `process.on('message', {type:'acme:rotate'})` → `server.reloadTls()`. No-op on non-HTTPS workers (hfs, previews, http-only api).
- `components/api-server/src/routes/system.js` — new `GET /system/admin/certs` returning `listCertificates()` metadata + `daysUntilExpiry`. admin-key gated by the existing `checkAuth`.

### Integration test
- `components/business/test/unit/acme-integration.test.js` `[ACMEINT]` — wires real rqlite + mocked acme-client + real FileMaterializer. Three assertions: initial issuance (encrypted in rqlite, decrypted keyPem on disk 0600), no-op on not-yet-due, rotation on forced near-expiry. Raw rqlite row scanned for `BEGIN PRIVATE KEY` marker — guards against plaintext regressions. Skips gracefully when rqlite isn't reachable.

### Real-world validation (outside the CI test suite)
A 3-level spike against Let's Encrypt STAGING in `_plans/35-letsencrypt-integration-atwork/spike/` proved the end-to-end flow: our dns2 authoritative server published `_acme-challenge.test-dns.datasafe.dev` TXT records through the full `. → .dev → datasafe.dev (Infomaniak) → test-dns (us)` delegation chain. LE issued a real staging wildcard cert (`*.test-dns.datasafe.dev + test-dns.datasafe.dev`). **15 distinct validator IPs across 5+ AWS regions** (Frankfurt, Singapore, Stockholm, Oregon, Ohio) all retrieved TXT + CAA correctly — multi-perspective validation fully exercised. Spike also confirmed `https.Server.setSecureContext()` hot-swaps the cert for new TLS connections without breaking in-flight keep-alive HTTP sessions.

### Test totals
- 83 acme-* unit tests + 1 integration test, all green.
- 9 new PlatformDB conformance tests (rqlite: 30 → 39).

## Multi-core bootstrap CLI + rqlite mTLS

Single-to-multi-core upgrade no longer requires hand-editing override YAML on the new host or copying platform secrets across by hand. An operator runs one CLI on the existing core, transfers a sealed bundle to the new core, and starts the new core in `--bootstrap` mode. Raft traffic between cores is mutually-authenticated TLS by default.

### rqlite mTLS argv passthrough
- `storages/engines/rqlite/src/rqliteProcess.js` `buildArgs()` — new `tls: { caFile, certFile, keyFile, verifyClient, verifyServerName }` block translates to rqlited flags `-node-ca-cert`, `-node-cert`, `-node-key`, `-node-verify-client`, `-node-verify-server-name` (rqlited 8.x naming).
- `tls: null` (default) → zero TLS flags emitted → identical pre-upgrade behaviour. No regression risk for single-core or VPN-protected multi-core.
- `[RQARGS]` 14 unit tests cover flag formation across single/multi-core, with/without TLS, `verifyClient` bool, `verifyServerName` override.
- `[RQMTLS]` integration test spins up two `rqlited` processes wired with the same self-signed CA + node certs and asserts the cluster forms + a write replicates within 3 s.

### `components/business/src/bootstrap/` (new, 8 modules)
- `ClusterCA.js` — `ensure()` / `getCACertPem()` / `issueNodeCert({ coreId, ip, hostname })`. Shells out to `openssl` (system dep) for X.509 signing; Node's built-in `crypto` can generate keys but not sign certs. CA private key never leaves `dir` (default `/etc/pryv/ca`, mode 0600); per-issuance temp dir for CSR + node key. EC P-256 keypairs throughout (10y CA / 1y node). 15 `[CLUSTERCA]` tests.
- `Bundle.js` — `assemble(input)` produces the canonical bundle object (version 1); `validate(bundle)` rejects unknown versions, missing fields, malformed PEM. Pure (no I/O). Shape: `{ version, issuedAt, cluster: { domain, ackUrl, joinToken, ca }, node: { id, ip, hosting, url, certPem, keyPem }, platformSecrets: { auth: { adminAccessKey, filesReadTokenSecret } }, rqlite: { raftPort, httpPort } }`. 19 `[BUNDLE]` tests.
- `BundleEncryption.js` — `encrypt/decrypt` using AES-256-GCM keyed off scrypt(passphrase, salt). 16-byte salt, 12-byte nonce, 16-byte tag, base64 + ASCII armor (`-----BEGIN PRYV BOOTSTRAP BUNDLE-----`). Deliberately uses node's built-in `crypto` rather than adding `age-encryption` — the bundle is only ever consumed by `bin/master.js --bootstrap`, never manually inspected, and every dep adds supply-chain surface. `generatePassphrase()` returns 128-bit base64url chunked `AbCd-EfGh-IjKl-MnOp` for operator readability. 22 `[BUNDLEENC]` tests.
- `TokenStore.js` — file-based one-time join-token lifecycle on the issuing core. Sha256-hashed at rest (`{ "<sha256>": { coreId, issuedAt, expiresAt, consumedAt, consumerIp } }`); raw token returned only at mint time. Atomic write (tmp + rename) at mode 0600. `mint` / `verify` / `consume` / `listActive` / `revokeByCoreId` / `purge`. Deliberately NOT in PlatformDB — the token consumer is the same core that issued it (the ack endpoint), so cross-core replication is not needed and we avoid adding methods to the PlatformDB interface + two-engine conformance. 26 `[TOKENSTORE]` tests.
- `DnsRegistration.js` — `registerNewCore({ platformDB, coreId, ip, url, hosting })` calls PlatformDB's existing `setCoreInfo` (with `available:false`) + `setDnsRecord(coreId, { a:[ip] })` + read-merge-write to append `ip` to `lsc.{domain}` (the persistent-DNS API is last-writer-wins per subdomain; we want append). `unregisterNewCore` is the symmetric undo, scoped so it only touches state belonging to this `coreId`+`ip`. Two concurrent bootstrap runs could race on `lsc`; the CLI surfaces a warning that adding cores is a single-operator action. 19 `[DNSREG]` tests.
- `cliOps.js` — orchestrates `newCore` / `listTokens` / `revokeToken` for `bin/bootstrap.js`. Pure: takes `platformDB`, `caDir`, `tokensPath`, `secrets`, `rqlite` ports, output path. Owns the rollback (revoke token + unregister core) on any failure after PlatformDB writes. 7 `[BOOTSTRAPCLI]` tests with a fake PlatformDB and tmp dirs.
- `applyBundle.js` (consumer side) — decrypts + validates a bundle, writes `/etc/pryv/tls/{ca.crt, node.crt, node.key}` with correct modes (key 0600), generates `override-config.yml` mapping the bundle into `core.{id,url,ip}` / `dns.domain` / `dnsLess.isActive:false` / `auth.{adminAccessKey,filesReadTokenSecret}` / `storages.engines.rqlite.{raftPort,url,tls.{caFile,certFile,keyFile,verifyClient:true}}`. `dns` + `dnsLess` are emitted only when `bundle.cluster.domain` is non-empty (DNSless variant skips both). Override file is mode 0600 (carries admin key). Exposes `sha256Fingerprint(certPem)` matching `openssl x509 -fingerprint -sha256` output. 6 `[APPLYBUNDLE]` tests.
- `consumer.js` (consumer-side driver) — reads bundle from disk, resolves passphrase (`passphrase` direct arg or `passphraseFile` with newline-stripping), calls `applyBundle`, POSTs ack to `bundle.cluster.ackUrl` with TLS pinned to the bundled CA (`https.request({ ca, rejectUnauthorized: true })`), deletes bundle on 200, throws on non-200 (bundle is kept so the operator can investigate). `httpClient` injectable for tests. 7 `[BOOTSTRAPCONSUMER]` tests.
- `ackHandler.js` — `makeHandler({ tokenStore, platformDB })` returns a pure `req → { statusCode, body }` function. 200 ok flips `available:true` and returns a cluster snapshot; 400 missing field; 401 token unknown / expired / already-consumed / coreId-mismatch (single status code, reasons differentiated in body but no oracle for guessing); 404 token verifies but no pre-registration row. Token is consumed even on the 404 path so the operator must mint a new one. 9 `[ACKHANDLER]` tests.

### Wiring
- `bin/bootstrap.js` (new) — argparse + boiler init + `cliOps.newCore` / `listTokens` / `revokeToken`. Pulls `core.url` / `dnsLess.publicUrl` for the ack URL base, `auth.adminAccessKey` + `auth.filesReadTokenSecret` for platform secrets (refuses to ship a bundle if either is still on the `REPLACE ME` placeholder), `dns.domain`, rqlite `raftPort` + http port out of `storages.engines.rqlite.url`.
- `bin/master.js` — bootstrap mode runs **before** `@pryv/boiler.init` so the `override-config.yml` it writes lands at the highest precedence in boiler's load order (`override-config.yml` → env → argv → `${NODE_ENV}-config.yml` → extras). Workers (`cluster.fork()`) skip the bootstrap block entirely.
- `components/api-server/src/routes/system.js` — `POST /system/admin/cores/ack` route added. `checkAuth` short-circuits for this single path so the new core can authenticate via the join token instead of the admin key.
- `config/default-config.yml` — adds `cluster.ca.path` (default `/etc/pryv/ca`) and `cluster.tokens.path` (default `/var/lib/pryv/bootstrap-tokens.json`) under the existing `cluster:` block. Both are PER-CORE — only the issuing core uses them.
- `components/business/src/bootstrap/index.js` — barrel exporting all 8 modules.

### End-to-end test
- `components/business/test/unit/bootstrap-e2e.test.js` `[BOOTSTRAPE2E]` (5 tests) — round-trips `cliOps.newCore` → `consumer.consume` → ack route → PlatformDB state with a real `http.createServer` mounting the ack handler and an in-memory PlatformDB shared between issuer and ack endpoint. Cases: happy path (available flips, bundle deleted, token burned), replay (stashed copy fails 401 already-consumed), wrong passphrase (consumer fails before ack POST attempt, token remains active, pre-registration unchanged), expired token (401 expired), revoke-token after issue (401 unknown, pre-registration unwound). Multi-process / real-rqlited e2e (the `reg-2core-seq.test.js` pattern) is deferred — not blocking the v2.0.0-pre publication.

### Test totals
- Bootstrap unit + e2e suite: **135 cases green** across 9 test files.
- Phase 1 (rqlite mTLS argv): **15 cases** in `storages/engines/rqlite/test/`.
- Pre-existing suites unaffected.

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
