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

The discovery document advertises:

```json
{
  "issuer": "https://<deployment-base>",
  "authorization_endpoint": "https://<deployment-base>/oauth2/authorize",
  "token_endpoint": "https://<deployment-base>/oauth2/token",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": [ ... ]
}
```

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
  # issuer: https://auth.example.com  # optional explicit issuer override (see below)
  accessTokenTTL: 3600             # access-token lifetime, seconds (1 hour)
  refreshTokenTTL: 2592000         # refresh-token sliding window, seconds (30 days)
  refreshTokenAbsoluteTTL: 7776000 # refresh-token absolute cap, seconds (90 days)
  clientRegistration:
    mode: curated                  # ONLY supported value (see below)
  requireAppAccountMfa: true       # app accounts must enrol MFA before /oauth2/* writes
  audAllowList: []                 # optional accepted `aud` values on /oauth2/authorize
  grantTypesSupported:             # advertised in the discovery document
    - authorization_code
```

### `issuer` (optional)

The RFC 8414 issuer — the concrete base URL clients fetch the discovery
document from and call `/oauth2/*` on — is derived automatically from your
deployment's public URL (`dnsLess.publicUrl` for single-URL deployments; the
core's own URL for multi-core). If the OAuth surface fails to mount with
`service:api not configured`, or your **public** URL differs from the
internally configured one (a reverse proxy or TLS terminator in front of the
core), set `oauth.issuer` explicitly to the public base URL — it overrides the
automatic derivation. Use the same value on every core in a cluster.

### `clientRegistration.mode` is `curated`

Dynamic client registration (RFC 7591) is **not** offered. `mode: open` is
rejected at boot. Application accounts are created out-of-band by an operator
with the CLI (§3). This is deliberate: on a self-hosted deployment the operator
is the trust anchor for which apps may request user consent.

### `requireAppAccountMfa`

When `true` (default), an application account must have MFA enrolled before it
can drive any `/oauth2/*` write. Keep it on in production — an app account is a
high-value credential.

### Token lifetimes

`accessTokenTTL` is short by design; clients renew via the refresh token.
`refreshTokenTTL` is a **sliding** window (each refresh resets it), bounded by
`refreshTokenAbsoluteTTL` (a hard cap regardless of activity).

### ⚑ Per-deployment config agreement (multi-core)

The discovery document is **per-deployment, not per-core**: its `issuer` and
endpoints describe the whole deployment. **Every core in a cluster MUST carry
the same `oauth:` block.** A drifting `oauth:` block on one core (different
TTLs, different `audAllowList`, MFA on/off) produces inconsistent token
behaviour depending on which core a request lands on. Treat the `oauth:` block
as a deployment-wide invariant and roll it out to all cores together.

---

## 3. Registering application accounts — `bin/oauth-client.js`

Client management is a CLI on the core. It is **promotion-only**: the target
user account must already exist (created through the normal `/reg/users` flow);
the CLI turns an existing account into an application account and writes its
OAuth client record.

**The `client_id` is the app account's username** — there is no separate opaque
client identifier. Promoting user `acme-app` yields `client_id = acme-app`.

```
node bin/oauth-client.js create <username> --redirect-uri <uri> [--redirect-uri <uri> ...] \
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
| app account cannot complete `/oauth2/*` | `requireAppAccountMfa: true` but the app account has not enrolled MFA |
| tokens behave differently between requests | `oauth:` block drift across cores (see §2) |

---

## 7. Security guidance

- **Rotate `client_secret`s** periodically and immediately on suspected
  compromise: `bin/oauth-client.js rotate-secret <clientId>`. The old secret
  stops working as soon as the new one is minted.
- **Keep `requireAppAccountMfa: true`.** An app account can request consent from
  any user on the deployment; protect it like an admin credential.
- **Rate-limit at the proxy** (§4) — the layer relies on the operator for this.
- **Monitor the audit stream** (§5), especially `oauth.code.reused` and bursts
  of `oauth.consent.refused` / `invalid_client`.
- **Keep the `oauth:` block identical across all cores** (§2) so token semantics
  are uniform deployment-wide.
