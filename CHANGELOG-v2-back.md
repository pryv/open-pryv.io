# Changelog - Internal (no API impact)

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
