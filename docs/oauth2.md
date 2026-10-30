# OAuth2 — operator guide

open-pryv.io can act as an **OAuth2 authorization server** (RFC 6749 +
PKCE / RFC 7636), letting third-party applications obtain access tokens
through the standard authorization-code redirect flow instead of the
Pryv-native access-request polling flow.

This document is for **operators** running a deployment: how to enable it,
register application accounts, front it with a reverse proxy, and audit it.

There are two kinds of OAuth client:

- **App-account clients** (the original kind): an existing Pryv account
  promoted to an application account. Its scope is a `cmc:<offer-name>`
  reference to a consent offer the account publishes (§ 1b, § 3).
- **Registry clients**: registered by the operator with no account behind
  them. Their scope vocabulary comes from an **OAuth extension** the operator
  installs on the cores, which maps a scope string to Pryv permissions
  (§ 1c, § 1d, § 3b). Without an installed extension, registry clients are
  refused at `/oauth2/authorize`.

Developers extending the layer (new scopes, grants, error mappings) should
read [`components/oauth2/IMPLEMENTERS-GUIDE.md`](../components/oauth2/IMPLEMENTERS-GUIDE.md).

---

## 1. Endpoints

Once enabled, each core exposes:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery document (public, cacheable, CORS `*`) |
| `GET /oauth2/authorize` | Authorization endpoint — starts the consent flow |
| `POST /oauth2/authorize` | Same as `GET`, parameters in a form-encoded body (`application/x-www-form-urlencoded`) |
| `POST /oauth2/authorize/offer` | Consent UI: fetch the consent offer of a registry client by reference (§ 1d) |
| `POST /oauth2/authorize/accept` | Consent UI: the user grants the request |
| `POST /oauth2/authorize/refuse` | Consent UI: the user declines the request |
| `POST /oauth2/token` | Token endpoint — code exchange, refresh, client credentials |

On `/oauth2/authorize` (either method), a parameter given twice is refused
with an HTML 400, and so is a `POST` body that is not form-encoded (JSON
included).

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

This section describes **app-account clients**. Registry clients use the
scope grammar of the installed OAuth extension instead (§ 1c).

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

## 1c. Registry clients and the OAuth extension

A registry client has no Pryv account behind it: the operator registers it
with `bin/oauth-client.js create-registry` (§ 3b), on any core. Its whole
`scope` string is handed to the **scope grammar** of the OAuth extension
installed on the cores, which turns it into a consent offer of granular Pryv
permissions (the same lexicon as `accesses.create`).

### Installing the extension

Point `customExtensions:oauthExtension` at the extension module on every core
(see § 2). The module exports a factory that receives
`{ apiVersion, options, logger }` (`options` is `oauth:extensionOptions`,
handed over as is) and returns:

```js
module.exports = function (host) {
  return {
    apiVersion: 1,
    name: 'my-extension',
    scopeGrammar: {
      parse (scopeString, { client, purpose }) { /* { ok: true, tokens, offer } or { ok: false, description } */ },
      echo ({ permissions, requestedTokens, client }) { /* scope tokens naming what permissions hold */ },
      supported () { /* optional */ }
    },
    tokenResponse (ctx) { /* optional: extra fields of the token response */ }
  };
};
```

The module is loaded at boot. **A module that cannot be loaded, or that breaks
the contract (unsupported `apiVersion`, missing `name` or grammar functions),
fails the boot**, not a user's first consent. The contract itself (types,
determinism, display labels, hook context) is documented in
`components/oauth2/src/extension.ts` and in the implementers' guide.

The extension's hooks **fail closed**: a hook that throws, does not settle
within `oauth:extensionHookTimeoutMs` (default 5000 ms), returns something
other than an object, or sets a key the core owns (`access_token`,
`token_type`, `expires_in`, `refresh_token`, `scope`, `id_token`,
`apiEndpoint`) fails the token request with `500 server_error`, before any
refresh token is stored. A refresh that fails this way does not use up the
refresh token: the app retries with the same one.

### Scope rules the core enforces

- A registry client's registered `scope` is its **maximum scope set**, parsed
  by the same grammar. A request beyond it answers `invalid_scope`.
- Whatever the grammar answers, the core refuses (`invalid_scope`) account and
  system streams, every stream (`*`), the `manage` level, two permissions on
  one stream in one offer, a token the client did not send, and an offer of
  more than 1000 permissions. It removes `defaultName` / `name` from the offer:
  a registry consent never creates a stream.
- The core owns two scope tokens and never hands them to the grammar:
  `offline_access` asks for a refresh token (granted only when the client is
  registered for the `refresh_token` grant), `openid` is **refused** on this
  core (`invalid_scope`).
- `client_credentials` and DPoP-bound tokens are not available to registry
  clients (a DPoP proof at `/oauth2/token` is refused with `invalid_request`
  before the code or refresh token is used).
- A client registered with audiences (`--audience`) must name one of them in
  the `aud` parameter of `/oauth2/authorize` (a trailing slash is ignored),
  else `invalid_request`.

### The token response `scope` (the echo)

The `scope` of a registry client's token response is the grammar's `echo`
over the permissions actually minted, so it narrows when the user unticked
part of the offer or the grant was narrowed later. The core checks the echo by
parsing the echoed string again with the same grammar, as a request:

- it **may** name tokens the client did not request (a narrowed token after a
  partial consent, a per-stream token, a marker that expands to no
  permission);
- it **may not** claim a stream or a level the session does not hold: a
  stream is held only by an entry on the same stream (no inheritance through
  the stream tree, and a stream held at `none` is not held); a feature entry
  is held by the same entry, and a `forbidden` one always passes. Such an echo
  fails the token request with `500 server_error` and is logged; a refresh
  refused this way leaves the refresh token usable once the extension is
  fixed;
- it should name all the reach the session holds: an echo that leaves a held
  stream unnamed is logged as a warning, not refused;
- at most 1000 tokens, and never `openid` or `offline_access` (the core adds
  those itself).

### What the app receives

The token response carries the core fields, `apiEndpoint`, the client's
static `--extra` fields, then the fields of the extension's `tokenResponse`
hook. The subject handed to the extension (and every hook field built on it)
is the user's **internal id**: not the username, and not routable (it does not
address the account).

### Not available yet

- **Pseudonymous subjects.** A `pairwise` client can be registered, but every
  request it makes, and any offer asking for a pseudonym, answers
  `invalid_scope` "pseudonymous subjects are not available on this core".
- **OpenID Connect.** The `openid` scope token is refused.
- **Token introspection and revocation endpoints** (RFC 7662 / RFC 7009) are
  not offered yet; they are planned.

---

## 1d. Consent for registry clients

### Offer by reference

For a registry client, the signed `state` sent to the consent UI carries only
the **digest** of the consent offer, not the offer itself. The consent UI
fetches the offer with:

```
POST /oauth2/authorize/offer
{ "state": "<signed state>" }
```

which answers (unauthenticated like `/oauth2/authorize`, `Cache-Control:
no-store`):

```json
{
  "client": { "clientId": "…", "clientName": "…", "logoUri": "…", "clientUri": "…", "policyUri": "…", "tosUri": "…" },
  "offer": { "allowUserChoice": false, "permissions": [ … ], "randomAlias": false, "entryLabels": { … } },
  "scope": [ "…" ]
}
```

`offer.entryLabels` (display labels keyed `s|<streamId>|<level>` or
`f|<feature>|<setting>`, values `{ [lang]: text }`) and the offer texts come
from the grammar and are passed through unchanged. `/offer` and
`/oauth2/authorize/accept` re-derive the offer from the request; a state whose
client or grammar changed since `/oauth2/authorize` is refused with
`invalid_request` (restart the flow). App-account clients keep the offer
inside the state, unchanged.

`/oauth2/authorize/accept` accepts only the account owner's **personal**
token; another token of the user answers `403 access_denied`.

### Composed re-consent (`shownDigest`)

When the user already has a grant for the client, the consent screen should
show the grant and the request together, so a later request for a subset never
silently strips what the user granted before. The consent UI posts the user's
credentials to `/offer`:

```
POST /oauth2/authorize/offer
{ "state": "…", "username": "…", "userToken": "<the owner's personal token>" }
```

and receives the **composed** screen (never cached): one entry per stream at
the level covering both the grant and the request; entries already granted
flagged `currentlyGranted: true` (a stream entry also with `currentLevel`, the
level held now); a new `optIn` entry left unticked; the grant's forbidden
features shown, locked. Beside it: `shownDigest` (opaque: never parse it, only
post it back), `currentGrant: { "subjectMode": "account" | "pseudonym" } |
null`, `subjectChange` and `authenticated: true`. A token that is not the
owner's personal token gets the request alone plus `authenticated: false`
(`authenticated` is absent when no sign-in was attempted). A stream held at
`read` and requested at `create-only` cannot be covered by one level and
answers `invalid_scope` with `reason: "permission-level-conflict"`.

On `POST /oauth2/authorize/accept` the consent UI then sends `shownDigest`
with the user's choice (`grantedPermissions`):

- **With `shownDigest`**: the grant becomes **exactly** what the user ticked
  (unticking narrows it), keeping the grant's forbidden features and
  exclusion masks. A `shownDigest` that no longer matches (the grant, the
  client or the grammar changed meanwhile) answers `400 invalid_request` with
  `reason: "consent-out-of-date"`: restart the flow.
- **Without `shownDigest`** (a consent UI older than this mechanism): the
  consent is **joined** into the grant per stream and never narrows it.
  Per-stream narrowing on re-consent needs a consent UI that posts
  `shownDigest`.

Both fields are ignored for app-account clients. A registry consent must keep
at least one stream entry (`reason: "keep-one-stream"`; refuse instead).

### Change of subject mode

When the request's subject mode (the user's id, or a pseudonym) differs from
the current grant's, `/offer` reports `subjectChange: { "from", "to" }` and
`/accept` requires both `shownDigest` and `acknowledgeSubjectChange: true`,
else `400 invalid_request` with `reason: "subject-change-unacknowledged"`.
Once acknowledged, the old grant is withdrawn (its sessions and refresh chains
end) and a new one is made; `oauth.consent.granted` carries `subjectChange`.
(Pseudonymous subjects themselves are not available yet, § 1c; a change of a
client's `--subject-type` reaches each user this way at their next consent.)

### `reason` on `/oauth2/authorize/*` errors

An error body of `/oauth2/authorize/*` may carry an optional machine-readable
`reason` beside the OAuth `error` and `error_description`. Match on `reason`,
never on the wording; render errors without one generically.

| `reason` | Meaning |
|---|---|
| `consent-out-of-date` | the screen the user saw is no longer current: restart the flow |
| `subject-change-unacknowledged` | a change of subject mode was not acknowledged |
| `permission-level-conflict` | a requested level conflicts with the grant's (`/offer` and `/accept`) |
| `keep-one-stream` | a registry consent kept no stream |
| `consent-widens-offer` | the kept subset would widen the offer through the stream hierarchy |

### Registry grants and their sessions

- The durable consent record of a registry client is an app access named
  `oauth-grant:<clientId>` on the user's account (no expiry; one the owner let
  expire is replaced at the next consent). A grant withdrawn between consent
  and code exchange answers `invalid_grant` at `/oauth2/token`.
- **Registry grants forbid the `webhooks` and `secretSharing` features by
  default**, unless the client row allows the feature
  (`--allow-feature`, § 3b). The core applies these forbids at every consent;
  they are not shown on the consent screen and are carried by the sessions.
  Allowing a feature later does not lift the forbid on grants that already
  carry it: a forbid on a grant is kept by every re-consent, only the owner
  can remove it.
- **In any consent offer, a forbidden feature is mandatory** (it cannot be
  unticked, whatever the offer says); one marked `optIn` is refused. This
  holds for OAuth and CMC offers and for the `consent` sidecar of an auth
  request on `/reg/access`.
- **A change to a grant reaches its live sessions at once.** When a grant's
  permissions change (a re-consent, the owner's `accesses.update` on a
  registry or CMC grant, a CMC consent scope update), each live OAuth session
  of the grant is re-cut to what its next refresh would mint: its chain's
  consent under the grant as it now stands (narrowed, or widened back, never
  beyond either). A session left with no reach is deleted; its chain's next
  refresh is then refused (`invalid_grant`) unless the owner widened the grant
  again before it.
- **`clientData.oauth` is server-owned.** OAuth session accesses
  (`name: "oauth:<clientId>"`, `createdBy: "system"`) carry
  `clientData.oauth = { dataGrantId, chain }`, the link to their grant and
  their chain's consent. `accesses.create` refuses an access carrying
  `clientData.oauth`, and `accesses.update` refuses any change to it
  (`403 forbidden`); sending it back unchanged passes.

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
  audAllowList: []                 # NOT ENFORCED, superseded (see below)
  grantTypesSupported:             # advertised in the discovery document
    - authorization_code
  extensionOptions: {}             # handed as is to the OAuth extension (see below)
  extensionHookTimeoutMs: 5000     # bound on each asynchronous extension hook, milliseconds

customExtensions:
  oauthExtension: ''               # module path of the OAuth extension (see below)
```

### `customExtensions:oauthExtension`, `extensionOptions`, `extensionHookTimeoutMs`

`customExtensions:oauthExtension` is the module path of the OAuth extension
that serves registry clients (§ 1c). It is loaded with Node's `require`, so
give an absolute path (or a resolvable module name). Empty (the default)
means no extension: every registry client's `/oauth2/authorize` answers
`invalid_scope`, app-account clients are unaffected. A module that fails to
load or breaks the contract fails the boot.

`oauth:extensionOptions` is handed to the extension's factory as
`host.options`, unchanged; its shape is the extension's business.

`oauth:extensionHookTimeoutMs` bounds each asynchronous hook of the extension
(the token-response hook). A hook that does not answer in time fails the
request (`500 server_error`) before any refresh token is stored.

Like the rest of the `oauth:` block, these must be identical on every core
of a cluster (same module, same version, same options): registry clients are
registered once for the whole platform, and their scopes must mean the same
on every core. Upgrading the extension while a consent is in progress is
safe but visible: the offer is re-derived at `/offer` and at `/accept`, and a
state whose grammar changed since `/oauth2/authorize` is refused (the user
restarts the flow).

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

### `audAllowList` (not enforced, superseded)

**No code reads this key**: `/oauth2/authorize` does not check an `aud` value
against it, whatever it lists. It is superseded by the per-client audience
list of registry clients (`--audience`, § 3b) and will be removed. Do not rely
on it.

### Token lifetimes

`accessTokenTTL` is short by design; clients renew via the refresh token.
`refreshTokenTTL` is a **sliding** window (each refresh resets it), bounded by
`refreshTokenAbsoluteTTL` (a hard cap regardless of activity).

### ⚑ Per-deployment config agreement (multi-core)

On a multi-core deployment each core serves its own discovery document, whose
`issuer` and endpoints name **that core** (see `issuer` above): the code and
refresh exchanges must reach the issuing core, and no core forwards them.
Apart from `issuer`, **every core in a cluster MUST carry the same `oauth:`
block.** A drifting block on one core (different TTLs, grant types, DPoP or
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
node bin/oauth-client.js revoke <clientId> --yes
```

(`list`, `show`, `update`, `revoke`, `suspend` and `resume` work on both
client kinds; registry clients are created with `create-registry`, § 3b.)

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

## 3b. Registry clients: `create-registry`

A registry client (§ 1c) needs no account: run `create-registry` on any core.
The `client_id` follows the same rules as `--client-id` above (4 to 64
characters of `A-Z a-z 0-9 . ~ -`, not an existing client, not an account name
on the platform).

```
node bin/oauth-client.js create-registry <clientId> \
    --redirect-uri <uri> [--redirect-uri <uri> ...] \
    --scope <s> [--scope <s> ...] \
    --subject-type public|pairwise \
    (--audience <url> [--audience <url> ...] | --any-audience) \
    [--auth-method none|client_secret_basic|private_key_jwt] \
    [--jwks-file <path> | --jwks-json <json>] \
    [--allow-insecure-redirect] [--allow-feature webhooks|secretSharing ...] \
    [--extra <key>=<value> ...] [--grant-type <name> ...] \
    [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--policy-uri <s>] [--tos-uri <s>] \
    [--contact <s> ...] [--launch-type <s> ...]
node bin/oauth-client.js suspend <clientId>
node bin/oauth-client.js resume  <clientId>
```

Flags:

- **`--scope`** (repeatable; space-separated tokens in one value are split):
  the client's **maximum scope set**, in the grammar of the installed
  extension. At least one is required. Requests beyond it answer
  `invalid_scope`; a registered scope the grammar refuses is reported at boot.
- **`--subject-type public|pairwise`** is **required, with no default**, and
  echoed back: `public`, the app sees the user's stable internal id (an alias
  only when it asks for a pseudonym); `pairwise`, always an alias, one per
  user and client. `pairwise` is accepted with a warning: pseudonymous
  subjects are not available yet, and `/oauth2/authorize` refuses every
  request of such a client (§ 1c).
- **`--audience <url>`** (repeatable): the absolute `https` resource URLs the
  client may name in the `aud` parameter of `/oauth2/authorize`. At least one
  is required, unless **`--any-audience`** registers the client explicitly for
  any audience (no `aud` check). The two exclude each other.
- **`--allow-insecure-redirect`**: plain-http redirect URIs are refused unless
  their host is a loopback one (`127.0.0.1`, `[::1]`, `localhost`); this flag
  accepts them on other hosts. Such clients are reported at every core boot.
- **`--allow-feature webhooks|secretSharing`** (repeatable): lifts the default
  forbid of that feature on the client's grants (§ 1d). Only these two
  features are accepted; `--allow-feature none` clears the list. `create-registry`
  and `show` print the features forbidden on the client's grants.
- **`--auth-method`**: `none` (the default, a public client using PKCE only),
  `client_secret_basic` (a secret is minted and printed **once**), or
  `private_key_jwt` (needs `--jwks-file` or `--jwks-json`, EC P-256 public
  keys only).
- **`--extra <key>=<value>`** (repeatable): a static field added to every
  token response of the client (`true`, `false` and numbers are stored as
  such, anything else as a string). Keys the core owns are ignored.
- **`--grant-type`** defaults to `authorization_code` and `refresh_token`;
  `client_credentials` is refused for registry clients.
- `--name` (the `client_name`, default the client id), `--logo-uri`,
  `--client-uri`, `--policy-uri`, `--tos-uri` are returned to the consent UI by
  `/oauth2/authorize/offer`. `--contact` and `--launch-type` are stored on the
  row and visible to the extension; the core does not act on them.

The boolean flags (`--any-audience`, `--allow-insecure-redirect`) take no
value, or `true` / `false`; anything else is refused.

**`suspend <clientId>` / `resume <clientId>`** (any client kind) refuse or
restore the client everywhere, with the description "this client is
suspended": `/oauth2/authorize`, `/offer` and `/accept` answer
`access_denied`, the code exchange and refresh at `/oauth2/token` answer
`unauthorized_client`. A
refused refresh consumes nothing, so the app's refresh token works again after
`resume`. Access tokens already issued keep working until they expire; use
`revoke` to stop them.

**`update <clientId>`** on a registry client takes `--redirect-uri`,
`--scope`, `--grant-type`, `--name`, `--logo-uri`, `--client-uri`,
`--jwks-file` / `--jwks-json`, and the registry flags `--audience`,
`--any-audience`, `--allow-insecure-redirect` (`false` withdraws it),
`--subject-type` and `--allow-feature` (these five are refused on
app-account clients). Repeatable flags replace the stored list. Changing
`--subject-type` needs `--yes`: existing grants keep their subject and their
sessions keep working, and each user sees the change, and must acknowledge it,
at their next consent (§ 1d). A registry row stored without a subject type
reads as `public`, is reported at boot and by `show`, and `update` on it asks
for `--subject-type`. `update` writes nothing when nothing changed.

**`list`** prints one line per client, `<clientId>  <kind>  <status>
<subjectType|->`, so `list | grep public` lists the public registry clients.
**`show <clientId>`** prints the row (JWK Sets as thumbprints only).

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

Registry clients emit the same events. `oauth.consent.granted` carries
`subjectChange` when the consent switched the grant's subject mode (§ 1d).

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
| registry client: `/oauth2/authorize` → `invalid_scope` "no scope grammar registered on this core" | no OAuth extension installed (`customExtensions:oauthExtension`, § 2) |
| registry client: `/oauth2/authorize` → `invalid_scope` "pseudonymous subjects are not available on this core" | the client is `pairwise`, or its grammar asked for a pseudonym (§ 1c) |
| registry client: `/oauth2/authorize` → `invalid_scope` "openid is not available on this core" | the request asked for `openid` (§ 1c) |
| registry client: `/oauth2/authorize` → `invalid_request` about `aud` | the client has audiences and the request named none of them (§ 3b) |
| registry client: `/oauth2/token` → `500 server_error` "failed to build the token response" | the extension's hook failed or timed out, or its echo claimed reach the session does not hold; see the server log (§ 1c) |
| consent UI: `400 invalid_request` with `reason: consent-out-of-date` | the grant, the client or the extension changed while the screen was shown: restart the flow (§ 1d) |
| `access_denied` / `unauthorized_client` "this client is suspended" | the client was suspended (`resume <clientId>`, § 3b) |

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
- **Treat the OAuth extension as trusted code.** It runs in the core process
  and decides which permissions a registry client's scope maps to. The core
  bounds what it may grant (§ 1c), but review and pin the module like any
  other server code, and install the same version on every core.
- **Register registry clients narrowly**: the smallest maximum scope set, an
  explicit `--audience` list rather than `--any-audience`, https redirect URIs
  (avoid `--allow-insecure-redirect`), and `--allow-feature` only when the app
  needs it. Use `suspend` to stop an app quickly without losing its
  registration.
