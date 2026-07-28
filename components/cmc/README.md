# components/cmc: Cross-Account Messaging & Consent plugin (`:_cmc:`)

> **Living design.** This README is the canonical design document for the CMC plugin. Companions in this directory:
> - [IMPLEMENTERS-GUIDE.md](IMPLEMENTERS-GUIDE.md): customer-facing wire shape (API consumers).
> - [INTERNALS.md](INTERNALS.md): plugin-side flow diagrams (engineering / security review).

**Status:** Released to `master` and shipped in open-pryv.io 2.0.0-pre.3. Client SDK ships as the [`@pryv/cmc`](https://github.com/pryv/lib-js/tree/master/components/cmc) npm package (sibling to `@pryv/monitor` and `@pryv/socket.io`).

**Design pillars:**
1. **Plugin, not storage engine**: CMC lives at `components/cmc/`; all state in standard per-user main storage (PG / SQLite).
2. **Zero new storage primitives**: retry queue is a hidden companion stream `:_cmc:_internal:retries`.
3. **Zero new HTTP route namespace**: every CMC behaviour is reachable via existing Pryv API surfaces (`events.*`, `streams.*`, `accesses.*`, socket.io monitor). No `/cmc/*` top-level routes. If a use case feels like it wants a CMC-specific endpoint, the right answer is either a `clientData` filter on the existing resource, a richer query on the trigger event, or a socket.io subscription. Keeps the plugin a true plugin (no API-surface ownership).
4. **`:_cmc:apps:` user namespace**: user-creatable streams pack under one plugin-managed parent.
5. **Three-region stream model**: `:_cmc:inbox` (one-shot lifecycle) / `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` (per user-pair, nested under the app/path the trigger was written to) / `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` (per collector-relationship, same nesting).
6. **System family absorbs scope-update**: `consent/scope-request-cmc` + `consent/scope-update-cmc` flow on the system channel; `accesses.update` post-hook auto-notifies the counterparty for user-initiated scope changes.

Cross-core mTLS optimization deliberately omitted; see "Future development scoping" sections below.

## Goal

Add a **first-class cross-account messaging + consent primitive** to open-pryv.io that works **across independent open-pryv.io deployments**, no shared cluster CA, no federation auth, no shared user namespace. Apps interact entirely through existing `events.create` / `events.get` / `streams.create` / `accesses.create` calls, **no new API methods, no new public HTTP routes on the core**.

The plugin's role is purely to:

- Validate `cmc/*` event-type schemas server-side.
- Mint **capability accesses** (single-event-scoped shared accesses) for invite hand-off.
- Provision streams + grant bidirectional shared accesses transactionally when a recipient accepts.
- Drive `accesses.update` (composite-id versioning) when scope-update accepts flow through.
- Maintain `:_cmc:state` projections.
- Emit socket.io pushes locally.
- **Act as a federated client** to remote platforms, making outbound HTTPS calls to deliver cross-account writes using the bidirectional access pair's apiEndpoints as credentials. This is the key architectural property: apps never write directly to a counterparty's account. They write a single event on their own platform and the plugin orchestrates everything else.

All cross-account communication, pre-acceptance via capability URL, post-acceptance via the bidirectional shared accesses, is **server-orchestrated**. The plugin on the actor's platform performs the local state change (e.g., `accesses.delete`, `accesses.update`, `accesses.create`) and then makes the outbound API call to the counterparty's platform using stored apiEndpoints. The receiving plugin processes the incoming write locally. There's no inter-platform plugin-to-plugin protocol beyond standard Pryv API calls.

This means the same protocol works:

- Same-core single-platform.
- Cross-core same-cluster (intra-operator, multi-core).
- **Cross-platform between two independent open-pryv.io deployments** with different domains, different operators, different `dnsLess` topologies, no shared trust.

The three event-type families (requests, chat, system, the latter folding in scope-update notifications) ship together in one coherent plugin.

## Why this matters

`the legacy collector-app template pattern` reimplements an ad-hoc cross-account workflow on top of plain Pryv primitives, with `clientData.cmcCollector.*` as an untyped discovery contract, per-Collector stream trees as state machines, `create-only` access permissions as message-queue tokens, and polling for catch-up. The pattern works within one operator's deployment but doesn't scale to **cross-platform** scenarios where the provider and user.are on separate open-pryv.io instances run by different operators, the design assumes shared trust at points where there is none.

Promoting the workflow to the platform via `:_cmc:` and leaning entirely on Pryv's existing `accesses.*` primitive as the federation fabric:

1. Kills inbox polling, direct API writes from one party's app to the other's apiEndpoint + socket.io push on receipt.
2. Kills delete+create on scope change, plugin proxies the recipient's accept into `accesses.update` (composite-id versioning preserves audit history).
3. Kills `clientData`-as-protocol, request/response shapes become first-class typed events validated by the plugin.
4. Kills the N×`streams.create` boilerplate, acceptance is transactional server-side.
5. Kills the leaky shared-access capability URL, capability is a single-event-scoped access; standard Pryv `apiEndpoint` URL.
6. **Works across independent platforms without federation auth.** Capability accesses pre-acceptance + bidirectional shared accesses post-acceptance are the federation.

And it does this **without changing the API surface** that clients consume. `lib-js@3.1.0` (the composite-id `accesses.update` floor) works unchanged.

## Scope

| Question | Answer |
|---|---|
| Implementation vehicle | **Dedicated CMC plugin (NOT a new storage engine).** Stream-id-namespace owner + orchestration hooks under `components/cmc/`. Reserves the `:_cmc:` prefix with the mall dispatcher for write-hook routing only, all state lives in the user's standard storage (PG/SQLite) alongside the user's other events / accesses / streams. **No new API methods. No new public HTTP routes on the core. No new storage engine.** |
| Composite-id `accesses.update` floor | Yes. Plugin uses composite-id `accesses.update` + `accessUpdated` socket event natively. |
| First-ship event-type families | All three: **requests + chat + system messages** (system family absorbs scope-update via `consent/scope-request-cmc` + `consent/scope-update-cmc`). One coherent plugin. |
| Federation model | **Cross-platform between independent operators is a first-class supported case.** No shared CA, no federation auth, no shared user namespace. Capability accesses + bidirectional shared accesses are the fabric. Topology-invariant (works for `dnsLess: true` and `false`). |
| Cross-core within one cluster | Same standard HTTPS path as cross-platform, the only addressing primitive is the counterparty's stored `apiEndpoint`. No special cross-core data-path treatment. |
| Capability URLs | **Standard Pryv `apiEndpoint` URLs.** Server mints a single-event-scoped shared access on the requester's account; the access's apiEndpoint IS the capability URL. No new endpoint, no opaque token store. |
| App scoping for the requester | Standard stream hierarchy, apps create their own `:_cmc:apps:<app-id>:<scope>` sub-trees via `streams.create({parentId: ':_cmc:apps'})` (and nested children with the matching parentId). Optional access-level enforcement via `clientData.cmc.appScope`. |
| Operator opt-in surface | The plugin manifest is itself the toggle (plugin loaded or not). No separate config flag. |
| Helpers in `legacy-shim` | Allowed. Old `Collector` / `CollectorClient` classes proxy to the new primitives during legacy-shim migration. |
| Scope-update constraint | Covers all of the composite-id `accesses.update` surface area: widening, narrowing, removing permissions; expiry chain changes. Server pre-validates the permission-chain rules when the collector writes `consent/scope-request-cmc`; the user's `consent/scope-update-cmc` (or a direct `accesses.update` call through the post-hook) triggers a plugin-internal `accesses.update`. |

## Relationship to future OAuth2 / app-accounts work

CMC and the future OAuth2 / app-accounts work sit at different layers:

- **CMC (this plugin)** defines the **wire shape of the cross-account workflow**: how a request is published, how a recipient accepts, what events flow on which streams.
- **OAuth2 / app-accounts (future)** defines the **server-to-server identity model**: how Platform A signs requests to Platform B, how operators register peers, how operator-side global revoke works.

CMC's protocol works without that future federation layer because every interaction is a direct Pryv API call through a per-pair shared access, the access token IS the auth. But one feature is gated on it:

**Directed cross-platform invites** (`to: 'alice@example.com'` where Alice is on a different platform) cannot be auto-routed without a federation channel. CMC v1 supports directed invites only **same-platform**; cross-platform directed invites degrade to capability-URL-only (the requester publishes the request, hands the URL to Alice via email/QR/etc.). When signed inter-platform requests + a well-known invite-webhook endpoint ship, CMC can fold directed cross-platform routing in as a follow-on.

The capability access mechanism here is also the natural store for future OAuth2 authorization codes, both are single-use, TTL-bounded, opaque-token-equivalent constructs.

## Architecture

### Data residency

**CMC introduces zero new storage primitives.** All state, user-visible and plugin-internal, lives in the user's **standard per-user main storage (PG / SQLite)**, addressed through the normal `events.*` / `accesses.*` / `streams.*` API paths. The plugin's role is purely:

1. **Stream-id-namespace ownership**: reserve the `:_cmc:` prefix with the mall dispatcher so writes to `:_cmc:*` route through CMC's hooks.
2. **Validation + orchestration hooks**: pre/post hooks on `events.create` (for `cmc/*` types), `accesses.update` (for the counterparty post-hook), and stream-creation under `:_cmc:` (reserved-root enforcement + anchor stream auto-creation idempotence).
3. **Outbound HTTPS client**: federated cross-platform / cross-core delivery using stored counterparty `apiEndpoint`s. No special data-path auth lane; standard access-token HTTPS.
4. **Helpers**: slug computation, error-id catalogue, stream-id builders, and the Level-1 protocol functions (`createInvite`, `acceptInvite`, `sendChat`, `sendSystemAlert`, `revokeRelationship`, …) ship as the [`@pryv/cmc`](https://github.com/pryv/lib-js/tree/master/components/cmc) npm package, a sibling to `@pryv/monitor` and `@pryv/socket.io`. Apps install it alongside `pryv` (≥ 3.3.0).

| Data | Lives in |
|---|---|
| `:_cmc:*` events (request, accept, refuse, revoke, chat, system-*) | Per-user main storage's standard events table |
| Capability access, data-grant access, back-channel access | Per-user main storage's standard accesses table |
| `:_cmc:inbox` / `:_cmc:apps:<app-code>:[<path>:]chats:<slug>` / `:_cmc:apps:<app-code>:[<path>:]collectors:<slug>` / `:_cmc:apps:<...>` stream definitions | Per-user main storage's standard streams table |
| Slug → access lookup | Same accesses table, indexed on `clientData.cmc.counterparty.{username, host}` |
| **Retry queue** for pending outbound deliveries | **Hidden companion stream `:_cmc:_internal:retries`** in per-user main storage. Each pending delivery = one event with `content.{apiEndpoint, payload, attempts, nextAttemptAt}`. Standard `events.create` / `events.update` / `events.delete` for queue management. |

**rqlite / platformDB is NOT part of CMC's design surface at all.** Same scoping principle as the mTLS / cluster-CA discipline below: cross-core platform infrastructure stays out of CMC's vocabulary. If CMC ever needs cross-core resilience (e.g., retry-queue failover when the home core dies), that's a separate plan with its own threat model, not a v1 feature.

**Hidden companion stream convention:** the `:_cmc:_internal:*` prefix is filtered out of regular `events.get` / `events.getOne` / `streams.get` responses by plugin-owned read-hooks (`createEventsGetInternalGuardHook`, `createEventGetOneInternalGuardHook`, `createStreamsGetInternalGuardHook`) keyed on `isCmcInternalStreamId()`. The `events.get` hook strips any internal-stream id from `params.streams`; `events.getOne` returns 404 (info-leak parity with hidden-system-stream behaviour) if the resolved event carries any internal streamId; `streams.get` prunes the `:_cmc:_internal` subtree from the response tree. Operators / admin tooling can opt-in to see internal events via direct PG/SQLite queries or via the platform `/system/admin/*` endpoints, the plugin guards only the user-facing route chains.

**Sequencing dependency (preferred):** the long-term goal is to promote the hidden-stream pattern to a first-class baseStorage primitive (modelled on Pryv's existing `isShown: false` flag for `:_system:email` / `:_system:account`), so any plugin can opt streams out of regular API responses by configuration rather than middleware. CMC shipped before that promotion landed, so the plugin carries its own filter middleware as interim debt, to be removed once the platform-wide primitive ships and `:_cmc:_internal:*` can declare `isShown: false` declaratively.

### Namespace

The `:_cmc:` namespace has three plugin-managed regions plus user-creatable scope streams:

| Stream | Created by | Writable by user | Holds |
|---|---|---|---|
| `:_cmc:` | server (always present) | no (reserved root) | namespace parent |
| `:_cmc:inbox` | server (always present) | no (plugin-internal writes) | one-shot lifecycle events: `consent/request-cmc`, `consent/accept-cmc`, `consent/refuse-cmc`, `consent/revoke-cmc` |
| `:_cmc:apps` | server (always present) | no (parent) | parent of user-creatable app scopes |
| `:_cmc:apps:<anything-you-create>` | user via `streams.create({parentId: ':_cmc:apps'})` (or deeper) | yes | user's organizational scopes for one-shot lifecycle triggers (publish requests, accept invites, revoke). Apps namespace their sub-trees here. App access can be scoped to `:_cmc:apps:<app-code>:*` (whole app) or `:_cmc:apps:<app-code>:<request-slug>:*` (per-request). |
| `:_cmc:apps:<app-code>:[<path>:]chats` | plugin (auto-created) | no (parent) | parent of per-counterparty chat sub-streams, nested under whichever app-scope stream the trigger was written to |
| `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` | plugin (auto-created on first chat) | apps may write `message/chat-cmc` triggers here | bidirectional chat with that counterparty: `message/chat-cmc` (both sent and received) |
| `:_cmc:apps:<app-code>:[<path>:]collectors` | plugin (auto-created) | no (parent) | parent of per-collector-relationship sub-streams, nested under whichever app-scope stream the trigger was written to |
| `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` | plugin (auto-created at acceptance) | apps may write `cmc/system-*-v1` triggers here | per-collector-relationship system channel: alerts, acks, scope-requests, scope-updates |
| `:_cmc:_internal` | server (always present) | no (parent) | parent of plugin-internal hidden streams |
| `:_cmc:_internal:retries` | plugin (always present) | plugin-internal | retry queue for pending outbound deliveries (one event per pending delivery). Hidden from regular `events.get` / `streams.get` via `isShown: false`. |
| `:_cmc:_internal:offer:<capId>` | plugin (per capability) | plugin-internal | per-capability single-event stream, bears the request event the capability access reads via `:_cmc:_internal:offer` parent (recursive expand). GC'd with the capability access. Not hidden, capability access permissions provide the scoping. |
| `:_cmc:_internal:responses:<capId>` | plugin (per capability) | plugin-internal | per-capability single-write stream, receives the one accept/refuse event written through the capability connection. GC'd with the capability access. Not hidden, capability access permissions provide the scoping. |

**Where `<path>` comes from:** the `chats` and `collectors` sub-segments live directly under whichever stream the trigger was written to. If the app writes a `consent/request-cmc` to `:_cmc:apps:my-app`, chat/collector streams hang off `:_cmc:apps:my-app:chats:*` / `:_cmc:apps:my-app:collectors:*`. If it writes to `:_cmc:apps:my-app:study-A`, they hang off `:_cmc:apps:my-app:study-A:chats:*` / `:_cmc:apps:my-app:study-A:collectors:*`. This lets the app's access be scoped at the app level OR at a per-request sub-tree by simple prefix-match.

**Anchoring rationale (locked):**
- **Chat is anchored per user-pair**: one thread per counterparty regardless of how many collector relationships exist between you. Matches messaging-app intuition.
- **System channel is anchored per collector-relationship**: each access pair has its own system stream so a study's reminders don't bleed into clinical-care alerts from the same doctor.
- **One-shot lifecycle events** stay in flat `:_cmc:inbox` because they don't have a stable per-counterparty home (e.g. an incoming `consent/request-cmc` from a stranger you don't yet have a relationship with).

**Slug conventions:**
- `<counterparty-slug>` = `<username>--<host-slug>` where `host-slug` replaces `.` with `-`. Examples: `alice--example-com`, `bob--my-host-example-org`. Same slug shape is used both for chat (`:chats:<counterparty-slug>`) and for system/collector relationships (`:collectors:<counterparty-slug>`), the app-code and any per-request scoping live in the stream PATH, not in the slug.
- Double-hyphen (`--`) is the load-bearing separator; usernames and host-slugs use single hyphens so `--` is unambiguous.
- Helper `counterpartySlug({username, host})` ships in the [`@pryv/cmc`](https://github.com/pryv/lib-js/tree/master/components/cmc) package.

**Cross-platform identity in slugs is required.** `alice@example.com` and `alice@example.com` are different people; the host is part of the slug.

*State projection across all scopes (`:_cmc:state`) deferred to v2, trigger events carry their own status in `content.status`.*

**`:_cmc:inbox` is plugin-internal-write-only.** Apps never write to it directly. The receiving plugin's outbound-call handler (server-internal) is the only writer; it validates the incoming HTTPS request bears a counterparty access token (carrying `clientData.cmc.role: 'counterparty'`, server-managed and not app-visible), stamps `content.from` from the access's stored counterparty identity, and inserts the event. Senders cannot forge `content.from`; they can only deliver via their own counterparty access tokens which encode their identity.

### Event-type families and the plugin-as-orchestrator model

**Apps always write to their own platform.** A user-initiated action is a single `events.create` on a stream under `:_cmc:`, either a user-managed `:_cmc:apps:*` scope stream (lifecycle triggers) or a plugin-managed `:_cmc:apps:<app-code>:[<path>:]chats:<slug>` / `:_cmc:apps:<app-code>:[<path>:]collectors:<slug>` stream (chat + system triggers). The plugin reads the write, performs the local state change, and (if the action affects a counterparty) makes the outbound API call to the counterparty's platform using stored apiEndpoints. The plugin updates the original trigger event's content with `status: 'pending' | 'completed' | 'failed'` as orchestration progresses; the app reads back via socket.io subscription on the relevant stream.

Counterparty events arrive in the recipient's `:_cmc:inbox` only because the **sender's plugin** wrote them via the stored apiEndpoint, never by the sender's app directly. The receiving plugin's write-hook on `:_cmc:inbox` validates that the actor carries `clientData.cmc.role: 'counterparty'`, stamps `content.from` from the access's stored counterparty identity, and fires socket.io push.

All event types live under the `cmc/*` namespace and are validated by the plugin via JSON Schema (registered in the plugin manifest).

**Family 1, Requests (one-shot lifecycle, anchored at `:_cmc:inbox`):**

| Event type | App writes to | Plugin orchestration |
|---|---|---|
| `consent/request-cmc` | requester's own user-managed `:_cmc:apps:*` scope stream | Mints capability access on requester's account. If `to:` set and recipient local same-platform, also writes a notification copy into recipient's `:_cmc:inbox` (in-process). For cross-platform directed: no auto-routing (capability URL hand-off only). |
| `consent/accept-cmc` | recipient's own user-managed `:_cmc:apps:*` scope stream, content carries the capability URL | Plugin: reads offer via capability connection; creates local data-grant access on recipient's account with permissions from the offer; uses capability connection to deliver accept event (with grantedAccess apiEndpoint) to requester's platform; receives back-channel apiEndpoint in response; stores it in `clientData.cmc.counterparty` of the data-grant. Plugin also auto-creates `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` + `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` on the recipient's account, nested under whichever app-scope stream the recipient wrote the accept trigger to. |
| `consent/refuse-cmc` | recipient's own user-managed `:_cmc:apps:*` scope stream, content carries capability URL | Plugin: delivers refuse via capability connection; capability is consumed. |
| `consent/revoke-cmc` | either party's own user-managed `:_cmc:apps:*` scope stream, content carries `accessId` | Plugin: `accesses.delete` locally on the access; uses stored counterparty apiEndpoint to deliver `consent/revoke-cmc` to the other party's `:_cmc:inbox`; receiving plugin `accesses.delete`s its half of the pair. |
| `consent/invalidate-link-cmc` | requester's own user-managed `:_cmc:apps:*` scope stream, content carries `capabilityId` | Plugin: flips the capability access's `clientData.cmc.capability.state` from `'open'` to `'invalidated'` so further accepts via the capability URL fail with `cmc-capability-invalidated`. Open-link mode only (single-use capabilities auto-consume on first accept; calling this on one is a no-op success). Already-established data-grant + back-channel relationships are NOT touched, use `consent/revoke-cmc` for per-relationship teardown. No outbound delivery; the rejection happens server-side on the next attempted accept. |

Delivered counterparties of `consent/request-cmc` (when same-platform directed) / `consent/accept-cmc` / `consent/refuse-cmc` / `consent/revoke-cmc` land in the recipient's `:_cmc:inbox`, the one-shot lifecycle channel.

**Family 2, Chat (anchored per user-pair under the app/path scope at `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>`):**

| Event type | App writes to | Plugin orchestration |
|---|---|---|
| `message/chat-cmc` | sender's `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` stream (plugin auto-creates on first chat) | Plugin resolves the relevant access pair from the counterparty slug, delivers chat event to recipient's matching `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` stream via stored apiEndpoint. Sent and received chat events live in the same per-counterparty stream on each side, one thread per user-pair per app-scope. |

**Family 3, System messages, incl. scope-update (anchored per collector-relationship under the app/path scope at `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>`):**

| Event type | App writes to | Plugin orchestration |
|---|---|---|
| `notification/alert-cmc` | operator's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream | Plugin verifies the participant access has `features.systemMessaging: true`; delivers alert to participant's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored data-grant apiEndpoint. |
| `notification/ack-cmc` | participant's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream | Plugin delivers ack to operator's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored back-channel apiEndpoint. |
| `consent/scope-request-cmc` | collector's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream (collector → user proposes scope change) | Plugin pre-validates permission-chain rules locally (collector must hold manage rights on the underlying data-grant; new permissions must be ⊆ collector's own app permissions); delivers the ask to user's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored data-grant apiEndpoint. User can `consent/scope-update-cmc` to accept (or simply ignore to refuse). |
| `consent/scope-update-cmc` | user's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream (responds to a request OR self-initiated change) | Plugin calls `accesses.update` locally on the data-grant access; delivers the update to collector's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored back-channel apiEndpoint; receiving plugin emits `accessUpdated` socket event locally. |

The four system event types share one stream per collector-relationship so a study's reminders don't bleed into clinical-care alerts from the same doctor, and scope-change history lives where the relationship itself lives.

### `accesses.update` post-hook (user-side scope changes via the standard API)

A user can change scope on a CMC counterparty access through the standard Pryv API, `accesses.update` with a fresh permissions array. The plugin's post-hook on `accesses.update`:

1. Detects the updated access carries `clientData.cmc.role: 'counterparty'`.
2. Reads the stored counterparty apiEndpoint + collector-stream-id from the access's `clientData.cmc`.
3. Auto-fires `consent/scope-update-cmc` to the counterparty's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream so the counterparty's app is notified.

The user gets the standard `accesses.update` composite-id surface for scope changes without needing to write a CMC trigger event; the collector still hears about it on the same system channel as if the user had used `consent/scope-update-cmc` directly.

**Double-fire suppression** (carried as open question 6 in SessionState): when the CMC trigger handler itself calls `accesses.update`, the post-hook must not redundantly fire a second notification. Implementation tactic TBD (cls flag, request-scoped marker, or distinguished caller identity).

**State tracking (v1):** the trigger event itself IS the state record. Apps query their own scope streams to see action status. The plugin updates each trigger event's `content.status` as orchestration progresses. No separate projection stream in v1.

**Deferred to v2:** `:_cmc:state` server-projection for cross-scope summaries (`cmc/request-status-v1`, `cmc/access-state-v1` synthesized across all the user's `:_cmc:apps:*` streams). Ship only on real consumer demand.

### Capability accesses

When a `consent/request-cmc` is written with `capabilityRequested: true`, the plugin creates a special shared access on the requester's account, backed by **two real per-capability streams** (not virtual streams, per-event access scoping doesn't exist in core, see audit notes):

- **Type:** `shared`
- **Name:** `__cmc-cap-<short-id>`
- **Per-capability streams** (created by the plugin alongside the access):
  - `:_cmc:_internal:offer:<capId>`: contains the single request event (server-stamped, immutable for the capability lifetime).
  - `:_cmc:_internal:responses:<capId>`: empty at creation; receives exactly one `consent/accept-cmc` or `consent/refuse-cmc` event during the capability's life.
- **Permissions:**
  - `read` on `:_cmc:_internal:offer:<capId>`.
  - `create-only` on `:_cmc:_internal:responses:<capId>`.
- **`clientData.cmc`:** `{ kind: 'capability', requestEventId: <id>, capability: { mode, state, stateChangedAt, [acceptedBy] }, singleUse: <bool> }`
- **TTL:** operator-configured default (7 days proposed); requester can override per-request.
- **Mode:** `'single-use'` (default) or `'open-link'`. Single-use auto-consumes on first accept and rejects re-clicks with `cmc-capability-consumed`. Open-link accepts multiple counterparties, each is recorded in `clientData.cmc.capability.acceptedBy` (`[{username, host, acceptedAt}]`); same-counterparty re-clicks are rejected with `cmc-capability-already-accepted-by-you`; the requester writes a `consent/invalidate-link-cmc` event to close the link to new accepters. See the Implementer's Guide section "Open-link capability" for the full semantics.
- **Auto-deletion:** single-use; plugin deletes the access after the first successful response write. Open-link capabilities stay alive until TTL expiry or explicit invalidation.

The access's `apiEndpoint` IS the capability URL, a standard `pryv.Connection(url)` works against it. Hidden from `accesses.get` by default (filtered by `clientData.cmc.kind: 'capability'`); operators can opt to surface them via a query parameter.

### Access-state-mutating triggers: token-class + access-permission gates

Three CMC lifecycle triggers mutate access state on the recipient's account. Two distinct gate shapes, chosen per trigger by what the orchestrator does with the access:

| Trigger | Gate | Rejection wire shape |
|---|---|---|
| `consent/accept-cmc` (mint) | **personal-token only** at `events.create`, AND `triggerAccess.canCreateAccess(payload)` in `handleAccept` | `400 invalid-operation` + `error.data.id === 'cmc-accept-requires-personal-token'` (at the gate) / trigger event `content.status === 'failed'` + `failure.reason === 'cmc-insufficient-permissions'` (at the handler) |
| `consent/scope-update-cmc` (widen) | **personal-token only** at `events.create`, AND `triggerAccess.canUpdateAccess(target)` + `triggerAccess.canCreateAccess({permissions: mergedPerms, type: 'shared'})` in `handleSystemScopeUpdate` | same shape |
| `consent/revoke-cmc` (delete) | **access-permission gate only**, `triggerAccess.canDeleteAccess(target)` in `handleRevoke` (per delete) | trigger event `content.status === 'failed'` + `failure.reason === 'cmc-revoke-forbidden'` |

The personal-token gate on mint/widen exists because the orchestration mints a new `shared` access with permissions derived from a remote (capability) offer, without user-presence at the trigger write, a narrow-scope app could drive creation of an arbitrarily-wider access. The personal-token gate is closed via the `cmcAcceptAccessGateHook` middleware; `handleAccept` / `handleSystemScopeUpdate` re-check via `AccessLogic.canCreateAccess` / `canUpdateAccess` for defense in depth.

**Revoke uses the standard access-permission gate, not personal-token.** Revoke deletes accesses; the access being deleted bounds the impact. `handleRevoke` runs `triggerAccess.canDeleteAccess(target)`, the same primitive `accesses.delete` enforces, which honours the `selfRevoke` feature permission on the target. So apps holding the relationship's data-grant access (the peer's "data-grant" copy stored on the user's account) can self-revoke directly without bouncing through the auth pages.

**Plugin-managed access exemption (mint/widen only)**: the gate passes through writes whose access carries `clientData.cmc.kind === 'capability'` (capability access, used for cross-platform accept delivery) or `clientData.cmc.role === 'counterparty'` (data-grant + back-channel pair, used for follow-up protocol deliveries). Both markers are plugin-stamped at mint time and shielded by the existing `cmc-clientdata-cmc-forbidden` forge-prevention hook. Revoke needs no equivalent exemption, peer-delivered revokes are short-circuited as `'skipped'` by dispatch's `isPeerDeliveredEvent` check on `OUTBOUND_LOOPABLE_TYPES` before the handler runs.

**Hand-off for apps without a personal token**: `pryv.cmc.requestAccept` opens `app-web-user-account`'s `/cmc-accept` page; `pryv.cmc.requestScopeUpdate` opens `/cmc-scope-update` (both in `@pryv/cmc` ≥ 3.9). User signs in, the page writes the trigger with the fresh personal token, and the result is returned via popup `postMessage` or `returnUrl` redirect. **No `requestRevoke` helper**, revoke is access-permission-gated, so any holder of the relationship's data-grant access can self-revoke via `pryv.cmc.revokeAcceptance` / `revokeRelationship` directly.

Full architectural notes in [INTERNALS.md](INTERNALS.md#access-state-mutating-triggers--token-class--access-permission-gates).

### Bidirectional shared accesses (post-acceptance)

When the recipient's app writes `consent/accept-cmc` to a local scope stream, the recipient's plugin orchestrates:

1. Opens the capability connection (URL is in the trigger event's content).
2. Reads the linked request via `events.get({streamIds: [':_cmc:_internal:offer']})` through the capability, recursive expand resolves to the one accessible child stream `:_cmc:_internal:offer:<capId>`.
3. **Creates the local data-grant access** on the recipient's account with permissions from the offer (`accesses.create` server-side; the plugin is the actor on the recipient's own platform).
4. Writes a delivered `consent/accept-cmc` event into the requester's `:_cmc:_internal:responses:<capId>` (via the capability connection) carrying the data-grant's apiEndpoint.
5. The **requester's plugin**, on the other side, creates the back-channel access on the requester's account:
   - Permissions: `create-only` on `:_cmc:inbox`. If features include chat: read on the requester's chat stream (so recipient can see history).
   - `clientData.cmc`: `{ role: 'counterparty', counterparty: { username, host, accessId: <patient-grant-id>, apiEndpoint: <patient-grant-apiEndpoint> } }`
6. The requester's plugin returns the back-channel apiEndpoint to the recipient via the same capability connection (e.g. via a server-stamped follow-up event the recipient's plugin reads back).
7. The recipient's plugin stores the back-channel apiEndpoint in `clientData.cmc.counterparty.backChannelApiEndpoint` on the local data-grant access.
8. Both plugins update their local trigger events with `status: 'completed'`.

After this exchange, both plugins hold each other's apiEndpoints in their access records, enabling all subsequent server-orchestrated cross-platform writes.

### Same-platform vs cross-platform delivery

**All actions look the same from the app's perspective**: one `events.create` on the user's own platform. The plugin's orchestration differs by where the counterparty lives:

| Counterparty location | Plugin's outbound call |
|---|---|
| Same core, same platform | In-process write to recipient's `:_cmc:inbox` (no HTTPS round-trip). |
| Different core, same platform | HTTPS call to the peer core's `/events` endpoint using the stored counterparty apiEndpoint (which already carries an access token). The receiving plugin processes normally. |
| Different platform | HTTPS call to the remote platform's `/events` endpoint using the stored counterparty apiEndpoint. Identical mechanism to cross-core; the only difference is destination host. |

**Open invite (`to: null`):** Capability-URL-based. The request stays on the requester's platform; recipient's plugin pulls it via the capability access when the recipient's app writes `consent/accept-cmc` (or `consent/refuse-cmc`).

**Same-platform directed invite (`to: <local-username>`):** Plugin's in-process write deposits a notification into the recipient's `:_cmc:inbox` automatically when the requester writes `consent/request-cmc`. Recipient sees it via socket.io. Capability URL also minted as fallback.

**Cross-platform directed invite:** Capability-URL-only in v1. The plugin has no authenticated way to write into a foreign user's `:_cmc:inbox` without an existing access pair. Auto-routing requires federation auth → out of scope for v1 (federation work later).

### App scoping for the requester

Apps namespace their work under `:_cmc:apps:<app-id>:...`. Plain `streams.create({parentId: ':_cmc:apps'})` for the app root, then nest freely. The plugin doesn't reserve sub-names under `:_cmc:apps`. Optional enforcement: the app's Pryv access carries `clientData.cmc.appScope: ':_cmc:apps:my-app'`; the plugin's write-hook on `:_cmc:apps:*` rejects writes outside the declared scope with `cmc-scope-violation`. Default is no enforcement (cooperative apps).

### State projections

The plugin maintains `:_cmc:state` server-side as projections off the user's outgoing scope streams + `:_cmc:inbox`:

- `cmc/request-status-v1` events, one per request, content reflects current status.
- `cmc/access-state-v1` events, one per data-grant or back-channel access this user holds, content reflects current permissions + serial.

Apps query via plain `events.get({streamIds:[':_cmc:state']})`.

### Socket.io push

Every successful `:_cmc:inbox` write (whether by in-process plugin routing for same-platform same-core directed invites, or by counterparty access writes for everything else) fires a standard socket.io `eventsCreated`. The recipient's app uses the standard `@pryv/monitor` add-on, `new pryv.Monitor(connection, { streams: [':_cmc:inbox'] })` + `monitor.on('event', cb)` + `monitor.start()`, no new socket primitive.

## Risks

- **`:_cmc:inbox` is writable by counterparty accesses.** This is unusual for
  Pryv: no other stream accepts writes on the strength of a `clientData`
  marker. The write-hook is the enforcer, and it is the part of this component
  to read first when reviewing security. It rejects a forged `content.from` by
  stamping the value itself from the access's stored counterparty identity, and
  it refuses event types outside the family that the relationship allows.
- **Single-use enforcement under concurrency.** Two accepters can hit the same
  open invite at once, so first-write-wins has to be decided by the database
  rather than by a read-then-write in the plugin.
- **Cross-platform directed invites.** Not supported. A directed invite to a
  user on another platform degrades to capability-URL hand-off; auto-routing
  needs a federation channel that does not exist yet.
- **State projection cost.** If `:_cmc:state` is ever materialized off
  outbox/inbox it is O(events) on write, so it wants a benchmark before any
  high-volume operator enables it. It is not implemented today.
- **Existing legacy data.** The compatibility shim covers runtime; migrating
  stored legacy data is deferred.

## Out of scope

- **Cross-platform directed invite auto-routing**: capability-URL hand-off works; auto-routing is out of scope for v1 (federation work later).
- **Dedicated cross-core auth lane.** Same-platform cross-core deliveries take the same standard HTTPS path as cross-platform, the apiEndpoint's access token is the auth. We deliberately do NOT short-circuit via cluster-CA mTLS on `/events` (see "Future development scoping" below).
- New API methods. New public HTTP routes on the core. (Capability access `apiEndpoint` URLs go through the existing access-auth path.)
- OAuth2 / signatures / operator-side global revoke, future OAuth2 / app-accounts work.
- E2E encryption of message payloads, backlog.
- Group / many-to-many messaging, operator concern (fan-out N events).
- Cross-platform data migration of existing legacy "Collector" data, legacy shim handles runtime.

## Future development scoping: mTLS / cluster CA stays out of the data path

**Principle (locked):** the cluster CA + mTLS capabilities introduced by the multi-core bootstrap and consumed by the Let's Encrypt cert replication are reserved for **platformDB traffic** (rqlite Raft + admin) and **setup-scope operations** (bootstrap join tokens, init-ca-holder, cert materialization). They MUST NOT be extended to general API data-path auth, e.g. authenticating one core's writes to another core's `/events`, `/streams`, `/accesses` endpoints.

**Why this principle:**

1. **The data path's auth model is the access token.** Every Pryv API call carries a `personal` / `app` / `shared` access token; that token is the actor identity. Layering cert-based actor identity on top creates two parallel auth lanes with subtly different semantics (cert says "this core"; token says "this user/app"). The combination is hard to reason about and easy to get wrong (e.g. permission elevation if cert auth bypasses access-permission checks).
2. **Cross-core and cross-platform must remain symmetric.** CMC's federation story rests on "the only thing connecting two parties' data is the stored apiEndpoint", that's true today both intra-cluster and inter-platform. A cross-core auth shortcut would break the symmetry and tempt code paths that don't work cross-platform.
3. **No correctness gap to fix.** The standard HTTPS path delivers correctly across cores, across clusters, and across operators. Any "optimization" is shaving handshakes, not solving an outage.
4. **Surface area cost is real.** A second auth lane on `/events` means new middleware, new test matrices, new security-review burden every time the endpoint changes. The cluster CA was scoped narrowly on purpose; extending it everywhere erodes that discipline.

**What this leaves on the table (intentionally):**

- A future "cluster-internal fast lane" idea: out of scope. If we ever build one, it should be a separate plan with its own threat model. The default answer is no.
- Removing TLS handshake cost on cross-core hops, accept the cost; rely on HTTP keep-alive + connection pooling.

**Where mTLS / cluster CA IS used (current correct scope):**

- rqlite Raft channel + admin (bootstrap + ACME).
- Bootstrap join-token verification on `/system/admin/cores/ack` (the multi-core bootstrap).
- LE-acme cert replication across cores via the rqlite TLS-enabled keyspace (ACME cert replication).
- Init-ca-holder cluster-CA-signed cert materialization (the bootstrap bundle hardening).

Anything else proposing mTLS should justify why it can't live in those scopes.

## Future development scoping: platformDB / cross-core state stays out of CMC's vocabulary

**Principle (locked):** the same discipline applies to platformDB (rqlite) and cluster-state primitives. CMC introduces **zero new storage primitives** and lives entirely in the user's standard main storage. Internal plugin state (retry queue) lives as events in a hidden companion stream (`:_cmc:_internal:retries`) inside main storage, NOT in rqlite.

**Why this principle:**

1. **CMC is per-user functionality.** A user lives on one core; their CMC state belongs with their data. Reaching into platform-level cross-core storage breaks that natural boundary.
2. **Cross-core resilience is a separate problem.** Today, if a user's home core dies, the user is unreachable until it recovers. CMC's pending deliveries inherit the same failure mode, no special handling needed. If we ever want true cross-core HA for users, that's a platform-wide plan, not a CMC concern.
3. **Tooling reuses what already works.** Backup (`bin/backup.js` (the backup CLI)), restore, cross-core forwarding (cross-core forwarding) all already handle per-user main storage. CMC's hidden companion stream rides on the same tooling.
4. **Hidden companion streams are an existing pattern.** Pryv already has internal streams (`_email`, `_account`, etc.) filtered from regular reads. `:_cmc:_internal:retries` is the same shape, no new mechanism.

**What this leaves on the table (intentionally):**

- Cross-core failover of pending CMC deliveries, out of scope. Pending deliveries wait for home core. Acceptable v1.
- Any "CMC has a cluster-wide state" feature: out of scope. If we discover a need, it goes in a separate plan.

**Where rqlite / platformDB IS used (current correct scope, untouched by CMC):**

- user-core mapping (cross-core forwarding)
- DNS records (persistent DNS records)
- TLS cert replication (the Let's Encrypt integration)
- access-state for `/reg/access` polls (the `cluster_kv` master-held primitive)
- observability config (the optional observability provider)
- schema_migrations tracking (the schema-migrations framework)
- bootstrap tokens (the multi-core bootstrap)

CMC does not add to this list.

## Settled by the implementation

These were open while the component was being designed. The shipped code
answered them, so they are recorded here as behaviour, not as choices still to
be made.

1. **Namespace name: `:_cmc:`.** The alternatives considered (`:channels:`,
   `:consent:`, `:messages:`, `:cross:`) are moot: the prefix is part of the
   published wire format and of every stream id an app builds, so it is fixed.
2. **Capability TTL default: 7 days**
   (`capability.ts` `DEFAULT_TTL_SECONDS`). A caller may set an absolute
   `content.request.expiresAt` on `consent/request-cmc`; values outside the
   accepted bounds (floor 60 s) are refused with
   `cmc-capability-ttl-out-of-range`, and the default applies when no
   `expiresAt` is given.
3. **System-messaging opt-in is all-or-nothing.** The negotiated flag is a
   single boolean, `clientData.cmc.features.systemMessaging`; there is no
   per-level (info / warning / critical) granularity.
4. **Back-channel apiEndpoint delivery: a `consent/back-channel-cmc` event.**
   The requester's plugin POSTs it to the accepter's `:_cmc:inbox` shortly
   after the accept, and the accepter stores the endpoint in
   `clientData.cmc.counterparty`. It is not stamped onto the accept's
   `events.create` response, which is why a data-grant access is briefly
   present with no back-channel recorded (the two-stage behaviour described in
   [IMPLEMENTERS-GUIDE.md](IMPLEMENTERS-GUIDE.md)).

## Open questions

1. **`:_cmc:inbox` deletion.** Should a user be able to `events.delete` from
   their inbox? No CMC-specific guard covers it today, so the standard events
   rules apply; nothing has deliberately ruled on it.
2. **Quota numbers.** A per-source per-recipient inbox limit (100 events/min
   was proposed) is not implemented. Operators rely on their own rate limiting
   in the meantime.
3. **Legacy shim removal date.** Product decision, unchanged: removal in a
   follow-on cycle once consumer apps have migrated.
4. **`:_cmc:state` semantics across multiple apps.** Still deferred; the
   projection stream is not implemented, and apps query their own trigger
   streams for status. Filter by app at read time, or project per-app
   server-side, remains undecided.
5. **Capability access visibility in `accesses.get`.** Whether capability
   accesses should be hidden by default and surfaced only to operator audit is
   still unsettled.
6. **App-scope enforcement default.** Whether `clientData.cmc.appScope` should
   be enforced only when set (opt-in) or always when present is still
   unsettled.
7. **Deeper OAuth2 / capability unification.** OAuth2 already references CMC
   capability URLs: a client registers `cmcOffers` and the matching
   `cmc:<name>` scope tokens (`components/oauth2/src/clientRegistry.ts`). Using
   the capability access mechanism as the store for OAuth2 authorization codes
   themselves, which share the single-use, TTL-bounded shape, has not been
   done.

---

# License

[BSD-3-Clause](LICENSE)
