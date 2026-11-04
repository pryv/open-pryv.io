# oauth2 — Implementers' Guide

How to extend this component without re-litigating design decisions.

## Adding a new scope parser

The scope parser registry (`src/scopeRegistry.ts`) is keyed by **namespace**. The default deployment registers only the `cmc` namespace (`cmc:<offer-name>`, a consent-offer reference); other grammars (e.g. resource/action tokens) layer on by registering an additional parser.

```ts
import { registerScopeParser, ScopeParseError } from './scopeRegistry.ts';

registerScopeParser('ext', (body) => {
  // body is the text after `<namespace>:`, e.g. `records/item.read` for `ext:records/item.read`
  // Return one ParsedScope (or throw ScopeParseError if malformed).
  const m = /^([a-z]+)\/([a-z]+)\.(read|write)$/.exec(body);
  if (m == null) throw new ScopeParseError(`invalid ext scope "${body}"`);
  return { namespace: 'ext', raw: `ext:${body}`, permission: m[3], resource: m[2] };
});
```

The registry is **process-global** — register at boot, before `registerRoutes(app, deps)` runs. Every whitespace-separated token in the OAuth `scope` parameter is split at its first `:` and handed to the parser of that namespace; a token without a namespace prefix, or with an unregistered one, is rejected with `invalid_scope`.

This per-token path serves **app-account clients** only. Registry clients hand their whole scope string to the operator's OAuth extension instead (next section): prefer an extension over a new namespace parser when the vocabulary is not Pryv's own.

## Writing an OAuth extension (registry clients)

A registry client's scope vocabulary comes from a module the operator installs with `customExtensions:oauthExtension` (options in `oauth:extensionOptions`, hook bound `oauth:extensionHookTimeoutMs`). The contract is the header and the types of `src/extension.ts`; the dispatch is `src/scopeGrammar.ts`; the token response is `src/responseHooks.ts`. The operator side is in [`docs/oauth2.md`](../../docs/oauth2.md) § 1c to § 3b.

The module exports a factory `(host: { apiVersion, options, logger }) => { apiVersion: 1, name, scopeGrammar: { parse, echo, supported?, grantState? }, tokenResponse?, idTokenClaims?, claimsSupported?, introspectionClaims? }`. `idTokenClaims(ctx)` adds claims to the id_token (code exchange with `openid` granted; a core claim, `RESERVED_KEYS.idTokenClaims`, fails the request) and `claimsSupported` feeds the OpenID discovery document; `introspectionClaims(ctx)` adds members to the introspection answer of a registry client's session (a core member, `RESERVED_KEYS.introspectionClaims`, fails it). A factory or object that breaks the contract fails the boot.

`scopeGrammar.parse(scopeString, { client, purpose })` answers `{ ok: true, tokens, offer }` or `{ ok: false, description }`. `purpose` is `'max'` for the client's registered scope (its maximum scope set) and `'request'` for a request (and for the echo check below). The rules the core enforces:

- **Pure and deterministic** in (scope string, client). The offer is not carried in the signed state: it is re-derived at `/oauth2/authorize/offer` and `/accept` and pinned by a digest, so a grammar that answers differently between calls makes every consent fail as out of date.
- `tokens` are the request tokens the grammar recognised; reporting a token the client did not send is refused.
- **One permission entry per stream** after canonicalisation (`a` and `:local:a` are one stream), at most 1000 entries. Account and system streams, every stream (`*`) and the `manage` level are refused whatever the grammar answers. `defaultName` / `name` are removed and logged: a registry consent never creates a stream.
- **A permission may name a stream the account does not have yet.** It is granted as is and applies once a stream with that id is created (a Pryv property, not an extension one: the core does not check that the stream exists). The grammar's stream ids are therefore a contract with the data model: an id the model later creates under another name is never reached, and one created later by someone else under a granted id is. Label such entries (`entryLabels`): the consent UI has no stream name to show for them.
- Stream entries grant positive access only: a `level: 'none'` entry (an exclusion mask) in an offer is a contract error (`invalid_scope` "scope could not be parsed", detail logged), and `/accept` refuses one in any consent offer ("consent offer is invalid"). Masks on a grant come from the account owner's own edits, never from a consent.
- A forbidden feature in an offer is always mandatory; one marked `optIn` is refused.
- `allowUserChoice` is the grammar's choice (core default `false`, all-or-nothing). Set it to let the user untick entries; mark entries the app cannot run without `mandatory`.
- `randomAlias: true` asks for a pseudonymous subject: the grant then carries an alias (one per user and client), every session of it is used at that alias only, and the app never sees the username. Every request of a `pairwise` client gets one whatever the offer says (the core sets `randomAlias` before the digest, so the consent shows it).
- `entryLabels` (optional, display only) are keyed by entry key, values `{ [lang]: text }`; passed through to the consent UI unchanged. An entry key is `s|<streamId>|<level>` / `f|<feature>|<setting>`, or the level-less `s|<streamId>` / `f|<feature>`, which names the entry at whatever level the screen shows it (a held entry joined to another level, or one outside the request); the consent UI tries the exact key first. Prefer level-less keys, and label every stream the grammar can grant, not only the requested ones: held entries outside the request appear on a re-consent.
- `entryGroups` (optional, display only; absent, not `null`): an ordered array (display order) of `{ key, label, entries }`, `entries` being entry keys. The core refuses (contract error) more than 64 groups, a `key` that is empty, longer than 64 characters or used twice, a `label` that is not an object of strings (at most 16 languages, 200 characters each), an entry key longer than 300 characters, more than 1000 entry keys in all, and an entry key in two groups; other members of a group are dropped. A group may list entries outside the offer (its whole membership); an entry no group names is shown ungrouped. Groups are part of both digests (a release that regroups restarts in-flight consents) and never change what `/accept` takes: a flat `grantedPermissions`. `s|a` in one group and `s|a|read` in another are distinct keys: the exact-first lookup puts stream `a` shown at `read` in the second group and at any other level in the first. Character limits count UTF-16 code units.
- The whole offer (permissions, texts, labels, groups) is bounded to 256 KiB of canonical JSON (`MAX_SYNTH_OFFER_BYTES`); an offer that is not JSON (a BigInt, a cycle) is a contract error too.
- **These checks hold on every parse**, not only the request's: the registered scope (`purpose: 'max'`; a failure refuses every request of the client before any consent, and the boot check warns) and the echo (a failure comes after the consent: the code exchange, every refresh and introspection answer `500 server_error`). The `max` offer is never shown and is the largest one a grammar produces: emit no `entryLabels` / `entryGroups` / texts when `ctx.purpose === 'max'`, measure that offer first, then your largest request offer, and keep both well under the bound.
- `openid` and `offline_access` are the core's tokens: the grammar never sees them.

`scopeGrammar.echo({ permissions, requestedTokens, client, aliased?, grantState? })` answers the scope tokens naming what `permissions` (the minted session's) hold; `aliased` (optional) tells whether the subject is the grant's alias, so the echo can name a pseudonym marker for a `pairwise` client that did not ask for one. The core parses the echoed string **whole**, with `purpose: 'request'`, so every request rule above applies to it, and then checks:

- every parsed stream entry is held by an entry **on the same stream** (no inheritance through the stream tree; a stream held at `none` is not held) at a level that does not exceed it; a feature entry by the same entry (`forbidden` always passes). A violation is an extension error: `500 server_error` at `/oauth2/token`, logged, and a refresh refused this way leaves the refresh token usable;
- tokens the client did not request are fine (a narrowed token after a partial consent, a per-stream token, a marker expanding to no permission);
- held stream reach that the echo leaves unnamed is logged as a warning (one line per response);
- at most 1000 tokens, never `openid` / `offline_access`.

Make the round trip a test on the extension's side: the echoed scope sent back to `/oauth2/authorize` should re-derive an offer equal to the session's data streams.

`tokenResponse(ctx)` may add fields to the token response. `ctx.subject` is the user's internal id (never the username, not routable) or, when `ctx.aliased` is true, the grant's alias (routable: the session is used at it), `ctx.scopeTokens` the granted tokens (core tokens plus the echo), `ctx.permissions` the minted permissions, `ctx.audience` (optional) the resource server the authorization named (`aud` / `resource`; absent when none; the same in `idTokenClaims` and `introspectionClaims`). `ctx.grantType` is `authorization_code`, `refresh_token`, `token-exchange` (a resource server exchanging a client's token, RFC 8693) or, for `introspectionClaims`, `introspection`. On a token exchange, and at the introspection of the derived token it issued, `ctx.actor` (optional) is `{ clientId }` of the resource server, while `ctx.clientId`, `ctx.client`, the subject, the grant state, `ctx.permissions` and `ctx.scopeTokens` (the echo over the subject session's permissions) are the client's authorization; `ctx.audience` is absent there. A hook (`tokenResponse`, `idTokenClaims`, `introspectionClaims`) that throws, times out, returns a value that is neither an object nor nothing (an array, a string or a number; `null` / `undefined` add no field) or sets a reserved key (`RESERVED_KEYS` in `src/extension.ts`) fails the request with `500 server_error`, before any refresh token is stored (fail closed). The contexts added since (the token exchange's response, the introspection of a derived token) reserve further keys in that context only (`EXCHANGE_RESERVED_KEYS`: `api_base` and `issued_token_type` in the exchange's response, `act` in a derived token's introspection); the other contexts' lists are unchanged.

`scopeGrammar.grantState({ permissions, requestedTokens, client })` (optional) computes the grant's state at every registry consent, once the grant's final permissions are known and before anything is written: any JSON value, or `undefined` for none. It replaces the previous state, is stored on the grant only (`clientData.oauth.extensionData[<name>]`, server-owned), and is not computed again at a refresh nor when the owner narrows the grant. Over `GRANT_STATE_MAX_BYTES` (16 KiB of JSON, counted in bytes), not serialisable, throwing or timing out: `500 server_error` at `/accept`, the grant unchanged. The echo and every hook get it back as `ctx.grantState` (optional context field); it is advisory, `permissions` is authoritative, and the echo is checked against `permissions` only. In the `grantState` context, `permissions` are the whole grant after the consent (composition, kept restrictions and default forbids included) while `requestedTokens` are this request's grammar tokens only: derive the state from `permissions`. `null` is stored and handed back; `undefined` removes the state. Dropping the hook or renaming the extension (the state is keyed by `name`) leaves grants without a state until their next consent, so every hook must handle `grantState === undefined`. The state handed over is frozen.

## Adding a new grant type

Each `grant_type` lives in `src/grants/<grant_type>.ts` and exports a single `handle(req, res, deps)` function. Register in `src/routes/token.ts`:

```ts
import { handle as handleAuthorizationCode } from './grants/authorization_code.ts';
import { handle as handleRefreshToken } from './grants/refresh_token.ts';

const grantHandlers = {
  authorization_code: handleAuthorizationCode,
  refresh_token: handleRefreshToken,
  // your new grant here
};
```

The handler MUST:

- Validate the grant-specific parameters.
- Emit the appropriate audit event (`audit.ts` → `oauth.token.issued.<grant_type>` etc.).
- Return the RFC 6749 §5.1 JSON shape with the `Cache-Control: no-store` + `Pragma: no-cache` response headers (the routes layer sets these; the grant handler returns the body).
- Map Pryv-shaped errors through `errorMap.ts` so the client sees RFC 6749 `error` enum values, not Pryv `error.id` strings.

## Adding a new error-map entry

`src/errorMap.ts` is hand-maintained — the deliberate choice (see the design notes). When you introduce a new Pryv `error.id` that should map to an RFC enum:

```ts
export const errorMap: Record<string, OAuth2Error> = {
  // …existing entries…
  'pryv-some-new-error': 'invalid_request',
};
```

Default fallback (any unmapped error) is `invalid_request`. Add a `[OAUTH-ERR]` test for the new entry.

## Audit events

Every grant + revoke path calls into `src/audit.ts`. Available event types:

| Event | Payload |
|---|---|
| `oauth.consent.shown` | `{ clientId, requestedScope, userId? }` |
| `oauth.consent.granted` | `{ clientId, grantedScope, userId }` |
| `oauth.consent.refused` | `{ clientId, requestedScope, userId?, reason }` |
| `oauth.code.exchanged` | `{ clientId, codeId, grantedScope, userId }` |
| `oauth.code.reused` | `{ clientId, codeId, attemptedBy }` — stolen-code indicator |
| `oauth.nonce.reused` | `{ clientId, userId, codeId }`: an OpenID Connect nonce replayed at a code exchange (no nonce in it) |
| `oauth.token.issued.<grant_type>` | `{ clientId, grantedScope, userId?, accessId }` |
| `oauth.token.refreshed` | `{ clientId, userId, oldTokenId, newTokenId, retiredAccessId? }` |
| `oauth.token.reuse_detected` | `{ clientId, userId, dataGrantAccessId?, codeId, reason }`: a consumed or ended refresh token presented again (`reason`: `revoked-token`, `foreign-client`, `within-grace`, `chain-revoked`) |
| `oauth.token.dpop_mismatch` | `{ clientId, userId, dataGrantAccessId?, reason }`: a refresh with a DPoP proof that does not match the chain's key |
| `oauth.token.revoked` | `{ clientId, userId, accessId?, reason }`: reuse detected, consent withdrawn, revoked by the client at `/oauth2/revoke`, or the chain ended during its rotation |
| `oauth.token.introspected` | `{ clientId, active, userId?, tokenClientId?, actorClientId?, reason? }`: syslog only, never the token |
| `oauth.token.exchanged` | `{ clientId, userId, accessId, dataGrantAccessId?, subjectClientId, subjectAccessId, reused, grantedScope }`: a token exchange (`clientId` the resource server, `accessId` the derived session) |
| `oauth.token.exchange_refused` | `{ clientId, reason }`: an authenticated token exchange refused (`not-entitled`, `request-shape`, `subject-inactive`, `subject-client-unavailable`, `foreign-audience`, `wrong-core`); syslog only |

The type list and payload fields are `OAuthAuditEvent` / `OAuthAuditPayload` in `src/audit.ts`; the events without a resolvable user (`USERLESS_EVENTS`) go to syslog only.

Audit calls MUST be awaited — silent fire-and-forget is a deliberate anti-pattern (audit failures must surface, per the existing `components/audit/` contract).

## App-account model

The App account IS the OAuth2 client. Its `:_app:*` streams carry RFC 7591 metadata (`redirect_uris`, `scope`, `client_name`, `logo_uri`, `client_uri`, `grant_types`, `application_type`). The operator CLI (`bin/oauth-client.js`) is the authoritative write path; the HTTP `POST /oauth2/register` endpoint is intentionally not shipped; see the project backlog.

`getClient(clientId)` reads from the PlatformDB cache row `oauth-client/<clientId>`, NOT directly from the App-account streams. The cache is refreshed by the CLI at every write (`create` / `update` / `revoke`) atomically. Cross-core consistency: PlatformDB is rqlite-replicated.

**Registry clients** (`kind: 'registry'`, written by `create-registry`) have no app account: the `oauth-client/<clientId>` row is the whole registration (validated by `persistClient` in `src/clientRegistry.ts`). Their durable consent record is an app access `oauth-grant:<clientId>` on the user's account; their default forbidden features are `REGISTRY_DEFAULT_FORBIDDEN_FEATURES` minus the row's `allowFeatures`.

**`clientData.oauth` is server-owned** on every OAuth access (a session's `{ dataGrantId, chain }`, an access a session created `{ dataGrantId }`, a registry grant's `{ grantOf, extensionData? }`): `accesses.create` refuses it and `accesses.update` refuses any change to it. Write it storage-direct from the OAuth flow only.

The core-side internals (consent composition, the grant bound, client status checks, the purge) are in [`INTERNALS.md`](INTERNALS.md); the operator guide is [`docs/oauth2.md`](../../docs/oauth2.md).

## What NOT to do here

- **Do not store `client_secret` plaintext anywhere.** The CLI hashes it with bcrypt at creation time; only the hash leaves the operator's terminal.
- **Do not extend `oauth-client/<clientId>` with credentials.** By design, that keyspace is metadata-only. `client_secret_hash` IS permitted (one-way; not a usable credential by itself); plaintexts and reversible encryption are not.
- **Do not match `redirect_uri` with regex or prefix.** Exact match only, with the loopback carve-out (on plain `http`, `127.0.0.1` / `[::1]` / `localhost` may vary port; the host string must match exactly, so register each loopback form your client may send: they are not interchangeable). See `INTERNALS.md` for the matcher rules.
- **Do not redirect back to a supplied `redirect_uri` on validation failure.** Render an HTML 400 instead — defends against open-redirector phishing.
