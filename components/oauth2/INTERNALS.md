# oauth2 — Internals

Design rationale + invariants that aren't obvious from the code. Read this before changing the storage layer, the routing layer, or the multi-core flow.

## Multi-core flow

Open Pryv.io deployments can run multiple cores fronted by a load balancer. Each user account is bound to ONE home core; PlatformDB (rqlite) is cluster-replicated.

| Endpoint | Lands on | Why |
|---|---|---|
| `GET /oauth2/authorize` | Any core | Validates client via the PlatformDB cache (`oauth-client/<clientId>`); the user's home core is not yet known. |
| Consent UI (`auth.pryv.me/oauth2-authorize`) | Any core (via app-web-auth3 then `GET /reg/<username>/server` → user's home core) | User authenticates against THEIR home core. |
| `POST /oauth2/authorize/accept` | **User's home core** | The granted access row lives in the user's per-user accesses table. The authorization-code row records this core's id (`coreId`) and the access id, never the access token. |
| `POST /oauth2/token` (any grant) | **User's home core** (the issuer resolves there, see `wellKnown.ts`) | The code grant reads the access token back from this core's storage, and the refresh grant re-mints through it, so both must reach the issuing core. There is no cross-core forwarding: a code presented to another core answers `invalid_grant` and logs the routing fault. |
| `GET /<username>/<api>` with Bearer | User's home core (via `checkUserCore.ts` 421 + `coreUrl`) | Existing Pryv resource-server routing; OAuth-issued tokens flow through unchanged. |

### Why `iss` is per-deployment, not per-core

`.well-known/oauth-authorization-server` is served by every core, but the `iss` field (and `authorization_endpoint`, `token_endpoint`, etc.) advertises the **load-balancer-facing URL** (e.g. `https://reg.pryv.me`), not the per-core URL. Every core's discovery doc MUST agree. Per-core URLs are internal routing detail; clients use the canonical service URL.

Operators MUST keep the `oauth.*` config block in sync across cores; the discovery doc cannot accommodate disagreement. An optional `bin/oauth-client.js doctor` subcommand may surface config drift in a later commit.

### Why vanilla OAuth clients need the `apiEndpoint` extension

After `/oauth2/token` returns an access token, that token is bound to a specific user on a specific home core. Vanilla RFC 6749 clients don't know about Pryv's home-core routing — they'd hit `reg.pryv.me/<user>/<api>`, receive `421 + coreUrl` from `checkUserCore.ts`, and fail (RFC 6749 doesn't define 421-handling).

The Pryv-specific `apiEndpoint` field in the token response (carried over from the existing `/reg/access` ACCEPTED response shape) tells the client the home-core URL directly. lib-js reads it automatically; vanilla clients MUST be told to read it (operator-facing doc deliverable). Single-core deployments: `apiEndpoint` equals the LB URL — no client-side change needed.

## PlatformDB keyspaces

The component uses these PlatformDB keyspaces, the TTL'd ones on the existing `setAccessState` / `getAccessState` machinery. PlatformDB is replicated to every core, so no credential is stored in it: codes and refresh tokens appear only as the SHA-256 of their value in the key (they are 256-bit random values, so no salt or slow hash is needed), and no row carries an access token.

| Keyspace | Lifetime | Contents | Per-core? |
|---|---|---|---|
| `oauth-client/<clientId>` | indefinite (rotated on App-account update) | Client metadata: `redirectUris`, `scope`, `grantTypes`, `updatedAt`, plus optional `clientName`, `clientUri`, `logoUri`, `applicationType`, `clientSecretHash`, `jwks`, `jwksRef`, `accountUserId`, `cmcOffers` | NO — cluster-wide |
| `oauth-client-revoked/<clientId>` | until pruned (`pruneRevokedClients`, by tombstone age) | `{ revokedAt }` — revoke tombstone, written by `deleteClient`. A token EPOCH, not a name reservation: each core caches it (`revokedClientsCache`) and the resource-server path refuses the client's oauth-session accesses minted before that epoch, so live tokens stop working before they expire. Re-registering the same id does NOT clear it. | NO — cluster-wide |
| `oauth-ac/<sha256(code)>` | 600s | `{ clientId, redirectUri, codeChallenge, codeChallengeMethod, userId, scope, expiresAt, accessId?, coreId?, dataGrantAccessId?, permissions? }` | YES — issuing core's id is in the row |
| `oauth-rt/<coreId>/<sha256(token)>` | sliding 30d (cap 90d absolute) | `{ clientId, userId, scope, issuedAt, lastUsedAt, expiresAt, absoluteExpiresAt, dataGrantAccessId?, permissions?, jkt? }` | YES — issuing core's id is in the key |
| `oauth-rt-used/<coreId>/<sha256(token)>` | remaining life of the rotated token | `{ clientId, userId, dataGrantAccessId?, consumedAt }` — reuse-detection marker (chain identity, no credential) | YES |

**No row carries a username.** Code and refresh rows identify the account by
`userId` only, and the client row points at its account through `accountUserId`; a
grant that needs the username resolves it locally on the core that serves the
exchange. Rows written before `accountUserId` existed carry `accountUsername`
instead and are read only through `legacyAccountUsername()`. This is what lets a
deployment keep usernames out of the replicated store.

`jwks` holds PUBLIC EC P-256 keys only (validated on write), so cluster-wide
caching is safe; `cmcOffers` maps a `cmc:<name>` scope to the capability URL of a
consent offer published by the app's account.

**Upgrade from raw keys.** Earlier releases used `oauth-code/<code>` (with the access token in the row) and `oauth-refresh[-used]/<coreId>/<token>`. At master boot each core moves its own refresh rows to the hashed keys (`rekeyLegacyRefreshTokens`, idempotent; another core's rows wait for that core's upgrade). Legacy code rows are read once by `consumeCode` so an exchange in flight across the upgrade completes; they expire within 10 minutes, and that read is to be removed in the following release.

**Orphaned accesses.** When a code is consumed but the exchange fails, or a code expires unexchanged, the pre-minted access is deleted from the issuing core's storage (grant failure path, and `orphanSweep.ts` from the master sweep for this core's expired rows). Legacy rows are still revoked over HTTP with the token they carry.

### Why client metadata is cluster-wide (no `coreId` prefix)

By design, client REGISTRATION METADATA may live in PlatformDB (NOT credentials — the only secret-derived value cached is the bcrypt hash, which is one-way). Cluster-wide reads are essential: `/oauth2/authorize` can land on any core, and the validator MUST resolve `client_id` → `redirect_uris` instantly. A `coreId` prefix would force a cross-core fetch on every authorize.

The App account's own `:_app:*` streams remain the authoritative source. The PlatformDB row is a denormalized read-cache; the operator CLI updates both atomically (single transaction at the write boundary).

### Why codes + refresh tokens carry `coreId`

Authorization codes and refresh tokens are bound to the **issuing core** because:

1. The granted access row lives in that core's per-user accesses table — only that core can revoke/inspect/touch it.
2. Refresh-token rotation + reuse-detection requires single-writer semantics; a cluster-wide row would invite race conditions.
3. Refresh tokens are core-sticky by multi-core design.

The `coreId` (in the refresh key, in the code row) lets a core recognise a row it did not issue and refuse it with `invalid_grant` instead of acting on another core's accesses.

## Redirect-URI matching

`matchRedirectUri(presented, registered)` is exact-string match with ONE carve-out: loopback addresses may vary port.

```
registered = "https://app.example.com/cb"
presented  = "https://app.example.com/cb"          → MATCH
presented  = "https://app.example.com/cb/"         → NO MATCH (trailing slash)
presented  = "https://app.example.com/cb?x=1"      → NO MATCH (query)
presented  = "https://app.example.com:443/cb"      → NO MATCH (explicit port)

registered = "http://127.0.0.1/cb"
presented  = "http://127.0.0.1:8742/cb"            → MATCH (loopback carve-out)
presented  = "http://127.0.0.1:8742/cb/"           → NO MATCH (trailing slash even on loopback)

registered = "com.example.app:/cb"
presented  = "com.example.app:/cb"                 → MATCH (private-use URI scheme)
```

No regex, no prefix matching, no scheme normalization. RFC 9700 §2.1 + RFC 8252 §7.5. Phishers exploit lax matching; we don't blink.

An exhaustive matcher test family (`[OAUTH-REDIR]`) is planned alongside the hardening pass; the callers are wired as the grant handlers land.

## Audit-event awaiting

Every audit emission MUST be `await`ed. Silent fire-and-forget is a deliberate anti-pattern — the existing `components/audit/` contract guarantees that audit failures surface; bypassing that via fire-and-forget defeats forensics.

Performance: audit writes are local (SQLite per-user audit DB); typical latency &lt; 5 ms. Not a hot-path concern.

## DPoP (RFC 9449) sender-constrained tokens

Opt-in per request: a client that presents a `DPoP` proof on `/oauth2/token`
binds the issued token to its key's RFC 7638 thumbprint (`jkt`). The bearer path
is untouched; tokens stay opaque CUID2.

- **Binding:** `src/routes/token.ts` verifies the proof (ES256-only, dependency-free
  `node:crypto` — `src/dpop.ts`) before any grant runs, then stamps `jkt` onto the
  access row (`bindAccessDpop` callback, authorization_code) and the refresh row
  (`grants/refresh_token.ts`, rotation keeps the same key). `/oauth2/token` returns
  `token_type: "DPoP"` for bound chains.
- **Scheme capture:** the `DPoP` scheme is read in `MethodContext`/`initContext`
  (NOT `getAuth`, which runs before `req.context` exists and is skipped by the
  batch route).
- **Enforcement:** `MethodContext.checkDpopBinding` runs in `retrieveExpandedAccess`
  — the shared choke point across HTTP, batch, socket.io and hfs — so a bound token
  is unusable without a matching proof on every transport (bound tokens fail closed
  over socket.io/hfs, which carry no proof).
- **Replay defence:** keyspace `dpop-jti/<jkt>/<jti>` via the atomic
  `setAccessStateIfAbsent` primitive (first-writer-wins single-use); TTL ≈ 2× the
  clock-skew window (`oauth.dpop.clockSkewSeconds`, default 120s).

### Operator revoke-by-key

`bin/oauth-client.js revoke-key <jkt> --yes` tombstones a single key thumbprint —
kill one leaked device/session key without revoking the whole client. Keyspace
`dpop-jkt-revoked/<jkt>` → `{ revokedAt }`, cluster-wide (each core reads it
locally — there is no cross-core bus). `MethodContext.checkDpopKeyNotRevoked`
consults a per-core cache (`src/revokedKeysCache.ts`, TTL
`oauth.dpop.keyRevokeCheckSeconds`, default 30s) and rejects any bound access on a
revoked key; `token.ts` additionally refuses to mint or rotate on a revoked key.

Semantics are **presence (blocklist), NOT the token-epoch used for client revoke**:
a `clientId` is a re-assignable name (re-registration is a fresh trust decision
whose new tokens must live), but a `jkt` IS the key — so any token bound to a
revoked jkt is dead regardless of mint time, including one a refresh rotation
re-mints on the same key after the revoke (an epoch check would wrongly honour it).
`unrevoke-key` clears the tombstone (operator recovery); the master sweep prunes
tombstones past the max token lifetime.
