# Upgrading from single-core to multi-core

This guide covers upgrading a running single-core service-core deployment to a multi-core setup with shared platform database (rqlite).

Since v2 the platform DB is **always** rqlite — `bin/master.js` spawns and supervises an embedded `rqlited` in both single- and multi-core mode. Going multi-core no longer requires migrating any platform data; it's a config-only change followed by deploying additional cores.

## Overview

| | Single-core | Multi-core |
|---|---|---|
| Platform DB | rqlite (single node, embedded) | rqlite (clustered, embedded on every core, joined via DNS discovery) |
| User routing | All users on one instance | Each core hosts a subset of users |
| DNS | dnsLess (path-based) or single domain | `{username}.{domain}` subdomains |
| Config | `dnsLess.isActive: true` | `dns.domain` + `core.id` per instance |

## Prerequisites

- Running single-core deployment with users and data (already using rqlite for platform — automatic since v2)
- DNS control for the target domain (wildcard A record needed)
- A second machine or Dokku app for the second core (with its own PostgreSQL/MongoDB)

## Step-by-step

### 1. Set up DNS

Create a wildcard DNS record for the multi-core domain:

```
*.mc.example.com  A  → <host-ip>
mc.example.com    A  → <host-ip>
```

Each core gets a subdomain: `core-a.mc.example.com`, `core-b.mc.example.com`.
Users get subdomains: `{username}.mc.example.com`.

For rqlite peer discovery, also add a DNS A record for `lsc.mc.example.com` listing every core's raft IP. `bin/master.js` reads `dns.domain` and passes `-disco-mode dns -disco-config '{"name":"lsc.mc.example.com","port":4002}'` to rqlited so cores can find each other automatically.

### 2. Update the first core's config

Switch from dnsLess to multi-core mode:

```yaml
# REMOVE these (single-core / dnsLess)
# dnsLess:
#   isActive: true
#   publicUrl: https://old-single-core.example.com

dnsLess:
  isActive: false

core:
  id: core-a              # unique per core
  ip: <host-public-ip>    # for DNS A record (optional if external DNS)
  available: true

dns:
  domain: mc.example.com  # shared domain for all cores
  active: false           # true only if using embedded DNS server

storages:
  engines:
    rqlite:
      raftPort: 4002      # Raft consensus port — must be reachable from peer cores
```

**Key changes:**
- `dnsLess.isActive` → `false`
- `core.id` → unique identifier for this core
- `dns.domain` → the shared domain (also used by rqlite for `lsc.{domain}` discovery)
- `storages.engines.rqlite.raftPort` → make sure it's open between cores

`storages.platform.engine` is already `rqlite` from day one — no change needed there.

### 3. Restart the first core

Restart service-core. It will now:
- Use the embedded rqlited for all platform operations (registration, user lookup, core discovery)
- Generate API URLs as `https://{username}.{dns.domain}/`
- Identify itself as `core-a` in the platform
- Self-register its core info (id, ip, available) into the platform DB on startup

**Verify:**
```bash
# Service info should show multi-core URLs
curl -s https://core-a.mc.example.com/reg/service/info
# api: https://{username}.mc.example.com/

# Existing users should still be accessible
curl -s https://core-a.mc.example.com/{username}/auth/login -X POST ...

# Core discovery should work for users registered on core-a
curl -s 'https://core-a.mc.example.com/reg/cores?username={existing-user}'
# → { core: { url: "https://core-a.mc.example.com" } }
```

### 4. Deploy the second core

Set up a second instance with its own base storage (PostgreSQL/MongoDB). The embedded rqlited on core-b will join core-a's rqlite cluster automatically via DNS discovery, sharing the same platform DB.

```yaml
core:
  id: core-b
  ip: <core-b-ip>
  available: true

dns:
  domain: mc.example.com

storages:
  engines:
    rqlite:
      raftPort: 4002      # same Raft port — must be reachable from core-a
    postgresql:
      host: <core-b-pg-host>
      database: pryv_db_b
      # ... core-b's own PG credentials
```

`bin/master.js` on core-b passes `-disco-mode dns -disco-config '{"name":"lsc.mc.example.com","port":4002}'` to rqlited, which queries `lsc.mc.example.com` and joins the existing cluster.

### 5. Verify cross-core operation

```bash
# Register user on Core B
curl -s https://core-b.mc.example.com/users -X POST \
  -H 'Content-Type: application/json' \
  -d '{"appId":"test","username":"newuser","password":"pass","email":"new@test.com","invitationtoken":"enjoy","languageCode":"en"}'

# Discover from Core A → should point to Core B
curl -s 'https://core-a.mc.example.com/reg/cores?username=newuser'
# → { core: { url: "https://core-b.mc.example.com" } }

# List all cores
curl -s https://core-a.mc.example.com/system/admin/cores -H 'Authorization: <admin-key>'
# → { cores: [{ id: "core-a", userCount: N }, { id: "core-b", userCount: M }] }

# Hostings
curl -s https://core-a.mc.example.com/reg/hostings
# → both cores listed as available
```

## Nginx notes

When running behind nginx (including Dokku), each core needs:

1. **HFS proxy** — route `/{user}/events/{id}/series` to port 4000 with plain IP Host header (see `INSTALL.md`)
2. **Socket.IO** — WebSocket upgrade location for `/socket.io/`
3. **Upload size** — `client_max_body_size` matching `uploads.maxSizeMb`

The rqlite Raft port (default 4002) does **not** go through nginx — it's a peer-to-peer TCP connection between cores. Open it in any firewall between cores.

## Rollback

To revert to single-core:
1. Stop the second core
2. Change first core's config back: `dnsLess.isActive: true`, restore `dnsLess.publicUrl`, remove `core.id`/`dns.domain`
3. Restart — the embedded rqlited will run as a standalone node again with the same data

No platform data migration is needed in either direction — it stays in rqlite throughout.

## DNSless multi-core (externally managed DNS)

If DNS is managed by an external system (load balancer, Cloudflare, internal DNS server, ...) and FQDNs cannot be derived from `{core.id}.{dns.domain}`, set an explicit `core.url` per core:

```yaml
# core-a config
core:
  id: core-a
  url: https://api1.example.com    # explicit override — wins over id+domain derivation
  ip: 1.2.3.4
  hosting: us-east-1
  available: true

dns:
  domain: example.com               # still needed for rqlite peer discovery (lsc.example.com)
```

```yaml
# core-b config
core:
  id: core-b
  url: https://api2.example.com
  ip: 5.6.7.8
  hosting: us-east-1
  available: true
```

Each core advertises its `core.url` to PlatformDB on startup (`Platform.registerSelf()`). Other cores read this via the `Platform.coreIdToUrl()` cache, so the `/reg/cores` discovery route and the wrong-core middleware return the externally-correct URL.

### Discovery preflight (required for client SDKs)

In multi-core mode (with or without DNSless overrides), client SDKs must discover the user's home core URL **before** issuing API requests. The pattern:

```
1. SDK → GET /reg/cores?username=alice  (load balancer / any core)
   ← 200 { core: { url: "https://api1.example.com" } }

2. SDK → POST https://api1.example.com/alice/auth/login  (direct, no redirect)
   ← 200 { token: "...", apiEndpoint: "https://api1.example.com/alice/" }

3. SDK → GET https://api1.example.com/alice/events  (direct)
```

`api.example.com` (the load-balanced entry point) is for `/reg/*` and `/system/*` only. **User API calls (`/:username/*`) must go directly to the user's home core URL** returned by the discovery route.

### Wrong-core protection (HTTP 421)

If a client mistakenly sends a `/:username/*` request to the wrong core, the server responds with **HTTP 421 Misdirected Request**:

```json
{
  "error": {
    "id": "wrong-core",
    "message": "User \"alice\" is hosted on a different core. Retry the request against the URL in `coreUrl`.",
    "coreUrl": "https://api1.example.com"
  }
}
```

The SDK should retry against `coreUrl`. **There is no HTTP redirect** because:

1. Cross-origin redirects strip the `Authorization` header per the HTTP spec — a 308 to a different host would 401 on the next core.
2. WebSocket upgrades cannot follow HTTP redirects, so Socket.IO would break.
3. Some clients do not reliably resend POST/PUT bodies on redirect.
4. CORS preflight overhead on every misrouted request.

The wrong-core middleware is mounted on `/:username/*` only. `/reg/*` and `/system/*` routes are intentionally load-balanced and bypass it.

In single-core mode the middleware is a no-op.
