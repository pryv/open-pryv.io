# oauth2 — Internals

Design rationale + invariants that aren't obvious from the code. Read this before changing the storage layer, the routing layer, or the multi-core flow.

## Multi-core flow

Open Pryv.io deployments can run multiple cores fronted by a load balancer. Each user account is bound to ONE home core; PlatformDB (rqlite) is cluster-replicated.

| Endpoint | Lands on | Why |
|---|---|---|
| `GET /oauth2/authorize` | Any core | Validates client via the PlatformDB cache (`oauth-client/<clientId>`); the user's home core is not yet known. |
| Consent UI (`auth.pryv.me/oauth2-authorize`) | Any core (via app-web-auth3 then `GET /reg/<username>/server` → user's home core) | User authenticates against THEIR home core. |
| `POST /oauth2/authorize/accept` | **User's home core** | The granted access row lives in the user's per-user accesses table. Authorization code stored in PlatformDB with `coreId` prefix locks the code to this core. |
| `POST /oauth2/token` (any grant) | **User's home core** (via `forwardIfCrossCore` if not local) | The code/refresh-token row's `coreId` prefix dictates routing. Vanilla RFC 6749 clients never see the cross-core hop. |
| `GET /<username>/<api>` with Bearer | User's home core (via `checkUserCore.ts` 421 + `coreUrl`) | Existing Pryv resource-server routing; OAuth-issued tokens flow through unchanged. |

### Why `iss` is per-deployment, not per-core

`.well-known/oauth-authorization-server` is served by every core, but the `iss` field (and `authorization_endpoint`, `token_endpoint`, etc.) advertises the **load-balancer-facing URL** (e.g. `https://reg.pryv.me`), not the per-core URL. Every core's discovery doc MUST agree. Per-core URLs are internal routing detail; clients use the canonical service URL.

Operators MUST keep the `oauth.*` config block in sync across cores; the discovery doc cannot accommodate disagreement. An optional `bin/oauth-client.js doctor` subcommand may surface config drift in a later commit.

### Why vanilla OAuth clients need the `apiEndpoint` extension

After `/oauth2/token` returns an access token, that token is bound to a specific user on a specific home core. Vanilla RFC 6749 clients don't know about Pryv's home-core routing — they'd hit `reg.pryv.me/<user>/<api>`, receive `421 + coreUrl` from `checkUserCore.ts`, and fail (RFC 6749 doesn't define 421-handling).

The Pryv-specific `apiEndpoint` field in the token response (carried over from the existing `/reg/access` ACCEPTED response shape) tells the client the home-core URL directly. lib-js reads it automatically; vanilla clients MUST be told to read it (operator-facing doc deliverable). Single-core deployments: `apiEndpoint` equals the LB URL — no client-side change needed.

## PlatformDB keyspaces

The component uses three PlatformDB keyspaces, all designed to fit the existing `setAccessState` / `getAccessState` TTL machinery:

| Keyspace | Lifetime | Contents | Per-core? |
|---|---|---|---|
| `oauth-client/<clientId>` | indefinite (rotated on App-account update) | Client metadata: `redirectUris`, `scope`, `clientName`, `logoUri`, `clientUri`, `grantTypes`, `applicationType`, `clientSecretHash?` | NO — cluster-wide |
| `oauth-code/<coreId>/<code>` | 600s | `{ clientId, redirectUri, codeChallenge, codeChallengeMethod, userId, scope, expiresAt, accessId? }` | YES — issuing core's id is in the key |
| `oauth-refresh/<coreId>/<token>` | sliding 30d (cap 90d absolute) | `{ clientId, userId, scope, issuedAt, lastUsedAt, expiresAt, absoluteExpiresAt }` | YES — issuing core's id is in the key |

### Why client metadata is cluster-wide (no `coreId` prefix)

By design, client REGISTRATION METADATA may live in PlatformDB (NOT credentials — the only secret-derived value cached is the Argon2id hash, which is one-way). Cluster-wide reads are essential: `/oauth2/authorize` can land on any core, and the validator MUST resolve `client_id` → `redirect_uris` instantly. A `coreId` prefix would force a cross-core fetch on every authorize.

The App account's own `:_app:*` streams remain the authoritative source. The PlatformDB row is a denormalized read-cache; the operator CLI updates both atomically (single transaction at the write boundary).

### Why codes + refresh tokens carry `coreId`

Authorization codes and refresh tokens are bound to the **issuing core** because:

1. The granted access row lives in that core's per-user accesses table — only that core can revoke/inspect/touch it.
2. Refresh-token rotation + reuse-detection requires single-writer semantics; a cluster-wide row would invite race conditions.
3. Refresh tokens are core-sticky by multi-core design.

The `coreId` prefix lets any core look up a row and immediately know whether to forward (`forwardIfCrossCore` if `coreId ≠ self`) or process locally.

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
