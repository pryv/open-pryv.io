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

Operators MUST keep the `oauth.*` config block in sync across cores; the discovery doc cannot accommodate disagreement. Optional polish: `bin/oauth-client.js doctor` (deferred — file as backlog if not in M6 scope).

### Why vanilla OAuth clients need the `apiEndpoint` extension

After `/oauth2/token` returns an access token, that token is bound to a specific user on a specific home core. Vanilla RFC 6749 clients don't know about Pryv's home-core routing — they'd hit `reg.pryv.me/<user>/<api>`, receive `421 + coreUrl` from `checkUserCore.ts`, and fail (RFC 6749 doesn't define 421-handling).

The Pryv-specific `apiEndpoint` field in the token response (carried over from the existing `/reg/access` ACCEPTED response shape) tells the client the home-core URL directly. lib-js reads it automatically; vanilla clients MUST be told to read it (Phase G doc deliverable). Single-core deployments: `apiEndpoint` equals the LB URL — no client-side change needed.

## PlatformDB keyspaces

The component uses three PlatformDB keyspaces, all designed to fit the existing `setAccessState` / `getAccessState` TTL machinery:

| Keyspace | Lifetime | Contents | Per-core? |
|---|---|---|---|
| `oauth-client/<clientId>` | indefinite (rotated on App-account update) | Client metadata: `redirectUris`, `scope`, `clientName`, `logoUri`, `clientUri`, `grantTypes`, `applicationType`, `clientSecretHash?` | NO — cluster-wide |
| `oauth-code/<coreId>/<code>` | 600s | `{ clientId, redirectUri, codeChallenge, codeChallengeMethod, userId, scope, expiresAt, accessId? }` | YES — issuing core's id is in the key |
| `oauth-refresh/<coreId>/<token>` | sliding 30d (cap 90d absolute) | `{ clientId, userId, scope, issuedAt, lastUsedAt, expiresAt, absoluteExpiresAt }` | YES — issuing core's id is in the key |

### Why client metadata is cluster-wide (no `coreId` prefix)

Frozen-contract Invariant 2 permits client REGISTRATION METADATA in PlatformDB (NOT credentials). Cluster-wide reads are essential: `/oauth2/authorize` can land on any core, and the validator MUST resolve `client_id` → `redirect_uris` instantly. A `coreId` prefix would force a cross-core fetch on every authorize.

The App account's own `:_app:*` streams remain the authoritative source. The PlatformDB row is a denormalized read-cache; the operator CLI updates both atomically (single transaction at the write boundary).

### Why codes + refresh tokens carry `coreId`

Authorization codes and refresh tokens are bound to the **issuing core** because:

1. The granted access row lives in that core's per-user accesses table — only that core can revoke/inspect/touch it.
2. Refresh-token rotation + reuse-detection (T-10 / Phase F) requires single-writer semantics; a cluster-wide row would invite race conditions.
3. Per multi-core invariant 5: refresh tokens are core-sticky by design.

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

The exhaustive matcher test family (`[OAUTH-REDIR]`) lands in M6 hardening but its callers exist from M2.

## Audit-event awaiting

Every audit emission MUST be `await`ed. Silent fire-and-forget is a deliberate anti-pattern — the existing `components/audit/` contract guarantees that audit failures surface; bypassing that via fire-and-forget defeats forensics.

Performance: audit writes are local (SQLite per-user audit DB); typical latency &lt; 5 ms. Not a hot-path concern.

## Future Phase F hooks

Phase F adds DPoP (RFC 9449). The substrate to look for:

- `componenets/oauth2/src/grants/authorization_code.ts` will gain a `jkt` (JWK thumbprint) binding to the issued access row when the token request carries a `DPoP` header.
- `/oauth2/token` response will switch `token_type: "Bearer"` → `"DPoP"` when the request carries a `DPoP` header (RFC 9449 §5).
- `components/middleware/src/getAuth.ts` will gain a `DPoP` scheme branch alongside the existing `Bearer` branch.
- New keyspace `dpop-nonce/<jkt>/<jti>` for single-use proof replay defence (short TTL ≈ clock-skew window).

None of this lands in M1.
