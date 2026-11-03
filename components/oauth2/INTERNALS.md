# oauth2 — Internals

Design rationale + invariants that aren't obvious from the code. Read this before changing the storage layer, the routing layer, or the multi-core flow.

## Multi-core flow

Open Pryv.io deployments can run multiple cores fronted by a load balancer. Each user account is bound to ONE home core; PlatformDB (rqlite) is cluster-replicated.

| Endpoint | Lands on | Why |
|---|---|---|
| `GET /oauth2/authorize` | Any core | Validates client via the PlatformDB cache (`oauth-client/<clientId>`); the user's home core is not yet known. |
| Consent UI (`oauth:consentUrl`, e.g. app-web-user-account) | Any core (the consent UI then resolves `GET /reg/<username>/server` → user's home core) | User authenticates against THEIR home core. |
| `POST /oauth2/authorize/accept` | **User's home core** | The granted access row lives in the user's per-user accesses table. The authorization-code row records this core's id (`coreId`) and the access id, never the access token. |
| `POST /oauth2/token` (any grant) | **User's home core** (the issuer resolves there, see `issuer.ts`) | The code grant reads the access token back from this core's storage, and the refresh grant re-mints through it, so both must reach the issuing core. There is no cross-core forwarding: a code presented to another core answers `invalid_grant` and logs the routing fault. |
| `GET /<username>/<api>` with Bearer | User's home core (via `checkUserCore.ts` 421 + `coreUrl`) | Existing Pryv resource-server routing; OAuth-issued tokens flow through unchanged. |

The signed `state` that `/oauth2/authorize` hands to the consent UI is signed with that core's own `oauth:stateKey` (required, distinct per core, no shared fallback), so it verifies only on the core that issued it: `offer`, `accept` and `refuse` must go back to that core (the consent UI posts to the `pryvApi` it received, which is the issuer). Since `accept` must also run on the user's home core, a working flow starts `/oauth2/authorize` on the home core, which is what a per-core issuer gives (next section). A state presented to another core fails with `bad_signature`.

### Why `iss` is per core on multi-core

`.well-known/oauth-authorization-server` is served by every core, and its `iss` field (and `authorization_endpoint`, `token_endpoint`, the `pryvApi` handed to the consent UI) is derived by `issuerFromConfig` (`src/issuer.ts`): `oauth:issuer` when set, else `dnsLess:publicUrl` (single-URL deployments), else, on multi-core, **this core's own `core:url`**. Nothing is forwarded between cores: the authorization-code row records its issuing `coreId` and the refresh keyspace is per core, so `/oauth2/token` must reach the core that issued the code or refresh token, which is why the issuer names that core. An `oauth:issuer` override on multi-core must therefore name each core's own public URL, not a shared load-balancer URL.

Apart from `issuer`, operators MUST keep the `oauth.*` config block in sync across cores (TTLs, grant types, DPoP and revoke settings), or token behaviour depends on which core served the user.

### Why vanilla OAuth clients need the `apiEndpoint` extension

After `/oauth2/token` returns an access token, that token is bound to a specific user on a specific home core. Vanilla RFC 6749 clients don't know about Pryv's home-core routing — they'd hit `reg.pryv.me/<user>/<api>`, receive `421 + coreUrl` from `checkUserCore.ts`, and fail (RFC 6749 doesn't define 421-handling).

The Pryv-specific `apiEndpoint` field in the token response (carried over from the existing `/reg/access` ACCEPTED response shape) tells the client the home-core URL directly. lib-js reads it automatically; vanilla clients MUST be told to read it (operator-facing doc deliverable). Single-core deployments: `apiEndpoint` equals the LB URL — no client-side change needed.

## PlatformDB keyspaces

The component uses these PlatformDB keyspaces, the TTL'd ones on the existing `setAccessState` / `getAccessState` machinery. PlatformDB is replicated to every core, so no credential is stored in it: codes and refresh tokens appear only as the SHA-256 of their value in the key (they are 256-bit random values, so no salt or slow hash is needed), and no row carries an access token.

| Keyspace | Lifetime | Contents | Per-core? |
|---|---|---|---|
| `oauth-client/<clientId>` | indefinite (written by the CLI) | The registration (`OAuthClient` in `src/storage.ts`): `kind` (`app-account` or `registry`), `redirectUris`, `scope`, `grantTypes`, `updatedAt`, display fields (`clientName`, `name`, `description`, `logoUri`, `clientUri`, `policyUri`, `tosUri`), client authentication (`tokenEndpointAuthMethod`, `clientSecretHash`, `previousSecretHash` + `previousSecretExpiresAt`, an inline `jwks` or a `jwksUri`, `tokenEndpointAuthSigningAlgs`), lifetimes and `offlineAccessAllowed`, `status` + `statusLog`, `regions`, `maxEntries`; app-account rows `accountUserId`, `applicationType`, `cmcOffers`; registry rows `subjectType`, `allowedAudiences` / `anyAudience`, `allowFeatures`, `canIntrospect`, `allowInsecureRedirect`, `tokenResponseExtras`, `contacts`, `launchTypes`, `softwareId` | NO, cluster-wide |
| `oauth-client-revoked/<clientId>` | until pruned (`pruneRevokedClients`, by tombstone age) | `{ revokedAt }`: revoke tombstone, written by `deleteClient`. A token EPOCH, not a name reservation: each core caches it (`revokedClientsCache`) and the resource-server path refuses the client's oauth-session accesses minted before that epoch, so live tokens stop working before they expire. Re-registering the same id does NOT clear it. | NO, cluster-wide |
| `oauth-ac/<sha256(code)>` | 600s | `{ clientId, redirectUri, codeChallenge, codeChallengeMethod, userId, scope, expiresAt, accessId?, coreId?, dataGrantAccessId?, permissions?, kind?, coreTokens?, grammarTokens?, audience?, nonce?, authTime? }` | YES: the issuing core's id is in the row |
| `oauth-rt/<coreId>/<sha256(token)>` | sliding 30d (cap 90d absolute; per-client lifetimes, capped) | `{ clientId, userId, scope, issuedAt, lastUsedAt, expiresAt, absoluteExpiresAt, dataGrantAccessId?, permissions?, jkt?, kind?, coreTokens?, grammarTokens?, audience?, accessId? }` (`accessId`: the session the chain backs) | YES: the issuing core's id is in the key |
| `oauth-rt-used/<coreId>/<sha256(token)>` | remaining life of the rotated token | `{ clientId, userId, dataGrantAccessId?, consumedAt, revoked?, rotated? }`: reuse-detection marker (chain identity, no credential); `rotated` once the rotation's new rows are durable, `revoked` when the chain was ended | YES |
| `oauth-at/<sha256(access token)>` | the session's expiry | Session index, written at every session mint: `{ userId, accessId, clientId, coreId, dataGrantAccessId?, coreTokens?, grammarTokens?, audience?, expiresAt, refreshTokenHash? }`; no token, username or alias. Lets any core answer introspection (421 to the home core) and revocation, and lets the deletion of a session end its refresh chain | NO, cluster-wide (the home core is in the row) |
| `oauth-nonce/<clientId>/<sha256(nonce)>` | while its id_token lives, at least 1 h | an OpenID Connect nonce already used (single use per client) | NO, cluster-wide |
| `oauth-cassert-jti/<clientId>/<jti>` | the assertion's expiry | a `private_key_jwt` assertion already used (single use) | NO, cluster-wide |
| `dpop-jkt-seen/<clientId>/<jkt>` | indefinite | DPoP key thumbprints seen bound to the client's tokens (`list-keys`) | NO, cluster-wide |

**No row carries a username.** Code and refresh rows identify the account by
`userId` only, and the client row points at its account through `accountUserId`; a
grant that needs the username resolves it locally on the core that serves the
exchange. Rows written before `accountUserId` existed carry `accountUsername`
instead and are read only through `legacyAccountUsername()`. This is what lets a
deployment keep usernames out of the replicated store.

`jwks` holds PUBLIC keys only (EC P-256 / P-384, RSA of 2048 bits or more;
private members refused on write), so cluster-wide caching is safe; `cmcOffers` maps a `cmc:<name>` scope to the capability URL of a
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

`matchRedirectUri(presented, registered)` is exact-string match with ONE carve-out: on plain `http`, the loopback hosts `127.0.0.1`, `[::1]` and `localhost` may vary port (RFC 8252 §7.3; the port is ignored on both sides). Everything else stays exact: scheme, userinfo, path, query, and the host string itself. The three hosts are not interchangeable: a `127.0.0.1` registration does not admit `localhost` and the reverse, so a client registers each form it may send. Subdomains of `localhost`, `localhost.` and `https://localhost` are not relaxed. Both sides go through the WHATWG URL parser, which normalises the host before the comparison (lowercasing, percent-decoding, numeric IPv4 forms such as `127.1`, long IPv6 forms), so `LOCALHOST` matches `localhost` and `[0:0:0:0:0:0:0:1]` matches `[::1]`; the browser follows the same parsing, so it still lands on loopback. A presented URI with a control character is refused before parsing (the parser would drop it, the `Location` header would not).

```
registered = "https://app.example.com/cb"
presented  = "https://app.example.com/cb"          → MATCH
presented  = "https://app.example.com/cb/"         → NO MATCH (trailing slash)
presented  = "https://app.example.com/cb?x=1"      → NO MATCH (query)
presented  = "https://app.example.com:443/cb"      → NO MATCH (explicit port)

registered = "http://127.0.0.1/cb"
presented  = "http://127.0.0.1:8742/cb"            → MATCH (loopback carve-out)
presented  = "http://127.0.0.1:8742/cb/"           → NO MATCH (trailing slash even on loopback)
presented  = "http://localhost:8742/cb"            → NO MATCH (host string differs, no cross-match)

registered = "http://localhost/cb"
presented  = "http://localhost:51234/cb"           → MATCH (loopback carve-out)
presented  = "http://127.0.0.1:51234/cb"           → NO MATCH (host string differs, no cross-match)
presented  = "http://foo.localhost:51234/cb"       → NO MATCH (subdomain)
presented  = "https://localhost:51234/cb"          → NO MATCH (carve-out is http only)

registered = "com.example.app:/cb"
presented  = "com.example.app:/cb"                 → MATCH (private-use URI scheme)
```

No regex, no prefix matching, no scheme normalization. RFC 9700 §2.1 + RFC 8252 §7.5. Phishers exploit lax matching; we don't blink.

The matcher is covered by the `[OAUTH-REDIR]` and `[OXLH]` families (`test/clientRegistry.test.js`); `routes/authorize.ts` is its only runtime caller. `LOOPBACK_HOSTS` (`clientRegistry.ts`) is the one list of loopback hosts: the port carve-out, the registration rule for plain-http redirect URIs (`--allow-insecure-redirect` needed elsewhere) and the `http` allowance for resource indicators (`resourceIndicator.ts`) all read it.

## Registry consent: composition, digests, the grant

A registry client's offer is not carried in the signed state: `/authorize` signs the offer's digest (`offerDigest`: the canonical JSON of the extension's name and `apiVersion`, the client row's `updatedAt` and the normalised offer) and `resolveStateOffer` (`routes/offer.ts`) re-derives it at `/offer` and `/accept` through the grammar, memoised per state (the signed-in composition never is). A digest that differs means the client or the grammar changed: the flow restarts. This is why the grammar must be deterministic.

- **Signed out**, `/offer` answers the request as parsed (frozen shape). **Signed in** with the owner's personal token, it answers `composeShownOffer` (`consentComposition.ts`, pure): the current grant (`readRegistryGrant`) joined with the request per stream, flags `currentlyGranted` / `currentLevel` / `optIn`, the grant's forbids locked, and `shownDigest` = SHA-256 of `{ offerDigest, shown (entries sorted by code unit), subjectChange }`, the same on every core.
- `/accept` recomputes the composition. With a matching `shownDigest`, `nextGrantPermissions` replaces the grant with what was ticked plus the kept restrictions (current forbids and exclusion masks); without it, it joins (never narrows). Then the client's default forbids (`defaultForbiddenFeatures`: `REGISTRY_DEFAULT_FORBIDDEN_FEATURES` minus `allowFeatures`). A change of subject mode needs `shownDigest` and `acknowledgeSubjectChange`. Consent offers are positive only: `normalizePermissions(…, { consent: true })` throws on a `none` entry, so a mask can never come from a consent.
- Then `computeGrantState` (the extension's optional hook, bounded, before anything is written), the grant write and the session mint; a grant permission change re-cuts the live sessions (`reconcileSessionsOfGrant`, api-server).

### The grant bound

`entryCeiling(client)` (`scopeGrammar.ts`) = the client's `maxEntries` capped at `MAX_SYNTH_ENTRIES` (1000), else 1000. It bounds the request at `/authorize` (`resolveRequestedScope`), the composed offer at the signed-in `/offer` (`shown.permissions.length`) and, at `/accept`, the grant the consent leaves (`grantEntryCount`: the grant after `nextGrantPermissions`, without exclusion masks and the client's default forbids, which the screen does not show). The `/accept` check catches a consent UI that never asks for the composition (join mode) and so could grow a grant a little at a time; with `shownDigest`, the `/accept` count is never above what the screen showed. Refusals share `grantTooLarge` (400 `invalid_scope`, `reason: 'grant-too-large'`) and come before anything is written.

## Client status and regions

`clientUnavailable(client, config)` (`clientRegistry.ts`) is the one check: status `active` (or absent) passes, `suspended`, `review` or anything else is refused; with a config, a core outside the client's `regions` (from `core:hosting` and the `hostings` hierarchy) is refused too. Callers:

- `/authorize`: the status first, right after `getClient` and before the redirect URI is looked at, answered as an HTML 400 (a client under review may have an unvetted redirect URI on file: nothing is redirected); the region after the redirect URI is validated, as a redirected `unauthorized_client`.
- `/offer` and `/accept`: 403 `access_denied`; the grants at `/token`: `unauthorized_client`, checked before a refresh row is consumed; introspection: the token's client (status and region) gives `active: false`, the caller is checked for status only (a resource server may introspect anywhere).
- The data API: `MethodContext.checkClientNotRevoked` (the revoke epoch) then `checkClientActive` for every `oauth:<clientId>` access, one platform read per client per `oauth:clientRevokeCheckSeconds` (`revokedClientsCache.getClientStatus`, bounded map, fail-open on a read error like the epochs). Sessions are not ended: both states are reversible. Same transport coverage as the revoke (request-authenticated calls; a socket.io connection opened before lags).

The CLI's `update` compares `VETTED_FIELDS` (`changedVettedFields`) and moves an active registry client to `review` unless `--approve`; `resume` refuses while the trail (`statusLog`, last 50) holds a `review` entry after its last `approve`.

## Purge (`purge-grants`)

`bin/oauth-client.js purge-grants` runs `purgeClientGrants` (api-server `methods/helpers/oauthGrantPurge.ts`) in the CLI process, over the users of THIS core: the client's registry grants (`oauth-grant:<clientId>` / `clientData.oauth.grantOf`), the grants its sessions name (`clientData.oauth.dataGrantId`, an app-account client's CMC data-grant included; personal accesses never), then the remaining accesses minted for the client (`oauth:<clientId>`), each through `deleteAccessChain` (deletion record, access-index tombstone, sessions, what they created, aliases, refresh chains); last, `storage.revokeClientRefreshTokens` ends the client's refresh rows left in this core's keyspace. Not run: the `accesses.delete` route's post-delete hooks (no CMC revoke notice) and any cache invalidation of the running server (a cached session lives up to `caching:accessMaxAgeSeconds` per worker). Two app-account clients on one offer share the data-grant, so a purge of either ends it for both.

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
