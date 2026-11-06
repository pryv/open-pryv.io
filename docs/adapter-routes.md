# Adapter routes: a sidecar under `/adapter/<name>/`

An **adapter route** exposes a sidecar container that runs on the same host as a core (typically a
resource server for this core's accounts: an API facade, an agent gateway) under the core's own
public URL, without an nginx in front:

```
https://<any host this core serves>/adapter/<name>/...            -> the sidecar
https://<any host>/.well-known/<label>/adapter/<name>/...          -> the sidecar (optional prefixes)
everything else                                                    -> the core, as before
```

**The core forwards unauthenticated traffic: the upstream must authenticate it.** On these paths the
core applies none of its own authentication, CORS, audit or rate limiting. The sidecar is a resource
server: it answers its own `401` + `WWW-Authenticate` challenges and validates the tokens it receives
(for instance through OAuth token exchange or introspection with its own registry client, see
`docs/oauth2.md`), answers its own CORS (preflights included) and audits what it does.

## Configuration

Per core, in the override config (`adapterRoutes: {}` by default, which turns the feature off):

```yaml
adapterRoutes:
  calendar:                                   # the route name: a DNS label, not "adapter"
    upstream: http://172.17.0.1:7450          # required: the sidecar's origin (scheme, host, port)
    paths:                                    # optional; /adapter/<name>/ is always included
      - /adapter/calendar/
      - /.well-known/oauth-protected-resource/adapter/calendar/
    maxBodyBytes: 1048576                     # optional; request bodies above it answer 413 (default 1 MiB)
    idleTimeoutMs: 60000                      # optional; 504 when no byte moves for this long (default 60 s)
```

| Key | Rule |
|---|---|
| name | a DNS label (1-63 lowercase letters, digits, inner hyphens); `adapter` is refused |
| `upstream` | an absolute `http:` or `https:` origin (port 1-65535), no path, query, fragment or credentials; never this platform (`dns.domain` or a subdomain, the dnsLess `publicUrl` origin, the `core.url` origin) nor this core's own listener (`http.port`, `http.hfsPort`, `http.previewsPort` on a loopback address, `localhost`, `0.0.0.0` or `http.ip`; on another address of the host when `http.ip` is `0.0.0.0` it warns). `http:` to an address that is not loopback, private, link-local or a single-label container name warns at boot (the traffic, credentials included, travels in clear) |
| `paths` | each entry starts with `/adapter/<name>/` or `/.well-known/<label>/adapter/<name>/`, ends with `/`, holds no `%`, no `//`, no dot segment, no query; `/.well-known/oauth-authorization-server/...`, `/.well-known/openid-configuration/...` and `/.well-known/acme-challenge/...` are refused (the core serves them) |
| `maxBodyBytes` | positive integer, bytes |
| `idleTimeoutMs` | positive integer, milliseconds, at most 86400000 (24 h); below 5000 warns |

Unknown keys are refused (typo safety). `bin/check-config.js` and the boot validation report every
problem with its key path. Keep the route names and `paths` identical on every core of a platform
(the same adapter at the same URL on each); `upstream` is per core.

**Reserved username.** `adapter` cannot be registered nor taken by a rename, on every core and in both
topologies. A core with at least one route refuses to boot while an account named `adapter` exists on
the platform (rename it with `account.changeUsername` first); without a route nothing changes for it.
A backup that names an account `adapter` is refused at restore ("reserved username"; `--skip-conflicts`
does not bypass it): rename the account on the source platform and back it up again.

At boot each route logs one line: `adapter route <name>: <upstream> paths <list>`. There is no probe of
the upstream: a sidecar may start after the core. Nothing in `/service/info` is derived from the
routes; list the adapters there by hand in `service.adapters` (see "Per-user addresses" below).

## What is forwarded

Matching is on the path only, on every host the core serves (in the DNS topology `alice.<domain>`,
`reg.<domain>` and a hosted site's host included), before hosted sites, HFS, previews and the API.
Only `/socket.io/` stays ahead (Socket.IO). The request path is normalised first (dot segments
resolved, `\` read as `/`); the normalised path is both what is matched and what is forwarded, with
the query unchanged. `/adapter/<name>` without its trailing slash is forwarded as is (no redirect).

**Request:**
- every method but TRACE (OPTIONS and preflights included), the body, streamed. A declared
  `Content-Length` is forwarded as is, a chunked body is forwarded chunked; a `Connection` header
  cannot remove `Host`, `Content-Length` or the `X-Forwarded-*` headers;
- every header except the hop-by-hop ones (`Connection` and the headers it names, `Keep-Alive`,
  `Proxy-Connection`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Proxy-Authenticate`,
  `Proxy-Authorization`) and `Expect` (the core answers `100 Continue` itself). `Authorization`,
  `Cookie`, `DPoP`, `Origin` and custom headers pass;
- `Host`: kept as the client sent it, so the sidecar can build its public URLs from it;
- set by the core, the client's values replaced: `X-Forwarded-For` (the client address under
  `http.trustedProxies`), `X-Forwarded-Proto` (`https` when this core terminated TLS, else `http`),
  `X-Forwarded-Host` (the received `Host`). When the TCP peer is a trusted proxy (an nginx in front),
  its own `X-Forwarded-Proto` / `X-Forwarded-Host` are kept;
- removed, never set: `Forwarded`, `X-Forwarded-Port`. Not set: `Via`, `X-Real-IP`;
- `X-Adapter-Name` / `X-Adapter-Base`: removed from every request, in any `-` / `_` spelling
  (`X_Adapter_Name` included; a client's or a trusted proxy's values never pass), then set by the
  core on a request addressed to an account (see below).

**Response:** status and every header except the hop-by-hop ones, `WWW-Authenticate`, `Set-Cookie`,
`Location` and `Access-Control-*` included, streamed (an event stream is passed on as it is written).
The core adds no header of its own: no CORS, no `X-Content-Type-Options`, no HSTS, no `API-Version`.

Each request uses a new connection to the sidecar (no keep-alive pool), so the sidecar's own
keep-alive timeout does not matter.

**Not supported:** WebSocket upgrades (the upgrade request is not forwarded and its connection is
closed). Streamable HTTP and server-sent events are plain responses and work.

## Per-user addresses and the addressed account

**An adapter is addressed at the account's own address, never by core or region.** The per-user
address is the platform's `service.api` template with the username filled in, followed by
`adapter/<name>/`:

```
https://alice.example.com/adapter/calendar/...     a per-user address: the account "alice" is addressed
https://reg.example.com/adapter/calendar/...       a platform address: the adapter, no account
https://core-a.example.com/adapter/calendar/...    a platform address too
https://alice.other.org/adapter/calendar/...       a platform address: not under dns.domain (example.com)
```

On a platform with per-user hosts (the DNS topology, which every platform with regions uses), DNS
already sends `alice.example.com` to alice's core; the wildcard certificate of the built-in ACME covers it. The core's
ingress then does the rest of the triage, so the sidecar needs no Host parsing, no list of
platform names, no map of cores and no region knowledge:

1. **It recognises the addressed account.** A per-user address is `<name>.<dns.domain>`: the received
   `Host` (lowercased, port and final dot aside) must be exactly one label under `dns.domain`, and that
   label is the account when it has the username shape and the platform does not answer that name
   itself: `reg`, `access`, `mfa`, the core ids, `dns.staticEntries` names, hosted sites, runtime DNS
   records and issuer labels of every core are platform addresses (the platform names the API's
   username rewriter skips too). So are a host under any other domain (a vanity name pointed at the
   core, `alice.attacker.tld`), a deeper host (`bob.alice.example.com`), `dns.domain` itself, an IP, a
   single-label host and `adapter`: this is stricter than the API's per-user hosts, whose rewriter reads
   the first label under any domain, because the sidecar puts the base in its public URLs. Without
   `dns.domain` no host is an account (the boot logs one warning). In dnsLess mode the host is never read: every request is a
   platform address (a path form, `https://<core host>/<username>/adapter/<name>/...`, is not served
   yet).
2. **It asks the platform where the account lives.** Another core: **`421`** with `Retry-After`
   (`dns.defaultTTL`, 300 s by default) and that core's URL, for every method, the sidecar not contacted, never a redirect (a cross-origin redirect drops the
   `Authorization` header, and a request body cannot safely be replayed through one). This core, or a
   name the platform does not map: forwarded (a stranger is refused by the sidecar's own
   authentication, as any request without valid credentials). A single-core platform makes no lookup.
3. **It names the account to the sidecar** with two headers, set by the core only:

| Header | Value | Example |
|---|---|---|
| `X-Adapter-Name` | the addressed name, lowercased, as addressed (a username, an alias, or a former username, which stays the account's address after a rename) | `alice` |
| `X-Adapter-Base` | the route's base as the client addressed it: the forwarded scheme (`X-Forwarded-Proto` above: this core's TLS or a trusted proxy's first value), the received `Host` lowercased with its port and without a final dot, the route's root path `/adapter/<name>/` (also on its `.well-known` prefixes) | `https://alice.example.com/adapter/calendar/` |

Both are absent on a platform address. **They are an address, not an identity:** the core
authenticates nothing on these paths, the token is the identity. What the sidecar does with them:

- its public URLs, its RFC 9728 `resource` and the links it emits are `X-Adapter-Base` + its own path;
  its audience check is `aud === X-Adapter-Base + <its resource path>` (a token issued for alice's
  address presented at bob's fails it, whatever the headers say);
- "is this request addressed to an account" is "is `X-Adapter-Name` there"; at a platform address it
  serves what needs no account (manifest, status, a sign-in entry), a platform-level resource if it has
  one, or `404`;
- it never calls `/reg/<username>/server`, never keeps a core map, never matches Host labels against
  a list of region names; after an account moves to another core its address is unchanged: on a
  `421` or a `503`, retry the same address after `Retry-After`; `coreUrl` says which core should be
  answering, it is not an address to call (`coreUrl` + the path is a platform address: no account named);
- it accepts the two headers from the core only (see "Behind nginx");
- **upgrade each core before the sidecar next to it starts reading the two headers**, core by core: a
  core of an earlier release forwards client-sent copies.

**Callers that hold a username** build the address from `/service/info`: `api` with `{username}`
filled, plus `adapter/<name>/`, or an entry of `adapters`. The core lists in `adapters` what the
operator sets in `service.adapters`, unchanged; use the `{username}` template form there:

```yaml
service:
  api: https://{username}.example.com/
  adapters:
    - https://{username}.example.com/adapter/calendar/
```

A caller that holds no username (a person pasting a platform address into an app's settings) reaches
the adapter at its platform address; the account becomes known at the OAuth consent, where an
account of another core is told to start again from its own address. An adapter may serve its own
"enter your username" page at its platform address, built from `/service/info`, as a link (never
reflecting a request value into it); the core serves none.

The 421 answer (`application/json`, `nosniff`, `no-store`, `Retry-After`, the connection closed; no CORS
header, like every answer of the core on adapter paths):

```json
{ "error": { "id": "wrong-core", "message": "adapter calendar: account \"alice\" is served by another core; retry the same address once its name resolves to that core (coreUrl identifies it)", "coreUrl": "https://core-b.example.com/" } }
```

The client retries the same URL. `coreUrl` identifies the core that should answer (for an operator,
or a check such as `curl --resolve <host>:443:<that core's IP>` that keeps the original `Host`); when
the platform has no usable URL for that core it is omitted and the message says so. The 421 names only the label
the client sent; DNS, `/reg/<username>/server` and the API's own wrong-core answer already disclose as
much for any name.

## Limits and answers of the core

| Status | When | Body (`application/json`, `nosniff`, `no-store`) |
|---|---|---|
| 400 | the path holds an encoded `/` or `\` (`%2f`, `%5c`), `%00`, a percent-encoding that is invalid or not UTF-8 (e.g. `%FF`), or an encoded dot segment; or the request's `Transfer-Encoding` is not exactly `chunked`; the connection is closed | `{ "error": { "id": "invalid-request-structure", ... } }` |
| 405 | the method is TRACE (it would echo the credentials); the connection is closed | `{ "error": { "id": "invalid-operation", ... } }` |
| 413 | the body is above `maxBodyBytes` (declared length: at once, without contacting the sidecar, and without `100 Continue` for a client that sent `Expect: 100-continue`; chunked: when it crosses the cap); the connection is closed | `{ "error": { "id": "invalid-request-structure", "message": "request body exceeds adapterRoutes.<name>.maxBodyBytes (<n> bytes)" } }` |
| 421 | the request is addressed to an account another core serves (see "Per-user addresses"), with `Retry-After`; the connection is closed | `{ "error": { "id": "wrong-core", "message": ..., "coreUrl": ... } }` |
| 500 | the request is addressed to an account and the platform cannot say where it lives (placement lookup failure): not forwarded on a guess; the connection is closed | `{ "error": { "id": "unexpected-error", "message": "adapter <name>: account placement unavailable" } }` |
| 502 | the sidecar cannot be reached (refused, reset, TLS failure) before it answered | `{ "error": { "id": "unexpected-error", "message": "adapter <name> unreachable" } }` |
| 504 | no byte moved on the sidecar connection for `idleTimeoutMs` before it answered | `{ "error": { "id": "unexpected-error", "message": "adapter <name> timed out" } }` |

After the answer has started, a failure closes the connection instead. The idle timeout has no total
counterpart: a stream lives as long as bytes move, so a sidecar that holds a stream open must send
something (an SSE comment) more often than `idleTimeoutMs`. A client that leaves ends the upstream
request. No answer names the upstream address. A client still uploading when the 413 arrives may see
its connection reset before it reads the answer (no lingering close).

Path and header fidelity: a raw non-ASCII byte in the path reaches the sidecar percent-encoded as UTF-8;
a response header the sidecar sent several times (`WWW-Authenticate`, `Link`, `Set-Cookie`) goes back
as several lines; a request header the client sent several times reaches the sidecar as one
comma-separated line.

Logs: one `debug` line per request (route, method, path without its query, status, duration), one
`warn` line per 400 / 413 / 421 / 500 / 502 / 504; never a header value or a body.

## Example: a sidecar container next to the core, no nginx

The core terminates TLS itself (built-in Let's Encrypt). The sidecar listens on the host side of the
Docker bridge, or on a network shared with the core container, and is not published to the internet:
everything reaches it through the core.

```bash
docker network create pryv
docker run -d --name calendar --network pryv <sidecar image>            # listens on 7450, no -p
docker run -d --name pryvio --network pryv -p 443:443 -p 80:80 \
  -v /host/pryv/override-config.yml:/app/config/override-config.yml:ro \
  pryvio/open-pryv.io:<version>                                          # plus the data mounts of INSTALL.md
```

```yaml
# override-config.yml (excerpt)
adapterRoutes:
  calendar:
    upstream: http://calendar:7450
    paths: ['/adapter/calendar/', '/.well-known/oauth-protected-resource/adapter/calendar/']
```

The sidecar's public base URL is then `https://<core host>/adapter/calendar/` at a platform address,
and `X-Adapter-Base` on a request addressed to an account (`https://alice.<domain>/adapter/calendar/`).
Configure the platform one in the sidecar, or derive it from `Host` / `X-Forwarded-Proto`, which the
core sets. Without a shared
network, bind the sidecar to the bridge gateway (`-p 172.17.0.1:7450:7450`) and use
`upstream: http://172.17.0.1:7450`. The sidecar is the upstream, not a proxy in front of the core:
`http.trustedProxies` does not list it.

## Behind nginx

nginx can route the same prefixes straight to the sidecar (see the `location /adapter/` blocks in
`docs/nginx-ingress-sample.conf`, with a rate limit), or leave them to `location /`: the core then
forwards them itself, keeping the `X-Forwarded-*` values of the trusted nginx. Raise nginx's
`client_max_body_size` to the route's `maxBodyBytes` if above 1 MiB.

**Routing around the core drops the per-user triage.** Behind an nginx that sends `/adapter/` straight
to the sidecar, the core never sees the request: no `421` for an account of another core, no
`X-Adapter-Name` / `X-Adapter-Base`. Choose one:
(a) let the core forward adapter paths (remove those `location` blocks; the core keeps the trusted
nginx's `X-Forwarded-*`): the per-user triage and the two headers work; or
(b) keep the bypass, and have the sidecar derive the account from `Host` itself, accepting that a
misrouted request is not caught. nginx cannot set the two headers (it does not know where the
platform serves each account), and the sidecar must never accept them from anything but the core:
with (b), have nginx clear them (`proxy_set_header X-Adapter-Name "";` and the same for
`X-Adapter-Base`).

## Troubleshooting

- **502 `adapter <name> unreachable`**: the sidecar is down, or not reachable from the core
  container (wrong network, bound to `127.0.0.1` inside its own container, firewall). From the core
  container: `curl -v http://<upstream>/adapter/<name>/`. With an `https:` upstream, its certificate
  must be valid for the upstream host name (or IP) in the system store (`NODE_EXTRA_CA_CERTS` for a
  private CA).
- **504 `adapter <name> timed out`**: the sidecar took longer than `idleTimeoutMs` to send anything.
  Raise `idleTimeoutMs`, or have long streams send keep-alive comments.
- **413**: raise `maxBodyBytes` for that route.
- **400 on a path with `%2F`**: encoded separators are refused by design; the sidecar's URLs must not
  carry them in the path (the query is free).
- **The core refuses to boot: "a user named adapter exists"**: rename that account
  (`account.changeUsername`), then restart.
- **The sidecar builds wrong public URLs**: it sees the client's `Host`; behind a proxy that rewrites
  `Host`, set `proxy_set_header Host $http_host` there (as in the nginx sample), or configure the
  public URL in the sidecar.
- **A browser app gets a CORS error**: the core adds no CORS on adapter paths; the sidecar must
  answer the preflight (`OPTIONS`) and send `Access-Control-Allow-Origin` itself. On per-user
  addresses each account is its own origin: echo the `Origin` the sidecar accepts.
- **421 `wrong-core` on a per-user address**: the request reached a core that does not serve the
  account (a resolver still holding an old DNS answer, a hosts entry, a proxy pinned to one core's
  address). The address is right: flush the resolver, drop the hosts entry or unpin the proxy, and
  retry the same URL; `coreUrl` tells the operator which core should be answering. A browser client
  sees this as a CORS or network error and cannot read the body (the core adds no CORS on adapter
  paths, and the preflight gets the same 421): it retries the same URL after a few minutes.
- **The sidecar never sees `X-Adapter-Name`**: the request was at a platform address (a service or
  core host, a host not under `dns.domain`, dnsLess, or `dns.domain` unset), or an nginx routes `/adapter/` around the core (see "Behind nginx").
