# Shared secrets — Internals

> **Audience:** plugin engineering, security review. **Not customer-facing** —
> for the API-consumer view see [IMPLEMENTERS-GUIDE.md](IMPLEMENTERS-GUIDE.md).

## Storage model

Zero new storage primitives. Every shared secret is one ordinary event in
standard per-user main storage (PG / SQLite), living under the reserved namespace
`:_shared-secrets:<accessId>` — one substream per creating access. The prefix is
routed to the local store as passthrough in
`components/mall/src/helpers/storeDataUtils.ts` (same branch shape as `:_cmc:`),
so the full prefixed id is preserved verbatim.

The event reuses standard fields rather than inventing columns:

| Field | Carries |
|---|---|
| `time` + `duration` | the TTL. Expiry is exactly `now > time + duration`; a missing/non-positive duration counts as expired (fails closed). |
| `trashed` | terminal marker — set when the item leaves `pending`. Distinguishes live (default `events.get`) from consumed/discarded (`state: trashed`). |
| `content.keyHash` | hex `SHA-256` of the key's random half. The only key derivative stored. |
| `content.status` | `pending` \| `consumed` \| `discarded`; `statusHistory` is append-only. |
| `content.secret` | the payload — present only while `pending`. |
| `content.signature` | `{ type, value? }`; `value` present only while `pending`. |
| `content.onConsumed` | `{ message, returnUrl? }` returned once the item is spent. |

## The key

`key = <eventId>.<randomPart>` (`src/key.ts`). The event id makes retrieval an
O(1) `getOne`; the random part (≥192 bits, base64url) is the credential. Only its
SHA-256 is stored. `parse()` returns `null` on any malformed shape — it runs on
unauthenticated input, so a wrong guess must be indistinguishable from garbage.
Comparisons are constant-time and tolerate a length mismatch (`timingSafeEqual`
would otherwise turn "wrong length" into a distinguishable throw).

Two creation modes: server-minted (`key.mint`, key returned once) or
client-supplied `keyHash` (the caller generated the random half, so it can bind
an `hmac-sha256` signature before the item exists; the server returns no key).

## One-shot consume — compare-and-set

The consume must yield exactly one winner under concurrency. Neither engine had a
conditional update, so one was added: `mall.events.update(..., { onlyIfNotTrashed
})` threads a CAS predicate `AND (trashed IS NULL OR trashed = FALSE)` into the
engine `UPDATE` (`storages/engines/postgresql/.../localUserEventsPG.ts`,
`storages/engines/sqlite/.../UserDatabase.ts`). The mall returns `null` for the
loser instead of raising. The status/`trashed` pair moves together, and the
transition pre-reads `pending` before the CAS, so `trashed` is a faithful proxy.

`{ skipVersioning }` on the same call suppresses the pre-update history snapshot:
an update whose purpose is to *remove* the secret must not archive a copy of it.
Without this, `versioning.forceKeepHistory: true` would keep the clear secret in a
version row and hand it back via `events.getOne?includeHistory=true`.

Retrieval flow (`methods/shared-secrets.ts`): parse → `getOne` → verify the event
is type `shared-secret/item` **and** lives in the namespace (type alone is not
identity — a forged event elsewhere must not redeem) → constant-time hash compare
→ pending? → expired? (lazy, transitions to `discarded/expired`) → signature? →
atomic consume → return secret.

## Guard seams

The items are ordinary events, so the ordinary API can reach them; guards keep
that from subverting the lifecycle. All are pure factories wired into the method
chains (`methods/events.ts`, `methods/streams.ts`):

| Hook | Chain | Effect |
|---|---|---|
| `createEventCreateGuard` | `events.create` (first) | refuse a hand-made event in the namespace, and the reserved type `shared-secret/item` anywhere else. |
| `createEventUpdateGuard` | `events.update` (after the event loads) | refuse any update whose subject OR result touches the namespace / reserved type — blocks both editing an item and moving an ordinary event in. |
| `createEventDeleteGuard` | `events.delete` (after load) | pending → rewrite to `discarded/deleted` for the chain's trashing step (which is a CAS, see above); terminal → let the normal delete hard-purge it. |
| `createStreamCreateGuard` / `UpdateGuard` / `DeleteGuard` | `streams.*` | refuse hand-made creation, and refuse renaming/re-parenting/deleting namespace streams (personal tokens included — moving the root would expose every secret). |
| `createEnsureStreamsOnReadHook` | `events.get`, `streams.get` (first) | lazily provision the namespace when a READ reaches into it, best-effort. Without it a consumer whose first action is "list my secrets" would 404 forever — the read that needs the stream is also what refuses to create it (the gap CMC #111 hit). |

Creation-time provisioning goes through `mall.streams.create` directly, bypassing
these guards (the plugin provisions its own parents).

## Permission model (`business/src/accesses/AccessLogic.ts`)

Deny-by-default across the whole namespace for non-personal accesses:
`canGetEventsOnStream`, `canCreateEventsOnStream` and `canListStream` short-circuit
— an access is allowed only on `:_shared-secrets:<its own id>`, and the root (or
any non-substream id under the prefix) is refused outright, so a broad `*` grant
cannot resolve to `read` on it. Personal tokens see everything, as elsewhere.

`events.get` wildcard exclusion (`methods/helpers/eventsGetUtils.ts`) adds
`not: [':_shared-secrets:']` to every `*` query on the local store, **before**
stream expansion so the whole subtree goes with the root. `streams.get` filters
foreign substreams out of the returned tree (`guards.filterVisibleStreams`), since
the permission-derived excluded-ids list cannot express "your own substream only".

## `secretSharing` opt-out

A feature permission `{ feature: 'secretSharing', setting: 'forbidden' }`
(default-allow, mirroring `selfRevoke`). `canCreateSharedSecrets()` gates the
create method. `canCreateAccess.inheritRestrictions` pushes the bar onto any
child a restricted access creates — inside `canCreateAccess`, which both
`accesses.create` and `accesses.update` share, so the restriction cannot be
shed by re-issuing the child without it.

## Audit note

`sharedSecrets.retrieve` runs with no access (key-authenticated). The audit hook
substitutes the `INVALID` access id for such calls (`components/audit/src/Audit.ts`)
— without it, `validApiCall` dereferenced a null access and a successful
redemption crashed the core wherever audit is enabled. `Result.writeToHttpResponse`
also observes the audit callback's promise so a failure there logs instead of
becoming an unhandled rejection.
