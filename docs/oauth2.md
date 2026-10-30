# OAuth2 — operator guide

open-pryv.io can act as an **OAuth2 authorization server** (RFC 6749 +
PKCE / RFC 7636), letting third-party applications obtain access tokens
through the standard authorization-code redirect flow instead of the
Pryv-native access-request polling flow.

This document is for **operators** running a deployment: how to enable it,
register application accounts, front it with a reverse proxy, and audit it.
Developers extending the layer (new scopes, grants, error mappings) should
read [`components/oauth2/IMPLEMENTERS-GUIDE.md`](../components/oauth2/IMPLEMENTERS-GUIDE.md).

---

## 1. Endpoints

Once enabled, each core exposes:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery document (public, cacheable, CORS `*`) |
| `GET /oauth2/authorize` | Authorization endpoint — starts the consent flow |
| `POST /oauth2/token` | Token endpoint — code exchange, refresh, client credentials |
| `GET /.well-known/openid-configuration` | OpenID Connect discovery (404 while `oauth.signingKeys` is empty) |
| `GET /oauth2/jwks` | JWK Set of the id_token signing keys, public members only (404 while `oauth.signingKeys` is empty) |

The discovery document advertises:

```json
{
  "issuer": "https://<deployment-base>",
  "authorization_endpoint": "https://<deployment-base>/oauth2/authorize",
  "token_endpoint": "https://<deployment-base>/oauth2/token",
  "scopes_supported": [ ... ],
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "private_key_jwt", "none"],
  "token_endpoint_auth_signing_alg_values_supported": ["ES256"],
  "code_challenge_methods_supported": ["S256"],
  "authorization_response_iss_parameter_supported": true,
  "dpop_signing_alg_values_supported": ["ES256"]
}
```

`grant_types_supported` reflects `oauth.grantTypesSupported`.
`private_key_jwt` is RFC 7523 client authentication with an ES256 assertion
(`aud` = the issuer or the token-endpoint URL). `dpop_signing_alg_values_supported`
means a client that sends an RFC 9449 DPoP proof to `/oauth2/token` receives a
sender-constrained `DPoP` token instead of a `Bearer` one.

The token endpoint returns the RFC 6749 §5.1 JSON plus a Pryv extension
field, `apiEndpoint`, that clients use to build a working connection:

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "cmc:study-A",
  "apiEndpoint": "https://<token>@<host>/<path>/"
}
```

---

## 1b. Scope model — consent-offer references

There are **no coarse wildcard scopes**. Every authorization-code grant goes
through an explicit granular permission set — as expressive as a native
`accesses.create` permissions array, including feature permissions such as
`{ "feature": "selfRevoke", "setting": "forbidden" }`.

The `scope` parameter carries exactly **one consent-offer reference**,
`cmc:<offer-name>`, resolved through the client registration:

1. **The app account publishes a consent offer** — an *open-link*
   `consent/request-cmc` event on its own account (see the cross-account
   messaging guide, `components/cmc/IMPLEMENTERS-GUIDE.md`) carrying the
   granular `permissions[]` plus the localized title/description/consent
   texts. The event's `content.capability.mode` must be `open-link` so many
   users can accept the same offer. The plugin stamps the capability URL on
   the event.

   **All-or-nothing vs. user choice.** By **default** (`request.allowUserChoice`
   absent or `false`) the consent is **all-or-nothing**: the consent screen
   shows the permissions locked and the user may only accept the whole set or
   deny. Set `request.allowUserChoice: true` to let the user untick individual
   entries — except entries flagged `"mandatory": true`, which stay locked
   (the app cannot run without them, so the user's only alternative is to
   deny). `mandatory` and `allowUserChoice` are consent-layer only — they
   never appear on the minted access. The server enforces the rule on
   `/oauth2/authorize/accept` (all-or-nothing → `granted == offered`; with
   choice → `granted ⊆ offered` AND all `mandatory` entries present),
   returning `invalid_scope` otherwise.
2. **The operator registers the offer on the client**:
   `--cmc-offer <name>=<capabilityUrl>` together with `--scope cmc:<name>`.
3. **At `GET /oauth2/authorize`** the core resolves the offer through its
   capability URL and embeds the permission set + consent texts into the
   HMAC-signed state — the consent UI displays exactly what the server
   resolved, and the accept step can only grant a subset of it.
4. **On accept** the core drives a real cross-account consent
   (`consent/accept-cmc`) with the user's personal session: a durable
   **data-grant access** is created on the user's account (the consent
   record), and the short-TTL OAuth access is minted with **exactly the
   permissions the user kept ticked**.
5. **Refresh is bound to the data-grant**: revoking the consent (the user
   deletes the data-grant, or a `consent/revoke-cmc` lands) makes the next
   refresh fail with `invalid_grant`; narrowing the data-grant's permissions
   propagates to the next refreshed access. Widening always requires a fresh
   authorization.

Re-authorization by the same user reuses the existing data-grant (widening it
only if the new consent grants entries the current one lacks). The
`client_credentials` grant never uses offer references — it serves the app's
OWN account.

Capability URLs expire (default 7 days, max 30 days per the platform bounds)
— publish offers with an explicit `expiresAt` and rotate the registration
before expiry; an expired offer surfaces as `invalid_scope` at
`/oauth2/authorize`.

---

## 2. Configuration

All settings live under the `oauth:` block. Defaults:

```yaml
oauth:
  # consentUrl: https://account.example.com/oauth2-authorize  # REQUIRED for /oauth2/authorize (see below)
  # issuer: https://auth.example.com  # optional explicit issuer override (see below)
  accessTokenTTL: 3600             # access-token lifetime, seconds (1 hour)
  refreshTokenTTL: 2592000         # refresh-token sliding window, seconds (30 days)
  refreshTokenAbsoluteTTL: 7776000 # refresh-token absolute cap, seconds (90 days)
  clientRegistration:
    mode: curated                  # ONLY supported value (see below)
  requireAppAccountMfa: true       # NOT ENFORCED yet (see below)
  stateKey: ''                     # SET IT: consent-state signing secret (see below)
  signingKeys: []                  # OpenID Connect id_token keys; empty = OIDC off (see below)
  idTokenTTL: 300                  # id_token lifetime, seconds
  grantTypesSupported:             # advertised in the discovery document
    - authorization_code
```

### `consentUrl` (required for the authorization-code flow)

The URL of the consent UI that `/oauth2/authorize` redirects the user-agent to,
with the signed `state` and the issuer (`pryvApi`) as query parameters. The
consent UI calls back `POST /oauth2/authorize/accept` or
`POST /oauth2/authorize/refuse`. It has no default: when it is unset,
`/oauth2/authorize` answers `500 server_error` (`oauth:consentUrl not
configured`). app-web-user-account is the reference consent UI (its
`/oauth2-authorize` page).

### `issuer` (optional)

The RFC 8414 issuer — the concrete base URL clients fetch the discovery
document from and call `/oauth2/*` on — is derived automatically from your
deployment's public URL (`dnsLess.publicUrl` for single-URL deployments; the
core's own URL for multi-core). If the OAuth surface fails to mount with
`service:api not configured`, or your **public** URL differs from the
internally configured one (a reverse proxy or TLS terminator in front of the
core), set `oauth.issuer` explicitly to the public base URL — it overrides the
automatic derivation. On a multi-core deployment the issuer is **per core**:
set each core's override to that core's own public URL, never one shared
load-balancer URL. The code exchange at `/oauth2/token` must reach the core
that issued the code (there is no cross-core forwarding; a code presented to
another core answers `invalid_grant`).

### `clientRegistration.mode` is `curated`

Dynamic client registration (RFC 7591) is **not** offered. `mode: open` is
rejected at boot. Application accounts are created out-of-band by an operator
with the CLI (§3). This is deliberate: on a self-hosted deployment the operator
is the trust anchor for which apps may request user consent.

### `requireAppAccountMfa` (not enforced yet)

Intended to require an application account to have MFA enrolled before it can
drive any `/oauth2/*` write. **No code reads this key today**: whatever its
value, an app account without MFA is not refused. A later release will either
enforce it or remove it. Until then, protect app accounts by other means (MFA
enrolled by the operator, strong credentials, curated registration).

### `stateKey` (set it)

The secret the consent-flow state is signed with (the parameter carried from
`/oauth2/authorize` to the consent page and back to `/oauth2/authorize/accept`).
It is used for nothing else and is per core: a consent flow runs on one core.
Set a random value of at least 32 characters (`openssl rand -base64 32`).
While it is empty, the key is derived from `auth.adminAccessKey` and every boot
logs a warning; a later release will require it. Setting or changing it only
cancels the consent screens open at that moment (a state lives 5 minutes).

### `signingKeys`, `idTokenTTL` (OpenID Connect)

With at least one signing key, registry clients (see the extension) may request
the `openid` scope: the code exchange then returns an `id_token` (RS256, the
key's `kid` in its header) carrying `iss`, `sub` (the user's stable internal
id, not routable), `aud` and `azp` (the client id), `iat`, `exp`
(`idTokenTTL` later), `auth_time` (the creation of the personal access the
user consented with, i.e. its first sign-in: never later than the real
authentication) and the
request's `nonce`, plus the extension's own claims. A refresh never returns an
`id_token`. A nonce is accepted once per client: an authorization request or a
code exchange reusing one that already went into an id_token is refused.
`/.well-known/openid-configuration` and `/oauth2/jwks` are served, and
`openid` is listed in `scopes_supported`. Without keys, `openid` is refused
(`invalid_scope`) and both documents answer 404.

```yaml
oauth:
  signingKeys:
    - kid: '2026-10'                       # unique; printable, no space
      privateKeyFile: /etc/pryv/oidc.pem   # or privateKeyPem: "-----BEGIN PRIVATE KEY-----..."
```

RSA keys of at least 2048 bits, unencrypted PEM (`openssl genpkey -algorithm
RSA -pkeyopt rsa_keygen_bits:3072 -out oidc.pem`); `alg` may be given and must
then be `RS256`. A malformed entry stops the boot. **Rotation is by ordering:**
the first entry signs, every entry is published. List the new key first, keep
the old one until its last id_token has expired (`idTokenTTL`), then remove it.
Keys are per core (each core is its own issuer) and are secrets: keep them in
the YAML file, readable by the server only.

### `audAllowList` (removed)

No longer read. The `aud` values a registry client may name at
`/oauth2/authorize` are registered per client (`create-registry --audience`).
A configuration that still sets the key gets a boot warning; remove it.

### Token lifetimes

`accessTokenTTL` is short by design; clients renew via the refresh token.
`refreshTokenTTL` is a **sliding** window (each refresh resets it), bounded by
`refreshTokenAbsoluteTTL` (a hard cap regardless of activity).

### ⚑ Per-deployment config agreement (multi-core)

On a multi-core deployment each core serves its own discovery document, whose
`issuer` and endpoints name **that core** (see `issuer` above): the code and
refresh exchanges must reach the issuing core, and no core forwards them.
Apart from `issuer` and the per-core secrets (`stateKey`, `signingKeys`: each
core signs its own states and id_tokens and publishes its own JWK Set; their
lifetimes such as `idTokenTTL` stay common), **every core in a cluster MUST
carry the same `oauth:` block.** A drifting block on one core (different TTLs, grant types, DPoP or
revoke settings) produces inconsistent token behaviour depending on which core
served the user. Treat it as a deployment-wide invariant and roll it out to
all cores together.

---

## 3. Registering application accounts — `bin/oauth-client.js`

Client management is a CLI on the core. It is **promotion-only**: the target
user account must already exist (created through the normal `/reg/users` flow);
the CLI turns an existing account into an application account and writes its
OAuth client record. Run `create` on the account's **home core**: the record
stores the account's user id, which only that core can resolve (on a multi-core
platform the CLI names the hosting core when run elsewhere). `show` prints the
record plus the account username resolved on the core it runs on.

**By default the `client_id` is the app account's username.** Promoting user
`acme-app` yields `client_id = acme-app`.

That id is a key in the platform store (the client record, its revocation
tombstone, the DPoP keys seen), it is replicated to every core, and it travels
in URLs and in the name of the access the grant mints. So with the default, the
app account's username does too, whatever the platform's PII mode. A deployment
that keeps usernames out of the platform store registers an opaque id instead:

```
node bin/oauth-client.js create acme-app --client-id k7Fq2LmZ4pR8 --redirect-uri https://app.example.com/cb
```

The account is still named on the command line (it is what the record points
at, as a user id), but `client_id` no longer carries it. An id is 4 to 64
characters of `A-Z a-z 0-9 . ~ -` (no `_`: the store scans keys with SQL
`LIKE`, where it is a wildcard). Registering an id that already exists, or one
that is an account name on the platform, is refused. Prefer an id no username
could ever take, which means anything holding an uppercase letter, a `.` or a
`~`: usernames are lowercase letters, digits and `-`, so `k7Fq2LmZ4pR8` can
never collide with one.

Two things still carry the username unless you act:

- **`client_name`**, shown on the consent screen and stored in the record.
  With `--client-id` it defaults to the id; pass `--name` to set what users
  read.
- **the capability URL of a `cmc:` offer**, which an authorization-code client
  needs. It is built from the publishing account's API endpoint, so it names
  that account, and it is stored in the record and travels in the signed
  state. Publish the offer from an account whose name is not sensitive.

`client_id` cannot be changed afterwards: `update` refuses the flag, because
the id keys the record. Moving an app to an opaque id means revoking the client
and creating it again. That kills its live tokens and refresh chains, and every
user re-runs the authorization flow; their consent records survive (they are
keyed by the offer, not by the client), and the accesses and streams the old id
created stay on their accounts.

```
node bin/oauth-client.js create <username> [--client-id <opaque-id>] \
    --redirect-uri <uri> [--redirect-uri <uri> ...] \
    [--scope cmc:<name>] [--cmc-offer <name>=<capabilityUrl>] \
    [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--application-type web|native]
node bin/oauth-client.js list
node bin/oauth-client.js show   <clientId>
node bin/oauth-client.js update <clientId> [--redirect-uri <uri> ...] [--scope <s>] ...
node bin/oauth-client.js rotate-secret <clientId>
node bin/oauth-client.js revoke <clientId>
```

Notes:

- **`--redirect-uri` is repeatable and required** — pass the flag once per URI.
  At least one is mandatory on `create`.
- **`--scope` is repeatable** — pass it once per scope; do **not** space-join
  several scopes into a single value (that registers one malformed scope and
  `/oauth2/authorize` will reject the request with `invalid_scope`).
- **`--cmc-offer <name>=<capabilityUrl>` is repeatable** — registers the
  consent offer behind each `cmc:<name>` scope token (see § 1b). Every
  `cmc:<name>` in `--scope` must have a matching `--cmc-offer` entry;
  registration fails fast otherwise.
- **`create` registers a PUBLIC client** (PKCE-only, no secret) — the common
  case for browser apps. It does not mint a `client_secret`.
- **`rotate-secret <clientId>`** mints a `client_secret`, promoting the client to
  **confidential** (for server-side apps). The plaintext is printed **once** and
  only its bcrypt hash is stored — re-run to rotate (which invalidates the old
  secret).
- `application-type native` is for installed/mobile apps that use a loopback or
  custom-scheme redirect; `web` is the default for server-hosted apps.

### Public vs confidential clients

A browser SPA that cannot keep a secret stays a **public** client — as created
by `create` — and authenticates the token endpoint with PKCE only
(`token_endpoint_auth_method: none`). A server-side app becomes **confidential**
by running `rotate-secret` to obtain a `client_secret`, which it then presents
via `client_secret_basic`. PKCE is mandatory either way.

---

## 4. Reverse proxy & rate limiting

**open-pryv.io does not rate-limit `/oauth2/*` itself.** The authorization and
token endpoints are unauthenticated attack surfaces (credential stuffing,
code-guessing, discovery scraping); the operator **must** rate-limit them at the
reverse proxy.

Recommended thresholds (per client IP):

| Endpoint | Limit |
|---|---|
| `POST /oauth2/token` | 60 requests / minute |
| `GET /oauth2/authorize` | 300 requests / minute |

A ready-to-adapt nginx configuration — including the `limit_req_zone`
definitions and per-location `limit_req` directives — is in
[`docs/nginx-ingress-sample.conf`](nginx-ingress-sample.conf).

---

## 5. Audit events

Every consent decision and token operation emits a structured audit event.
Collect these for security monitoring and incident response.

| Event type | Emitted when |
|---|---|
| `oauth.consent.shown` | consent screen presented to the user |
| `oauth.consent.granted` | user approved the authorization request |
| `oauth.consent.refused` | user declined the authorization request |
| `oauth.code.exchanged` | authorization code successfully exchanged for tokens |
| `oauth.code.reused` | an already-consumed authorization code was presented again (attack signal) |
| `oauth.token.issued.authorization_code` | access token issued via the authorization-code grant |
| `oauth.token.issued.client_credentials` | access token issued via the client-credentials grant |
| `oauth.token.refreshed` | access token renewed via the refresh grant |
| `oauth.token.revoked` | a token was revoked |

`oauth.code.reused` in particular should page: per RFC 6749 a code is
single-use, so a reuse means either a broken client or a stolen code.

---

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/oauth2/authorize` → `invalid_scope` | scope is not exactly one registered `cmc:<offer-name>` reference, the offer's capability URL expired/was invalidated, or scopes were space-joined into one `--scope` value at registration |
| `/oauth2/authorize` → `invalid_request` / `redirect_uri` mismatch | the request's `redirect_uri` is not byte-for-byte one of the registered URIs |
| `/oauth2/token` → `invalid_grant` (PKCE) | the `code_verifier` does not match the `code_challenge` sent at `/authorize`, or the code expired / was already used |
| `/oauth2/token` → `invalid_client` | confidential client presented a wrong/rotated `client_secret` |
| `/oauth2/token` → `invalid_grant` on a multi-core deployment, the core logs "presented to core" | the exchange reached a core other than the one that issued the code: an `oauth.issuer` shared by several cores (see §2) |
| tokens behave differently between requests | `oauth:` block drift across cores (see §2) |

---

## 7. Security guidance

- **Rotate `client_secret`s** periodically and immediately on suspected
  compromise: `bin/oauth-client.js rotate-secret <clientId>`. The old secret
  stops working as soon as the new one is minted.
- **Protect app accounts like admin credentials.** An app account can request
  consent from any user on the deployment. Enrol MFA on it: the
  `requireAppAccountMfa` key does not enforce that yet (§2).
- **Rate-limit at the proxy** (§4) — the layer relies on the operator for this.
- **Monitor the audit stream** (§5), especially `oauth.code.reused` and bursts
  of `oauth.consent.refused` / `invalid_client`.
- **Keep the `oauth:` block identical across all cores** (§2) so token semantics
  are uniform deployment-wide.
