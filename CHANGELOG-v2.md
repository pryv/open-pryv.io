# Changelog - API Changes

## 2.0.0-rc.2 — 2026-06-12

### PostgreSQL attachment storage (low file volume)

- **`storages.file.engine: postgresql`** — event attachments stored as chunked rows (1 MiB) in an `attachment_files` table in the same PostgreSQL instance as user data; no extra service. Completes the diskless shape without an S3 dependency: combined with `storages.platform.engine: postgresql`, every durable byte lives in PostgreSQL and a single `pg_dump` covers the whole deployment.
- Intended for installations where **low attachment volume** is foreseen — attachment bytes inflate the database, its WAL and every backup; the server logs a warning at boot to that effect. Pick the s3 engine for attachment-heavy deployments.
- **Install wizard** — the attachments question now comes before the platform-storage question and offers `filesystem` / `s3` / `postgresql`; the diskless platform option is only proposed once attachments are off the local disk (it previously could be enabled with filesystem attachments, which is not actually diskless).
- **Fix: missing attachment content returns 404 instead of crashing the worker** — `GET /events/<id>/<fileId>` for an attachment whose content is absent from the store crashed the api-server worker with the s3 engine (and would have with postgresql): the attachment-access middleware didn't catch async rejections, and unlike the filesystem engine those engines reject up front. Now a regular `unknown-resource` (404).

### Diskless deployment: PostgreSQL platform storage + S3 attachments

Single-core dnsLess deployments in full PostgreSQL mode can now run with **no persistent filesystem on the app host** — every durable byte lives in PostgreSQL and an S3-compatible object store. Verified end-to-end with the app container on a `--read-only` rootfs (tmpfs for caches only).

- **`storages.platform.engine: postgresql`** — platform data (registrations index, user-core map, DNS records, ACME account + TLS certs, observability values, mail templates, invitation tokens, access-request states) is stored in a `platform_kv` table in the same PostgreSQL instance as user data. No rqlited process, no Raft ports, no platform data dir. Boot-time validation refuses the option outside the single-core dnsLess full-PG shape (multi-core keeps rqlite); `check-config` mirrors the same rules.
- **`storages.file.engine: s3`** — new attachment storage engine for AWS S3 / MinIO / Ceph RGW / any S3-compatible store, configured under `storages.engines.s3` (`endpoint`, `region`, `bucket`, credentials or IAM chain, `forcePathStyle`, `keyPrefix`). Streaming multipart uploads; one object per attachment at `<keyPrefix><userId>/<eventId>/<fileId>`.
- **`bin/migrate-platform.js`** — one-shot migration of all platform data between rqlite and PostgreSQL, both directions (`--from/--to`, `--dry-run`, `--force`); adopt the diskless shape on an existing deployment, or move back to rqlite before going multi-core.
- **`bin/config-to-env.js`** (+ `config-to-env` docker subcommand) — converts a YAML config into an env file (`KEY=VALUE`, nested paths joined with `__`, type-exact round-trip) so a deployment can run from `docker run --env-file …` with no config file mounted.
- **Install wizard** — picking dnsLess + postgresql now offers both diskless options; the generated config carries the choices (audit storage follows onto PostgreSQL) or documents them as commented-out appendix blocks when declined, and a sibling `config-to-env.sh` launcher is generated alongside `check-config.sh`.
- **`auth.delete` erases attachments through the storage engine** — account deletion now routes attachment removal through the fileStorage interface, so remote stores (S3) are emptied too; previously only the local user directory wipe covered them (filesystem engine unaffected).
- INSTALL.md gains a "Diskless (PostgreSQL + S3)" section: config recipe, tmpfs guidance for the remaining cache paths, migration runbook, read-only container example.

### Content queries: filter `events.get` by `content` / `clientData`

Two new `events.get` parameters — `content` and `clientData` — each an array of conditions on dot-paths into the corresponding event field, e.g. `[{"path":"drug.codes.atc","in":["G03DA04","B01AC06"]},{"path":"taken","eq":true}]`. Conditions AND together and compose with all existing parameters (`streams`, `types`, time bounds, paging).

- **Operators:** `eq`, `neq`, `in`, `exists`, `gt`, `gte`, `lt`, `lte`, `prefix` (`prefix` covers hierarchical code classes, e.g. ATC `"G03DA"`). Paths use dot-separated segments (`[a-zA-Z0-9_:-]`; colon-namespaced `clientData` keys are queryable) or the reserved `$` addressing the root value of scalar content.
- **Strict JSON-type matching** on both engines: `eq: true` matches JSON `true` only — never `1`, never `"true"`; numbers likewise. A missing path never matches; current event versions only.
- **Always available, indexes optional.** Queries are correct on every deployment with no migration (engines scan). The new platform-wide `storages.contentIndexes` config declares paths to accelerate; the PostgreSQL engine reconciles partial expression indexes against the declaration at startup (created `CONCURRENTLY`, dropped when undeclared). SQLite serves content queries by scan.
- **Capability discovery.** `GET /service/info` advertises `features.contentQueries: true`; custom data stores declare per-field/per-operator support via the new `DataStore.supports` (`@pryv/datastore` 1.1.0), surfaced to clients in the `clientData` of the store's root pseudo-stream (`pryv-datastore:supports`). Conditions aimed at a store without the capability are rejected with `invalid-operation` instead of returning silently-unfiltered results.
- **Errors:** malformed conditions yield `invalid-parameters-format` naming the offending condition; older servers reject the unknown parameters with the same hard 400 signal.
- **lib-js** (`pryv` npm, unreleased branch): conditions pass through `events.get`/`getEventsStreamed`; new `Connection.getLatestByContent(path, values, baseQuery)` (latest event per value, paged — typical form-prefill) and `Service.supportsContentQueries()`.
- **Cross-reference convention:** outbound event references live under the bare `related` key of `clientData` as `{ "<eventId>": "<relation-label>" }`; reverse lookup is an ordinary `clientData` query (`{"path":"related.<eventId>","exists":true}`).

## 2.0.0-rc.1 — 2026-06-03

First Release Candidate of open-pryv.io v2. The runtime has been production-deployed since 2026-04-23 on pryv.me (two-core cluster, 14 real users, 28K events, 264 attachments). lib-js conformance against deployed infra: 168/169 (the missing one is the documented HF case on raw deploys without nginx ingress, see "Known gaps in v2.0.0" below).

### New in `2.0.0-rc.1`: install wizard

```bash
mkdir -p /opt/pryv && cd /opt/pryv
docker run -it --rm -v "$(pwd):/app/pryv" \
  pryvio/open-pryv.io:2.0.0-rc.1 init
```

Interactive single-core install wizard. Hardcodes the in-container mount target to `/app/pryv` (avoids the `/app/config` collision that masks the image's bundled config plugins), auto-discovers the host path from `/proc/self/mountinfo`, and writes three artefacts into the operator's chosen directory:

- `pryv-config.yml` — section-grouped + commented YAML covering service identity, DNS topology (dnsLess or dns-active), HTTP+TLS, Let's Encrypt, auth secrets, app-web-auth3 integration, cluster sizing, and storage engines. Followed by a commented-out optional-sections block (`services.email`, `services.mfa`, `hostings`, `custom.systemStreams`, `observability`, …) operators can uncomment in place.
- `run-pryv.sh` — self-locating launcher (`cd "$(dirname "$0")" && pwd`) that mounts the install dir to `/app/pryv` and runs master.js.
- `check-config.sh` — sibling launcher that validates the config without booting; companion subcommand `check-config <path>` runs the same structural checks (REQUIRED service fields, REQUIRED_WHEN auth secrets, dnsLess vs dns.active, PG creds when applicable).

User-data lives under `<install-dir>/data/` (sibling to the config); the wizard auto-derives this path so the operator answers fewer questions. Both directories ride the same single `-v` mount.

No-arg `docker run pryvio/open-pryv.io` continues to behave exactly as before (boots `bin/master.js`). Anything else passes through (`node --version`, `bash`, …).

### What an implementer pinning to `2.0.0-rc.1` gets

- **Single-binary topology.** One `bin/master.js` process manages API + HFS + Previews workers in one Docker image (`pryvio/open-pryv.io:2.0.0-rc.1`). No more MongoDB, no separate `service-register` / `service-mfa` / `service-mail` containers — all merged into core.
- **Two production-grade user-data engines.** PostgreSQL (default, cross-user queries via shared tables) or SQLite (per-user files, cleaner GDPR Art.17 erasure semantics). Both pass the same 2351-test matrix at parity.
- **Multi-core cluster bootstrap.** `bin/bootstrap.js new-core` issues a passphrase-encrypted bundle on an existing core; new core boots and joins over mTLS-protected Raft. DNS discovery + LE wildcard cert auto-renewal across the cluster, hot-swap via cluster IPC.
- **Built-in observability.** Opt-in New Relic APM provider via `letsEncrypt.atRestKey`-protected secret store (provider façade; second concrete provider plugs in cleanly).
- **Cross-account Messaging & Consent (CMC) plugin.** Federated consent + chat + system notifications between two Pryv accounts. `pryv@3.5.0` + `@pryv/cmc@1.0.1` on npm.
- **Versioned accesses.** `accesses.update` is back with composite-id versioning + audit history; `accesses.getOne` accepts `?includeHistory=true`. socket.io emits `accessUpdated` events.
- **Engine-agnostic schema migrations.** `bin/migrate.js status` / `up` primitive; per-engine `schema_migrations` tracking. Forward-only, integer-versioned, timestamp-named.
- **v1 → v2 migration path.** `dev-migrate-v1-v2` repo + `bin/backup.js --restore`. Production-validated on pryv.me (14 users restored from v1.9.0).

### BREAKING changes since `2.0.0-pre`

Two breaking surface changes have landed since the rolling `:2.0.0-pre` line and the implementer should plan for them up-front. Both have full migration guides below:

- **`/reg/access` polling endpoint response shapes trimmed.** SDK callers using `pryv@>=3.5.0` are unaffected (the SDK speaks the new shape). Pre-3.5.0 SDKs that read `body.url` / `body.returnUrl` / `body.code` / `body.reasonID` need to switch to `authUrl` / `returnURL` / HTTP status / `reasonId`. See the dedicated entry below.
- **MongoDB removed as a user-data storage engine.** Operators running MongoDB-backed deployments must export via `bin/backup.js --export` and re-import into a fresh PostgreSQL (or SQLite) deployment via `bin/backup.js --restore`. See the dedicated entry below.

Additional smaller breaking changes already landed in `2.0.0-pre`: `accesses.create` managed-shared expiry now capped by parent, ID minting algorithm changed cuid v1 → cuid2, `accesses.delete` personal-access no longer cascades, `/reg/hostings` returns slash-terminated URLs. All documented in the per-feature entries.

### Recommended SDK pin

- `pryv@3.5.0` (npm) — handles both `/reg/access` shape changes and the cuid2 ID format.
- `@pryv/cmc@1.0.1` if using CMC.
- `@pryv/monitor@3.5.0` + `@pryv/socket.io@3.5.0` for live updates including the new `accessUpdated` event.

### Known gaps in `2.0.0-rc.1`

- HF-series ingress on raw deploys requires the optional in-process dispatcher (Plan 67) or an nginx vhost (sample at `docs/nginx-ingress-sample.conf`). The deployed-infra lib-js `[CHFA]` case fails without one; the in-process dispatcher closes it for low-volume deployments. Documented in `faq-infra.md`.
- `[ASTE][AS02][TJ8S]` audit time-range test is an intermittent matrix flake (passes in isolation, fires occasionally in the full sequential matrix). Same family as the existing `[ZD22]` baseline noise. Not a runtime bug. Tracked in workspace bug log.
- `[CMCHS-AP][AP01]` CMC back-channel access integrity test is an intermittent matrix flake (~1/2 on test infra; runtime behaviour on deployed infra is unverified pending the RC cut's deploy-validation pass).
- OAuth2 RFC 6749 surface is deferred to post-v2. The current `/reg/access` flow is Pryv-native; OAuth2 will be additive.

### Compliance posture

Compliance-matrix work (regulator-row coverage, primitive-citation lattice) is a parallel deliverable. The latest published matrix lives at https://pryv.github.io/compliance-matrix/.

---

## **BREAKING** — `/reg/access` polling endpoint response shapes trimmed

The access-request polling endpoints have been narrowed to expose only the fields each consumer audience actually needs. SDKs (lib-js + downstream apps) get the minimum needed to drive the flow; the auth UI (app-web-auth3 + equivalents) keeps a richer poll response.

### What changed

**`POST /reg/access`** (SDK-facing — create access request):

The response now contains only `{ status, key, authUrl, poll, poll_rate_ms }`. Removed fields: `code`, `url` (was a v1 alias of `authUrl`), `returnUrl` (camelCase duplicate of `returnURL`), `requestingAppId`, `requestedPermissions`, `lang`, `returnURL`, `oauthState`, `clientData`, `serviceInfo`. Echoed inputs and service metadata are reachable via the GET poll path or `/service/info`.

**`GET /reg/access/:key`** (auth-UI-facing on `NEED_SIGNIN`, SDK-facing on terminal states):

- `code` field dropped from the body (it was always the HTTP status, already conveyed by `res.status`).
- `url` (v1 alias of `authUrl`) and `returnUrl` (camelCase duplicate of `returnURL`) dropped.
- `serviceInfo` is now embedded only on the `NEED_SIGNIN` poll — the only response the auth UI actually consumes for that field. SDK polling does not need it (the SDK fetches `/service/info` directly when it wants service metadata).
- `REDIRECTED` responses now emit both `poll` (back-compat with existing SDK rehydration) and a new explicit `redirectUrl` field so consumers don't have to overload `poll`.

**Refused/Error responses** (POST + GET, all forms):

- The `reasonID` field has been renamed to `reasonId` to match the camelCase convention used by the auth UI and by every consumer that actually reads the field. The old `reasonID` spelling never reached any reader and was effectively dead.

### Migration

- SDK callers using `pryv@>=3.5.0` are unaffected — the SDK already speaks the new shapes.
- SDK callers on `pryv@<3.5.0` that read `body.url`, `body.returnUrl`, `body.code`, or `body.reasonID` from `/reg/access` responses must switch to `authUrl` / `returnURL` / HTTP status / `reasonId` respectively, or upgrade.
- Custom auth UIs that depend on `serviceInfo` being present on every poll must read it from the initial `NEED_SIGNIN` poll (still emitted) and cache, or fetch from `/service/info` directly. The `app-web-auth3` build shipped alongside this server release derives a fallback `/service/info` URL from the poll URL.

## **BREAKING** — MongoDB removed as a user-data storage engine

The MongoDB engine has been dropped from open-pryv.io. Supported user-data engines are now **PostgreSQL** (default) and **SQLite** (alternative). InfluxDB remains optional for high-frequency seriesStorage; rqlited remains the only platformStorage.

### What changed at the operator surface

- `storages.base.engine: mongodb` and `storages.engines.mongodb.*` config keys are gone — startup fails with a clear plugin-loader error if `engine: mongodb` is set.
- `STORAGE_ENGINE=mongodb` test harness override is gone.
- The `mongodb` npm dependency is removed from `package.json`; the install footprint shrinks accordingly.
- The `storages/engines/mongodb/` plugin directory is deleted entirely.

### Migration path for existing MongoDB deployments

Use the engine-agnostic backup tool that has been part of the V2 release line:

```bash
# On the MongoDB-backed deployment (this build's predecessor)
bin/backup.js --export --userid <userid>     # exports user data as a JSONL bundle

# On a fresh PostgreSQL-backed deployment of this build
bin/backup.js --restore --bundle <path>      # reads the bundle into PG
```

This is the same path used for the V1→V2 migration and for production MongoDB→PostgreSQL cutovers. Bundles include accounts, streams, events, accesses, profiles, webhooks, and attachments.

### Code-level removals

`components/storage/src/index.ts` drops `getDatabaseSync` + `_ensureMongoDatabase`; test-helpers `dependencies.ts` no longer imports the MongoDB collection classes; `databaseFixture.ts` drops the legacy raw-DB branches; `storages/index.ts` drops the `baseEngine === 'mongodb'` connection bootstrap branch.

### Platform.deleteUser hardening

Shipped alongside the engine removal: `Platform.deleteUser` now discovers PlatformDB entries by username prefix and deletes whatever is present, instead of iterating the mutable `accountStreams.{uniqueFieldNames,indexedFieldNames}` module-level lists at call time. Fixes a latent leak where a fixture user created under one `systemStreams` config couldn't be fully removed after a config change (test-only impact, but the root cause was a production-side fragility).

## SQLite baseStorage — now a complete V2 alternative engine

Counterpart to the MongoDB removal: the SQLite engine is now a real user-data option, not the "not yet implemented" stub that throws at init.

### Engine-choice tradeoff: backup/deletion semantics, not volume

The PG and SQLite engines have **different data-layout shapes**:

- **PostgreSQL** holds all users' data in shared tables keyed by `user_id`. Cross-user queries are cheap; backups via `pg_dump` are a single artefact; a user's data is interspersed with other users' rows in any backup taken before that user's deletion.
- **SQLite** (new) holds each user's data in a **per-user file** at `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`. Deleting a user is an `unlink` — the user's data goes away cleanly, and historical backups that haven't yet included this user (or are taken per-user) don't carry the deleted user's rows by default.

This shape difference matters under **GDPR Art.17 / right-to-be-forgotten** + similar privacy-preserving deletion regimes. Operators with stricter deletion semantics, per-user backup orchestration, or per-user retention policies may prefer SQLite. Operators with high-volume cross-user analytics or who already have PG operational tooling stay on PG. Neither is a "low-volume only" choice.

### What ships under `storages/engines/sqlite/src/`

- **Shared baseStorage SQLite** (`DatabaseSQLite`, `LocalTransactionSQLite`): single file at `<sqlite.path>/_shared/baseStorage.sqlite` for cross-user collections (Sessions, PasswordResetRequests).
- **Per-user baseStorage** (`UserBaseStorageDb` + `BaseStorageSQLite`): per-user file at `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`. Tables for `accesses`, `profile`, `streams`, `webhooks` with minimal schema (id / headId / deleted as columns + JSON `data` column). MongoDB-style query translation (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$type`/`$or`) and update operators (`$set`/`$unset`/`$inc`/`$min`/`$max` with dotted-path nested-object semantics).
- **Collection subclasses**: `AccessesSQLite` (full mirror including integrity-batch delete + `findHistory`/`snapshotHead`), `ProfileSQLite`, `StreamsSQLite` (path computation + treeUtils tree-shape), `WebhooksSQLite` (soft-delete with the same unset list as PostgreSQL).
- **dataStore streams** (`localUserStreamsSQLite`) wired in `localDataStoreSQLite`. Events were already implemented; the engine now ships full dataStore.

Per-test SQLite matrix is clean across `audit`, `business`, `cmc`, `hfs-server`, `mall`, `storages`, etc (1225+ tests passing under `STORAGE_ENGINE=sqlite`). The `api-server` component shares a pre-existing test-helper crash with the now-removed Mongo matrix run (tracked separately) and is verified component-by-component until that is closed.

## `accesses.create` — accepts `:_cmc:*` stream-ids in permissions

`accesses.create` was rejecting permissions referencing the CMC plugin's reserved namespace (e.g. `:_cmc:apps:<app-code>`, `:_cmc:inbox`) with `invalid-request-structure`: *"forbidden character(s) in streamId ':_cmc:...'"*. The auto-create-stream side-effect of personal-access app authorization was hitting the local-store streamId regex (`^[a-z0-9-]{1,100}`), which rejects the leading colon.

The fix skips the auto-create step for `:_cmc:*` stream-ids — the CMC plugin owns provisioning of that namespace (reserved parents auto-provisioned at user creation; user-creatable scopes under `:_cmc:apps:<app>` lazy-provisioned by the plugin or by user-side `streams.create`). Same-shaped permissions on other namespaces (e.g. `:_system:`/`:system:`) are unchanged; truly invalid local stream-ids are still rejected with the same error.

This unblocks app onboarding flows whose `accesses.create` payload mixes local + CMC permissions (e.g. doctor-dashboard via app-web-auth-3, third-party bridges).

Also: the error message for that path is now spelled *"forbidden character(s)"* (was *"forbidden chartacter(s)"*). Clients matching on the message text need to update — matching on `error.id === 'invalid-request-structure'` was always the correct path.

## CMC plugin — features-negotiation now correctly stamped on data-grant `clientData.cmc.features`

Coordinated fix with `@pryv/cmc@1.1.1` (lib-js): the accept handshake now persists the offer-resolved features onto the accepter's data-grant access in `clientData.cmc.features`. Previously the patient-side data-grant ended up with `clientData.cmc.features: null` even when the offer specified default-true values, because the plugin read the negotiated features from the wrong field of the accept trigger (`content.extra`, which is the SDK's user-supplied free-form pass-through) instead of `content.features`.

- **CHANGED** `components/cmc/src/handleAccept.ts`: reads `triggerEvent.content?.features` (was `triggerEvent.content?.extra`). The handler still defaults to `null` when the field is absent, so older `@pryv/cmc < 1.1.1` clients (which don't write `content.features` yet) keep producing `clientData.cmc.features: null` — bump the SDK to get the full negotiation persisted.
- **NO IMPACT** on the offer side (`createInvite` already writes `request.features` verbatim), on doctor-side delivery (`handleIncomingAccept` already mirrors features onto the doctor's inbox event), or on the feature-gating hooks (`handleChat` / `handleSystem` honour `clientData.cmc.features.chat` / `.systemMessaging` exactly as before).

## CMC plugin — security hardening (forge-prevention + reserved-root immutability + internal-stream filtering)

Four route-level guards added to close enforcement gaps in the CMC plugin's `clientData.cmc.*` namespace, reserved-stream lifecycle, peer-side `content.from` stamping, and `:_cmc:_internal:*` visibility. None of these change the wire shape for valid CMC traffic; they add `4xx` rejections for misuse and prune internal events from read responses.

- **NEW** rejection on `accesses.create` / `accesses.update` when `clientData.cmc` is supplied by user code — error id `cmc-clientdata-cmc-forbidden`. The `clientData.cmc.*` namespace (`role`, `appCode`, `counterparty`, `capability`, `requestEventId`, `features`) is populated end-to-end by the plugin via `mall.accesses.{create,update}`; allowing user-supplied values would let a malicious app forge a counterparty role on its own access (bypassing the handshake) or stamp a fake `capability.state`. The CMC plugin's own internal calls go through the mall, bypassing the route hook — no impact on the handshake.
- **NEW** rejection on `streams.delete` when the target is one of the five plugin-auto-provisioned reserved parents (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, `:_cmc:_internal`, `:_cmc:_internal:retries`), under `:_cmc:_internal:*`, or at/under a plugin-managed `chats|collectors` segment of `:_cmc:apps:*` — error id `cmc-reserved-stream-undeletable`. The base permission model (`AccessLogic._canManageStream`) returns `true` for personal accesses, so before this guard a personal token could `DELETE :_cmc:` and silently break every active CMC relationship. User-creatable `:_cmc:apps:<app>:<sub>` streams remain deletable.
- **NEW** `content.from` stamping for non-inbox CMC writes by counterparty-marked accesses. `inboxWriteHook` already stamped from-field on `:_cmc:inbox` writes; the new `cmcCounterpartyFromStampingHook` covers the per-app `chats:*` / `collectors:*` streams so a peer cannot forge `content.from` on `message/chat-cmc`, `notification/alert-cmc`, `notification/ack-cmc`, `consent/scope-request-cmc`, `consent/scope-update-cmc`. The access's stored `clientData.cmc.counterparty.{username, host}` (stamped at handshake from server-derived offer metadata) is the canonical identity that overwrites any user-supplied `from`.
- **NEW** defense-in-depth filter on `events.get` / `events.getOne` / `streams.get` that strips `:_cmc:_internal:*` from query inputs (events.get), returns 404 if a fetched event has any internal `streamIds` (events.getOne — info-leak parity with the existing hidden-system-stream pattern), and prunes the `:_cmc:_internal` subtree from the response tree (streams.get). Today the plugin auto-provisions internal streams with no app-visible permissions so explicit queries return empty anyway; the filter guards against future regressions in the permission system.

## Boot-time `REQUIRED_WHEN` validation — refuse to start on misconfigured feature gates

The boiler's `config-validation` plugin now refuses to boot when a feature-gated configuration key is missing or carries a sentinel value (`REPLACE …`, unresolved `${VAR}`, empty string, `null`). Replaces the previous silent-degradation behaviour — e.g. password-reset emails rendered with a broken `<a href="?resetToken=…">` when `auth.passwordResetPageURL` was absent at request time.

**Upgrade check before `2.0.0-pre.4`** — confirm your `override-config.yml` (or the platform-issued bootstrap bundle) sets:

| Key | Required when |
|---|---|
| `auth.adminAccessKey` | Always |
| `auth.filesReadTokenSecret` | Always (multi-core bootstrap bundles already set this; single-core deploys had no equivalent guard) |
| `auth.passwordResetPageURL` | `services.email.enabled` is `true` OR `services.email.enabled.resetPassword !== false` |
| `letsEncrypt.atRestKey` | `letsEncrypt.enabled: true` |
| `letsEncrypt.email` | `letsEncrypt.enabled: true` |

If any of these were unset or carried a `REPLACE_WITH_…` sentinel on `2.0.0-pre.3`, the core will exit with a non-zero status on `pre.4` boot. The error log names every missing key in a single pass so the fix is one config edit + one restart.

Pryv.me production (use1 + euc1) and HDS production deploys (api-ch1, demo-api-se1) have all five keys populated — no operator action expected. Dokku quickstart / `INSTALL.md` deploys that booted with `default-config.yml` placeholders left in place will need to fill them in before upgrading.

Follow-up to PR #71 (see "Password-reset email" entry below) — the request-time fallback shipped in `pre.3` has been removed; boot-time `REQUIRED_WHEN` makes it structurally unreachable in valid deployments.

## Password-reset email: robust against late-bound `auth.passwordResetPageURL`

> Superseded as of `2.0.0-pre.4` — the request-time fallback documented here was removed and replaced by the boot-time `REQUIRED_WHEN` check above. The `RESET_LINK` Pug substitution is retained.

The `account.requestPasswordReset` mail-sending step now re-reads `auth.passwordResetPageURL` from the config store at request time instead of relying on the module-init `auth` slice capture. The captured slice can be missing values populated later by override-config or extraConfig plugins; when that happened, the Pug template rendered `<a href="?resetToken=…">` — a relative URL with no scheme/host that Outlook/Apple Mail QuickLook silently dropped, leaving the user with an invisible link. Observed in HDS production.

- **Re-read at request time** with a fallback to the captured value (back-compat). — *removed in `pre.4`; the boot-time check above replaces it.*
- **Warn at request time** when `auth.passwordResetPageURL` is missing, so operators see a clear server-side signal instead of debugging from user inboxes. — *removed in `pre.4`; the boot-time check above replaces it.*
- **NEW Pug substitution `RESET_LINK`** — pre-composed full URL (`passwordResetPageURL + '?resetToken=' + encodeURIComponent(token)`). Existing templates that use the two-substitution form `#{RESET_URL}?resetToken=#{RESET_TOKEN}` keep working unchanged; new/updated templates can switch to the single `#{RESET_LINK}` form for robustness against the same class of bug.

## Cross-account Messaging & Consent (CMC plugin)

**Public-facing namespace addition.** The api-server now reserves the `:_cmc:` stream-id namespace for the Cross-account Messaging & Consent plugin. Reserved roots auto-create on-demand at first use; per-app and per-counterparty sub-streams are auto-created by the plugin at acceptance time.

- **NEW reserved namespace** `:_cmc:` — five auto-managed parents:
  - `:_cmc:` (root), `:_cmc:inbox` (one-shot lifecycle, cross-app), `:_cmc:apps` (user-creatable app scopes), `:_cmc:_internal` (plugin-managed), `:_cmc:_internal:retries` (retry queue events).
  - Apps freely create their own app-scope sub-trees under `:_cmc:apps:<app-code>:[<user-path>:]`. The plugin auto-creates `chats` and `collectors` segments below the trigger's stream at acceptance — these names are reserved as plugin-managed.
- **NEW event types** (validated by the api-server's CMC content-validation hook):
  - Lifecycle: `consent/request-cmc`, `consent/accept-cmc`, `consent/refuse-cmc`, `consent/revoke-cmc`.
  - Chat: `message/chat-cmc` (per user-pair stream under the app scope).
  - System channel: `notification/alert-cmc`, `notification/ack-cmc`, `consent/scope-request-cmc`, `consent/scope-update-cmc`.
- **NEW events.create write-hooks**:
  - `cmc-content-validation` — validates `content` against the per-type schema.
  - `cmc-capability-mint` — on `consent/request-cmc`, mints a single-use capability access + per-capability offer / responses streams, stamps `content.capabilityUrl` + `content.capabilityExpiresAt` + `status: 'pending'`.
  - `cmc-inbox-write` — for writes on `:_cmc:inbox` only: validates the access's `clientData.cmc.role === 'counterparty'`, restricts to lifecycle event types, and **server-stamps `content.from` from the access's stored counterparty identity** (unforgeable — any client-supplied `content.from` is overwritten).
  - `cmc-dispatch` — fire-and-forget orchestration loop that fires post-create for every `cmc/*` event: type-routes to the right handler, performs local state changes + outbound HTTPS delivery to the peer, updates the trigger event's `content.status` (`pending → delivered → completed | failed`), and pushes `pubsub.USERNAME_BASED_EVENTS_CHANGED` so the app's socket.io subscription sees every status flip.
- **NEW accesses.update post-hook** — auto-notifies CMC counterparties when a scope-changed access is detected. Writes a local audit event under the user's collectors stream + delivers `consent/scope-update-cmc` to the peer via the access's stored apiEndpoint. The hook is suppressed when the update is initiated by a CMC handler (AsyncLocalStorage-based, runWithSuppression).
- **Federation**: cross-platform AND cross-core deliveries take the standard HTTPS path with the access token in the apiEndpoint URL. No mTLS, no shared CA, no federation auth needed.
- **Retry queue**: zero new storage primitive — retry events live in `:_cmc:_internal:retries` with exponential backoff (1s → 5s → 25s → 125s → 600s cap, max 6 attempts) before being marked `failed-permanent` for operator review.
- **Backwards-compat**: nothing legacy is changed; deployments that don't use CMC see the namespace as inert. No migration required.

See `components/cmc/README.md` for the canonical design, `IMPLEMENTERS-GUIDE.md` for app integration, and `INTERNALS.md` for the orchestration flow diagrams.

## Audit + socket.io for versioned accesses (Plan 66 Phase E)

- **NEW** every audit row written under a **versioned** access (one whose `serial` is non-null) now carries **two** access-stream ids: the bare `access-<base>` (unchanged shape) AND the composite `access-<base>:<serial>` (specific contract version). Audit queries by `streamIds: ['access-<base>']` keep returning every record across all versions — fully backwards-compatible. New version-specific queries can target `access-<base>:<K>` directly. Never-updated accesses keep emitting only the bare streamId, so this is a no-op until `accesses.update` is first invoked.
- **NEW socket.io event** `accessUpdated` — fired on the user's socket.io namespace right after a successful `accesses.update`, alongside the existing coarse-grained `accessesChanged` event. The new event carries a structured payload `{ type: 'access-updated', accessId: '<base>:<serial>', serial }` so fine-grained subscribers can react to a specific update without refetching. The legacy `accessesChanged` event continues to fire (arg-less) for any access change — existing SDK consumers keep working unchanged.
- **Why the dual emission**: Plan 66 §7.1 — coarse-grained event for backwards compat, fine-grained event with serial for new consumers that want to act on the specific update. Token-scoped notification (broadcast to the shared-access recipient on a separate device) remains out of scope; backlogged at `XXX-Backlog/SCOPED-NOTIFICATION.md`.

## `accesses.getOne` + composite-id wire format applied (Plan 66 Phase D)

- **NEW** `GET /accesses/:id` → `accesses.getOne`. Returns the access identified by the path id. The id can be either bare `<base>` (returns the current head) or composite `<base>:<serial>`:
  - composite matching current serial → current head.
  - composite for an older serial → the historical snapshot row + a `current: '<base>:<currentSerial>'` hint pointing at the live head. Mirrors GitHub's `GET /repos/X/Y/commits/<sha>` behaviour for ref-by-version.
  - composite for a serial that never existed (or bare on a versioned access whose serial doesn't match) → `404 unknown-resource`.
- **NEW** `accesses.getOne ?includeHistory=true` — opt-in flag (default `false`, mirrors `events.getOne`). When set, the response includes a `history: [...]` array of every historical snapshot in chronological order (oldest first). Each history entry uses the composite id of the frozen version. The list endpoint `accesses.get` does NOT take this flag today (singular case covers the typical "audit this access" use case; list-side support is intentionally deferred).
- **Composite wire format now consistently applied.** Every `accesses.*` response (get, getOne, create, update, checkApp, accessDeletions) now serialises `id`, `createdBy`, and `modifiedBy` using the new composite format when a corresponding `serial` exists in storage. Never-updated accesses still serialise as bare cuids — fully backwards-compatible. The previously-internal `serial` / `createdBySerial` / `modifiedBySerial` fields are kept off the wire (stripped at the api-server seam to stay within the schema's `additionalProperties: false` whitelist).
- **App visibility on `getOne`:** an `app` caller can fetch only its own access (self) or shareds it directly manages (chain match by `base`). Other accesses return `unknown-resource` — no info leak via differentiated error.
- **`accesses.checkApp` unchanged in semantics**: still matches against current heads only (no opt-in for historical matching). Plan 66 Q12.3=a — the whole point of revoking/narrowing is the app loses scope, not that it can silently re-claim it.

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
