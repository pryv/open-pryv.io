# oauth2

OAuth 2.0 authorization-server component for Open Pryv.io.

The surface is the RFC 6749 authorization-code flow with PKCE-S256 mandatory, curated client registration through Pryv app accounts (RFC 7591 dynamic registration is not offered), RFC 9207 `iss` parameter on authorization responses, RFC 8414 `.well-known/oauth-authorization-server` metadata, refresh tokens with rotation, the client-credentials grant, RFC 7523 `private_key_jwt` client authentication and RFC 9449 DPoP proof-of-possession.

## Status

What's wired:

- `GET /.well-known/oauth-authorization-server`, `GET /oauth2/authorize`, `POST /oauth2/authorize/accept`, `POST /oauth2/authorize/refuse` (called by the consent UI) and `POST /oauth2/token` (`authorization_code`, `refresh_token`, `client_credentials`).
- Pluggable scope-parser registry (`cmc` parser registered; other grammars layer on as plugins).
- Hand-maintained Pryv `error.id` → RFC 6749 `error` enum map.
- App-account client registry (read + write via the operator CLI; HTTP `POST /oauth2/register` is intentionally not shipped).
- PlatformDB cache keyspace `oauth-client/<clientId>` (cluster-wide App-account-metadata cache for `/oauth2/authorize` validation on any core).
- PlatformDB short-TTL keyspaces `oauth-ac/<sha256(code)>` and `oauth-rt/<coreId>/<sha256(token)>` (no credential stored; see `INTERNALS.md`).
- Operator CLI (`bin/oauth-client.js`) for app-account promotion in `curated` registration mode.
- Audit events (`audit.ts`).

Operator documentation: `docs/oauth2.md` at the repository root.

## Public API

Imported as `oauth2` from elsewhere in the workspace (the package short-name resolves via npm workspaces).

```ts
import {
  registerRoutes,         // mount /.well-known + /oauth2/* on an Express app
  registerScopeParser,    // extension point for additional scope grammars
  getClient,              // App-account-backed client lookup
  errorMap,               // Pryv error.id → RFC 6749 enum
  WWW_AUTHENTICATE_BEARER // helper for components/middleware 401 responses
} from 'oauth2';
```

## Where to read next

- `IMPLEMENTERS-GUIDE.md` — how to add a new scope parser, a new grant, or a new error-map entry.
- `INTERNALS.md` — multi-core flow, the PlatformDB cache invariants, redirect-URI matcher rules.

## Tests

Run from the open-pryv.io root:

```
just test oauth2          # PostgreSQL baseStorage (default)
just test-sqlite oauth2   # SQLite baseStorage
```

Test families: `[OAUTH-SCOPE]`, `[OAUTH-ERR]`, `[OAUTH-CLIENT]`, `[OAUTH-STORE]`, `[PLKV]`, `[OAUTH-WK]`.


# License

[BSD-3-Clause](LICENSE)
