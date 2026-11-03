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
| `GET /.well-known/openid-configuration` | OpenID Connect discovery (404 while `oauth.signingKeys` is empty) |
| `GET /oauth2/jwks` | JWK Set of the id_token signing keys, public members only (404 while `oauth.signingKeys` is empty) |
| `POST /oauth2/introspect` | RFC 7662 token introspection, for resource servers (confidential clients registered with `--can-introspect`) |
| `POST /oauth2/revoke` | RFC 7009 token revocation, a client revoking its own access or refresh token |

**Introspection.** The caller authenticates as at the token endpoint (HTTP
Basic, `client_secret_post` or `private_key_jwt`) and must be confidential,
registered with `--can-introspect` and not suspended; anyone else gets one
uniform `401 invalid_client`. Any core answers for any OAuth session token: a
session living on another core answers `421 { "error": "wrong_core",
"coreUrl": "<home core>" }` (ask there); the home core re-reads the session and
answers `{ "active": false }` when it is deleted, expired, its consent grant is
gone or its client is revoked, suspended, under review, gone or not served in
this core's region (§ 3b). An active answer carries the
RFC members (`scope`, for a registry client's session: the same scope answer as
the token endpoint, recomputed from the session as it stands; omitted for an
app-account session; `client_id`, `exp`, `iat`, `sub`, `iss`,
`token_type`, `aud` when the request named one, `cnf` for DPoP-bound sessions)
and two extension members,
never present in a token response: `api_base` (the account's API base URL, no
credential in it; for a pseudonymous grant, built on its alias, which is then
also the `sub`) and, for a registry client's session, `permissions`
(`[{ "streamId", "level" }]`, the stream permissions the session holds now, as
the core enforces them). The extension's `introspectionClaims` hook may add
members of its own (not the reserved ones).

**Revocation.** The client authenticates as at the token endpoint (a public
client names itself with `client_id`); `token_type_hint` is a hint only.
Revoking either token of a refresh chain ends that chain (its session and its
refresh token): revoking an access token deletes its session, which also ends
its refresh chain; revoking a refresh token ends it and deletes the session it
currently backs. The user's consent grant and the client's other chains (other
devices or launches) stay, so a sign-out on one device logs out nowhere else
and asks for no new consent. A refresh token issued before refresh tokens named
their session ends alone (its session lives out its lifetime). The consent
itself is withdrawn only by the user, or by the server on a detected
refresh-token reuse. An unknown token, another client's token or one already
ended answers `200` (no oracle); a token whose session or chain lives on
another core answers `421` with that core's URL.

**Refresh chains.** A refresh retires the access token it replaces: the previous
session of the chain expires `oauth.refreshRetireGraceSeconds` (default 60)
after the refresh. Deleting an OAuth session (from the account, by a grant
change that leaves it no reach, by a revocation) ends its refresh chain; a
replay of a token ended that way is refused without being treated as theft.

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
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "private_key_jwt", "none"],
  "token_endpoint_auth_signing_alg_values_supported": ["ES256", "ES384", "RS384"],
  "code_challenge_methods_supported": ["S256"],
  "authorization_response_iss_parameter_supported": true,
  "dpop_signing_alg_values_supported": ["ES256"],
  "jwks_uri": "https://<deployment-base>/oauth2/jwks",
  "introspection_endpoint": "https://<deployment-base>/oauth2/introspect",
  "introspection_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "private_key_jwt"],
  "revocation_endpoint": "https://<deployment-base>/oauth2/revoke",
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "private_key_jwt", "none"]
}
```

`grant_types_supported` reflects `oauth.grantTypesSupported`. The
introspection and revocation members appear only when those endpoints are
mounted (with the authorization-code flow); `jwks_uri` only when
`oauth.signingKeys` lists a key (§ 2). A client with a secret may send it
as HTTP Basic (`client_secret_basic`) or in the form body (`client_secret_post`).
`private_key_jwt` is RFC 7523 client authentication with an ES256, ES384 or RS384 assertion
(see § 3c for keys, pinned algorithms and `jwks_uri`; `aud` = the issuer or the token-endpoint URL; `/oauth2/introspect` and
`/oauth2/revoke` also accept their own URL as `aud`). With an assertion, `client_id` may be left
out of the request (RFC 7523 § 3): the client is the assertion's `iss`, which must equal its `sub`;
a `client_id` that is given must equal `iss`. `dpop_signing_alg_values_supported`
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
      echo ({ permissions, requestedTokens, client, grantState }) { /* scope tokens naming what permissions hold */ },
      supported () { /* optional */ },
      grantState ({ permissions, requestedTokens, client }) { /* optional: the grant's state, see below */ }
    },
    tokenResponse (ctx) { /* optional: extra fields of the token response */ },
    idTokenClaims (ctx) { /* optional: extra claims of the id_token */ },
    claimsSupported: [ /* optional: those claims, for the OpenID discovery document */ ],
    introspectionClaims (ctx) { /* optional: extra members of an introspection answer */ }
  };
};
```

The module is loaded at boot. **A module that cannot be loaded, or that breaks
the contract (unsupported `apiVersion`, missing `name` or grammar functions),
fails the boot**, not a user's first consent. The contract itself (types,
determinism, display labels, hook context) is documented in
`components/oauth2/src/extension.ts` and in the implementers' guide.

The extension's hooks (`tokenResponse`, `idTokenClaims`,
`introspectionClaims`) **fail closed**: a hook that throws, does not settle
within `oauth:extensionHookTimeoutMs` (default 5000 ms), returns a value that
is neither an object nor nothing (an array, a string or a number; `null` /
`undefined` add no field), or sets a key the core owns fails the request with
`500 server_error`. The core's keys are, for `tokenResponse`, `access_token`,
`token_type`, `expires_in`, `refresh_token`, `scope`, `id_token` and
`apiEndpoint`; for `idTokenClaims`, `iss`, `sub`, `aud`, `exp`, `iat`,
`nonce`, `auth_time` and `azp`; for `introspectionClaims`, the members the
core answers (§ 1). A token request that fails this way stores no refresh
token, and a refresh that fails this way does not use up the refresh token:
the app retries with the same one.

### The grant's state

`scopeGrammar.grantState` (optional) gives each registry grant a state: any
JSON value (or `undefined`, no state) computed from the grant's permissions
once a consent has settled them, at the first consent and at every
re-authorization, where it **replaces** the previous one. It is not computed
again at a refresh, nor when the account owner narrows the grant. The core
stores it on the grant (`clientData.oauth`, which only the server writes: the
owner's `accesses.update` cannot change it) and hands it back as `grantState`
to `echo` and to every hook (`tokenResponse`, `idTokenClaims`,
`introspectionClaims`). A state whose JSON exceeds 16 KiB, that is not
JSON-serialisable, or a hook that throws or does not settle in time fails the
consent with `500 server_error` and leaves the grant unchanged. **The state is
advisory**: `permissions` in each context is what the session holds now (the
owner may have narrowed the grant since the state was computed), the echo is
checked against `permissions` only, and anything derived from the state must
be intersected with them.

- `permissions` in the `grantState` context are the WHOLE grant after the
  consent (the composed re-consent, the kept restrictions and the client's
  default forbids included), while `requestedTokens` are the grammar tokens of
  THIS request only: derive the state from `permissions`.
- `null` is a value (stored, handed back as `null`); `undefined` means no state
  and removes a stored one.
- An extension that drops the hook, or is renamed (the state is stored under
  the extension's `name`), leaves every grant without a state until that
  user's next consent; grants made before the hook existed have none either.
  Hooks must handle `grantState === undefined`.
- The state handed to the echo and the hooks is frozen.

### Scope rules the core enforces

- A registry client's registered `scope` is its **maximum scope set**, parsed
  by the same grammar. A request beyond it answers `invalid_scope`.
- Whatever the grammar answers, the core refuses (`invalid_scope`) account and
  system streams, every stream (`*`), the `manage` level, an exclusion mask
  (level `none`), two permissions on
  one stream in one offer, a token the client did not send, an offer of
  more than 1000 permissions, an offer over 256 KiB of JSON (labels and texts
  included) and malformed `entryGroups` (below). It removes `defaultName` /
  `name` from the offer: a registry consent never creates a stream.
- These offer checks hold on every parse: the registered scope's (a
  registered scope over a bound refuses every request of the client, and the
  boot check warns about it) and the echo's (a failure there comes after the
  consent: the code exchange, a refresh and an introspection answer
  `server_error`). The registered scope's offer is never shown: an extension
  should emit no labels, groups or texts for it.
- The core owns two scope tokens and never hands them to the grammar:
  `offline_access` asks for a refresh token (granted only when the client is
  registered for the `refresh_token` grant), `openid` asks for an `id_token`
  and is refused (`invalid_scope`) unless `oauth:signingKeys` lists a key
  (§ 2).
- `client_credentials` and DPoP-bound tokens are not available to registry
  clients (a DPoP proof at `/oauth2/token` is refused with `invalid_request`
  before the code or refresh token is used).
- A client registered with audiences (`--audience`) must name one of them in
  the `aud` parameter of `/oauth2/authorize`, or in its RFC 8707 spelling
  `resource` (a trailing slash and the case of the scheme and host are
  ignored), else `invalid_target`.

### Resource indicators (`aud` / `resource`)

`/oauth2/authorize` (GET and POST) takes the resource server a session is
for as `aud` or as `resource` (RFC 8707): one parameter with two spellings,
the same rules, the same stored value. **One resource per authorization**:
the parameter given twice is refused (HTML 400, no redirect); a client that
needs tokens for two resource servers runs two authorizations. `aud` and
`resource` given together must name the same resource (else
`invalid_request`). Every audience refusal answers `invalid_target`: missing
on a client registered with audiences, not one of them, or malformed. The
description never lists the client's audiences. Two values name the same
resource when they are equal once a trailing slash is removed and the scheme
and host are lower-cased (RFC 3986 § 6.2.2.1); the path and query compare as
written (`/Mcp` is not `/mcp`), and no other normalisation applies (no
percent-decoding, no default port).

- **Client with registered audiences** (`--audience`): the value must be one
  of them; the registered spelling is stored.
- **Client registered for any audience** (`--any-audience`), and an
  application-account client (no audience list): a value is optional; when
  given it must be an absolute ASCII `https` URL (an internationalised host
  in its punycode form) without fragment, user information or backslash
  (`http` only on a loopback host: `localhost`, `127.0.0.1`, `[::1]`), at
  most 512 bytes, and is stored as given. The audience is then chosen by the
  client: only the resource server's own check of introspection `aud`
  protects it. The registered list is the recommended setting.

The chosen value is answered as `aud` by `/oauth2/introspect` (a resource
server checks it names itself) and handed to the extension's hooks as
`ctx.audience`; the token response carries no `aud`, and the id_token `aud`
stays the client id. `/oauth2/token` accepts `resource` (RFC 8707 § 2.2) on
the authorization-code and refresh-token grants: it must name the resource
the authorization named (compared as above), else `invalid_target`; on the
code grant the code is then used up like any other binding failure, on the
refresh grant the refresh token stays usable. A code without an audience
takes no `resource`. A refresh token issued without an audience (any chain
from before this release) ignores `resource` and stays unbound until the
user re-authorizes. `client_credentials` ignores `resource`.
Nothing is added to the discovery document (RFC 8707 registers no metadata).

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

The token response carries the core fields, `apiEndpoint` (not for a
pseudonymous grant, see below), the client's static `--extra` fields, then the
fields of the extension's `tokenResponse` hook and, at the code exchange of a
request granted `openid`, an `id_token` (§ 2 `signingKeys`; never on refresh).
The subject handed to the extension (and every hook field built on it, the
`id_token` `sub`, the introspection `sub`) is the user's **internal id**: not
the username, and not routable (it does not address the account); for a
pseudonymous grant it is the grant's alias.

### Pseudonymous subjects

A `pairwise` client (§ 3b `--subject-type`) always gets a pseudonymous
subject; a `public` client gets one when the grammar's offer asks for it
(`randomAlias: true`). Such a consent makes an **aliased grant**: the grant
carries a routable alias (`r-` and 8 characters), one per user and client,
kept across refreshes and re-consents, and every session minted under it
carries the same alias. The app knows the account by that alias only:

- the subject of its token responses, of the extension hooks, the `id_token`
  `sub` and the introspection `sub` are the alias;
- its token responses carry no `apiEndpoint`; the session's `access-info`,
  its own `apiEndpoint` (`accesses.getOne`), the introspection `api_base` and
  every access it creates (which carry the alias too) name the alias. The
  account's username reaches the app in no answer;
- the grammar's `echo` is told whether the subject is an alias (`aliased` in
  its context).

**Alias-bound addressing.** An aliased access (a session of an aliased grant,
an access created with `randomAlias`, or one created by such an access) is
accepted only on requests addressed by its alias: `https://<alias>.<domain>/…`
or `/<alias>/…`, the socket.io namespace `/<alias>`, the high-frequency series
URLs and attachment downloads. At the username, a former username or another
access's alias it is refused, answered like an unknown token. An access
without an alias is accepted at the account's own names and refused at an
access's alias; the owner's personal token is accepted at any of them.
**Sign-in and password reset are refused at an access alias**
(`POST /<alias>/auth/login` and `POST /<alias>/account/request-password-reset`
answer `400 invalid-operation`, whatever the credentials, before any password
check).

The alias is released when its last holder is deleted: deleting one session
keeps it (the grant and the other sessions hold it); deleting the grant, a
change of subject mode, a refresh-token reuse or the account's deletion
releases it, and a later consent gets a new one. Revoking a token
(`/oauth2/revoke`) or the retirement of a session on refresh keeps the alias
with the grant.

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
  "offer": { "allowUserChoice": false, "permissions": [ … ], "randomAlias": false, "entryLabels": { … }, "entryGroups": [ … ] },
  "scope": [ "…" ]
}
```

`offer.entryLabels` (display labels, values `{ [lang]: text }`),
`offer.entryGroups` and the offer texts come from the grammar and are passed
through unchanged. Both name entries by **entry key**: `s|<streamId>|<level>`
or `f|<feature>|<setting>`, or the level-less `s|<streamId>` / `f|<feature>`,
which name the entry at whatever level the screen shows it (a consent UI
looks up the exact key first, then the level-less one; the stream id is
matched as spelled). `entryGroups` is an ordered array (the display order)
of `{ "key": "…", "label": { "<lang>": "…" }, "entries": [ "<entry key>", … ] }`:
at most 64 groups, a `key` of 1 to 64 characters unique in the offer, labels
of at most 16 languages and 200 characters each, entry keys of at most 300
characters, at most 1000 entry keys in all, none in two groups; the core
refuses an offer that breaks these rules (`invalid_scope`, detail logged on
the server). A group may name entries the offer does not hold (a stream the
user's grant holds outside the request falls into its group on a
re-consent); an entry no group names is shown ungrouped. Grouping is display
only: it is part of the offer's digest and of `shownDigest`, never removes
an entry from the screen, and `/oauth2/authorize/accept` still takes a flat
`grantedPermissions`. The signed-out `/offer` answers the request as
parsed, never the composition: client defaults
(forbidden features) and the current grant appear only on the signed-in
composed offer, which is the authoritative screen (next section). `/offer` and `/oauth2/authorize/accept` re-derive the offer
from the request; a state whose client or grammar changed since
`/oauth2/authorize` is refused with `invalid_request` (or `invalid_scope` when
the new registration no longer covers the request): restart the flow.
App-account clients keep the offer inside the state, unchanged.

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
features shown, locked; a feature the request asks to allow but the client's
grants forbid by default (see "Registry grants" below) shown as the locked
forbid it becomes. The core's other default forbids are not listed: they are applied
after every consent. Beside it: `shownDigest` (opaque: never parse it, only
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
end, its alias is released) and a new one is made; `oauth.consent.granted`
carries `subjectChange`. A change of a client's `--subject-type` reaches each
user this way at their next consent (§ 1c, pseudonymous subjects).

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
| `grant-too-large` | the grant the consent would leave is above the client's `--max-entries` ceiling (`/offer` and `/accept`) |

### Registry grants and their sessions

- The durable consent record of a registry client is an app access named
  `oauth-grant:<clientId>` on the user's account (no expiry; one the owner let
  expire is replaced at the next consent). A grant withdrawn between consent
  and code exchange answers `invalid_grant` at `/oauth2/token`.
- **Registry grants forbid the `webhooks`, `secretSharing` and
  `accessCreation` features by default**, unless the client row allows the
  feature
  (`--allow-feature`, § 3b). The core applies these forbids at every consent
  and the sessions carry them. They are not part of the offer the grammar
  answers, so the signed-out offer does not show them; the signed-in composed
  screen shows one, locked, only when the request asks to allow that feature.
  Allowing a feature later does not lift the forbid on grants that already
  carry it: a forbid on a grant is kept by every re-consent, only the owner
  can remove it. **`accessCreation` is forbidden by default since the release
  that introduced it**: a client whose sessions create accesses, webhooks or
  CMC capability requests (invites) must be updated with `--allow-feature accessCreation` BEFORE that release is
  deployed, or each user's next consent locks the forbid onto their grant.
- **Exclusion masks (a stream at level `none`) never come from a consent.** A
  consent offer carrying one is refused (from the extension's grammar:
  `invalid_scope` at `/oauth2/authorize`; at `/oauth2/authorize/accept`:
  `400 invalid_scope`, "consent offer is invalid"). A registry grant holds masks only when the account owner edited
  the grant access (`accesses.update`), besides the restriction the core adds
  to every app access when it loads one (`:_system:account` at `none`). They
  narrow what the client reaches, are kept by every re-consent and do not
  count against `--max-entries` (§ 3b).
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
- **What a session creates belongs to the grant.** A shared access an OAuth
  session creates (possible only when the grant allows `accessCreation`) is
  stamped with the session's grant (`clientData.oauth.dataGrantId`; its
  `createdBy` stays the session). When the grant's permissions change, after
  the sessions, each live such access is narrowed to what the grant still
  reaches (through the stream tree), never widened; one left with no reach is
  deleted. Deleting the grant deletes them, whichever session created them and
  whether that session has expired or been retired since. Accesses a session
  created before this binding existed are matched by their `createdBy`. A
  stream the grant no longer reaches as a whole is dropped from such an access,
  even when the grant keeps a stream below it. Its `clientData` can be edited
  key by key, not wiped (`clientData: null` is `403`).
- **`clientData.oauth` is server-owned.** OAuth session accesses
  (`name: "oauth:<clientId>"`, `createdBy: "system"`) carry
  `clientData.oauth = { dataGrantId, chain }`, the link to their grant and
  their chain's consent; the accesses they create carry
  `clientData.oauth = { dataGrantId }`; a registry grant carries
  `clientData.oauth = { grantOf, extensionData? }` (its client, and the
  grant's state under the extension's name). `accesses.create` refuses an access carrying
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
  refreshReuseGraceSeconds: 10     # a replay within this window of a rotation is a benign double-submit
  refreshRetireGraceSeconds: 60    # how long the access token a refresh replaces keeps working
  dpop:
    clockSkewSeconds: 120          # accepted DPoP proof iat drift, seconds
    keyRevokeCheckSeconds: 30      # revoke-key reaches live DPoP-bound tokens within this, seconds
  clientRevokeCheckSeconds: 30     # revoke, suspend or review reaches live access tokens within this, seconds
  clientRegistration:
    mode: curated                  # ONLY supported value (see below)
  logoHosts: []                    # hosts client logos may be served from (see below)
  stateKey: ''                     # REQUIRED with consentUrl: consent-state signing secret (see below)
  signingKeys: []                  # OpenID Connect id_token keys; empty = OIDC off (see below)
  idTokenTTL: 300                  # id_token lifetime, seconds
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
(the token-response, id_token-claims and introspection-claims hooks). A hook
that does not answer in time fails the request (`500 server_error`), before
any refresh token is stored.

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

### `logoHosts`

The hosts (`host`, or `host:port` for a port other than 443) a client's logo
may come from. `--logo-uri` must be an https URL on one of them (the CLI
refuses any other), and the consent offer leaves out a stored logo that is not
https on a listed host (a host removed from the list stops being served at
once). Empty, the default: no logo is shown and `--logo-uri` is refused.
**Upgrade (breaking for clients with logos):** put the list on every core
BEFORE upgrading a platform whose clients have logos, else their logos stop
being served at the upgrade. Platform-wide, like the client registry: keep
the list identical on every core. Write each host alone (no scheme, path
or trailing dot), without the default port 443, an international name in its
`xn--` form: an entry that can never match, or a malformed list, is reported
at boot.

### `requireAppAccountMfa` (removed)

The key was never enforced and is no longer read; a core where it is still set
logs a warning at boot. Protect app accounts by other means (MFA enrolled by
the operator, strong credentials, curated registration).

### `stateKey` (required with `consentUrl`)

The secret the consent-flow state is signed with (the parameter carried from
`/oauth2/authorize` to the consent page and back to `/oauth2/authorize/accept`).
It is used for nothing else and is per core: a consent flow runs on one core.
It is required on every core where `consentUrl` is set: the boot refuses an
empty one (as does `bin/check-config.js`). Set a random value of at least 32
characters (`openssl rand -base64 32`). A placeholder, an unexpanded `${…}`
reference or a value published as an example refuses the boot (like the
`auth.*` secrets); one equal to `auth.adminAccessKey` or shorter than 32
characters is reported at boot. No other key ever stands in for it: a state
signed with any other key is refused. Setting or changing it only cancels the
consent screens open at that moment (a state lives 5 minutes). Third-party
sign-in signs its state cookie with its own per-core secret, `sso:stateKey`
(required where `sso:enabled` is true, same rules); give the two keys
different values.

### `signingKeys`, `idTokenTTL` (OpenID Connect)

With at least one signing key, registry clients (§ 1c) may request
the `openid` scope: the code exchange then returns an `id_token` (RS256, the
key's `kid` in its header) carrying `iss`, `sub` (the user's stable internal
id, not routable; for a pseudonymous grant, a `pairwise` client or an offer
asking for a pseudonym, the grant's alias, at which the app addresses the
account), `aud` and `azp` (the client id), `iat`, `exp`
(`idTokenTTL` later; default 300 s, at most 3600 s: a larger value is clamped
with a boot warning), `auth_time` and the request's `nonce`, plus the
extension's own claims. A refresh never returns an `id_token`. A nonce is
accepted once per client, across the platform: an authorization request or a
code exchange reusing one that already went into an id_token is refused.
`/.well-known/openid-configuration` and `/oauth2/jwks` are served, and
`openid` is listed in `scopes_supported` with an extension installed (it is a
scope of registry clients only; `subject_types_supported` lists `public` and
`pairwise`). Without keys, `openid` is refused (`invalid_scope`) and both documents answer 404.

`auth_time` is the time of the last completed sign-in (password, password plus
second factor, or identity provider) of the account on the app the user
consented with (the consent UI's personal access, which reports it as
`lastLogin`). A sign-in token the consent UI keeps from an earlier session keeps
that earlier time. A personal access written before this was recorded reports
its creation time, a lower bound, until its next sign-in. `max_age`, `prompt`
(including `prompt=login`) and `at_hash` are **not supported**: `/oauth2/authorize`
ignores `max_age` and `prompt`. A relying party that needs a fresh
authentication applies its own `max_age` policy to `auth_time`.

```yaml
oauth:
  signingKeys:
    - kid: '2026-10'                       # unique; printable, no space
      privateKeyFile: /etc/pryv/oidc.pem   # or privateKeyPem: "-----BEGIN PRIVATE KEY-----..."
```

RSA keys of at least 2048 bits, unencrypted PEM (`openssl genpkey -algorithm
RSA -pkeyopt rsa_keygen_bits:3072 -out oidc.pem`); `alg` may be given and must
then be `RS256`. A malformed entry stops the boot.

**Rotation is by ordering:** the first entry signs, every entry is published.
`/oauth2/jwks` is served with `Cache-Control: public, max-age=300`, and relying
parties may cache it longer, so a key must be published before it signs. Three
steps:

1. Add the new key **second** and restart. Wait at least the JWK Set cache
   lifetime (5 minutes, longer if your relying parties cache it longer): the
   key is published, not yet signing.
2. Move it **first** and restart: it signs from then on; the old key stays
   published.
3. Once `idTokenTTL` has passed, remove the old key and restart.

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
`refreshRetireGraceSeconds` (default 60, clamped to `[0, accessTokenTTL]`) is how
long the access token a refresh replaces keeps working; keep it at or above
`refreshReuseGraceSeconds`.

These three lifetimes are also **caps**: a client registered with its own
(`--access-token-ttl`, `--refresh-token-ttl`, `--refresh-token-absolute-ttl`,
§ 3c) gets the shorter of its value and the platform's. Lowering a setting
lowers every client at its next token, except the absolute lifetime of a
refresh chain already started (fixed when the chain began).

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
    [--scope cmc:<name>] [--cmc-offer <name>=<capabilityUrl>] [--grant-type <name> ...] \
    [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--application-type web|native] \
    [--jwks-file <path> | --jwks-json <json> | --jwks-uri <https-url>] [--signing-alg <alg> ...] \
    [--access-token-ttl <s>] [--refresh-token-ttl <s>] [--refresh-token-absolute-ttl <s>] \
    [--offline-access true|false] [--region <key> ...]
node bin/oauth-client.js list
node bin/oauth-client.js show   <clientId>
node bin/oauth-client.js update <clientId> [--redirect-uri <uri> ...] [--scope <s>] ...
node bin/oauth-client.js rotate-secret <clientId> [--previous-valid-for <seconds>]
node bin/oauth-client.js revoke <clientId> --yes
node bin/oauth-client.js list-keys [<clientId>]
node bin/oauth-client.js revoke-key <jkt> --yes
node bin/oauth-client.js unrevoke-key <jkt> --yes
node bin/oauth-client.js list-revoked-keys
```

(`list`, `show`, `update`, `rotate-secret`, `revoke`, `suspend`, `resume` and
`purge-grants` work on both client kinds; registry clients are created with
`create-registry`, § 3b, where `suspend`, `resume` and `purge-grants` are
described.)

Notes:

- **An unknown flag is refused** by `create`, `create-registry` and `update`
  (`<command>: unknown flag --x`), and so is a flag that needs a value given
  without one (`<command>: --x requires a value`): exit 1, nothing written.
  The registry flags (`--auth-method`, `--audience`, …) are unknown to
  `create`.
- **`--redirect-uri` is repeatable and required** — pass the flag once per URI.
  At least one is mandatory on `create`. Matching is exact, except that on a
  plain-`http` loopback host (`127.0.0.1`, `[::1]`, `localhost`) any port is
  accepted: register `http://localhost/callback` for a native or CLI client
  that listens on an ephemeral port. The three host forms are not
  interchangeable; register each one the client may send.
- **`--scope` is repeatable**; one value may hold several space-separated
  tokens, which are split (on `create`, `update` and `create-registry`).
- **`--cmc-offer <name>=<capabilityUrl>` is repeatable** — registers the
  consent offer behind each `cmc:<name>` scope token (see § 1b). Every
  `cmc:<name>` in `--scope` must have a matching `--cmc-offer` entry;
  registration fails fast otherwise.
- **`create` registers a PUBLIC client** (PKCE-only, no secret) — the common
  case for browser apps. It does not mint a `client_secret`.
- **`rotate-secret <clientId>`** mints a `client_secret`, promoting the client to
  **confidential** (for server-side apps). The plaintext is printed **once** and
  only its bcrypt hash is stored; re-run to rotate. The old secret is refused
  at once, unless `--previous-valid-for <seconds>` (30 days at most) keeps it
  valid that long while the app switches (§ 3c). On a registry client it works
  only for `client_secret_basic`; one
  registered with `none` or `private_key_jwt` is refused, nothing written
  (switch it with `update <clientId> --auth-method client_secret_basic`).
- **`show <clientId>`** prints the client secret (and a rotated one) as
  `"(set)"` when the client has one, never the hash, and JWK Sets as `kid`,
  `kty`, `crv`, `alg` and thumbprint only; then the pinned algorithms, the
  client's lifetimes and the end of a rotated secret's window.
- **`revoke <clientId> --yes`** removes the client row (no new consent, no
  refresh) and writes a platform-wide tombstone: every core refuses the live
  access tokens minted before it within `oauth:clientRevokeCheckSeconds`
  (default 30 s). Re-registering the same id does not clear the tombstone
  (tokens of the new registration are honoured). The users' grants stay until
  `purge-grants` (§ 3b), which `revoke` prints as the next step.
- **DPoP keys.** `list-keys [<clientId>]` lists the DPoP key thumbprints
  (`jkt`) seen bound to a client's tokens, most recently used first, flagged
  `REVOKED` where revoked. `revoke-key <jkt> --yes` revokes one key across the
  platform: every core stops the live tokens bound to it within
  `oauth.dpop.keyRevokeCheckSeconds` (default 30 s), and it can neither mint nor
  rotate tokens. `unrevoke-key <jkt> --yes` reverses it; `list-revoked-keys`
  lists the revoked keys.
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
    [--jwks-file <path> | --jwks-json <json> | --jwks-uri <https-url>] [--signing-alg <alg> ...] \
    [--access-token-ttl <s>] [--refresh-token-ttl <s>] [--refresh-token-absolute-ttl <s>] \
    [--offline-access true|false] [--can-introspect] \
    [--allow-insecure-redirect] [--allow-feature webhooks|secretSharing|accessCreation ...] \
    [--extra <key>=<value> ...] [--grant-type <name> ...] \
    [--name <s>] [--logo-uri <s>] [--client-uri <s>] [--policy-uri <s>] [--tos-uri <s>] \
    [--contact <s> ...] [--launch-type <s> ...] \
    [--localized-name <lang>=<text> ...] [--description <text> | --localized-description <lang>=<text> ...] \
    [--software-id <s>] [--max-entries <n>] [--region <key> ...]
node bin/oauth-client.js suspend <clientId>
node bin/oauth-client.js resume  <clientId>
node bin/oauth-client.js update  <clientId> [flags] [--approve]
node bin/oauth-client.js purge-grants <clientId> --yes
```

Flags:

- **`--scope`** (repeatable; space-separated tokens in one value are split):
  the client's **maximum scope set**, in the grammar of the installed
  extension. At least one is required. Requests beyond it answer
  `invalid_scope`; a registered scope the grammar refuses is reported at boot.
- **`--subject-type public|pairwise`** is **required, with no default**, and
  echoed back: `public`, the app sees the user's stable internal id (an alias
  only when its offer asks for a pseudonym); `pairwise`, always an alias, one
  per user and client, at which the app addresses the account (§ 1c,
  pseudonymous subjects).
- **`--audience <url>`** (repeatable): the absolute `https` resource URLs the
  client may name in the `aud` or `resource` parameter of `/oauth2/authorize`
  (refusal: `invalid_target`). At least one is required, unless
  **`--any-audience`** registers the client explicitly for any audience (no
  list check: a well-formed `aud` / `resource` is stored and answered as
  introspection `aud`, § 1c). The two exclude each other.
- **`--allow-insecure-redirect`**: plain-http redirect URIs are refused unless
  their host is a loopback one (`127.0.0.1`, `[::1]`, `localhost`); this flag
  accepts them on other hosts. Such clients are reported at every core boot.
- **`--allow-feature webhooks|secretSharing|accessCreation`** (repeatable):
  lifts the default forbid of that feature on the client's grants (§ 1d). Only
  these three features are accepted; `--allow-feature none` clears the list. `create-registry`
  and `show` print the features forbidden on the client's grants.
- **`--auth-method`**: `none` (the default, a public client using PKCE only),
  `client_secret_basic` (a secret is minted and printed **once**), or
  `private_key_jwt` (needs `--jwks-file`, `--jwks-json` or `--jwks-uri`, § 3c).
  The key flags and `--signing-alg` go with `private_key_jwt` only: with
  another method they are refused, nothing written.
- **`--can-introspect`**: the resource-server role, the client may call
  `/oauth2/introspect` (§ 1). Confidential clients only (`client_secret_basic`
  or `private_key_jwt`); refused with `--auth-method none`.
- **`--extra <key>=<value>`** (repeatable): a static field added to every
  token response of the client (`true`, `false` and numbers are stored as
  such, anything else as a string). Keys the core owns are ignored.
- **`--grant-type`** defaults to `authorization_code` and `refresh_token`;
  `client_credentials` is refused for registry clients.
- `--name` (the `client_name`, default the client id), `--logo-uri`,
  `--client-uri`, `--policy-uri`, `--tos-uri` are returned to the consent UI by
  `/oauth2/authorize/offer`. `--contact` and `--launch-type` are stored on the
  row and visible to the extension; the core does not act on them.

The boolean flags (`--any-audience`, `--allow-insecure-redirect`,
`--can-introspect`) take no value, or `true` / `false`; anything else is
refused. For `--contact`, `--launch-type`, `--extra`, `--policy-uri` and
`--tos-uri`, the value `none` means empty / unset.

**`suspend <clientId>` / `resume <clientId>`** (any client kind) refuse or
restore the client everywhere, with the description "this client is
suspended": `/oauth2/authorize` answers an HTML 400 and redirects nowhere,
`/offer` and `/accept` answer `403 access_denied`, every grant at
`/oauth2/token` answers `unauthorized_client`, introspection answers
`active: false` for its tokens, and the data API refuses its live access
tokens (403) within `oauth:clientRevokeCheckSeconds` (default 30 s). A
refused refresh consumes nothing, and sessions are not ended: the app's
tokens work again after `resume`. To end the grants and sessions for good,
run `purge-grants` (which `suspend` prints as the next step). A client under
review is refused the same way (below).

**`update <clientId>`** takes `--redirect-uri`, `--scope`, `--grant-type`,
`--name`, `--logo-uri`, `--client-uri`, `--jwks-file` / `--jwks-json` /
`--jwks-uri` (one replaces the other), `--signing-alg`, the lifetime flags,
`--offline-access`, `--region` and
`--can-introspect` (`false` withdraws it; a confidential client only) on both
kinds; on an app-account client also `--application-type` and `--cmc-offer`;
on a registry client also `--audience`, `--any-audience`,
`--allow-insecure-redirect` (`false` withdraws it), `--subject-type`,
`--allow-feature`, `--policy-uri`, `--tos-uri`, `--contact`, `--extra`,
`--launch-type`, `--auth-method`, the profile flags (below) and `--approve`
(all refused on app-account clients:
`update: --x applies to registry clients only`), parsed as `create-registry`
parses them. A repeatable flag replaces the stored list; `none` clears
`--policy-uri`, `--tos-uri`, `--contact`, `--extra`, `--launch-type` and
`--allow-feature`. **`--auth-method`** moves the credentials with it: to
`client_secret_basic` mints a secret, printed **once**, and drops the key set;
to `private_key_jwt` needs a key set (given with the command or already on the
row) and drops the secret; to `none` drops both and needs `--yes` (the client
becomes public: its refresh tokens are then redeemed without client
authentication). The same method again changes nothing (use `rotate-secret` to
rotate). On a registry client a key set is accepted only with
`private_key_jwt`. An unknown flag, or a flag that needs a value given without
one, is refused and nothing is written.

Changing `--subject-type` needs `--yes`: existing grants keep their subject
and their sessions keep working, and each user sees the change, and must
acknowledge it, at their next consent (§ 1d). A registry row stored without a
subject type reads as `public`, is reported at boot and by `show`, and
`update` on it asks for `--subject-type`. `update` writes nothing when nothing
changed (`OK   client unchanged: <id>`). On a registry client, every write
ends the consent screens open for it at that moment (the synthesised offer is
pinned to the registration's version); app-account consents in flight are
unaffected (their offer travels in the state). After `OK   client updated: <id>`, `update` echoes what the flags
given changed: the subject type, the auth method (`<new> (was <old>)`), the
new `client_secret` (once), the audiences, the plain-http redirect setting and
the features forbidden on the client's grants.

### Vetting status, profile, regions, purge

**Status.** A client is `active`, `suspended` or `review`. On a registry
client, an `update` that changes a vetted field moves an active client to
`review`, unless the same command carries **`--approve`**. The vetted fields
decide where its codes and tokens land, how it authenticates, what it reaches
and for how long: redirect URIs, scope, key set (`--jwks-file`, `--jwks-json`,
`--jwks-uri`), auth method, `--signing-alg`, grant types, audiences
(`--audience`, `--any-audience`), `--allow-feature`, `--can-introspect`, the
lifetimes and `--offline-access`. Any change counts, a narrowing too, compared
as stored (the same scope tokens in another order are a change). Not vetted:
`--subject-type` (its own `--yes`), the display and contact fields,
`--region`, `--max-entries`. A `jwks_uri` client's published key set can
change without any `update`: the review step does not see it.

A client under review is refused like a suspended one. `/oauth2/authorize`
answers an HTML 400 and redirects nowhere (the redirect URIs on file may be
the change awaiting approval), the consent answers 403, `/oauth2/token` answers
`unauthorized_client` (a refused refresh consumes nothing), introspection
answers `active: false` for its tokens and refuses it as a caller, and the
data API refuses its live access tokens (403) within
`oauth:clientRevokeCheckSeconds` (default 30 s). Sessions are not ended: they
work again once the client is active. `update <clientId> --approve` approves
it; `resume` does not. A change made while the client is suspended is recorded
and the status kept; `resume` then refuses until `update <clientId> --approve`
approves it (the client staying suspended). `--approve` is an update like any
other: every write rule applies to the row. Each change of status (and each
approved change) is kept in the row's `statusLog` (time, `by`: the OS user the
CLI ran as, `operator` when unset, from, to, reason, fields; the last 50),
printed by `show`, never handed to the extension. It is a trail, not an
identity record. App-account clients have no review step.

**Profile** (registry clients; `none` clears on `update`, none of these puts
the client under review): `--localized-name <lang>=<text>` (repeatable; the
name per language, `--name` staying the plain fallback), `--description
<text>` or `--localized-description <lang>=<text>` (repeatable), both returned
by `/oauth2/authorize/offer` as `client.name` / `client.description` (a text,
or a map by language code), before sign-in too; `--software-id <s>` (RFC 7591
`software_id`); `--max-entries <n>`, the ceiling on the permission entries of
one authorization request (above it `/oauth2/authorize` answers
`invalid_scope`) and of the grant a re-consent would leave (the signed-in
`/offer` and `/accept` answer 400 `invalid_scope`, `reason: 'grant-too-large'`;
`/accept` counts the grant after the consent is applied, without its
exclusion masks, which never come from a consent (§ 1d), and the client's
default forbids, and leaves it unchanged when refusing): 1 to 1000, default the platform bound, 1000. Token lifetimes
are set with the lifetime flags (§ 3c). `--logo-uri` must be https on a host of `oauth:logoHosts` (§ 2);
a stored non-https logo is removed (and printed) by the next `update` or
`rotate-secret` of a registry client.

**Regions** (`--region <key>`, repeatable, any client kind): the regions of
the platform's `hostings` hierarchy whose cores serve the client. A core whose
`core:hosting` lies in another region (or in none) refuses it at
`/oauth2/authorize` (`unauthorized_client`), the consent, `/oauth2/token` and
introspection of its tokens (a resource server may introspect anywhere).
Without a `hostings` hierarchy the platform has one region, `default`. The CLI
refuses a region the platform does not declare. Without `--region`: every
region.

**`purge-grants <clientId> --yes`**: grants are not swept when a client is
revoked or suspended (each is deleted at the user's next consent). This
command deletes them now, on **this core**: every grant of the client (its
registry grants, and the consent grants its sessions are bound to, an
app-account client's CMC data-grant included) with its sessions, the accesses
they created, their aliases and refresh chains, then every other access minted
for the client (its `client_credentials` tokens), and any refresh token of the
client left in this core's keyspace; it prints the counts. Run it on each core
of the platform (`revoke` and `suspend` print it as the next step), or after a
change of subject type to make every user consent afresh.

- **CMC data-grants.** The purged data-grants are those a session of the
  client is bound to; a CMC relationship with the client's app account that
  no OAuth session ever used is left alone. Two app-account clients
  registered on the same offer share the user's data-grant (it is keyed by
  the offer, not the client): purging either one deletes it for both, and
  the users re-consent to both. The counterparty of a deleted data-grant
  gets no revoke notice (the CLI has no CMC hook); its reach ends all the
  same, and the app side's relationship record, now stale, clears when its
  next call with it fails.
- **Bound.** Introspection answers `active: false` at once. The CLI sends no
  cache invalidation to the running server: an API worker that cached a
  deleted session keeps honouring it for up to `caching:accessMaxAgeSeconds`
  (default 60 s), per worker.
- The command reads every refresh row of the platform's keyspace for this
  core: on a large platform it may take a while.

**`list`** prints one line per client, `<clientId>  <kind>  <status>
<subjectType|->`, so `list | grep public` lists the public registry clients.
**`show <clientId>`** prints the row (`"clientSecretHash": "(set)"` when the
client has a secret, never the hash; JWK Sets as `kid`, `kty`, `crv`, `alg`
and thumbprint only; the `statusLog`), then a note when the subject type is
unset and the features forbidden on its grants.

---

## 3c. Client keys, algorithms, lifetimes and secret rotation

These flags work on both client kinds (`create`, `create-registry`, `update`).

**Key set (`private_key_jwt`).** `--jwks-file <path>` or `--jwks-json <json>`
registers an inline public JWK Set; `--jwks-uri <https-url>` registers it by
reference instead (one excludes the other; on `update` the one given replaces
the other). Accepted keys: EC P-256 (ES256), EC P-384 (ES384), RSA of 2048 bits
or more (RS384). A key with private members is refused; a key may carry `kid`,
`alg` (it then verifies that algorithm only), `use` (`sig` only) and `key_ops`
(must include `verify`). A set of more than one key needs a distinct `kid` on every key, and an assertion must
then name its key in its `kid` header. An algorithm is verified only with a key
of its type: an RS384 header naming an EC key is refused.

`--jwks-uri` is fetched by the core like any counterparty call: `https` only,
no redirect followed, a `200` answer of at most 64 KiB (up to 100 keys), a 5
second timeout, loopback / private / link-local addresses refused before any
connection. `cmc.allowedPrivateHosts` widens what a `jwks_uri` may reach, and
the platform's own host names (`core.url`'s host, `dns.domain` and below, the
`service.api` host) are trusted by name, without the address check, as for
every counterparty call. Each core caches a fetched set for 5 minutes; an
assertion naming a `kid` the cached set lacks fetches it again (at most every
30 seconds), so a client adding a key just signs with it. While the URL
answers, a key the client withdraws stops verifying within 5 minutes; while it
does not, the last set fetched stays in use and the URL is retried every 30
seconds. A URL never fetched successfully is refused for 30 seconds after a
failure. Every failure answers the uniform `invalid_client`; the reason (a
refused assertion, an unusable `jwks_uri`) is in the server log as a warning.

**Pinned algorithms.** `--signing-alg <alg>` (repeatable: `ES256`, `ES384`,
`RS384`; `none` clears on `update`) stores `tokenEndpointAuthSigningAlgs`: an
assertion with another algorithm is refused. Without it, any supported
algorithm that fits a key of the set is accepted. Each pinned algorithm must
fit a key of an inline set. The list is the stored form of the registration
metadata `token_endpoint_auth_signing_alg` (one value in RFC 7591 registration,
a list here so that one client may use two algorithms).

Example: one client with an RS384 and an ES384 key, both algorithms pinned:

```
node bin/oauth-client.js create-registry my-backend \
    --redirect-uri https://app.example.com/callback --scope <scope> \
    --subject-type public --audience https://resource.example.com/ \
    --auth-method private_key_jwt --jwks-file ./jwks.json \
    --signing-alg RS384 --signing-alg ES384
```

with `jwks.json` holding `{ "keys": [ { "kty": "RSA", "kid": "rsa-1", "n": …,
"e": "AQAB" }, { "kty": "EC", "crv": "P-384", "kid": "ec-1", "x": …, "y": … } ] }`.
The assertion: `iss` = `sub` = the client id, `aud` = the token-endpoint URL
(or the issuer), a single-use `jti`, `exp` at most 5 minutes ahead.

**Lifetimes.** `--access-token-ttl`, `--refresh-token-ttl` and
`--refresh-token-absolute-ttl` (seconds; `none` clears on `update`) set the
client's own lifetimes, each capped by the `oauth:` setting of the same name
(§ 2): the session minted at consent, the code exchange, refresh and
`client_credentials` use them, and `expires_in` follows. A lower absolute
lifetime applies to chains started after the change.
`--offline-access false` withholds refresh tokens: `offline_access` is dropped
from a registry client's request, the code exchange issues no refresh token,
and a refresh token issued before is refused (`unauthorized_client`) without
being used up (`--offline-access true` restores the default).

**Secret rotation.** `rotate-secret <clientId> --previous-valid-for <seconds>`
mints a new secret and keeps the one it replaces valid for that long (30 days at
most): both authenticate until then, the old one is refused after. Without the
flag (or with `0`) the old secret is refused at once: the right choice after a
leak. A second rotation ends the older secret; changing the client's
authentication method drops it.

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
| `oauth.nonce.reused` | an OpenID Connect nonce already used by the client came back at a code exchange (refused; the code by its hash, never the nonce) |
| `oauth.token.issued.authorization_code` | access token issued via the authorization-code grant |
| `oauth.token.issued.client_credentials` | access token issued via the client-credentials grant |
| `oauth.token.refreshed` | access token renewed via the refresh grant |
| `oauth.token.reuse_detected` | a consumed or ended refresh token was presented again (`reason`: `revoked-token`, `foreign-client`, `within-grace`, or `chain-revoked`: theft signal, the chain is revoked) |
| `oauth.token.dpop_mismatch` | a refresh carried a DPoP proof that does not match the chain's key (refused) |
| `oauth.token.revoked` | a token was revoked (reuse detected, consent withdrawn, revoked by its client at `/oauth2/revoke`, or its chain ended while a refresh was in flight) |
| `oauth.token.introspected` | a resource server introspected a token (caller, `active`; never the token; syslog only) |

Registry clients emit the same events. `oauth.consent.granted` carries
`subjectChange` when the consent switched the grant's subject mode (§ 1d).

`oauth.code.reused` in particular should page: per RFC 6749 a code is
single-use, so a reuse means either a broken client or a stolen code.

---

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/oauth2/authorize` → `invalid_scope` | scope is not exactly one registered `cmc:<offer-name>` reference, the offer's capability URL expired/was invalidated, or (on a client registered before `--scope` values were split) scopes were space-joined into one `--scope` value at registration |
| `/oauth2/authorize` → HTML 400 "redirect_uri does not match any registered URI" | the request's `redirect_uri` is not exactly one of the registered URIs (on plain `http` to `127.0.0.1`, `[::1]` or `localhost` only the port may differ, and the host must be a registered form: register each loopback form the client sends, § 3) |
| `/oauth2/token` → `invalid_grant` (PKCE) | the `code_verifier` does not match the `code_challenge` sent at `/authorize`, or the code expired / was already used |
| `/oauth2/token` → `invalid_client` | confidential client presented a wrong/rotated `client_secret` |
| `/oauth2/token` → `invalid_grant` on a multi-core deployment, the core logs "presented to core" | the exchange reached a core other than the one that issued the code: an `oauth.issuer` shared by several cores (see §2) |
| tokens behave differently between requests | `oauth:` block drift across cores (see §2) |
| registry client: `/oauth2/authorize` → `invalid_scope` "no scope grammar registered on this core" | no OAuth extension installed (`customExtensions:oauthExtension`, § 2) |
| a pseudonymous session's token is refused like an unknown token | the request addressed the account by its username (or another name) instead of the session's alias: use the alias the app received as its subject (§ 1c, alias-bound addressing) |
| registry client: `/oauth2/authorize` → `invalid_scope` "openid is not available on this core (no signing key configured)" | no `oauth.signingKeys` on this core (§ 2) |
| `/oauth2/authorize` → `invalid_target` | the client has audiences and the request named none of them in `aud` / `resource`, or a value no list vouches for is not an absolute https URL without fragment (§ 1c, resource indicators; § 3b) |
| `/oauth2/token` → `invalid_target` | the `resource` given is not the one the authorization named (§ 1c, resource indicators) |
| registry client: `/oauth2/token` → `500 server_error` "failed to build the token response" | the extension's hook failed or timed out, or its echo claimed reach the session does not hold; see the server log (§ 1c) |
| consent UI: `400 invalid_request` with `reason: consent-out-of-date` | the grant, the client or the extension changed while the screen was shown: restart the flow (§ 1d) |
| HTML 400, `access_denied` or `unauthorized_client` "this client is suspended"; data API 403 "The application access is suspended." | the client was suspended (`resume <clientId>`, § 3b) |
| the same with "this client is under review" / "The application access is under review." | a vetted field of the client changed without `--approve` (`update <clientId> --approve`, § 3b) |
| consent UI: `400 invalid_scope` with `reason: grant-too-large` | the grant the consent would leave is above the client's `--max-entries` ceiling (§ 3b) |

---

## 7. Security guidance

- **Rotate `client_secret`s** periodically and immediately on suspected
  compromise: `bin/oauth-client.js rotate-secret <clientId>`. The old secret
  stops working as soon as the new one is minted; for a planned rotation,
  `--previous-valid-for <seconds>` keeps it valid while the app switches
  (never after a leak).
- **Protect app accounts like admin credentials.** An app account can request
  consent from any user on the deployment. Enrol MFA on it (the core does not
  require it).
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
