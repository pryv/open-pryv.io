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
the upstream and nothing in `/service/info`: a sidecar may start after the core.

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
- removed, never set: `Forwarded`, `X-Forwarded-Port`. Not set: `Via`, `X-Real-IP`.

**Response:** status and every header except the hop-by-hop ones, `WWW-Authenticate`, `Set-Cookie`,
`Location` and `Access-Control-*` included, streamed (an event stream is passed on as it is written).
The core adds no header of its own: no CORS, no `X-Content-Type-Options`, no HSTS, no `API-Version`.

Each request uses a new connection to the sidecar (no keep-alive pool), so the sidecar's own
keep-alive timeout does not matter.

**Not supported:** WebSocket upgrades (the upgrade request is not forwarded and its connection is
closed). Streamable HTTP and server-sent events are plain responses and work.

## Limits and answers of the core

| Status | When | Body (`application/json`, `nosniff`, `no-store`) |
|---|---|---|
| 400 | the path holds an encoded `/` or `\` (`%2f`, `%5c`), `%00`, a percent-encoding that is invalid or not UTF-8 (e.g. `%FF`), or an encoded dot segment; or the request's `Transfer-Encoding` is not exactly `chunked`; the connection is closed | `{ "error": { "id": "invalid-request-structure", ... } }` |
| 405 | the method is TRACE (it would echo the credentials); the connection is closed | `{ "error": { "id": "invalid-operation", ... } }` |
| 413 | the body is above `maxBodyBytes` (declared length: at once, without contacting the sidecar, and without `100 Continue` for a client that sent `Expect: 100-continue`; chunked: when it crosses the cap); the connection is closed | `{ "error": { "id": "invalid-request-structure", "message": "request body exceeds adapterRoutes.<name>.maxBodyBytes (<n> bytes)" } }` |
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
`warn` line per 400 / 413 / 502 / 504; never a header value or a body.

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

The sidecar's public base URL is then `https://<core host>/adapter/calendar/`. Configure it in the
sidecar, or derive it from `Host` / `X-Forwarded-Proto`, which the core sets. Without a shared
network, bind the sidecar to the bridge gateway (`-p 172.17.0.1:7450:7450`) and use
`upstream: http://172.17.0.1:7450`. The sidecar is the upstream, not a proxy in front of the core:
`http.trustedProxies` does not list it.

## Behind nginx

nginx can route the same prefixes straight to the sidecar (see the `location /adapter/` blocks in
`docs/nginx-ingress-sample.conf`, with a rate limit), or leave them to `location /`: the core then
forwards them itself, keeping the `X-Forwarded-*` values of the trusted nginx. Raise nginx's
`client_max_body_size` to the route's `maxBodyBytes` if above 1 MiB.

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
  answer the preflight (`OPTIONS`) and send `Access-Control-Allow-Origin` itself.
