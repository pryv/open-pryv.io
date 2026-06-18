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
- A second machine or Dokku app for the second core (with its own PostgreSQL)
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

> **Join role — a joining core defaults to a non-voter (safe by default).** A non-voting core replicates the platform DB and forwards writes to the leader, but never counts toward Raft quorum — so if it ever becomes unreachable it **cannot** stall the existing core. This keeps a two-core deployment safe (the first core stays a 1-of-1 quorum). Pass `--bootstrap-as-voter` **only** when you are building a **3-or-more-core** cluster and want leader-failover high availability. See "Cluster availability & container orchestrators" below for the full rationale and a preset table.
>
> **If the existing core's API is fronted by a public/ACME certificate** (the normal internet-facing case), also add `--bootstrap-ack-trust-system-ca`. By default the ack POST pins the cluster CA, which fails with `unable to get local issuer certificate` against a public cert. The flag verifies the ack against the system CA store instead (still `rejectUnauthorized`); the one-shot join token remains the authenticator. Omit the flag only when the existing core presents the cluster CA on its API origin (e.g. an internal-only deployment).

So a typical internet-facing second-core join is just (non-voter is the default):

```bash
node bin/master.js \
    --bootstrap /root/core-b.bundle.age \
    --bootstrap-passphrase-file /root/core-b.pass \
    --bootstrap-ack-trust-system-ca
```

For a ≥3-core HA cluster, add `--bootstrap-as-voter` to each core that should vote.

The master process:
- decrypts and validates the bundle,
- writes `override-config.yml` to its config directory and `/etc/pryv/tls/{ca,node}.{crt,key}` (mode 0600 for the key),
- POSTs an ack to the URL embedded in the bundle, with TLS pinned to the bundled CA (or, with `--bootstrap-ack-trust-system-ca`, verified against the system CA store),
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

## Cluster availability & container orchestrators

Read this before adding a core under Dokku, Kubernetes, Docker Compose, or any orchestrator that runs health checks — **adding a core can take a previously-healthy core's control plane offline** if you skip these precautions.

### Quorum: a new core counts as a voter immediately

rqlite is a Raft cluster. A new core joins **as a voter** as soon as it registers, and a Raft cluster needs a **majority** of voters reachable to elect a leader and accept platform writes:

| Voters | Majority needed | Tolerates losing |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | **0** |
| 3 | 2 | 1 |

A **two-core cluster is a trap for availability**: quorum is 2-of-2, so if *either* core becomes unreachable (crash, restart, redeploy, network blip) the survivor loses majority, steps down, and its control plane stalls — platform writes block and API calls that read the platform DB hang. A two-core cluster is *less* resilient to a single-core outage than a lone single core. The moment a brand-new, not-yet-proven core registers and then goes away, it can stall the core you already had.

**Recommendations:**
- Add cores **one at a time**, and confirm each is stable and reachable before adding the next.
- **Extra cores join as non-voters by default** — pass `--bootstrap-as-voter` only when deliberately building a ≥3-voter HA cluster. A non-voter replicates everything and serves its users, but cannot drag the cluster down if it goes away.
- Keep a recovery runbook ready: if you lose quorum, a surviving core can be forced back to a single-node cluster with an rqlite `peers.json` recovery file in its data directory (`storages.engines.rqlite` `dataDir`). See the rqlite recovery docs for the exact file format.

### Presets — which role for which topology

Pick the preset that matches what you're building. The default join role is **non-voter**; pass `--bootstrap-as-voter` to join as a voter (persisted as `core.nonVoter` in the new core's generated `override-config.yml`).

| Your goal | First core (`core-a`) | Each additional core | Quorum | Survives a core dying? |
|---|---|---|---|---|
| **Two cores, geo/locality split** (recommended default) | voter | **non-voter** (default) | 1-of-1 on core-a | Yes if a non-voter dies; core-a is the only SPOF (same as single-core) |
| **High availability / leader failover** | voter | **voter** (`--bootstrap-as-voter`) — and run **≥3 voters total** | majority of voters | Yes — 3 voters tolerate losing 1 |
| **Read scaling / many edge cores** | voter | **non-voter** for all edges; keep voters at 1 or 3 | on the voter set | Yes for edge deaths |

**Rules of thumb:**
- **Never run exactly two voters.** 2-of-2 quorum means either core dying is an outage. Use 1 voter + 1 non-voter, or 3 voters.
- A voter count of **1 or an odd number ≥3** is what you want. Even voter counts add no fault tolerance over the next-lower odd number.
- `core.nonVoter: true` in a core's config (written automatically by the default join; `--bootstrap-as-voter` omits it) is the switch. Changing a running core's role is a deliberate remove-and-rejoin operation, not just a config edit — see "Changing a core's role" below.

### Changing a core's role (voter ⇄ non-voter)

There is no in-place promotion/demotion. To change a core's role you remove it from the cluster, then rejoin it with the new role:

```bash
# On the leader: remove the core from the Raft configuration
curl -s -XDELETE "http://127.0.0.1:4001/remove" -d '{"id":"core-b"}'

# On core-b: set core.nonVoter (true to become a non-voter, remove/false for voter),
# clear its stale rqlite Raft data so it rejoins cleanly, and restart.
#   - edit override-config.yml (or host-config.yml) → core.nonVoter
#   - the platform DB re-replicates from the leader on rejoin; user data is untouched
```

Before promoting a non-voter to voter, confirm it is reachable and fully caught up via `GET /nodes?nonvoters` on the leader. **Do not promote into a two-voter configuration** — that re-creates the 2-of-2 trap.

### Health checks can strand an unreachable voter

When a core binds privileged ports (443, 53/udp) **directly** (proxy disabled, master owns the port), an orchestrator's **zero-downtime / rolling health check** can start the new core's container, fail the check during the brief window where the old and new containers coexist (the privileged bind can't succeed twice), and **stop the new container** — but only *after* `--bootstrap` has already acked and joined the cluster as a voter. You're left with a registered-but-unreachable voter, which immediately triggers the quorum problem above.

**Deploy contract for cores that bind privileged ports directly:**
- **Disable zero-downtime / rolling health checks** for the core app (e.g. on Dokku, set `CHECKS` to skip or use `zero-downtime: false`), so the orchestrator does not start-then-stop a container that has already joined the cluster.
- **Or front the core with nginx** terminating TLS on 443 and run master on `http.port: 3000` (see "Nginx notes" and `INSTALL.md`). Then no container needs a privileged direct bind and standard health checks work.
- Either way, ensure a freshly-started core stays up long enough to be reachable before you consider the join complete — verify with step 6 below before adding another core.

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
  # Recommended for a 2-core deployment: join as a non-voter so this core
  # never counts toward Raft quorum (see "Cluster availability" above).
  # Omit / set false only when building a >=3-voter HA cluster.
  nonVoter: true
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
