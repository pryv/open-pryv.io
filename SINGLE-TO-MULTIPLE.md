# Upgrading from single-core to multi-core

This guide covers upgrading a running single-core Open Pryv.io deployment to a multi-core setup with shared platform database (rqlite) and mutually-authenticated TLS on the Raft channel.

Since v2 the platform DB is **always** rqlite — `bin/master.js` spawns and supervises an embedded `rqlited` in both single- and multi-core mode. Going multi-core no longer requires migrating any platform data; it's a config-only change followed by deploying additional cores.

## Overview

| | Single-core | Multi-core |
|---|---|---|
| Platform DB | rqlite (single node, embedded) | rqlite (clustered, embedded on every core, joined via DNS discovery) |
| User routing | All users on one instance | Each core hosts a subset of users |
| DNS | dnsLess (path-based) or single domain | `{username}.{domain}` subdomains |
| Raft channel | local only (loopback) | mutually-authenticated TLS between cores |
| Adding a core | n/a | one CLI invocation issues a sealed bundle |

## Prerequisites

- Running single-core deployment with users and data (already using rqlite for platform — automatic since v2)
- DNS control for the target domain (wildcard A record needed)
- A second machine or Dokku app for the second core (with its own PostgreSQL/MongoDB)
- `openssl` available on the existing core (used to mint the cluster CA on first run)

## How adding a core works

The existing core (call it `core-a`) holds a self-signed **cluster CA** in `/etc/pryv/ca/`. To add a new core (`core-b`):

1. On `core-a`, you run `bin/bootstrap.js new-core --id core-b --ip <ip>`. This:
   - generates the cluster CA on first run (one time only — back up `/etc/pryv/ca/`),
   - issues a node cert + key signed by the CA, scoped to `core-b`,
   - mints a one-time join token (24h TTL by default),
   - pre-registers `core-b` in PlatformDB as `available:false` and publishes its DNS records,
   - bundles everything (identity, platform secrets, TLS material, ack URL, token) into a passphrase-encrypted file.
2. You transfer the bundle file and the passphrase to `core-b` over a secure channel (separate channels recommended).
3. On `core-b`, you run `bin/master.js --bootstrap <bundle> --bootstrap-passphrase-file <pass>`. This:
   - decrypts and validates the bundle,
   - writes `override-config.yml` and the TLS files to disk,
   - POSTs an ack to `core-a` (TLS pinned to the bundled CA),
   - on success, deletes the bundle file (the join token is one-shot),
   - chains into normal startup — joining the rqlite cluster over mTLS.

Once the ack lands, `core-a` flips `core-b` to `available:true` in PlatformDB. Both cores now serve the cluster.

## Step-by-step

### 1. Set up DNS

Create a wildcard DNS record for the multi-core domain:

```
*.mc.example.com  A  → <host-ip>
mc.example.com    A  → <host-ip>
```

Each core gets a subdomain: `core-a.mc.example.com`, `core-b.mc.example.com`.
Users get subdomains: `{username}.mc.example.com`.

For rqlite peer discovery, the bootstrap CLI also publishes `lsc.{domain}` listing every core's Raft IP — you don't need to maintain it by hand.

### 2. Switch the existing core to multi-core mode

The existing core is in single-core (dnsLess) mode. Edit its config to identify itself in the cluster:

```yaml
# REMOVE these (single-core / dnsLess)
# dnsLess:
#   isActive: true
#   publicUrl: https://old-single-core.example.com

dnsLess:
  isActive: false

core:
  id: core-a              # this core's identifier
  ip: <host-public-ip>
  available: true

dns:
  domain: mc.example.com  # shared domain for all cores
  active: false           # true only if using embedded DNS server
```

Restart the existing core. It will now identify itself as `core-a` and be reachable at `https://core-a.mc.example.com/`. The embedded rqlited continues to run as a single-node cluster — until the first new core joins.

**Verify:**
```bash
curl -s https://core-a.mc.example.com/reg/service/info
# api: https://{username}.mc.example.com/

# Existing users still accessible
curl -s 'https://core-a.mc.example.com/reg/cores?username=<existing-user>'
# → { core: { url: "https://core-a.mc.example.com" } }
```

### 3. Issue a bootstrap bundle for the new core

On `core-a` (the existing core, which holds the cluster CA):

```bash
node bin/bootstrap.js new-core \
    --id core-b \
    --ip 1.2.3.4 \
    --hosting us-east-1 \
    --out /tmp/core-b.bundle.age
```

The CLI prints:

```
[ca] new cluster CA generated at /etc/pryv/ca
[ca] BACK UP THIS DIRECTORY — losing it means you cannot add cores later.

Bundle written:
  file       : /tmp/core-b.bundle.age
  passphrase : AbCd-EfGh-IjKl-MnOp
  expires    : 2026-04-18T08:42:00.000Z
  ack URL    : https://core-a.mc.example.com/system/admin/cores/ack
```

> **Back up `/etc/pryv/ca/` immediately** after the first run. The CA private key never leaves this host. If you lose it, you cannot add or rotate cores without a new cluster.

The CLI:
- generated the cluster CA (only on the very first invocation),
- pre-registered `core-b` in PlatformDB as `available:false`,
- appended `1.2.3.4` to the `lsc.mc.example.com` DNS record,
- added a `core-b.mc.example.com` A record,
- minted a one-time, 24h-TTL join token.

### 4. Transfer bundle + passphrase to the new core

Send the bundle file and the passphrase **on different channels** (e.g. file via `scp`, passphrase via password manager / Signal / sealed envelope). The bundle is encrypted with AES-256-GCM keyed off the passphrase via scrypt, but the passphrase itself is the only thing standing between an attacker who steals the file and full cluster admin access.

### 5. Boot the new core in `--bootstrap` mode

On `core-b` (a fresh host with a base storage already provisioned and `bin/master.js` installed):

```bash
# write the passphrase to a file readable only by the master process
echo "AbCd-EfGh-IjKl-MnOp" > /root/core-b.pass
chmod 600 /root/core-b.pass

node bin/master.js \
    --bootstrap /root/core-b.bundle.age \
    --bootstrap-passphrase-file /root/core-b.pass
```

The master process:
- decrypts and validates the bundle,
- writes `override-config.yml` to its config directory and `/etc/pryv/tls/{ca,node}.{crt,key}` (mode 0600 for the key),
- POSTs an ack to the URL embedded in the bundle, with TLS pinned to the bundled CA,
- on success, deletes the bundle file (the token is single-use; replay attempts get a 401 from the ack endpoint),
- continues into normal startup — `rqlited` joins the cluster over mTLS.

The ack response includes a snapshot of the cluster's cores so you can sanity-check what you've joined.

### 6. Verify cross-core operation

```bash
# Both cores listed, both available
curl -s https://core-a.mc.example.com/system/admin/cores -H 'Authorization: <admin-key>'
# → { cores: [
#       { id: "core-a", available: true, userCount: N },
#       { id: "core-b", available: true, userCount: 0 }
#   ]}

# Register a user on core-b
curl -s https://core-b.mc.example.com/users -X POST \
  -H 'Content-Type: application/json' \
  -d '{"appId":"test","username":"newuser","password":"pass","email":"new@test.com","invitationtoken":"enjoy","languageCode":"en"}'

# Discover from core-a → should point to core-b
curl -s 'https://core-a.mc.example.com/reg/cores?username=newuser'
# → { core: { url: "https://core-b.mc.example.com" } }
```

## Cluster security

- **Raft channel uses mTLS.** Bootstrap-issued cores ship with `storages.engines.rqlite.tls.{caFile,certFile,keyFile,verifyClient:true}` set in `override-config.yml`. Both ends of every Raft connection verify the peer's cert against the cluster CA — a stranger on the network cannot join or impersonate a peer.
- **The cluster CA private key lives only on the issuing core**, in `/etc/pryv/ca/ca.key` (mode 0600). Only this host can issue new node certs. Back up this directory off-host.
- **Join tokens are one-shot.** A token verifies exactly once at the ack endpoint and is then burned; replays return 401. Default TTL 24h.
- **Bundles are AES-256-GCM encrypted** with a passphrase derived via scrypt. Tampering breaks GCM auth at decrypt time.
- **The ack endpoint bypasses admin-key auth.** It's gated by the join token instead — the new core doesn't yet have the admin key in a usable place when it acks. Once acked, every subsequent admin call uses the standard `auth.adminAccessKey`.
- **The Raft port (default 4002) is no longer required to be VPN-protected** between cores by default. Plain TCP between cores is rejected by `verifyClient: true`.

## Operations: managing in-flight bundles

```bash
# List active (un-consumed, un-expired) tokens
node bin/bootstrap.js list-tokens
# coreId           expiresAt                  issuedAt
# core-c           2026-04-18T08:42:00.000Z   2026-04-17T08:42:00.000Z

# Operator changes their mind — revoke a token AND undo the pre-registration
node bin/bootstrap.js revoke-token core-c --ip 5.6.7.8
# Revoked 1 active token(s) for core-c.
# Cleaned up DNS/PlatformDB: coreInfoDeleted=true, perCoreDeleted=true, lscIpsAfter=[1.2.3.4]
```

If `--ip` is omitted, only the token is revoked; the DNS / PlatformDB pre-registration stays. Pass `--ip <ip>` to fully unwind the issuance.

## Nginx notes

When running behind nginx (including Dokku), each core needs:

1. **HFS proxy** — route `/{user}/events/{id}/series` to port 4000 with plain IP Host header (see `INSTALL.md`).
2. **Socket.IO** — WebSocket upgrade location for `/socket.io/`.
3. **Upload size** — `client_max_body_size` matching `uploads.maxSizeMb`.

The rqlite Raft port (default 4002) does **not** go through nginx — it's a peer-to-peer mTLS connection between cores. Open it in any firewall between cores.

## Rollback

To revert to single-core:

1. Stop the new core(s).
2. On the original core, run `node bin/bootstrap.js revoke-token <id> --ip <ip>` for each removed core to clean up DNS + PlatformDB.
3. Change the original core's config back: `dnsLess.isActive: true`, restore `dnsLess.publicUrl`, remove `core.id` / `dns.domain`.
4. Restart — the embedded rqlited will run as a standalone node again with the same data.

No platform data migration is needed in either direction — it stays in rqlite throughout.

## DNSless multi-core (externally managed DNS)

If DNS is managed by an external system (load balancer, Cloudflare, internal DNS server) and FQDNs cannot be derived from `{core.id}.{dns.domain}`, the bootstrap CLI accepts `--url`:

```bash
node bin/bootstrap.js new-core \
    --id core-b \
    --ip 5.6.7.8 \
    --url https://api2.example.com \
    --hosting us-east-1 \
    --out /tmp/core-b.bundle.age
```

The bundle includes the explicit `core.url`, which the new core writes into its `override-config.yml` and advertises to PlatformDB on startup. Other cores read this via the `Platform.coreIdToUrl()` cache, so the `/reg/cores` discovery route and the wrong-core middleware return the externally-correct URL.

### Discovery preflight (required for client SDKs)

In multi-core mode (with or without DNSless overrides), client SDKs must discover the user's home core URL **before** issuing API requests:

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

---

## Appendix — manual bootstrap (no CLI)

The `bin/bootstrap.js` CLI is the recommended path. If you need full control — for example, an offline install where the new core can never reach the existing core to ack — you can stand up a new core entirely by hand. This is intentionally more work because the CLI does six things you'd otherwise do yourself.

### A.1 Generate a cluster CA (if you don't have one)

```bash
mkdir -p /etc/pryv/ca && cd /etc/pryv/ca
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
chmod 600 ca.key
openssl req -x509 -new -key ca.key -days 3650 -out ca.crt -subj '/CN=pryv-cluster-ca'
```

Copy `ca.crt` (only) to every core. Keep `ca.key` on exactly one host.

### A.2 Issue a node cert for the new core

```bash
NODE_DIR=$(mktemp -d)
cd "$NODE_DIR"
openssl ecparam -name prime256v1 -genkey -noout -out node.key
chmod 600 node.key
openssl req -new -key node.key -out node.csr -subj '/CN=core-b'

cat > node.ext <<EOF
subjectAltName = DNS:core-b, DNS:core-b.mc.example.com, IP:1.2.3.4
EOF

openssl x509 -req -in node.csr \
  -CA /etc/pryv/ca/ca.crt -CAkey /etc/pryv/ca/ca.key -CAcreateserial \
  -days 365 -out node.crt -extfile node.ext
```

Transfer `node.crt`, `node.key`, and `ca.crt` to the new core and place them under `/etc/pryv/tls/`.

### A.3 Pre-register the new core in PlatformDB

On the existing core (any one with PlatformDB access):

```bash
node bin/dns-records.js load - <<EOF
records:
  - subdomain: core-b
    records:
      a: ["1.2.3.4"]
EOF
```

Then merge `1.2.3.4` into the `lsc.mc.example.com` record (read it first, append, write back via the same CLI). The bootstrap CLI does this read-merge-write atomically; doing it by hand is racy if two operators add cores at once.

### A.4 Hand-write `override-config.yml` on the new core

Copy the platform-wide secrets from the existing core (`auth.adminAccessKey`, `auth.filesReadTokenSecret`) and write:

```yaml
core:
  id: core-b
  ip: 1.2.3.4
dns:
  domain: mc.example.com
dnsLess:
  isActive: false
auth:
  adminAccessKey: '<copy from core-a>'
  filesReadTokenSecret: '<copy from core-a>'
storages:
  engines:
    rqlite:
      raftPort: 4002
      url: http://localhost:4001
      tls:
        caFile: /etc/pryv/tls/ca.crt
        certFile: /etc/pryv/tls/node.crt
        keyFile: /etc/pryv/tls/node.key
        verifyClient: true
```

`chmod 600 override-config.yml` — it carries the admin key.

### A.5 Start the new core

```bash
node bin/master.js
# rqlited joins the cluster over mTLS, master forks workers
# Platform.registerSelf() writes core-b into PlatformDB as available:true
# (default, unless `core.available: false` is set explicitly).
```

Verify on the existing core that `core-b` is listed as `available:true`:

```bash
curl -s https://core-a.mc.example.com/system/admin/cores -H 'Authorization: <admin-key>'
```

The CLI path collapses A.1 through A.5 into two commands and removes the race in A.3 plus the secret-copying mistake in A.4. Use the CLI unless you specifically can't.
