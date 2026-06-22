# oauth2

OAuth 2.0 authorization-server component for Open Pryv.io.

Ships the RFC 6749 authorization-code flow with PKCE-S256 mandatory, RFC 7591 dynamic client registration via Pryv app accounts, RFC 9207 `iss` parameter on authorization responses, RFC 8414 `.well-known/oauth-authorization-server` metadata, and the substrate for refresh tokens, client-credentials grant, and DPoP proof-of-possession (the latter lands in Phase F).

## Status

**M1 (Foundation) — substrate only.** This milestone ships:

- Pluggable scope-parser registry (`pryv:` parser registered; SMART parser later lands as a plugin).
- Hand-maintained Pryv `error.id` → RFC 6749 `error` enum map.
- App-account client registry (read + write via the operator CLI; HTTP `POST /oauth2/register` is intentionally NOT shipped — see Spin-off candidates in the parent plan folder).
- PlatformDB cache keyspace `oauth-client/<clientId>` (cluster-wide App-account-metadata cache for cross-core `/oauth2/authorize` validation, per the frozen-contract Invariant 3).
- PlatformDB short-TTL keyspaces `oauth-code/<coreId>/<code>` and `oauth-refresh/<coreId>/<token>` (used by M2 + M3).
- `.well-known/oauth-authorization-server` discovery doc handler.
- Operator CLI (`bin/oauth-client.js`) for app-account promotion in `curated` registration mode.
- Audit-event helper (`audit.ts` skeleton; actual emission lands in M2/M3/M4).

**No public auth flow yet** — M2 adds `/oauth2/authorize` + `/oauth2/token`.

## Public API

Imported as `components-oauth2` from elsewhere in the workspace (the package short-name resolves via npm workspaces).

```ts
import {
  registerRoutes,         // mount /.well-known + (later) /oauth2/* on an Express app
  registerScopeParser,    // extension point for SMART (Phase 40 follow-up plan)
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
