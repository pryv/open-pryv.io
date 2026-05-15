# components/cmc — Cross-Account Messaging & Consent plugin (`:_cmc:`)

> **Living design.** This README is the canonical design document for the CMC plugin. Companions in this directory:
> - [IMPLEMENTERS-GUIDE.md](IMPLEMENTERS-GUIDE.md) — customer-facing wire shape (API consumers).
> - [INTERNALS.md](INTERNALS.md) — plugin-side flow diagrams (engineering / security review).

**Status:** Design locked. Implementation in progress on the `feature/cmc` branch.

**Design pillars:**
1. **Plugin, not storage engine** — CMC lives at `components/cmc/`; all state in standard per-user main storage (PG / Mongo).
2. **Zero new storage primitives** — retry queue is a hidden companion stream `:_cmc:_internal:retries`; rate-limit is per-worker in-memory.
3. **`:_cmc:apps:` user namespace** — user-creatable streams pack under one plugin-managed parent.
4. **Three-region stream model** — `:_cmc:inbox` (one-shot lifecycle) / `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` (per user-pair, nested under the app/path the trigger was written to) / `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` (per collector-relationship, same nesting).
5. **System family absorbs scope-update** — `consent/scope-request-cmc` + `consent/scope-update-cmc` flow on the system channel; `accesses.update` post-hook auto-notifies the counterparty for user-initiated scope changes.

Cross-core mTLS optimization deliberately omitted; see "Future development scoping" sections below.

## Goal

Add a **first-class cross-account messaging + consent primitive** to open-pryv.io that works **across independent open-pryv.io deployments** — no shared cluster CA, no federation auth, no shared user namespace. Apps interact entirely through existing `events.create` / `events.get` / `streams.create` / `accesses.create` calls — **no new API methods, no new public HTTP routes on the core**.

The plugin's role is purely to:

- Validate `cmc/*` event-type schemas server-side.
- Mint **capability accesses** (single-event-scoped shared accesses) for invite hand-off.
- Provision streams + grant bidirectional shared accesses transactionally when a recipient accepts.
- Drive `accesses.update` (composite-id versioning) when scope-update accepts flow through.
- Maintain `:_cmc:state` projections.
- Emit socket.io pushes locally.
- **Act as a federated client** to remote platforms — making outbound HTTPS calls to deliver cross-account writes using the bidirectional access pair's apiEndpoints as credentials. This is the key architectural property: apps never write directly to a counterparty's account. They write a single event on their own platform and the plugin orchestrates everything else.

All cross-account communication — pre-acceptance via capability URL, post-acceptance via the bidirectional shared accesses — is **server-orchestrated**. The plugin on the actor's platform performs the local state change (e.g., `accesses.delete`, `accesses.update`, `accesses.create`) and then makes the outbound API call to the counterparty's platform using stored apiEndpoints. The receiving plugin processes the incoming write locally. There's no inter-platform plugin-to-plugin protocol beyond standard Pryv API calls.

This means the same protocol works:

- Same-core single-platform.
- Cross-core same-cluster (intra-operator, multi-core).
- **Cross-platform between two independent open-pryv.io deployments** with different domains, different operators, different `dnsLess` topologies, no shared trust.

The three event-type families (requests, chat, system — the latter folding in scope-update notifications) ship together in one coherent plugin.

## Why this matters

`the legacy collector-app template pattern` reimplements an ad-hoc cross-account workflow on top of plain Pryv primitives, with `clientData.cmcCollector.*` as an untyped discovery contract, per-Collector stream trees as state machines, `create-only` access permissions as message-queue tokens, and polling for catch-up. The pattern works within one operator's deployment but doesn't scale to **cross-platform** scenarios where the provider and user.are on separate open-pryv.io instances run by different operators — the design assumes shared trust at points where there is none.

Promoting the workflow to the platform via `:_cmc:` and leaning entirely on Pryv's existing `accesses.*` primitive as the federation fabric:

1. Kills inbox polling — direct API writes from one party's app to the other's apiEndpoint + socket.io push on receipt.
2. Kills delete+create on scope change — plugin proxies the recipient's accept into `accesses.update` (composite-id versioning preserves audit history).
3. Kills `clientData`-as-protocol — request/response shapes become first-class typed events validated by the plugin.
4. Kills the N×`streams.create` boilerplate — acceptance is transactional server-side.
5. Kills the leaky shared-access capability URL — capability is a single-event-scoped access; standard Pryv `apiEndpoint` URL.
6. **Works across independent platforms without federation auth.** Capability accesses pre-acceptance + bidirectional shared accesses post-acceptance are the federation.

And it does this **without changing the API surface** that clients consume. `lib-js@3.1.0` (the composite-id `accesses.update` floor) works unchanged.

## Scope locked in interactive Q&A (2026-05-13)

| Question | Answer |
|---|---|
| Implementation vehicle | **Dedicated CMC plugin (NOT a new storage engine).** Stream-id-namespace owner + orchestration hooks under `components/cmc/`. Reserves the `:_cmc:` prefix with the mall dispatcher for write-hook routing only — all state lives in the user's standard storage (PG/Mongo) alongside the user's other events / accesses / streams. **No new API methods. No new public HTTP routes on the core. No new storage engine.** |
| Composite-id `accesses.update` floor | Yes. Plugin uses composite-id `accesses.update` + `accessUpdated` socket event natively. |
| First-ship event-type families | All three: **requests + chat + system messages** (system family absorbs scope-update via `consent/scope-request-cmc` + `consent/scope-update-cmc`). One coherent plugin. |
| Federation model | **Cross-platform between independent operators is a first-class supported case.** No shared CA, no federation auth, no shared user namespace. Capability accesses + bidirectional shared accesses are the fabric. Topology-invariant (works for `dnsLess: true` and `false`). |
| Cross-core within one cluster | Same standard HTTPS path as cross-platform — the only addressing primitive is the counterparty's stored `apiEndpoint`. No special cross-core data-path treatment. |
| Capability URLs | **Standard Pryv `apiEndpoint` URLs.** Server mints a single-event-scoped shared access on the requester's account; the access's apiEndpoint IS the capability URL. No new endpoint, no opaque token store. |
| App scoping for the requester | Standard stream hierarchy — apps create their own `:_cmc:apps:<app-id>:<scope>` sub-trees via `streams.create({parentId: ':_cmc:apps'})` (and nested children with the matching parentId). Optional access-level enforcement via `clientData.cmc.appScope`. |
| Operator opt-in surface | The plugin manifest is itself the toggle (plugin loaded or not). No separate config flag. |
| Helpers in `legacy-shim` | Allowed. Old `Collector` / `CollectorClient` classes proxy to the new primitives during legacy-shim migration. |
| Scope-update constraint | Covers all of the composite-id `accesses.update` surface area: widening, narrowing, removing permissions; expiry chain changes. Server pre-validates the permission-chain rules when the collector writes `consent/scope-request-cmc`; the user's `consent/scope-update-cmc` (or a direct `accesses.update` call through the post-hook) triggers a plugin-internal `accesses.update`. |

## Relationship to future OAuth2 / app-accounts work

CMC and the future OAuth2 / app-accounts work sit at different layers:

- **CMC (this plugin)** defines the **wire shape of the cross-account workflow**: how a request is published, how a recipient accepts, what events flow on which streams.
- **OAuth2 / app-accounts (future)** defines the **server-to-server identity model**: how Platform A signs requests to Platform B, how operators register peers, how operator-side global revoke works.

CMC's protocol works without that future federation layer because every interaction is a direct Pryv API call through a per-pair shared access — the access token IS the auth. But one feature is gated on it:

**Directed cross-platform invites** (`to: 'alice@example.com'` where Alice is on a different platform) cannot be auto-routed without a federation channel. CMC v1 supports directed invites only **same-platform**; cross-platform directed invites degrade to capability-URL-only (the requester publishes the request, hands the URL to Alice via email/QR/etc.). When signed inter-platform requests + a well-known invite-webhook endpoint ship, CMC can fold directed cross-platform routing in as a follow-on.

The capability access mechanism here is also the natural store for future OAuth2 authorization codes — both are single-use, TTL-bounded, opaque-token-equivalent constructs.

## Architecture

### Data residency

**CMC introduces zero new storage primitives.** All state — user-visible and plugin-internal — lives in the user's **standard per-user main storage (PG / Mongo)**, addressed through the normal `events.*` / `accesses.*` / `streams.*` API paths. The plugin's role is purely:

1. **Stream-id-namespace ownership** — reserve the `:_cmc:` prefix with the mall dispatcher so writes to `:_cmc:*` route through CMC's hooks.
2. **Validation + orchestration hooks** — pre/post hooks on `events.create` (for `cmc/*` types), `accesses.update` (for the counterparty post-hook), and stream-creation under `:_cmc:` (reserved-root enforcement + anchor stream auto-creation idempotence).
3. **Outbound HTTPS client** — federated cross-platform / cross-core delivery using stored counterparty `apiEndpoint`s. No special data-path auth lane; standard access-token HTTPS.
4. **Helpers** — slug computation, schema validators, status-projection helpers (shipped in `lib-js` / `legacy-shim`).

| Data | Lives in |
|---|---|
| `:_cmc:*` events (request, accept, refuse, revoke, chat, system-*) | Per-user main storage's standard events table |
| Capability access, data-grant access, back-channel access | Per-user main storage's standard accesses table |
| `:_cmc:inbox` / `:_cmc:apps:<app-code>:[<path>:]chats:<slug>` / `:_cmc:apps:<app-code>:[<path>:]collectors:<slug>` / `:_cmc:apps:<...>` stream definitions | Per-user main storage's standard streams table |
| Slug → access lookup | Same accesses table, indexed on `clientData.cmc.counterparty.{username, host}` |
| **Retry queue** for pending outbound deliveries | **Hidden companion stream `:_cmc:_internal:retries`** in per-user main storage. Each pending delivery = one event with `content.{apiEndpoint, payload, attempts, nextAttemptAt}`. Standard `events.create` / `events.update` / `events.delete` for queue management. |
| **Rate-limit counters** | **Per-worker in-memory** sliding window. N× drift on N-worker cores is accepted for v1; `cluster_kv` (master-held in-process, same-core cross-worker primitive) is the fallback if drift matters in practice. |

**rqlite / platformDB is NOT part of CMC's design surface at all.** Same scoping principle as the mTLS / cluster-CA discipline below: cross-core platform infrastructure stays out of CMC's vocabulary. If CMC ever needs cross-core resilience (e.g., retry-queue failover when the home core dies), that's a separate plan with its own threat model — not a v1 feature.

**Hidden companion stream convention:** the `:_cmc:_internal:*` prefix is filtered out of regular `events.get` / `streams.get` responses. Operators / admin tooling using a personal access can opt-in to see them. Modeled on how Pryv's existing system streams (`:_system:email`, `:_system:account`) handle internal-vs-visible distinction via the `isShown: false` flag.

**Sequencing dependency (preferred):** the hidden-stream primitive today is entangled with the system-streams config-plugin machinery — only system streams can be marked `isShown: false`. To declare `:_cmc:_internal:*` hidden cleanly, the hidden-stream pattern needs to be promoted to a first-class baseStorage primitive available to any plugin. That promotion is proposed as a prerequisite and should land BEFORE CMC implementation. If CMC ships first, CMC carries its own filter middleware as interim debt.

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
| `:_cmc:_internal:offer:<capId>` | plugin (per capability) | plugin-internal | per-capability single-event stream — bears the request event the capability access reads via `:_cmc:_internal:offer` parent (recursive expand). GC'd with the capability access. Not hidden — capability access permissions provide the scoping. |
| `:_cmc:_internal:responses:<capId>` | plugin (per capability) | plugin-internal | per-capability single-write stream — receives the one accept/refuse event written through the capability connection. GC'd with the capability access. Not hidden — capability access permissions provide the scoping. |

**Where `<path>` comes from:** the `chats` and `collectors` sub-segments live directly under whichever stream the trigger was written to. If the app writes a `consent/request-cmc` to `:_cmc:apps:my-app`, chat/collector streams hang off `:_cmc:apps:my-app:chats:*` / `:_cmc:apps:my-app:collectors:*`. If it writes to `:_cmc:apps:my-app:study-A`, they hang off `:_cmc:apps:my-app:study-A:chats:*` / `:_cmc:apps:my-app:study-A:collectors:*`. This lets the app's access be scoped at the app level OR at a per-request sub-tree by simple prefix-match.

**Anchoring rationale (locked):**
- **Chat is anchored per user-pair** — one thread per counterparty regardless of how many collector relationships exist between you. Matches messaging-app intuition.
- **System channel is anchored per collector-relationship** — each access pair has its own system stream so a study's reminders don't bleed into clinical-care alerts from the same doctor.
- **One-shot lifecycle events** stay in flat `:_cmc:inbox` because they don't have a stable per-counterparty home (e.g. an incoming `consent/request-cmc` from a stranger you don't yet have a relationship with).

**Slug conventions:**
- `<counterparty-slug>` = `<username>--<host-slug>` where `host-slug` replaces `.` with `-`. Examples: `alice--example-com`, `bob--my-host-example-org`. Same slug shape is used both for chat (`:chats:<counterparty-slug>`) and for system/collector relationships (`:collectors:<counterparty-slug>`) — the app-code and any per-request scoping live in the stream PATH, not in the slug.
- Double-hyphen (`--`) is the load-bearing separator; usernames and host-slugs use single hyphens so `--` is unambiguous.
- Helper `pryv.cmc.counterpartySlug({username, host})` ships in `lib-js` / `legacy-shim`.

**Cross-platform identity in slugs is required.** `alice@example.com` and `alice@example.com` are different people; the host is part of the slug.

*State projection across all scopes (`:_cmc:state`) deferred to v2 — trigger events carry their own status in `content.status`.*

**`:_cmc:inbox` is plugin-internal-write-only.** Apps never write to it directly. The receiving plugin's outbound-call handler (server-internal) is the only writer; it validates the incoming HTTPS request bears a counterparty access token (carrying `clientData.cmc.role: 'counterparty'`, server-managed and not app-visible), stamps `content.from` from the access's stored counterparty identity, and inserts the event. Senders cannot forge `content.from` — they can only deliver via their own counterparty access tokens which encode their identity.

### Event-type families and the plugin-as-orchestrator model

**Apps always write to their own platform.** A user-initiated action is a single `events.create` on a stream under `:_cmc:` — either a user-managed `:_cmc:apps:*` scope stream (lifecycle triggers) or a plugin-managed `:_cmc:apps:<app-code>:[<path>:]chats:<slug>` / `:_cmc:apps:<app-code>:[<path>:]collectors:<slug>` stream (chat + system triggers). The plugin reads the write, performs the local state change, and (if the action affects a counterparty) makes the outbound API call to the counterparty's platform using stored apiEndpoints. The plugin updates the original trigger event's content with `status: 'pending' | 'completed' | 'failed'` as orchestration progresses; the app reads back via socket.io subscription on the relevant stream.

Counterparty events arrive in the recipient's `:_cmc:inbox` only because the **sender's plugin** wrote them via the stored apiEndpoint — never by the sender's app directly. The receiving plugin's write-hook on `:_cmc:inbox` validates that the actor carries `clientData.cmc.role: 'counterparty'`, stamps `content.from` from the access's stored counterparty identity, and fires socket.io push.

All event types live under the `cmc/*` namespace and are validated by the plugin via JSON Schema (registered in the plugin manifest).

**Family 1 — Requests (one-shot lifecycle, anchored at `:_cmc:inbox`):**

| Event type | App writes to | Plugin orchestration |
|---|---|---|
| `consent/request-cmc` | requester's own user-managed `:_cmc:apps:*` scope stream | Mints capability access on requester's account. If `to:` set and recipient local same-platform, also writes a notification copy into recipient's `:_cmc:inbox` (in-process). For cross-platform directed: no auto-routing (capability URL hand-off only). |
| `consent/accept-cmc` | recipient's own user-managed `:_cmc:apps:*` scope stream, content carries the capability URL | Plugin: reads offer via capability connection; creates local data-grant access on recipient's account with permissions from the offer; uses capability connection to deliver accept event (with grantedAccess apiEndpoint) to requester's platform; receives back-channel apiEndpoint in response; stores it in `clientData.cmc.counterparty` of the data-grant. Plugin also auto-creates `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` + `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` on the recipient's account, nested under whichever app-scope stream the recipient wrote the accept trigger to. |
| `consent/refuse-cmc` | recipient's own user-managed `:_cmc:apps:*` scope stream, content carries capability URL | Plugin: delivers refuse via capability connection; capability is consumed. |
| `consent/revoke-cmc` | either party's own user-managed `:_cmc:apps:*` scope stream, content carries `accessId` | Plugin: `accesses.delete` locally on the access; uses stored counterparty apiEndpoint to deliver `consent/revoke-cmc` to the other party's `:_cmc:inbox`; receiving plugin `accesses.delete`s its half of the pair. |

Delivered counterparties of `consent/request-cmc` (when same-platform directed) / `consent/accept-cmc` / `consent/refuse-cmc` / `consent/revoke-cmc` land in the recipient's `:_cmc:inbox` — the one-shot lifecycle channel.

**Family 2 — Chat (anchored per user-pair under the app/path scope at `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>`):**

| Event type | App writes to | Plugin orchestration |
|---|---|---|
| `message/chat-cmc` | sender's `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` stream (plugin auto-creates on first chat) | Plugin resolves the relevant access pair from the counterparty slug, delivers chat event to recipient's matching `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` stream via stored apiEndpoint. Sent and received chat events live in the same per-counterparty stream on each side — one thread per user-pair per app-scope. |

**Family 3 — System messages, incl. scope-update (anchored per collector-relationship under the app/path scope at `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>`):**

| Event type | App writes to | Plugin orchestration |
|---|---|---|
| `notification/alert-cmc` | operator's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream | Plugin verifies the participant access has `features.systemMessaging: true`; delivers alert to participant's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored data-grant apiEndpoint; enforces per-participant rate limits. |
| `notification/ack-cmc` | participant's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream | Plugin delivers ack to operator's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored back-channel apiEndpoint. |
| `consent/scope-request-cmc` | collector's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream (collector → user proposes scope change) | Plugin pre-validates permission-chain rules locally (collector must hold manage rights on the underlying data-grant; new permissions must be ⊆ collector's own app permissions); delivers the ask to user's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored data-grant apiEndpoint. User can `consent/scope-update-cmc` to accept (or simply ignore to refuse). |
| `consent/scope-update-cmc` | user's `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream (responds to a request OR self-initiated change) | Plugin calls `accesses.update` locally on the data-grant access; delivers the update to collector's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream via stored back-channel apiEndpoint; receiving plugin emits `accessUpdated` socket event locally. |

The four system event types share one stream per collector-relationship so a study's reminders don't bleed into clinical-care alerts from the same doctor, and scope-change history lives where the relationship itself lives.

### `accesses.update` post-hook (user-side scope changes via the standard API)

A user can change scope on a CMC counterparty access through the standard Pryv API — `accesses.update` with a fresh permissions array. The plugin's post-hook on `accesses.update`:

1. Detects the updated access carries `clientData.cmc.role: 'counterparty'`.
2. Reads the stored counterparty apiEndpoint + collector-stream-id from the access's `clientData.cmc`.
3. Auto-fires `consent/scope-update-cmc` to the counterparty's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` stream so the counterparty's app is notified.

The user gets the standard `accesses.update` composite-id surface for scope changes without needing to write a CMC trigger event; the collector still hears about it on the same system channel as if the user had used `consent/scope-update-cmc` directly.

**Double-fire suppression** (carried as open question 6 in SessionState): when the CMC trigger handler itself calls `accesses.update`, the post-hook must not redundantly fire a second notification. Implementation tactic TBD (cls flag, request-scoped marker, or distinguished caller identity).

**State tracking (v1):** the trigger event itself IS the state record. Apps query their own scope streams to see action status. The plugin updates each trigger event's `content.status` as orchestration progresses. No separate projection stream in v1.

**Deferred to v2:** `:_cmc:state` server-projection for cross-scope summaries (`cmc/request-status-v1`, `cmc/access-state-v1` synthesized across all the user's `:_cmc:apps:*` streams). Ship only on real consumer demand.

### Capability accesses

When a `consent/request-cmc` is written with `capabilityRequested: true`, the plugin creates a special shared access on the requester's account, backed by **two real per-capability streams** (not virtual streams — per-event access scoping doesn't exist in core, see audit notes):

- **Type:** `shared`
- **Name:** `__cmc-cap-<short-id>`
- **Per-capability streams** (created by the plugin alongside the access):
  - `:_cmc:_internal:offer:<capId>` — contains the single request event (server-stamped, immutable for the capability lifetime).
  - `:_cmc:_internal:responses:<capId>` — empty at creation; receives exactly one `consent/accept-cmc` or `consent/refuse-cmc` event during the capability's life.
- **Permissions:**
  - `read` on `:_cmc:_internal:offer:<capId>`.
  - `create-only` on `:_cmc:_internal:responses:<capId>`.
- **`clientData.cmc`:** `{ kind: 'capability', requestEventId: <id>, singleUse: true }`
- **TTL:** operator-configured default (7 days proposed); requester can override per-request.
- **Auto-deletion:** single-use; plugin deletes the access after the first successful response write.

The access's `apiEndpoint` IS the capability URL — a standard `pryv.Connection(url)` works against it. Hidden from `accesses.get` by default (filtered by `clientData.cmc.kind: 'capability'`); operators can opt to surface them via a query parameter.

### Bidirectional shared accesses (post-acceptance)

When the recipient's app writes `consent/accept-cmc` to a local scope stream, the recipient's plugin orchestrates:

1. Opens the capability connection (URL is in the trigger event's content).
2. Reads the linked request via `events.get({streamIds: [':_cmc:_internal:offer']})` through the capability — recursive expand resolves to the one accessible child stream `:_cmc:_internal:offer:<capId>`.
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

- `cmc/request-status-v1` events — one per request, content reflects current status.
- `cmc/access-state-v1` events — one per data-grant or back-channel access this user holds, content reflects current permissions + serial.

Apps query via plain `events.get({streamIds:[':_cmc:state']})`.

### Socket.io push

Every successful `:_cmc:inbox` write (whether by in-process plugin routing for same-platform same-core directed invites, or by counterparty access writes for everything else) fires a standard socket.io `eventsCreated`. The recipient's app uses `monitor.subscribe(':_cmc:inbox')` — no new socket primitive.

## Phases

### Phase A — Implementer's Guide (FIRST DELIVERABLE — user review gate)

Output: `IMPLEMENTERS-GUIDE.md`.

A standalone document written from an API-consumer's perspective. The reader is an app/bridge developer building on open-pryv.io. The doc walks through every flow with full JSON for every API call, then provides reference sections on event-type schemas, capability accesses, socket subscription, error catalogue, and migration from the legacy "Collector" pattern. Includes a dedicated section on cross-platform federation showing that the same protocol works between independent operators.

**Exit:** Pierre review. Any wire-shape change in later phases must update this document.

### Phase B — Engineering pre-flight (spec + open questions)

Output: short spec docs alongside this README (or expanded sections of this README).

1. **`PLUGIN-INTERFACE.md`** — how a plugin reserves a stream-id prefix with the mall dispatcher + registers pre/post write-hooks on `events.create` / `accesses.update` / `streams.create`. **Confirms CMC is NOT a new storage engine** — all state lives in standard per-user storage; the plugin only routes hook execution. Audit existing precedents (system-streams in the system-streams module, observability in the optional observability provider) for the cleanest pattern.
2. **`DATA-RESIDENCY.md`** — documents (a) the `:_cmc:_internal:*` hidden-stream convention and read-hook filter; (b) the required index on the accesses table's `clientData.cmc.counterparty.{username, host}`; (c) the retry-queue event schema on `:_cmc:_internal:retries`; (d) v1 limitations (home-core failover delays pending retries; per-worker rate-limit drift). Short doc — the decision matrix is gone now that we've locked "zero new storage primitives."
3. **`EVENT-SCHEMAS.md`** — full JSON Schema for every `cmc/*` event type, split by write-side vs deliver-side.
4. **`CAPABILITY-ACCESSES.md`** — capability access permission shape; per-capability real streams `:_cmc:_internal:offer:<capId>` (single-event-bearing) + `:_cmc:_internal:responses:<capId>` (single-write); TTL; single-use enforcement; lifecycle (mint + GC with the capability).
5. **`COUNTERPARTY-ACCESSES.md`** — `clientData.cmc.role: 'counterparty'` permission model on `:_cmc:inbox`, write-hook validation rules, `content.from` stamping.
6. **`FEDERATION.md`** — cross-platform reference: the bidirectional access pair, what happens on each platform's plugin, where state lives, what fails how. **Notes that cross-core same-platform deliveries take the same standard HTTPS path as cross-platform — no dedicated cross-core auth lane.**
7. **`SECURITY-NOTES.md`** — threat model. Replay protection, `content.from` spoofing prevention (capability access marker), capability interception, quota abuse, single-use enforcement under concurrency.
8. **`OPEN-QUESTIONS.md`** — track unresolved decisions.

**Exit:** specs reviewed; open questions resolved or explicitly deferred.

### Phase C — Plugin skeleton & namespace registration

1. Create `components/business/src/cmc/` (NOT `storages/datastores/` — CMC is a plugin, not a storage engine) with: plugin manifest, namespace-registration helper, write-hook registration, schema-validators directory, slug helpers, type-script source. No new storage engine, no new mall routing target — `:_cmc:*` events / accesses / streams use the existing per-user PG/Mongo storage paths.
2. Register `:_cmc:` prefix with mall dispatcher for **write-hook routing only**. Reserve the five plugin-managed parent regions (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, `:_cmc:_internal`, `:_cmc:_internal:retries`) so they auto-exist on every user account. Allow user `streams.create({parentId: ':_cmc:apps'})` for everything user-creatable. Reject `streams.create` directly under `:_cmc:` outside `:_cmc:apps`. The `chats` / `collectors` sub-segments are plugin-reserved at any depth under `:_cmc:apps:<app-code>:...` and auto-created on demand by the plugin (user code may not create them).
3. Auto-provision the five reserved parent streams on user creation (system-stream-style — they always exist).
4. Wire into the API server hook chain (after access auth, before storage write). No `storages.init()` participation — the plugin doesn't own storage.
5. Test: `[CMCNS]` namespace registration + reserved-root rejection + auto-provisioning + `:_cmc:apps` sub-stream creation (10–12 tests).

**Exit:** PG + Mongo matrix green; users can `streams.create({parentId: ':_cmc:apps'})`; reserved-root streams reject mutation; `cmc/*` events can be written into `:_cmc:apps:*` sub-streams; events / accesses / streams under `:_cmc:*` are queryable via the standard `events.get` / `accesses.get` / `streams.get` paths (no plugin-specific reader).

### Phase D — Plugin orchestration framework + capability + accept/refuse

1. Implement the **trigger-event dispatch loop**: plugin watches `cmc/*` writes across all `:_cmc:` regions (user-managed `:_cmc:apps:*` for lifecycle, plugin-managed `:_cmc:apps:<app-code>:[<path>:]chats:*` / `:_cmc:apps:<app-code>:[<path>:]collectors:*` for chat + system); dispatches to per-type orchestration handlers; updates trigger event content with `status` lifecycle.
2. Implement the plugin's **outbound HTTPS client** for making Pryv API calls to counterparty apiEndpoints. Includes timeout + audit logging. **Retry queue:** hidden companion stream `:_cmc:_internal:retries` in per-user main storage; one event per pending delivery with `content.{apiEndpoint, payload, attempts, nextAttemptAt}`. Queue management via standard `events.create` / `events.update` / `events.delete`. Survives core restart; pending deliveries wait for home core to recover (no cross-core failover in v1 — same semantics as the user's other queued work).
3. Implement capability access minting on `consent/request-cmc` triggers with `capabilityRequested: true`. Materialize per-capability streams `:_cmc:_internal:offer:<capId>` (with the single request event) and `:_cmc:_internal:responses:<capId>` (empty, awaiting single accept/refuse). Grant the capability access `read` + `create-only` on those two streams.
4. Implement `consent/accept-cmc` / `consent/refuse-cmc` orchestration:
   - Plugin opens capability connection via stored URL from trigger event.
   - Reads offer; creates local data-grant access; delivers accept via capability connection.
   - Receives back-channel apiEndpoint from response; stores in `clientData.cmc.counterparty.backChannelApiEndpoint`.
5. Implement single-use consumption + auto-deletion of capability access.
6. Implement counterparty marker (`clientData.cmc.role: 'counterparty'`) on both sides of the access pair, with stored apiEndpoints.
7. Test: `[CMCCAP]` capability mint/read/consume (12 tests), `[CMCREQ]` end-to-end accept/refuse with plugin orchestration (15 tests), `[CMCRACE]` concurrent-accept race resolution (3 tests), `[CMCRETRY]` outbound-call failure/retry (5 tests).

**Exit:** End-to-end open-invite flow works as a single trigger event on each side; both plugins coordinate via stored apiEndpoints; data-grant + back-channel accesses are bidirectionally wired.

### Phase E — Counterparty writes on `:_cmc:inbox` (receiving side validation)

1. Implement `:_cmc:inbox` write-hook that accepts incoming writes from counterparty accesses (server-internal — these writes come from the **plugin's outbound HTTPS calls**, not from app code).
2. Validate the actor's `clientData.cmc.role === 'counterparty'`, the event type matches the role's allowed family, content schema is valid.
3. Stamp `content.from` from the access's stored counterparty identity.
4. Fire socket.io push.
5. Test: `[CMCINBOX]` write-hook validation (10 tests), `[CMCFROM]` content.from stamping (4 tests), `[CMCROLE]` allowed-event-type enforcement (8 tests).

**Exit:** Counterparty writes via the plugin's outbound calls are received, validated, and pushed correctly.

### Phase F — Chat + revoke + auto-anchor streams

1. Implement per-app/path `:chats` parent + per-counterparty `:chats:<counterparty-slug>` auto-creation hook (nested under whichever `:_cmc:apps:<app-code>:[<path>:]` scope stream the trigger was written to) in accept orchestration (so the anchor stream exists before the first chat write).
2. Implement `message/chat-cmc` orchestration: plugin resolves access pair from counterparty slug + delivers chat to counterparty's matching `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>` via stored apiEndpoint.
3. Implement `consent/revoke-cmc` orchestration: plugin `accesses.delete`s locally + delivers `consent/revoke-cmc` to counterparty's `:_cmc:inbox`; receiving plugin `accesses.delete`s its half and the anchor streams are left in place (history preserved).
4. Quota / rate-limit per-source per-recipient on outbound deliveries. **Per-worker in-memory** sliding window. N× drift on N-worker cores accepted for v1; `cluster_kv` (master-held in-process) is the fallback if drift matters in practice.
5. Test: `[CMCCHAT]` (8 tests, incl. per-counterparty stream auto-create idempotence), `[CMCREVOKE]` (8 tests), `[CMCRATE]` (4 tests).

**Exit:** Chat works as one trigger on the sender's `:_cmc:apps:<app-code>:[<path>:]chats:<counterparty-slug>`; revoke is a single trigger that tears down both halves of the access pair.

### Phase G — System channel (alerts + acks + scope-request + scope-update)

1. Implement per-app/path `:collectors` parent + per-counterparty `:collectors:<counterparty-slug>` auto-creation (nested under whichever `:_cmc:apps:<app-code>:[<path>:]` scope stream the trigger was written to) in accept orchestration (so the anchor stream exists at acceptance, before any system messages can flow).
2. Implement `notification/alert-cmc` / `notification/ack-cmc` orchestrations: plugin delivers to counterparty's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` via stored apiEndpoint.
3. Implement `consent/scope-request-cmc` orchestration (collector side): plugin pre-validates permission-chain rules locally + delivers ask to user's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` via stored data-grant apiEndpoint.
4. Implement `consent/scope-update-cmc` orchestration (user side, both response-to-request AND self-initiated): plugin calls `accesses.update` locally on the data-grant access + delivers the update to collector's matching `:_cmc:apps:<app-code>:[<path>:]collectors:<counterparty-slug>` via stored back-channel apiEndpoint. Receiving plugin emits `accessUpdated` socket event locally.
5. Implement `accesses.update` post-hook: detect counterparty accesses + auto-fire `consent/scope-update-cmc` notification to the counterparty's collector stream. Implement double-fire suppression so the CMC trigger handler's own `accesses.update` call doesn't trigger a redundant notification.
6. Enforce opt-in: counterparty access must carry `clientData.cmc.features.systemMessaging: true`.
7. Operator-specific quota; critical alerts higher allowance.
8. Test: `[CMCSYS]` system-alert/ack flows (10 tests), `[CMCSCOPE]` scope-request/scope-update flows (15 tests: widening/narrowing/removing/expiry/self-initiated/stale-id), `[CMCPOSTHOOK]` accesses.update post-hook + double-fire suppression (8 tests).

**Exit:** All four event-type families functional. Cross-core deliveries use the same standard HTTPS path as cross-platform (no dedicated cross-core auth lane — see "Future development scoping" note below).

### Phase H — Socket.io push

1. Hook every successful `:_cmc:inbox` insert (by the plugin's incoming-delivery handler) to emit a socket.io event.
2. Hook every trigger-event status update (orchestration progress) to emit a socket.io event on the trigger's scope stream.
3. Test: `[CMCPUSH]` socket.io delivery (5 tests), `[CMCTRIGGERPUSH]` trigger status updates (5 tests).

**Exit:** Recipients see inbox arrivals without polling; senders see action-status updates without polling.

*(`:_cmc:state` cross-scope projection deferred to v2 — apps query their own trigger streams for status in v1.)*

### Phase I — legacy-shim helpers + backwards-compat shims

(In `the legacy client library ` — user-driven; this plan documents the surface.)

1. `Connection.cmcSend(type, content, options?)` — convenience for `events.create({streamIds: [<scope>], type, content})`.
2. `Connection.cmcSubscribe(handler)` — monitor wrapper for `:_cmc:inbox`.
3. `Collector` / `CollectorClient` proxy classes — route to `:_cmc:` underneath.

**Exit:** legacy can adopt without rewriting consumer apps.

### Phase J — Test matrix + deploy + cross-platform e2e + public docs

1. Full PG + Mongo matrix green. Plugin tests live under `components/cmc/test/`. No new conformance matrix — `:_cmc:*` events / accesses / streams pass through the existing per-user-storage conformance.
2. Deploy to `dev-pryv2-single` (single-core single-platform), validate.
3. Deploy to pryv.me `core-use1` + `core-euc1`, validate cross-core via the standard HTTPS path.
4. **Cross-platform e2e**: stand up a second open-pryv.io instance on a different domain (e.g. dev-deploy could add `dev-cmc-peer.example.com`); run a request → accept → chat → scope-update → revoke flow with users on both platforms. Different `dnsLess` topologies on each side ideally.
5. `lib-js` conformance against deployed infra unchanged (no API surface drift).
6. **Public-docs hand-off.** This is the moment the customer-facing chain catches up with the implementation:
   - `CHANGELOG-v2.md` (API-facing) + `CHANGELOG-v2-back.md` (internal) entries written.
   - **dev-site dedicated CMC section** — a new top-level page on `pryv.github.io` that links into the canonical [IMPLEMENTERS-GUIDE.md](IMPLEMENTERS-GUIDE.md) in this component (or republishes its content with a stable URL). Pattern matches how the v2 topology rewrite and the Let's Encrypt integration (LE integration) added customer-resources pages.
   - **Documentation chain** — every public entry-point that references CMC (customer-resources sidebar, API reference, change-log, "What's new" page) gets a link to the component's `IMPLEMENTERS-GUIDE.md`. No stale stale plan-tracking references in public docs.
   - `lib-js` README + `legacy-shim` README cross-link to `components/cmc/IMPLEMENTERS-GUIDE.md` as the canonical wire-shape doc.

**Exit:** Production deploy. Cross-platform interop demonstrated. Public-doc chain refreshed; this component is discoverable from the dev-site landing page.

## Risks & open questions

- **`:_cmc:inbox` writable-by-counterparty permission model.** New behaviour for Pryv — today no stream accepts writes from accesses based on a `clientData` marker. The plugin's write-hook is the enforcer. Careful security review needed: must reject forged `content.from`, must validate event-type belongs to the family allowed for the access's counterparty relationship.
- **Capability access lifecycle.** Hidden from `accesses.get` by default? Visible? Discoverable by operator audit?
- **Back-channel apiEndpoint delivery.** How does the recipient retrieve the back-channel apiEndpoint after writing accept? Proposed: the plugin appends a `cmc/accept-receipt-v1` event to `:_cmc:_internal:offer:<capId>` (readable via the same capability connection). Or: the accept event's `events.create` response includes it server-stamped.
- **Single-use enforcement under concurrency.** Two patients simultaneously hit an open invite (`to: null`); first-write-wins must be transactional. Tested in `[CMCRACE]`.
- **`:_cmc:inbox` quota / abuse.** Per-source per-recipient rate-limit is defensive. Operator may want platform-level limits too.
- **State projection cost.** Maintaining `:_cmc:state` materialized off outbox/inbox is O(events) on write. For high-volume operators, benchmark before Phase H ships.
- **Cross-platform directed invites.** Out of scope for v1. Backlog item depending on future OAuth2 / app-accounts work federated invite webhook.
- **Capability access visibility.** Operators may want audit visibility. Plugin should expose capability accesses to operator audit but hide from regular `accesses.get`.
- **Existing legacy data.** Legacy compat shim covers runtime; data migration deferred.

## Out of scope

- **Cross-platform directed invite auto-routing** — capability-URL hand-off works; auto-routing is out of scope for v1 (federation work later).
- **Dedicated cross-core auth lane.** Same-platform cross-core deliveries take the same standard HTTPS path as cross-platform — the apiEndpoint's access token is the auth. We deliberately do NOT short-circuit via cluster-CA mTLS on `/events` (see "Future development scoping" below).
- New API methods. New public HTTP routes on the core. (Capability access `apiEndpoint` URLs go through the existing access-auth path.)
- OAuth2 / signatures / operator-side global revoke — future OAuth2 / app-accounts work.
- E2E encryption of message payloads — backlog.
- Group / many-to-many messaging — operator concern (fan-out N events).
- Cross-platform data migration of existing legacy "Collector" data — legacy shim handles runtime.

## Future development scoping — mTLS / cluster CA stays out of the data path

**Principle (locked):** the cluster CA + mTLS capabilities introduced by the multi-core bootstrap and consumed by the Let's Encrypt cert replication are reserved for **platformDB traffic** (rqlite Raft + admin) and **setup-scope operations** (bootstrap join tokens, init-ca-holder, cert materialization). They MUST NOT be extended to general API data-path auth — e.g. authenticating one core's writes to another core's `/events`, `/streams`, `/accesses` endpoints.

**Why this principle:**

1. **The data path's auth model is the access token.** Every Pryv API call carries a `personal` / `app` / `shared` access token; that token is the actor identity. Layering cert-based actor identity on top creates two parallel auth lanes with subtly different semantics (cert says "this core"; token says "this user/app"). The combination is hard to reason about and easy to get wrong (e.g. permission elevation if cert auth bypasses access-permission checks).
2. **Cross-core and cross-platform must remain symmetric.** CMC's federation story rests on "the only thing connecting two parties' data is the stored apiEndpoint" — that's true today both intra-cluster and inter-platform. A cross-core auth shortcut would break the symmetry and tempt code paths that don't work cross-platform.
3. **No correctness gap to fix.** The standard HTTPS path delivers correctly across cores, across clusters, and across operators. Any "optimization" is shaving handshakes — not solving an outage.
4. **Surface area cost is real.** A second auth lane on `/events` means new middleware, new test matrices, new security-review burden every time the endpoint changes. The cluster CA was scoped narrowly on purpose; extending it everywhere erodes that discipline.

**What this leaves on the table (intentionally):**

- A future "cluster-internal fast lane" idea — out of scope. If we ever build one, it should be a separate plan with its own threat model. The default answer is no.
- Removing TLS handshake cost on cross-core hops — accept the cost; rely on HTTP keep-alive + connection pooling.

**Where mTLS / cluster CA IS used (current correct scope):**

- rqlite Raft channel + admin (bootstrap + ACME).
- Bootstrap join-token verification on `/system/admin/cores/ack` (the multi-core bootstrap).
- LE-acme cert replication across cores via the rqlite TLS-enabled keyspace (ACME cert replication).
- Init-ca-holder cluster-CA-signed cert materialization (the bootstrap bundle hardening).

Anything else proposing mTLS should justify why it can't live in those scopes.

## Future development scoping — platformDB / cross-core state stays out of CMC's vocabulary

**Principle (locked):** the same discipline applies to platformDB (rqlite) and cluster-state primitives. CMC introduces **zero new storage primitives** and lives entirely in the user's standard main storage. Internal plugin state (retry queue) lives as events in a hidden companion stream (`:_cmc:_internal:retries`) inside main storage, NOT in rqlite. Rate-limit counters live in per-worker memory or — if drift becomes a concern — in `cluster_kv` (master-held in-process, **same-core** cross-worker — NOT a cross-core primitive).

**Why this principle:**

1. **CMC is per-user functionality.** A user lives on one core; their CMC state belongs with their data. Reaching into platform-level cross-core storage breaks that natural boundary.
2. **Cross-core resilience is a separate problem.** Today, if a user's home core dies, the user is unreachable until it recovers. CMC's pending deliveries inherit the same failure mode — no special handling needed. If we ever want true cross-core HA for users, that's a platform-wide plan, not a CMC concern.
3. **Tooling reuses what already works.** Backup (`bin/backup.js` (the backup CLI)), restore, cross-core forwarding (cross-core forwarding) all already handle per-user main storage. CMC's hidden companion stream rides on the same tooling.
4. **Hidden companion streams are an existing pattern.** Pryv already has internal streams (`_email`, `_account`, etc.) filtered from regular reads. `:_cmc:_internal:retries` is the same shape — no new mechanism.

**What this leaves on the table (intentionally):**

- Cross-core failover of pending CMC deliveries — out of scope. Pending deliveries wait for home core. Acceptable v1.
- Strictly accurate cross-core rate-limiting — out of scope. Per-worker memory with N× drift is acceptable; `cluster_kv` is a same-core upgrade path if needed.
- Any "CMC has a cluster-wide state" feature — out of scope. If we discover a need, it goes in a separate plan.

**Where rqlite / platformDB IS used (current correct scope, untouched by CMC):**

- user-core mapping (cross-core forwarding)
- DNS records (persistent DNS records)
- TLS cert replication (the Let's Encrypt integration)
- access-state for `/reg/access` polls (the `cluster_kv` master-held primitive)
- observability config (the optional observability provider)
- schema_migrations tracking (the schema-migrations framework)
- bootstrap tokens (the multi-core bootstrap)

CMC does not add to this list.

## Open questions (carry through Phase B)

1. **Namespace name.** `:_cmc:` is functional but cryptic. Alternatives: `:channels:`, `:consent:`, `:messages:`, `:cross:`. Decide before Phase C.
2. **`:_cmc:inbox` deletion.** Can a user `events.delete` from their inbox? Proposed: yes, soft-delete.
3. **Capability TTL default.** 7 days proposed. **Align with future OAuth2 token TTL default.**
4. **Quota numbers.** Per-source per-recipient inbox limit: 100 events/min proposed.
5. **System-messaging opt-in granularity.** All-or-nothing vs per-level (info/warning/critical)?
6. **Legacy shim removal date.** Proposed: removed in a follow-on cycle after CMC ships and consumer apps are migrated.
7. **`:_cmc:state` semantics across multiple apps.** Filter by app at read time vs server-projected per-app?
8. **Future OAuth2 capability-token unification.** Use CMC's capability access mechanism for OAuth2 authorization codes too? Same single-use, TTL-bounded, opaque-token-equivalent.
9. **Back-channel apiEndpoint delivery mechanism.** Plugin appends a follow-up event to `:_cmc:_internal:offer:<capId>` (capability connection re-read)? Or `events.create` response carries it server-stamped?
10. **Capability access visibility in `accesses.get`.** Hidden by default? Always visible to operator?
11. **App-scope enforcement default.** `clientData.cmc.appScope` enforced when set (opt-in) vs always enforced when present (default-on)?

---

## Pre-implementation checklist

- [x] **Phase A Implementer's Guide drafted** (federation-friendly redesign)
- [x] **Component scaffolded** at `components/cmc/` (Phase C foundation: constants + slug + validators + 59 unit tests)
- [ ] Phase B spec docs written + reviewed
- [ ] composite-id `accesses.update` floor confirmed deployed on dev infra
- [ ] Future OAuth2 / app-accounts work cross-referenced once Phase B closes
- [ ] client-lib team aware (co-coordinated plan for legacy-shim helpers)
- [ ] Hidden-streams-as-baseStorage primitive landed (preferred prerequisite) OR explicit decision to ship CMC-specific filter middleware as interim debt
- [ ] Scoped-notification refactor landed (optional optimization — CMC works correctly under coarse notifications via lib-js client-side filtering even without it)
- [ ] dev-site dedicated CMC section drafted (see Phase J item 6)
- [ ] Cross-platform test infrastructure spec (second open-pryv.io instance — dev-deploy YAML)
- [ ] Doc workflow: every change to design or behaviour applies here (README + IMPLEMENTERS-GUIDE + INTERNALS) first.


# License

[BSD-3-Clause](LICENSE)
