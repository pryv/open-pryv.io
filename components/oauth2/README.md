# oauth2

OAuth 2.0 authorization-server component for Open Pryv.io.

The target surface is the RFC 6749 authorization-code flow with PKCE-S256 mandatory, RFC 7591 dynamic client registration via Pryv app accounts, RFC 9207 `iss` parameter on authorization responses, RFC 8414 `.well-known/oauth-authorization-server` metadata, refresh tokens with rotation, the client-credentials grant, and DPoP proof-of-possession.

## Status

This commit ships the **substrate only** — no public auth flow yet. What's wired:

- Pluggable scope-parser registry (`pryv:` parser registered; other grammars layer on as plugins).
- Hand-maintained Pryv `error.id` → RFC 6749 `error` enum map.
- App-account client registry (read + write via the operator CLI; HTTP `POST /oauth2/register` is intentionally not shipped).
- PlatformDB cache keyspace `oauth-client/<clientId>` (cluster-wide App-account-metadata cache for cross-core `/oauth2/authorize` validation).
- PlatformDB short-TTL keyspaces `oauth-code/<coreId>/<code>` and `oauth-refresh/<coreId>/<token>`.
- `.well-known/oauth-authorization-server` discovery doc handler.
- Operator CLI (`bin/oauth-client.js`) for app-account promotion in `curated` registration mode.
- Audit-event helper skeleton (`audit.ts`).

A follow-up commit adds `/oauth2/authorize` + `/oauth2/token` and the consent UI on the auth-page side.

## Public API

Imported as `oauth2` from elsewhere in the workspace (the package short-name resolves via npm workspaces).

```ts
import {
  registerRoutes,         // mount /.well-known + (later) /oauth2/* on an Express app
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
