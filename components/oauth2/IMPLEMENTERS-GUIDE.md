# oauth2 — Implementers' Guide

How to extend this component without re-litigating design decisions.

## Adding a new scope parser

The scope parser registry (`src/scopeRegistry.ts`) is keyed by **namespace**. The default deployment registers only the `pryv:` namespace; the SMART on FHIR follow-up plan registers a `smart` parser the same way.

```ts
import { registerScopeParser } from './scopeRegistry.ts';

registerScopeParser('smart', (scopeToken) => {
  // scopeToken is the raw text after `<namespace>/`, e.g. `patient/Observation.read`
  // Return an array of internal permission objects (or throw if malformed).
  return parseSmartScopeToken(scopeToken);
});
```

The registry is **process-global** — register at boot, before `registerRoutes(app, deps)` runs. The first whitespace-separated token in the OAuth `scope` parameter is matched against registered namespaces; tokens without a known namespace are rejected with `invalid_scope`.

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
| `oauth.token.issued.<grant_type>` | `{ clientId, grantedScope, userId?, accessId }` |
| `oauth.token.refreshed` | `{ clientId, userId, oldTokenId, newTokenId }` |
| `oauth.token.revoked` | `{ clientId, scope, source: 'user' \| 'operator' }` |

Audit calls MUST be awaited — silent fire-and-forget is a deliberate anti-pattern (audit failures must surface, per the existing `components/audit/` contract).

## App-account model

The App account IS the OAuth2 client. Its `:_app:*` streams carry RFC 7591 metadata (`redirect_uris`, `scope`, `client_name`, `logo_uri`, `client_uri`, `grant_types`, `application_type`). The operator CLI (`bin/oauth-client.js`) is the authoritative write path; the HTTP `POST /oauth2/register` endpoint is intentionally not shipped; see the project backlog.

`getClient(clientId)` reads from the PlatformDB cache row `oauth-client/<clientId>`, NOT directly from the App-account streams. The cache is refreshed by the CLI at every write (`create` / `update` / `revoke`) atomically. Cross-core consistency: PlatformDB is rqlite-replicated.

## What NOT to do here

- **Do not store `client_secret` plaintext anywhere.** The CLI hashes it with Argon2id at creation time; only the hash leaves the operator's terminal.
- **Do not extend `oauth-client/<clientId>` with credentials.** Per frozen-contract Invariant 2, that keyspace is metadata-only. `client_secret_hash` IS permitted (one-way; not a usable credential by itself); plaintexts and reversible encryption are not.
- **Do not match `redirect_uri` with regex or prefix.** Exact match only, with the loopback carve-out (`127.0.0.1` / `[::1]` may vary port). See `INTERNALS.md` for the matcher rules.
- **Do not redirect back to a supplied `redirect_uri` on validation failure.** Render an HTML 400 instead — defends against open-redirector phishing.
