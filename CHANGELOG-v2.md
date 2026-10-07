# Changelog - API Changes

## Unreleased

**Upgrade promptly: this release carries several security fixes.** Before upgrading, check that
`auth.adminAccessKey` and `auth.filesReadTokenSecret` are at least 16 characters (see the last entry);
after upgrading, run `bin/hfs-author-scrub.js` once per core (see "HF series").

### accesses.update only changes the updatable fields

- **Security.** `accesses.update` accepts only `name`, `deviceName`, `permissions`, `expireAfter`,
  `expires` and `clientData`, as its schema always documented; any other field (`type`, `token`, `id`,
  `createdBy`, `alias`...) is refused with `403 forbidden` and the access is left unchanged. Before, an
  app allowed to manage an access could change those fields too.
- **Security.** A personal access is valid only with a session opened for the same account (a username
  change keeps existing sessions working).

### Registration: the user id, password hash and initial account events are the server's

- **Security.** A registration (`POST /users`, `/reg/user`, `/reg/users`) no longer takes `id`,
  `passwordHash` or `events` from its parameters; they are ignored. Creating a user whose id already
  belongs to an account is refused, and the clean-up after a failed registration only removes what that
  registration created. Custom account fields are unchanged.

### HF series: `modifiedBy` is the writing access id

- **Security.** Writing to a high-frequency series recorded the request's authorization value as the
  series event's `modifiedBy`, so any access allowed to read the event could read it. It now records the
  access id (with the caller id when one is given), like every other write.
- **Operators:** data written by earlier releases keeps those values until cleaned. After upgrading the
  code, run once per core, before restarting it:
  `node bin/hfs-author-scrub.js --dry-run` (report), then `node bin/hfs-author-scrub.js --revoke`
  (rewrite the values to access ids, then delete the accesses concerned as `accesses.delete` does:
  sessions closed, their webhooks removed, the access index updated), then restart. Add
  `--config <your host config>` where the core uses one. With the Docker image, run it inside the
  running container once it runs the new image (`docker exec <container> node bin/hfs-author-scrub.js
  --dry-run`, then `--revoke`), then restart the container. The tool prints no credential.
- The tool rewrites live events only. Event version history (kept when versioning is on) and deleted
  events whose author `versioning.deletionMode` keeps are not rewritten: revoking the access is what
  neutralises those values, so use `--revoke`.

### HF series: the event's duration is in seconds

- **Fix.** Writing points to a high-frequency series set the series event's `duration` in nanoseconds
  instead of seconds: one second of data gave a duration of 1,000,000,000 s, so the event matched every
  later time-range query, and for many such events the stored integrity did not verify. New
  writes now set the duration in seconds. Series events written by earlier releases keep the oversized
  duration (a later write never shortens it); a repair tool for them will come in a later release.

### Event ids and attachment paths

- **Security.** A client-supplied event id must be exactly one of the accepted shapes: the
  store-prefixed form was not anchored at its end, so trailing characters passed validation. As defence
  in depth, the filesystem attachment store and the previews worker refuse any id that would resolve
  outside the account's directory.

### Boot validation refuses placeholder secrets

- **Security, BREAKING for weak configurations.** A core refuses to boot when `auth.adminAccessKey` or
  `auth.filesReadTokenSecret` is a placeholder (such as the `OVERRIDE ME` of `production-config.yml`), in
  every environment, or shorter than 16 characters when `NODE_ENV=production`. Set long random values of
  your own (e.g. `openssl rand -hex 32`). `bin/check-config.js` reports the same.

### Previews no longer decode SVG

- **Security (hardening).** Event previews are raster thumbnails, and SVG is decoded by `librsvg`, a
  large native parser that a user-supplied attachment would reach. The previews worker now blocks the
  SVG loaders: a `picture/attached` event whose attachment is an SVG file gets the same answer as any
  other format it cannot preview (`422`, `corrupted-data`) instead of a JPEG rendering; a preview of
  such a file cached by an earlier release is no longer served and ages out with the cache clean-up.
  Raster formats (JPEG, PNG, GIF, WebP, ...) are unchanged.

## 2.0.0-rc.39 - 2026-10-06

### Image previews: sharp 0.35.5

- **Security.** The image library behind event previews is updated to `sharp` 0.35.5, which bundles
  `librsvg` 2.63.2 and fixes CVE-2026-96889 (GHSA-wq5f-xc86-pv6w): a memory flaw in decoding SVG
  that can lead to code execution on glibc-based Linux. The previews worker detects an attachment's
  format from its content, so an SVG file attached to a `picture/attached` event was decoded when its
  preview was requested; any account able to create such an event could reach it. Other formats were
  not concerned. Every published Docker image before this release (Debian-based, glibc) is affected.
  No API or configuration change; update promptly.

### A server-written event field no longer overwrites a concurrent client update

- **Fix.** The fields the server writes onto an existing event (a CMC trigger's `status` and
  `failure`, the `withdrawal` on a consent record, an invite's state, the outcome recorded on a
  scope update, the enrichment of a revoke arrival, a delegation record, an email record's status,
  a series event's `duration`, an attachment added or removed) are now applied onto the event as
  stored at write time. Before, such a write was built from the copy the server had read earlier,
  so an `events.update` landing in between was overwritten with that copy. The client's own change
  survives; the server-owned field is set alongside it.

### Event types 1.1.3: `consent/accept-cmc` declares `content.features`

- The published catalogue now declares `content.features` (`chat` / `systemMessaging`, booleans or
  null) on `consent/accept-cmc`, the field the platform reads and validates; `content.extra`, which the
  platform ignores, is marked deprecated. The test fixture and the runtime seed are re-vendored. No
  behaviour change: the platform already validated the same shape.

### CMC: an accept is only taken through the capability

- **Security.** A `consent/accept-cmc` written to `:_cmc:inbox` with a relationship token (the
  back-channel a peer holds on the requester's account) is now refused with `400 invalid-operation`,
  `error.data.id: 'cmc-event-type-not-allowed'`. Before, a peer could post one naming any
  `:_cmc:apps:*` scope of the requester's account, and the `chats` / `collectors` streams for that peer
  plus a back-channel with contribute rights on them were provisioned under it: a relationship the
  account never offered. An accept reaches the requester only through the capability's responses
  stream, which is how every released version has delivered it, so no client or peer core changes. The
  server-written copy of each accept on `:_cmc:inbox` is unchanged, as are `consent/request-cmc`,
  `consent/revoke-cmc` and `consent/back-channel-cmc` deliveries. The same applies to
  `consent/refuse-cmc`, also delivered only through the responses stream: a peer can no longer mark one
  of the requester's invites refused.

### Previews cache clean-up requires the admin key

- **Security.** `POST /clean-up-cache` and `POST /{username}/clean-up-cache` on the previews worker
  ran the cache clean-up for any caller. They now require `Authorization: <auth.adminAccessKey>` and
  answer "unknown resource" otherwise. The worker's port is internal and the public port never
  routed them, so only a caller already inside the host or its network was concerned. The nightly
  clean-up is unchanged.

## 2.0.0-rc.38 - 2026-10-06

### CMC: `features.chat` decides whether a relationship gets a chat channel (#149)

- **Features resolved by the server.** A relationship's `features` (`chat`, `systemMessaging`) are
  now resolved from the offer's `content.request.features` (each one true unless set to `false`);
  the accept's `content.features` may only narrow them, and a `true` there against an offer that
  turned the feature off is ignored (no error). Each side resolves against its own copy of the
  offer (an accept that does not arrive through the capability can only narrow a relationship the
  requester already holds) and stamps the resolved pair on the `consent/accept-cmc` trigger (at completion), on both
  relationship accesses (`clientData.cmc.features`) and on the requester's inbox mirror; an
  `events.update` of the accept keeps the stored `features`. Before,
  the value came from the accept as written: an accept without `features` recorded `null`, and an
  accepter could turn chat on against the offer.
- **No chat channel without chat.** A relationship whose resolved `features.chat` is false gets no
  `<scope>:chats:<peer>` stream and no chat permission, on either side (the `<scope>:chats` parent is
  still created, so a subscription or a query on it stays valid). The back-channel's
  `counterparty.remoteChatStreamId` is null and the back-channel delivery leaves it out. The
  collectors stream is unchanged. An app writing a chat on such a relationship gets
  `unknown-referenced-resource`.
- **Inbound guard.** A counterparty writing `message/chat-cmc` directly with its relationship token
  (creating one, editing one, or updating another event's type to it) is refused with `403 forbidden`, `error.data.id: 'cmc-chat-disabled'`, when the relationship's
  `features.chat` is false; likewise `notification/alert-cmc` / `notification/ack-cmc` with
  `systemMessaging: false` (`cmc-system-messaging-disabled`). Scope requests and scope updates are
  never gated. Relationships recording no features stay permissive.
- **Relationships accepted earlier** keep their chat stream and chat permission; the inbound guard
  refuses chat writes on them when `features.chat` is false. To decide whether to offer chat, read
  `features` (on the accept event, or from `listAcceptedRelationships`), not the stream's
  existence.
- `consent/accept-cmc` `content.features` is now validated: an object with boolean `chat` /
  `systemMessaging` when present (`400`, `error.data.id: 'cmc-invalid-event-content'` otherwise).
- `@pryv/cmc` needs no update: `acceptInvite` already narrows to the offer.

### CMC: an account cannot accept its own invite (#150)

- A `consent/accept-cmc` whose offer was made by the accepting account itself (an open link opened
  while signed in as the requester) now fails with `failure.reason: 'cmc-self-accept-forbidden'`,
  before any stream or access is created. Before, the account got a relationship with itself.
- Such a self-relationship, created before this change, is a single relationship access. Deleting
  it with `accesses.delete` now records `content.withdrawal` on the accept event that created it,
  and attempts no delivery to a peer.

### Server-written event fields survive a concurrent update

- **Fix.** A field the server writes on an event (a CMC dispatch status, the consent withdrawal
  record on a `consent/accept-cmc` event, the owner's confirmation) could be lost when a client
  updated or trashed the same event at that moment: the client's write was built from the copy it
  had read just before. `events.update`, `events.delete` (trash) and `events.deleteAttachment` now
  apply the client's change onto the event as stored at write time: the fields the request changes
  win, and a field sent back with the value the request read does not overwrite a newer stored
  value. `clientData` keys merge onto the stored map as before. Nothing changes in requests or
  responses.
- **Fix (CMC).** `content.status` and `content.failure` on every CMC event type are written by the
  server only: an `events.update` keeps the stored values and ignores client-sent ones, as it
  already did for the accept event's `approvedBy`, `ownerConfirmedAt` and `withdrawal`.

## 2.0.0-rc.37 - 2026-10-06

### Trusted proxies: proxy-addr 2.0.8 (CVE-2026-90711)

- **Security.** `proxy-addr`, which resolves the client address against `http.trustedProxies`, is
  now 2.0.8. Before it, an IPv4-mapped IPv6 entry with a short prefix (for example
  `::ffff:10.0.0.0/8` instead of `::ffff:10.0.0.0/104`) matched every IPv4 client, so any client
  could choose the address recorded for it (GHSA-jqcg-44mw-7w3h). Lists in plain IPv4 notation, the
  names `loopback` / `linklocal` / `uniquelocal`, and the default `['loopback']` were not affected.
- **Boot check.** A `http.trustedProxies` list that would trust every client (for example `::/1`
  or `::ffff:0.0.0.0/96`), or a subnet that matches no client (the short mapped prefix above: on
  2.0.8 it matches nobody, so the proxy would be recorded instead of the client), now refuses the boot
  with a message naming the entry. The same check runs when a worker process applies the list.

### Data stores: removing a key-value entry on SQLite

- **Fix.** On the SQLite storage engine, a data store's per-account key-value storage refused to
  remove an entry (`set(key, null)` failed with a SQL syntax error). PostgreSQL was not affected.

## 2.0.0-rc.36 - 2026-10-05

### Consent withdrawal recorded on the person's own record (#146)

- When a cross-account consent ends, the `consent/accept-cmc` event in the person's
  `:_cmc:apps:<app>` scope now carries `content.withdrawal = { at, by, accessId, revokeEventId? }`
  (`at` in seconds), whatever ended it: `accesses.delete` on the data grant
  (`by: 'accesses.delete'`), a `consent/revoke-cmc` written by the person (`'revoke-cmc'`,
  `revokeEventId` is that trigger), a revocation by the requester (`'peer-revoke'`,
  `revokeEventId` is the inbox arrival). A delegation detach keeps its existing
  `'delegation-detach'` marker. The field is server-owned (it cannot be written, changed or erased
  through the API) and never overwritten once set; after `accesses.delete` it lands shortly after
  the delete answers, and the user's socket clients receive `eventsChanged` when it does. Apps listing a person's consents should treat an accept event with
  `withdrawal` as ended (`@pryv/cmc` 3.18.0 does by default).

### A consent revocation that did not take effect no longer reads completed

- **Fix.** When a `consent/revoke-cmc` could not delete the relationship access on the writer's
  own account (a storage error), the trigger was still stamped `status: 'completed'` while the
  access kept working. It is now stamped `failed` with `failure.reason: 'cmc-revoke-delete-failed'`
  (`failure.detail.accessIds` names the accesses still in place) and retried like other transient
  failures, without delivering the revocation again to a peer the first attempt reached;
  nothing is recorded as revoked or withdrawn until the delete succeeds. An access found
  already gone (deleted meanwhile by another path) still completes.

### `cmcInvites[].accessName` (#147)

- An invite of an authorisation request (`POST /reg/access`) may name the data grant the person
  mints by accepting it: `accessName`, 1 to 256 characters, stored as sent and echoed with the
  invite on the 201 and on the NEED_SIGNIN poll (absent when not sent). The core never uses it;
  the authentication page passes it to the accept. An older core refuses an entry carrying it with
  `400 invalid-parameters`.

### `actAsManagedOnly` (#148)

- An authorisation request (`POST /reg/access`) may require the access to be granted for an
  account the user manages: `actAsManagedOnly: true`, with `actAs: 'allow'` or a username; refused
  with `400 invalid-parameters` with `actAs: 'deny'`, without `actAs`, or when not a boolean.
  Stored and echoed on the 201 and on the NEED_SIGNIN poll only when sent and `true` (`false` is
  treated as not sent); the outcome post cannot add or clear it. The core does not enforce it, the
  authentication page does. An older core drops the field (no echo); an older page behaves per
  `actAs`.

### No `REDIRECTED` outcome for an authorisation request

- **BREAKING (security hardening).** `POST /reg/access/{key}` no longer accepts
  `status: 'REDIRECTED'` (answered `400 invalid-parameters`, like any other unknown status), a
  `redirectUrl` is no longer stored from any outcome post, and the poll never answers
  `REDIRECTED`. The status let anyone holding a request key store an unvalidated URL served to the
  authentication page under a field pages are written to follow. No shipped authentication page
  ever sent it: a request stays on the core that created it (its poll URL is that core's own) and
  a credential for an account on another core travels by the shared-secret hand-off.

### Client addresses only from trusted proxies (`http.trustedProxies`)

- **Security.** The client address recorded in the audit log (`source.ip`, on API calls,
  socket.io calls and high-frequency series) was taken from the `X-Forwarded-For` header as
  sent, so on a core exposed directly (built-in TLS) any client could choose the address
  recorded for it. It is now resolved with a trusted-proxy list, `http.trustedProxies` (IPs,
  CIDRs, or `loopback` / `linklocal` / `uniquelocal`; default `['loopback']`): the header is read
  only when the request comes from a listed proxy, from the right, and the first untrusted
  address is the client. The core's own HFS dispatcher now hands the resolved address to the HFS
  worker instead of the client's header.
- **Security (DPoP).** `X-Forwarded-Host` / `X-Forwarded-Proto`, used to rebuild the URI a DPoP
  proof must name, are read under the same rule. A client reaching the core directly can no
  longer make a proof minted for another host pass.
- **BREAKING for proxies that are not on the same host.** A proxy on another host, or one
  reaching the core over a Docker bridge (Dokku's nginx arrives from `172.17.0.1`), must be added
  to `http.trustedProxies`, or every request is recorded with the proxy's address and DPoP
  proofs naming the public host are refused. nginx on the same host and a directly exposed core
  need nothing. The list in use is in the boot log; an entry that is not an IP, a CIDR or a known
  name refuses the boot. See INSTALL.md, "Client addresses behind a proxy".
- **Fix (previews worker).** The username-in-host rewrite is decided like the API server and the
  HFS worker.

### Image previews reachable again on the public port

- **Fix.** Image previews were unreachable for clients: the previews worker listens only on its
  internal port, and nothing on the public port routed to it (unlike high-frequency series), so a
  core terminating TLS itself answered 404 to every preview. The public port now routes the
  preview URL to the worker, in-process: `{apiEndpoint}previews/events/{id}` with optional
  `.jpg` / `.jpeg`, `w` / `h` and `auth` (i.e. `/{username}/previews/events/{id}` on a dnsLess
  core, `/previews/events/{id}` on `{username}.{domain}`). The nginx sample and INSTALL.md carry
  the matching location for deployments behind nginx. The worker's `clean-up-cache` maintenance
  call is not exposed.
- Usernames `users`, `oauth2`, `previews`, `series` and `system` are reserved: they are path
  segments the core routes itself, and on a dnsLess core such a user would lose part of its own
  API to them (existing accounts are not affected).
- **Security (logs).** Request logs no longer include access tokens passed as `?auth=` (preview
  and attachment links): the request trace of the API, HFS and previews servers, the error log's
  request location, and the in-process dispatchers write `auth=***`.
- **Fix.** `GET /reg/{username}/check_username` now answers `reserved: true` for a name that
  registration refuses (reserved words, `pryv…`, hosted-site and route-segment names), not only
  for a name already taken.

## 2.0.0-rc.35 - 2026-10-05

### High-frequency series on dnsLess cores with a username-looking host name

- **Fix.** On a dnsLess core whose public host name starts with a label that looks like a
  username (5 characters or more, e.g. `api-core1.example.com`), every high-frequency series
  request through the API port (`/{username}/events/{id}/series`, `/{username}/series/batch`)
  answered `404 unknown-resource`. The HFS worker now decides whether the host carries a
  username exactly as the API server does. Other API calls were not affected.

### Account deletion on the SQLite series engine leaves no directory

- **Fix (privacy).** Deleting an account removed its high-frequency series file but left an empty
  directory named after the account's username under the users directory. The directory is now
  removed too. Directories left by earlier deletions are empty and can be removed by hand; they
  are named `user.<username>`, a few levels under `var-pryv/users/`:
  `find var-pryv/users -type d -name 'user.*' -empty -delete`.

### Clock-skew checks at core join and at TLS certificate load

- **Joining a cluster.** `bin/master.js --bootstrap` now compares the new core's clock with the
  issuing core's (its API root `meta.serverTime`, else the HTTP `Date` header) before sending the
  ack, and refuses the join when they differ by more than 30 s: the master exits 1, the join token
  is not used and the bundle file is kept, so fixing the clock and re-running the same command
  succeeds. New flag `--bootstrap-clock-skew-seconds <n>` (default 30, `0` disables). When the
  answer carries no server time the check is skipped with a log line.
- **Loading a TLS certificate.** New config key `cluster.clockSkewSeconds` (default 30, `0`
  disables). A certificate from the Let's Encrypt engine whose validity window does not contain
  the local clock (with that tolerance on `notBefore`) is not written to disk, mirrored to
  `http.ssl.*` nor hot-swapped into the workers; the core logs `refusing to materialize ...`,
  keeps the previous certificate and retries every minute. A worker asked to reload such a
  certificate keeps its current one. A custom certificate outside its window at boot is reported
  with a warning (never refused, so the worker does not crash-loop).
- **Scope.** These are checks at join and at certificate load. Clock synchronization itself
  (chronyd / ntpd) stays the host's job; there is no periodic clock polling.

## 2.0.0-rc.34 - 2026-10-02

### Attachments with an active content type are served in a sandbox

- **Security.** An attachment keeps the content type declared at upload. When that type is one a
  browser executes or renders as a document (`text/html`, `application/xhtml+xml`,
  `image/svg+xml`, `text/xml`, `application/xml`, `text/xsl`, any `*+xml`,
  `multipart/x-mixed-replace`, and the JavaScript types (`text/javascript`, `application/javascript`
  and their legacy variants); parameters and case ignored),
  `GET /{username}/events/{id}/{fileId}[/{fileName}]` (with an
  `Authorization` header or a `readToken`) now also sends
  `Content-Security-Policy: sandbox; default-src 'none'`, next to the
  `Content-Disposition: attachment` every attachment already carries. Opened on the API origin,
  such a file can no longer run scripts, load resources or reach the API with the viewer's
  session. Uploads are not refused for their type, and other types (PNG, JPEG, PDF, JSON,
  plain text, octet-stream, ...) are served as before.
- **Apps:** a browser that renders such an attachment anyway (a frame or tab pointed at the
  attachment URL, a client ignoring `Content-Disposition`) gets a sandboxed document: no script,
  no style, no image loads. To display HTML or SVG attachments, fetch the content and render it
  in the app's own sandbox. `<img src>` of an SVG attachment is not affected (an image does not
  run scripts).

### Hosted sites: HSTS behind a TLS-terminating proxy (`hostedSites.<name>.hsts`)

Hosted-site answers carried `Strict-Transport-Security` only when the request reached the core
over TLS. Behind a proxy that terminates TLS (nginx, a load balancer, Dokku) the core sees plain
HTTP, so the header was never sent although users reach the site over HTTPS.

New optional per-site key `hostedSites.<name>.hsts`, set from the configuration only (no request
header such as `X-Forwarded-Proto` is trusted):

- `auto` (default, unchanged behaviour): HSTS only when this core terminates TLS.
- `always`: HSTS on every answer. Set it when a proxy in front terminates TLS and the site is
  HTTPS-only (browsers only honour the header received over HTTPS). In dnsLess mode the site
  shares the API's host, so this applies to that whole host.
- `never`: no HSTS, even over TLS.

A `strict-transport-security` set in the site's `headers` still replaces the built-in value.

```yaml
hostedSites:
  account:
    static: /srv/pryv/sites/account
    hsts: always
```

The header value is unchanged (`max-age=31536000`, this host only). Any other value refuses the
boot.

### Platform DB: rqlite 10.5.1 (was 9.4.5)

- The image and `storages/engines/rqlite/scripts/setup` bundle rqlite 10.5.1. Under 9.x a node
  killed while taking a snapshot could later restore stale pages into its copy of the platform DB
  (keyValue index missing rows, a key stored twice); 10.x keeps that state crash-safe, checksums
  its snapshot files and stops a node on a node-local SQLite error. No change to the flags or the
  HTTP API the core uses.
- **Fix (multi-core).** After the leader core restarted, the first platform write a follower core
  forwarded to it failed once with `read protobuf length: EOF` (rqlite 9 reused a stale connection
  to the restarted leader without retrying). rqlite 10 retries on a new connection, so the write
  succeeds.
- **One-way data directory upgrade.** The first start converts the rqlite data directory and
  rebuilds the node's database from its snapshot store; rqlite 9 cannot open it afterwards, so
  rolling the image back to an older release needs the data directory restored from a backup.
  Upgrade from 2.0.0-rc.33 or later (older masters could interrupt rqlited's snapshot on stop),
  back up and check the snapshot store before the first start, and upgrade every node of a
  cluster back to back (followers first): see INSTALL.md, "Upgrading the bundled rqlite (9.x to
  10.x)".
- Keep rqlite's HTTP port (4001) closed to the outside: rqlite 10 also serves an unauthenticated
  web console there.
- Native installs: `scripts/setup` keeps an existing `bin-ext/rqlited` and warns when its
  version differs from the pinned one; replace it by hand as described there.

### Backups carry high-frequency series data

- **Fix (data loss in backups).** `bin/backup.js` backups contained no high-frequency series
  data, on every series engine, and nothing warned: backup and restore addressed each user's
  series under a different key than the one the series are stored under. Backups taken before
  this release carry no series: **take a new backup after upgrading**.
- **Fix (InfluxDB).** Series backed up from the InfluxDB series engine could not be restored
  (point times were written in a format its import refused). Series now move between any two
  series engines.
- The backup manifest's `coreVersion` now reports the core's release (it read `1.9.3`).

## 2.0.0-rc.33 - 2026-10-02

### Platform DB: the master waits for rqlited at shutdown; periodic integrity check

- **Fix (data integrity).** At shutdown the master could exit before its embedded rqlited had
  finished the snapshot it writes on close, and rqlited's output went to pipes the master read, so
  the master's exit killed it mid-snapshot. With rqlite 9.x an interrupted snapshot can be restored
  at the next boot and corrupt the node's copy of the platform DB (keyValue index missing rows, a
  key stored twice). The master now stops the workers, then rqlited, and exits only once rqlited
  has exited. rqlited writes to the master's own stdout/stderr (or to
  `storages.engines.rqlite.logFile` when set), so its output no longer depends on the master.
- **Give the master at least 30 s to stop** (systemd `TimeoutStopSec`, Docker `docker stop -t 30`
  / compose `stop_grace_period: 30s`; Dokku's default is 30 s). The sequence is bounded at 28 s.
- **Upgrading from rc.32 or older:** the running (old) master still has the bug when it is stopped
  for the upgrade. Stop rqlited first (`kill -TERM` on the rqlited child, wait for
  `rqlited exited (code=0` in the master's log), then restart. After any restart, check each node
  with a `level=none` read (INSTALL.md, "Platform DB integrity").
- **Periodic check.** The master re-runs the platform DB integrity check every
  `storages.platform.integrityCheckIntervalMs` (default 1 h, `0` disables) and logs an ERROR at
  every failed check, INFO when it passes again. Repair: INSTALL.md, "Platform DB integrity".

### `bin/integrity-check.js`: `--config <file>`, readable failure without rqlited

- The tool now accepts `--config <file>` and layers that file on top of the default config, as the
  core does. A core started with a host-config file (a multi-core joiner, for instance) can now be
  checked with its own PG host, storage paths and rqlite URL:
  `node bin/integrity-check.js --platform --config <file>`. It used to refuse the argument
  (`Unknown argument: --config`).
- When the platform DB cannot be reached (e.g. in a one-off container where no rqlited runs), the
  tool exits `1` with `Platform DB unreachable at <url>: is rqlited running for this core?`
  instead of a bare `Error: fetch failed`.
- `--help` prints the tool's own usage again (it printed a generic options list); `-h` was not
  affected.
- `bin/integrity-check.js`, `bin/cmc-scrub-credentials.js` and `bin/reconcile-user-cores.js` now
  exit `1` with `--config: file not found` when the `--config` file is missing or not given. They
  used to ignore it silently and run against the default config, i.e. possibly another storage
  than the core's.

### `config/production-config.yml`: reset, verification and SSO landing pages on the account app

`auth.passwordResetPageURL` and `auth.emailVerificationPageURL` pointed at the old app-web-auth3
pages (`https://sw.pryv.me/access/reset-password.html`, `.../verify-email.html`), which answer 404:
password-reset and email-verification emails sent users to a dead page. They now default to
`https://account.pryv.me/reset-password` and `https://account.pryv.me/verify-email` (the commented
`sso.landingPageURL` example to `/sso-signin`), pages of app-web-user-account that read the same
link parameters. A platform that sets these keys in its own config is unaffected; one that relied
on the shipped values should set them to its own account app.

The password-reset link also keeps a query the page URL already carries (e.g.
`?pryvServiceInfoUrl=…` for an account app serving several platforms): the token is appended with
`&` there, as the email-verification link already did, instead of a second `?` that folded it into
the operator's parameter. The `bin/init.js` config appendix's SSO example now points at the account
app URL given to the wizard.

## 2.0.0-rc.32 - 2026-10-01

### Consent invites inside the authorisation request (`cmcInvites`)

An app can ask the user, in the same authorisation request (`POST /reg/access`), to also answer
cross-account messaging invites it received: `cmcInvites: [{ capabilityUrl, mandatory?, for? }]`,
1 to 8 entries, each `capabilityUrl` an absolute http(s) URL of at most 2048 characters,
`mandatory` a boolean (default `false`), `for` `'self'` (default) or `'target'` (an account the
user manages through account delegation, when the access is granted for it). A malformed list is refused
`400 invalid-parameters`. The request's size ceiling (`access:maxRequestBytes`) still applies.

- **Detection:** the 201 answer echoes the normalised `cmcInvites` (with `mandatory` and `for`
  filled in) only when the core understood them; an older core drops the field. The NEED_SIGNIN
  poll carries the same list for the auth page.
- **Outcomes:** the auth page posts, with `status: 'ACCEPTED'`, one outcome per invite in the
  request's order: `{ acceptEventId, dataGrantAccessId?, acceptedFor?: 'self' }`,
  `{ declined: true }` or `{ reason }`. A list of the wrong length or shape, or one sent with
  another status or on a request without invites, is refused `400` before anything is written.
  The ACCEPTED bodies (POST answer and polls, inline or hand-off) carry it as `cmcInvites`.
- **A hint, not a proof:** the outcomes are what the page reports; the requester learns the truth
  from its own inbox (`consent/accept-cmc`). `mandatory` is enforced by the auth page: a declined
  mandatory invite ends the request `REFUSED` with `reasonId: 'REFUSED_MANDATORY_CONSENT'`, and a
  mandatory invite that could not be accepted with `reasonId: 'MANDATORY_CONSENT_FAILED'` (its
  `message` names the invite and the platform's error id). The core stores both as given.
- The capability URLs stay in the request, which lives in this core's memory only (at most one
  hour, and 120 s after its outcome is first read) and is readable by whoever holds the poll key,
  as the rest of the request is.

## 2.0.0-rc.31 - 2026-10-01

### Platform DB integrity: checked at every boot and by `bin/integrity-check.js`

A corrupted primary-key index on the platform DB raises no error by itself: upserts then store a
key twice and lookups miss rows (user-to-core mappings, unique-field reservations, DNS records).
Each core now checks its own copy, read-only: once at boot (an `ERROR` naming the duplicated keys,
the boot continues) and on demand with `node bin/integrity-check.js --platform` (exit code `1` on
failure, `--json` for the report). A run of `bin/integrity-check.js` without `--user` also checks
the platform DB after the users; its `--json` output is unchanged (a platform failure is reported
on stderr and in the exit code). With rqlite the check runs `PRAGMA integrity_check` and a
duplicate-key scan that bypasses the index; with PostgreSQL the duplicate-key scan only. INSTALL.md
§ "Platform DB integrity" gives the repair (a table rebuild).

### Hosted sites: a proxy upstream's Content-Security-Policy and Permissions-Policy are kept

A proxied hosted site used to lose its upstream's `Content-Security-Policy` and
`Permissions-Policy` (the response allow-list did not include them), so it ran with only the
anti-framing policy. The upstream CSP is now sent as a further policy after the site's own
(anti-framing, then the operator's `headers` CSP if any): browsers enforce every policy, so it
can tighten but never relax framing. The upstream `Permissions-Policy` is kept unless the
site's `headers` set one. Static sites are unchanged.

### Embedded DNS: `dns.ip6: '::'` next to `dns.ip: 0.0.0.0` now binds on Linux

The IPv6 UDP socket of the embedded DNS server was dual-stack, so with `dns.ip6: '::'` and
`dns.ip: 0.0.0.0` on the same port the boot failed on Linux with `EADDRINUSE`. It is now
IPv6-only, like the IPv6 TCP listener already was.

### Removing a delegate: the account owner reviews the consents the delegate gave

`delegations.detachDelegate` takes an optional `keepAccessIds`: the consent grants (cross-account
messaging data grants) the delegate gave for the account that the account owner keeps. Over HTTP,
`DELETE /delegations/delegates/<username>?keepAccessIds=<id>&keepAccessIds=<id>`; in a batch call,
an array param. Nothing is kept by default.

- **Every id must be a consent grant given through the relationship being removed** (an access of
  the account carrying `clientData.cmc.role === 'counterparty'` and the delegation lineage of this
  relationship). Otherwise the whole call is refused before anything is written: `400`,
  `delegation-invalid-keep-list` (`error.data.accessId` names the first id refused). A keep list
  that is not an array of ids is refused the same way.
- **A kept grant** loses its delegation lineage (`clientData.delegation` is removed): it is then
  the account owner's own consent, `access-info` with its token no longer reports a delegation,
  and the requester is told nothing. Its accept event (`consent/accept-cmc`) records
  `content.ownerConfirmedAt` (the detach time, seconds); `approvedBy` stays as history.
- **A grant not kept** is deleted and its requester receives `consent/revoke-cmc`, as before. Its
  accept event now records `content.withdrawal = { at, by: 'delegation-detach', relId }`, so every
  consent a delegate gave carries its end on the managed account.
- **`ownerConfirmedAt` and `withdrawal` are server-owned like `approvedBy`**: a client-supplied
  value is dropped on create, by any token, and an update keeps the stored value.

The other accesses granted through the delegation are deleted as before, whatever the keep list.

### Fixed: high-frequency series answer 400 to a malformed JSON body

A request to the high-frequency series endpoints whose JSON body cannot be parsed (or is too large)
is now answered `400` with `invalid-request-structure`, like every other API answer, instead of a
`500` whose error id was the parser's message.

## 2.0.0-rc.30 - 2026-10-01

### Security: `X-Content-Type-Options: nosniff` on every API answer; the OAuth2 error page refuses framing

Every answer of the API (high-frequency series, previews and the Socket.IO HTTP transport
included) now carries `X-Content-Type-Options: nosniff`, errors and `OPTIONS` included, so a
browser never second-guesses the declared content type. Attachments are served with the content
type the client declared when uploading them: with `nosniff` a browser no longer guesses a type
instead (an attachment uploaded as `text/plain` is not rendered as an image cross-origin), so
clients should declare the right type at upload. The HTML error page of
`GET /oauth2/authorize` (missing `client_id` or `redirect_uri`, unknown client, unregistered `redirect_uri`) also carries
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`
and `Referrer-Policy: no-referrer`: a page of the authorization server is never framed, loads
nothing and never leaks its URL as a referrer.

Hosted sites, dnsLess topology: the `/<name>` → `/<name>/` redirect now carries the same headers
as every other answer of the site (`nosniff`, `Referrer-Policy`, HSTS over TLS and the
operator's `headers`), not only the anti-framing ones.

### A delegate may accept a consent for the account it manages

A carer who manages an account through account delegation (a parent for a child) can now give
the consent a cross-account messaging request asks for, with the delegate token: writing
`consent/accept-cmc` with the delegate token is no longer refused (an app or shared access the
delegate granted stays refused by the personal-token rule, as for any app).
Publishing an offer (`consent/request-cmc`) and widening a grant (`consent/scope-update-cmc`)
stay reserved to the account owner (`400`, `delegation-grant-requires-owner`), as does the
OAuth2 consent.

- **The data grant carries the delegation lineage.** The grant minted for such an accept carries
  `clientData.delegation = { kind: 'delegated-child', relId, delegate, viaAccessId }`, taken from
  the authenticated access (never from the request), like an access the delegate creates with
  `accesses.create`. `access-info` with the grant's token reports
  `delegation: { isDelegatedAccess: true, controlledUsername, delegate, grantedVia: 'app' }`, so
  the requester can tell a consent was given by a delegate.
- **The accept event records who approved.** It carries
  `content.approvedBy = { delegate: { username, hostSlug }, relId }` (`hostSlug` when known),
  stamped by the server when the event is written. A client-supplied `approvedBy` is dropped on
  create, by any token, and an update keeps the stored value. An accept the account owner writes
  has no `approvedBy`.
- **An accept in progress when the delegation ends does not complete.** The relationship is
  checked when the accept is processed and again once the grant exists: if the delegation was
  detached in between, no grant is left and the accept fails with
  `cmc-handler-delegation-ended` (not retried).
- **Detach withdraws those consents and tells the requester.** `delegations.detachDelegate`
  deletes the consent grants given through the relationship together with the other accesses
  granted through it (synchronously, before it answers), and each requester then receives
  `consent/revoke-cmc` in its inbox, as for a consent withdrawn with `accesses.delete`, instead
  of meeting a dead token. Delivery is best-effort and never holds the detach. The requester may
  invite again and the account owner may accept.

## 2.0.0-rc.29 - 2026-09-30

Security update of runtime dependencies (8 high and 3 moderate advisories cleared, including
nodemailer SMTP credential disclosure across transports); the install wizard, the
`bin/check-config.js` hint and the cmc implementers' guide point at the reference account app
on its own origin, `https://account.pryv.me` (see `CHANGELOG-v2-back.md`).

### Security: hosted sites refuse to be framed (clickjacking)

Hosted-site answers carried no framing policy, so any page could frame a hosted site (e.g. an
account app's consent page) and trick a click. Every hosted-site answer, whatever its status
(including 404, 405, 5xx and the redirects), now carries
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.

New optional per-site key `hostedSites.<name>.frameAncestors`, a non-empty list of CSP source
expressions allowed to frame the site:

```yaml
hostedSites:
  account:
    static: /srv/pryv/sites/account
    frameAncestors: ["'self'", "https://app.example.com"]
```

The answers then carry `frame-ancestors 'self' https://app.example.com`; `X-Frame-Options` is
`SAMEORIGIN` for `["'self'"]` alone and omitted for any other list (it cannot express one).
Entries with spaces, `;` or `,`, an empty list, an unquoted `self` / `none`, or `'none'` next to
other entries (browsers would ignore it and allow the others) refuse the boot; keywords are
case-insensitive.

- **BREAKING (hosted sites that are framed on purpose).** A site framed by another page (an
  embedded dashboard, say) is refused by browsers after the upgrade until its entry lists the
  framing pages in `frameAncestors`.
- **BREAKING (config).** `x-frame-options` in a site's `headers` refuses the boot: framing is set
  with `frameAncestors`, since browsers follow the CSP `frame-ancestors` it sends. A
  `content-security-policy` in the site's `headers` is now sent as a second policy next to the
  anti-framing one (browsers enforce both); it can no longer be used to allow framing.

## 2.0.0-rc.28 — 2026-09-29

### Hosted sites: serve a static folder or proxy a fixed upstream under a reserved name

New config key `hostedSites` (default `{}`: nothing changes). Each entry turns a platform
name into a web site instead of a user account:

```yaml
hostedSites:
  account:
    static: /srv/pryv/sites/account         # a folder holding index.html
  docs:
    proxy: https://example.github.io/docs/  # a fixed upstream
    headers: { content-security-policy: "default-src 'self'" }
```

- **Where it answers.** DNS topology (`dns.domain` set, dnsLess off): on
  `<name>.<dns.domain>`, its own origin. dnsLess: under `<dnsLess.publicUrl>/<name>/`
  (`/<name>` redirects there), which is the **same origin as the API**, not a separate one;
  bundles must be built for that base. Without `dns.domain` and without dnsLess the boot is
  refused.
- **Static**: GitHub Pages-like (`index.html`, `.html` fallback, `404.html` with status 404,
  ETag / 304, Range, HEAD); dotfiles and anything outside the folder answer 404.
- **Proxy**: GET and HEAD only, request and response headers by allow-list (no cookies,
  `Authorization` or client address upstream; no `set-cookie` back), redirects inside the
  upstream rewritten to the site, 502 / 504 on upstream failure or silence. An `http://`
  upstream warns at boot; an upstream on the platform's own domain is refused.
- Every site answer carries `nosniff`, a referrer policy, HSTS (this host only) over TLS and
  the entry's `headers`; never the API's CORS or `api-version` headers.
- **Reserved usernames.** A site name is refused at registration (`409 item-already-exists`)
  and by the change-username method (`400 invalid-operation`) on every core, including a
  name that only another core serves.
- **Boot refusals (new).** A core does not start when a `static` folder is missing or has no
  `index.html`, when an existing user holds a site name (rename the user or pick another
  name), when a site name is the id of any core of the platform, or when a name clashes
  with `reg`, `access`, `mfa`, `lsc` or a `dns.staticEntries` key. `bin/check-config.js`
  reports the shape problems. In dnsLess, API root segments (`reg`, `system`, `www`,
  `auth`, `users`, `oauth2`, `service`, `apps`) are refused as site names.
- **Embedded DNS.** `<name>.<dns.domain>` answers the A / AAAA of the cores that serve the
  site, ahead of `dns.staticEntries` and usernames; a runtime DNS record with that name is
  shadowed (with a warning).
- Known limitation: `/socket.io/` on a site host is still answered by the API's Socket.IO.

## 2.0.0-rc.27 — 2026-09-28

### Embedded DNS: TCP/53 and RFC-conformant answers (operator action: open TCP/53)

When `dns.active: true`, the embedded DNS server now also listens on **TCP** on `dns.port`
/ `dns.ip` (and `dns.ip6` when set), as RFC 7766 requires. **Allow TCP 53 inbound** next to
UDP 53 in the host firewall / cloud security group, and publish it in Docker
(`-p 53:53/udp -p 53:53/tcp`; the image now `EXPOSE`s `53/tcp`). No new config key.

- Negative answers (NXDOMAIN, and NOERROR with no data such as `CAA` on a name without CAA
  records) now carry the apex SOA from `dns.records.root.soa` in the AUTHORITY section,
  with the negative TTL `min(dns.defaultTTL, soa.minimum)` (RFC 2308). Resolvers such as
  Unbound 1.18+ (used by Let's Encrypt and Quad9) discarded the previous SOA-less answers,
  which made Let's Encrypt's CAA check fail (SERVFAIL) for every name of the domain.
- Answers set the AA (authoritative) flag and no longer echo the query's AD/CD bits.
- Queries for names outside `dns.domain` are answered **REFUSED** instead of NXDOMAIN
  (monitoring that expected NXDOMAIN from these servers sees a different rcode). A name
  that merely ends with the domain string (e.g. `notexample.com` for `example.com`) is now
  out of zone.
- A bind failure (port taken, missing `cap_net_bind_service`) now stops the boot with
  `DNS server failed to bind …` instead of hanging silently. A deployment where another
  process holds TCP 53 now fails at boot: free the port first.

### Profile: MFA state stays out of the profile methods (security)

The private profile's `mfa` (the MFA enrolment) and `mfaThrottle` (the failed-attempt
tally) are managed by the MFA methods only: `PUT /profile/private` refuses them with
`400 invalid-operation` (writing nothing). `GET /profile/private` shows the enrolment
without its secrets, `mfa: { method, content, totp: { confirmedAt, algorithm, digits,
periodSeconds } }` (`content` is the account holder's own data, e.g. the phone an SMS
method texts), and never shows `mfaThrottle`. Data exports built on that read (such as
the subject account backup) therefore keep the subject's MFA data but no longer carry the
encrypted TOTP secret, the replay step or the recovery-code hashes. The admin MFA reset (`DELETE /system/users/:username/mfa`) now always targets the
private profile; on SQLite it could previously hit another profile of the user and leave
the enrolment in place.
Separately, the app profile of `/profile/app` is keyed by the access name, so an app access
named `private` or `public` could read and write the user's private or public profile; such
names now have no app profile (`400 invalid-operation`).

### MFA: the per-account limit is a backoff, not a lockout (security)

Replaces the per-account lockout introduced in 2.0.0-rc.16 ("MFA: per-account
failed-attempt limit"). That lockout let anyone holding a user's password lock the
user's second factor for `lockoutSeconds`, renewable indefinitely. Failures still accrue
per account across logins, but past `services.mfa.attempts.backoff.freeFailures` (default
3) failures within `perAccountWindowSeconds`, each further failure only delays the NEXT
attempt: `baseSeconds` (default 2), doubling up to `maxSeconds` (default 300). The real
user therefore waits at most `maxSeconds` even while under attack, and a successful
second factor clears the tally. The `attempts` block is platform-wide policy: set the same
values on every core.

- During a delay, `mfa.verify`, `mfa.confirm` and `mfa.challenge` answer `429
  too-many-attempts` with a `Retry-After` header and `error.data.retryAfterSeconds` (for
  browsers that cannot read the header cross-origin); a code sent during the delay is
  neither checked nor counted.
- The failing guess itself is answered as before (`400`, or `401` when the per-session
  ceiling invalidates the session); only the following attempt is delayed.
- `services.mfa.attempts.perAccount` and `services.mfa.attempts.lockoutSeconds` are no
  longer read (a boot warning names them when present). `backoff.maxSeconds: 0` disables
  the per-account backoff. A tally stored by the former lockout is carried over and its
  lock is not honoured.
- `mfa.recover` stays exempt, and still clears the tally.

### MFA: a TOTP code is consumed atomically (security)

The replay guard now consumes the accepted time step with one conditional storage write
(the enrolment is unchanged and the stored step is still below the accepted one). Two
verifications of the same code arriving at the same time, on different sessions or
different API workers, release exactly one token; the other is answered like a wrong code.
A code for an earlier step inside the drift window is refused once a later step was used.

### MFA settings are checked at boot

`services.mfa` settings that cannot work now refuse the boot with a message naming the key,
instead of failing each request: an unknown `mode`; a `defaultMethod` that is not an active
method set explicitly; a `methods.totp.secretsKey` that is not the base64 of 32 bytes;
TOTP `digits` outside 6-8, `periodSeconds` outside 1-3600 or `driftSteps` outside 0-10;
an active SMS method with an unknown mode or without the endpoint urls its mode needs;
`sessions.ttlSeconds` below 1. Boot warnings, which never refuse the boot: removed or
invalid `attempts` values, backoff settings that silently weaken it (`baseSeconds: 0`, or
`maxSeconds` above `perAccountWindowSeconds`), an unset `defaultMethod` whose implicit
`totp` is inactive, and a legacy SMS-only `mode` in effect. `bin/check-config.js` runs the same
check on an override file (merged over the shipped defaults).

### New accounts get the CMC reserved streams at creation

The reserved `:_cmc:` stream tree (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps` and the
plugin-internal subtree) is now created together with the account, so a new account's
first `streams.get` (with a personal token, or an access whose permissions cover those
streams) already lists `:_cmc:`, `:_cmc:inbox` and `:_cmc:apps`. Until now the
tree appeared only on the first CMC read, write or access grant. Accounts created before
this change, or whose creation-time attempt failed (it never fails the registration), are
still provisioned on first touch as before. Clients that snapshot a fresh account's stream
list will see these three streams.

## 2.0.0-rc.26 — 2026-09-24

_(2.0.0-rc.25 carries the same changes but published no image: its build could not run the lib-js conformance suite, because backloop.dev stopped issuing certificates without a secret. Use rc.26.)_

### CMC accept and back-channel records no longer carry access tokens (security)

Accepting an invite writes a `consent/accept-cmc` event into the accepter's own
`:_cmc:apps:<app-code>` stream. That event stored two working credentials: the data-grant
endpoint under `acceptedBy.apiEndpoint`, which is a token to the accepter's own data, and
the invite URL under `capabilityUrl`. Both are now stored with the token removed, so what
remains names the endpoint and opens nothing. The refuse record is stripped the same way.

This mattered because an app can hold `read` on that stream, typically the requesting
app's own, and because an export of the account includes it: a "download my data" file
meant to be shareable handed a live credential to whoever received it.

The record keeps what it is read for. `dataGrantAccessId` still names which access was
granted and `content.from` still names the counterparty, which is what
`listAcceptedRelationships` reads. An app that treated `acceptedBy.apiEndpoint` as a
usable connection now receives a URL without a token and must use `dataGrantAccessId`
instead. A record left by a FAILED accept is stripped the same way, which matters because
a failed single-use accept leaves the invite unconsumed and therefore still live; the
retry queue is unaffected, since it re-dispatches from its own copy in a stream no API
read path reaches. Nothing else in the handshake changes: the endpoint delivered to the
requester, which is what makes the grant usable at all, is untouched.

The same applies to the **back-channel record**, in the other direction. After an accept,
the requester delivers a `consent/back-channel-cmc` event into the accepter's
`:_cmc:inbox` whose `apiEndpoint` is the requester's own back-channel endpoint. That is a
credential to the *requester's* account sitting in the *accepter's*, and `:_cmc:inbox` is
a stream apps poll by design and every export carries. Its token is now removed once the
delivery has been handled. Nothing depends on the event's copy: the handler writes the
endpoint to the data-grant access's `clientData` first, and that is what the chat, system
and revoke paths read.

`grantedAccess.apiEndpoint`, on the accept event delivered to the requester, is
deliberately NOT stripped: `cmc.waitForAccept()` returns it and apps open a connection
with it, which is the documented handshake.

**The token is now removed before the record is stored, not after.** Previously the row
was written exactly as sent and a later status update scrubbed it, so between the two the
stored record held a live credential, and the change notification that `events.create`
emits pointed subscribers at it in precisely that window. An `events.create` for
`consent/accept-cmc`, `consent/refuse-cmc` or `consent/back-channel-cmc` now strips the
credential before the event is persisted, so the store never holds it at all. The change
notification that `events.create` emits carries the event's content, not just a pointer to
it, so that payload no longer carries the token either. Two consequences for apps: the
`201` response echoes the record as stored, which means a token-less `capabilityUrl` (or
`apiEndpoint` on a back-channel record), and reading the event back at any moment, however
soon, shows the same. An app that relied on reading its own invite token back out of the
create response must keep the value it posted. `consent/request-cmc` is unaffected: its
`capabilityUrl` is the invite the app hands out.

A back-channel delivery failure also stopped writing the peer's endpoint to the
operator's log with its token attached.

A core running with `versioning.forceKeepHistory` also stopped archiving the trigger's
intermediate statuses. A version row snapshots the content as it was before an update, so
with history on, the stamp that removes the token would have preserved it in a row that
`events.getOne?includeHistory=true` still reaches. These stamps are the plugin's own
bookkeeping rather than user edits, so they no longer produce history rows at all; the
trigger's final state is unaffected.

Events written before this change keep the tokens already stored in them.
`bin/cmc-scrub-credentials.js` rewrites those older records in place: run it once per
core, `--dry-run` first. It covers settled records, completed and failed, including
trashed ones, and leaves a record that is still mid-flight alone, reporting it so a later
run can sweep it. A core that was running with `versioning.forceKeepHistory` may also hold a
credential in an older record's version history, which no supported write path can
rewrite; the tool names those records rather than appear to clean them. Revoking a
relationship invalidates the grant its token belongs to.

## 2.0.0-rc.24 — 2026-09-22

### Ceilings on the access requests a core holds at once (security)

`POST /reg/access` needs no credentials, and each request it creates is held in the core's
memory for up to an hour, so a flood of calls could grow that process until it died. Two
ceilings now bound it:

- `access.maxLiveRequests` (default 10000, `0` disables): how many pending requests one
  core holds. Over it the core answers `429 too-many-requests` with a `Retry-After` header;
  the message names neither the ceiling nor how close the caller got. The count and the
  write happen in one step, so concurrent calls cannot slip past it together.
- `access.maxRequestBytes` (default 16384, `0` disables): the stored size of a single
  request, which is what makes the first ceiling a real memory bound (the fields an app
  sends are stored as sent, under a body limit measured in megabytes). Over it the core
  answers `413 payload-too-large`. A request carrying permissions and a consent form is a
  few KB, so the default leaves a wide margin. The ceiling applies to **every** write of a
  request, including `POST /reg/access/{key}`, which rewrites the same entry and takes no
  credentials beyond the key; an over-large outcome post is refused and the stored request
  is left untouched. That post's text fields (`username`, `token`, `apiEndpoint`,
  `reasonId`, `message`, `redirectUrl`) must now be strings, else `400 invalid-parameters`.

Both counts are per core, like the requests themselves, and expired or decided requests
stop counting once their window passes. This is a last line of defence: configure a rate
limit for `/reg/access` in the reverse proxy in front of the core as well.

### Third-party sign-in keeps the app's return context

`GET /auth/sso/:provider/start` accepts an optional `ssoReturn` query parameter: an opaque
string of at most 2048 characters in the form-urlencoded alphabet that the auth app uses to
remember where the user came from (its own `returnURL`, `state`, `requestingAppId`, `next`).
The core stores it in the signed state cookie and, once that cookie has verified at the
callback, hands it back unchanged as `ssoReturn` on the landing page's URL fragment, on every
outcome (`login`, `mfa`, error). The core never interprets it and still redirects only to
`sso.landingPageURL`; a value that is too long or malformed is refused with `400`.

A start without `ssoReturn` behaves exactly as before, and a landing page that does not know
the key ignores it. Before this, an app that sent a user through third-party sign-in got no
completion redirect back: the query it started from was dropped at the first hop, so the user
landed on the account profile instead of wherever the app had sent them.

### An OAuth client can be registered under an opaque `client_id`

`client_id` was always the app account's username, and that id is a key in the
replicated platform store (the client record, its revocation tombstone, the DPoP keys
seen) as well as travelling in URLs and in the name of the access a grant mints. On a
deployment that keeps usernames out of the platform store, the username went in anyway.

`bin/oauth-client.js create <username>` now takes `--client-id <opaque-id>` (4 to 64
characters of `A-Z a-z 0-9 . ~ -`; `_` is excluded because the store scans keys with SQL
`LIKE`, where it is a wildcard). An id already registered, or one that is an account name
on the platform, is refused. The record still points at the account, by user id, and
`client_name` then defaults to the id rather than the username.

Two things still name the account unless the operator acts: `client_name` (pass `--name`)
and the capability URL of a `cmc:` offer, which is built from the publishing account's
API endpoint and is needed by every authorization-code client.

Nothing changes for existing clients: without the flag the `client_id` is the username as
before, and `create` now says so on stdout. `client_id` cannot be changed on an existing
record (`update` refuses the flag), so moving an app to an opaque id means revoking and
re-creating it: live tokens and refresh chains die and users re-run the authorization
flow, while their consent records survive (keyed by the offer, not by the client).

## 2.0.0-rc.23 — 2026-09-18

### Managed shared accesses no longer outlive their managing app access (security)

The expiry chain (a `shared` access managed by an `app` access cannot expire later
than that app access) treated a shared access without expiry as within the limit, so a
shared token could outlive the app access that issued it.

- **BREAKING (`accesses.update`).** Clearing the expiry of a managed shared access
  (`expires: null`) while its managing app access expires is refused
  (`400 invalid-operation`, `data.requestedExpires: null`, `data.parentExpires`). Giving an
  app access an expiry (or a shorter one) while a shared access it manages has none is
  refused with `data.offendingChildren`, like a child that expires later: set an expiry
  on each listed shared access (or delete it), then retry.
- **Change (`accesses.create`).** A shared access created by an expiring app access
  without `expireAfter` now takes the app access's `expires` (it used to never expire).
  The response carries the resolved value.
- **Security (authentication).** A shared access without expiry whose managing app
  access has expired is refused with `403 Access has expired.`, which also covers shared
  accesses created before this change.
- **Security (webhooks).** A webhook no longer fires once its access has expired (or,
  for a shared access without expiry, once its managing app access has expired): it
  becomes `inactive`, as it already did when its access was deleted. An access still
  held in the server's cache was not checked at all before. Once the access is valid
  again, reactivate the webhook with `webhooks.update` (`state: 'active'`) from the same
  access or a personal token.

### Account delegation: granting an app access for a controlled account

A delegate (a parent, a caregiver) can now grant an app access on an account it
controls, the way the account owner grants one: an auth page authenticated with the
delegate token creates the app access on the controlled account and posts it back.

- **New (`accessInfo.delegation.grantedVia`).** An access created through
  `accesses.create` while authenticated by a delegate token carries a server-set
  lineage marker, and
  `access-info` reports it as
  `delegation: { isDelegatedAccess: true, controlledUsername, delegate, grantedVia: 'app' }`.
  The same applies to the shared accesses such an app creates. The audit records of
  their actions on the controlled account name the delegate (`content.delegation`),
  as for the delegate token itself. The marker cannot be set, changed or removed by
  any client, and it is kept across `accesses.update`.
- **New (`/reg/access` `actAs`).** `POST /reg/access` accepts an optional
  `actAs`: `'allow'` (the auth page may offer the accounts the user controls),
  `'deny'` (the signed-in account only) or a username to preselect. Any other value
  is a `400 invalid-parameters`. It is echoed on the `NEED_SIGNIN` poll only when
  sent.
- **New (`/reg/access` `delegation`).** An auth page that granted the access on a
  controlled account posts `delegation: { isDelegatedAccess: true,
  controlledUsername, delegate: { username, hostSlug? } }` with `ACCEPTED`;
  `controlledUsername` must equal `username`, unknown keys and non-`ACCEPTED`
  statuses are refused with `400`, and the request stays pending. It is echoed on
  the `ACCEPTED` poll and on the POST response. It is a display hint:
  `accessInfo().delegation` on the token is authoritative. Bodies without it are
  unchanged.
- **Changed (`accesses.checkApp`).** The lineage marker is not compared as app
  data, so such an access matches a later request exactly as the owner's own grant
  would. Consequence: if the account owner later signs in to the same app on the
  same device, the access the delegate granted is reused, and it ends with the
  delegation.
- **Changed, security: OAuth2 consent and CMC data grants require the account
  owner.** Those grants are written outside `accesses.create` and carry no lineage
  marker, so a delegate could create grants that outlive the delegation. A delegate
  token, or an access it granted, is now refused: `POST /oauth2/authorize/accept`
  answers `403 access_denied`, and writing `consent/accept-cmc`,
  `consent/scope-update-cmc` or `consent/request-cmc` (publishing an offer, whose
  capability and back-channel accesses are written the same way) answers `400`
  with `delegation-grant-requires-owner`.
- **Changed, BREAKING for apps granted through a delegation: detach revokes them.**
  `delegations.detachDelegate` now also deletes every access carrying the lineage
  marker (the accesses created through `accesses.create` with the delegate token,
  and what those apps created). An app that relied on keeping such an
  access after the delegation ended loses it; the account owner can grant it again.
  Accesses the account owner granted are untouched. Such accesses can otherwise be
  updated or revoked by the account owner or the delegate, and revoked by the app
  itself (no access can update itself).

### `bin/oauth-client.js create` runs on the app account's home core

The OAuth client record now stores the app account's user id instead of its username,
so `create <username>` must run on the core that hosts the account; on a multi-core
platform it refuses elsewhere and names the hosting core (it used to answer "user not
found"). `show` prints the stored `accountUserId` plus the account username resolved on
the core it runs on; `update` converts a record written by an earlier version when the
account is local. `/oauth2/token` wire shapes are unchanged. The CLI also no longer
claims that re-registering a revoked client id clears the revocation (it does not: tokens
minted before the revoke stay dead).

### Credential hand-off: one-time shared-secret delivery for `/reg/access`

An app can ask that its access token be delivered through a one-time shared secret
instead of being returned in the authorization poll, so the token never lingers in the
poll response (or in the logs of the core that answered the authorization request) and
a theft becomes detectable (the legitimate retrieve fails loudly).

- **New (`/reg/access` `credentialHandoff`).** `POST /reg/access` accepts an optional
  `credentialHandoff: 'shared-secret'`. Any other value is a `400 invalid-parameters`.
  It is echoed on the `201` and on the `NEED_SIGNIN` poll when the server understood it;
  an older core drops it and echoes nothing, so a client learns it will get the legacy
  inline delivery.
- **New (ACCEPTED `handoff`).** When a request asked for it, the `ACCEPTED` poll body
  carries `handoff: { type: 'shared-secret', key }` and a token-less `apiEndpoint`
  instead of `token`. The app retrieves the credential exactly once with
  `POST <apiEndpoint>shared-secrets/retrieve { key }`, which returns
  `{ secret: { username, token, apiEndpoint } }`; a second retrieve answers `403`
  (`shared-secret-unavailable`). Requests that did not ask for a hand-off keep the
  inline `token` and are byte-identical to before.
- **Two accept shapes.** The auth page may post the token inline as before (the server
  moves it into a one-time secret on the user's core, then keeps only the key), or, when
  the request carried no consent form, create the secret itself and post `handoff` with
  no token. Posting both `token` and `handoff`, a `handoff` on a request that did not ask
  for one, a `handoff` on a consent-form request, a malformed key, or an `apiEndpoint`
  carrying credentials are each `400 invalid-parameters` and leave the request pending.
- **Never breaks sign-in.** If the secret cannot be created (shared secrets disabled or
  forbidden on the user's core, the core unreachable, a delegated grant), the accept
  falls back to inline delivery.
- **New config (`access.handoffTtl`).** Life in seconds of the hand-off secret, default
  `600`, clamped to the request's remaining life and to `sharedSecrets.maxTtl`.

### Service info: `account` and `features.delegation`

- **New (`service.account`).** The root URL of the platform's account app
  (app-web-user-account), served in `service/info` when configured. The install
  wizard now writes it from the app-web-user-account URL it already asks for, and
  `check-config` warns when `access.defaultAuthUrl` is set without it. The lib-js
  sign-in button uses it for its "Manage my account" link.
- **New (`features.delegation`).** `true` when account delegation is available
  (`delegation.active`, on by default); an explicit `service.features.delegation`
  wins. Auth pages use it to decide whether to offer granting an app access for an
  account the user controls.

## 2.0.0-rc.22 — 2026-09-18

### `service/info.version` now reports the release on native installs too

2.0.0-rc.21 fixed the reported version for the Docker image only: a native
install that checks out a release tag still reported `2.0.0-pre.4` in
`service/info.version`, the `API-Version` header and `meta.apiVersion`, because
it reads the committed `.api-version` file. From this release on, the release
commit carries the tag in that file (the tag build refuses to publish
otherwise), so native installs report the release they run. Reported in
[#135](https://github.com/pryv/open-pryv.io/issues/135).

### Security: credentials no longer stored in the platform store replicated to every core

The platform store (rqlite) is replicated to every core of a platform, on disk.
Until this release it held live credentials: the app token of every accepted
`/reg/access` request (with the username, for up to one hour), and the OAuth2
authorization codes, refresh tokens (valid up to 90 days) and pre-minted access
tokens. Anyone able to read one core's platform data, or a backup of it, could use
them against accounts hosted on any core. Operators of multi-core platforms should
upgrade every core.

- **Changed (`/reg/access`).** A decided request (`ACCEPTED`, `REFUSED`, `ERROR`)
  stays pollable for a retention window after a poll first reads it, then its key
  answers `400 unknown-access-key`, exactly as on expiry. Default 2 minutes, new
  setting `access.terminalRetentionMs` (`0` keeps the previous behaviour: until the
  request expires). Clients that poll the outcome once or twice right away, such as
  lib-js (`AuthController` then `connectFromKey`), are unaffected; an integration
  that reads the outcome much later must do so within the window or set the option.
- **Changed (`/reg/access`).** Requests are held in memory on the core that created
  them, shared by its workers. A core restart drops the requests in flight (the user
  signs in again). The poll URL is always that core's own URL; on a multi-core
  platform without `core.url`, it is now derived from the core id instead of the
  register URL.
- **Changed (OAuth2).** The authorization-code exchange (`POST /oauth2/token`,
  `grant_type=authorization_code`) must reach the core that ran `/accept`, which is
  the documented topology (the issuer resolves to the user's home core, like the
  refresh grant). A code presented to another core now answers `invalid_grant`. Codes
  issued before the upgrade are still accepted until they expire (10 minutes), and
  existing refresh tokens keep working: each core converts its own at startup.

### `/reg/access`: `expireAfter`, `deviceName` and `token` reach the auth page again

- **Fixed.** `expireAfter` in `POST /reg/access` is the lifetime of the access to
  create, in seconds, but the server used it as the lifetime of the request itself,
  in milliseconds: an app sending `expireAfter: 3600` had 3.6 seconds to complete
  sign-in before the key became unknown. The request now always lives one hour.
- **Fixed.** The `NEED_SIGNIN` poll now returns `expireAfter`, `deviceName` and
  `token` when the app sent them, so the auth page applies them when it creates the
  access (it read them from the poll, which did not carry them, so the access was
  created without a lifetime, device name or requested token). Absent when not sent.
- **Fixed.** `accesses.checkApp` now accepts `expireAfter` and `token`, which auth pages forward
  from the auth request before creating the access, and a `null` `clientData` (what the poll
  carries when the app sent none). None of them affect the match. Without this, sign-in for an app
  that sends `expireAfter` or `token` stopped at `check-app failed (400)`.
- **Fixed (OAuth2).** When a refresh token is reused, the chain is revoked and the app is told
  through a `consent/revoke-cmc` in its inbox. That notification lacked the required `accessId`
  (and sent `reason` as a string), so the app's core refused it and the app only found out at its
  next refresh. It now carries `accessId` (the revoked data-grant), a localized `reason` and the
  relationship's correlation ids, like a user-initiated revoke.

### Native installs: use Node.js 24 below 24.19.0

On Node.js 24.19.0 and later (confirmed on 24.21), the SQLite driver installed on
that Node version aborts the whole process when a SQLite statement is
garbage-collected
(`RemoveEnvironmentCleanupHook ... Assertion (env) != nullptr`,
[nodejs/node#65446](https://github.com/nodejs/node/issues/65446)). SQLite is the
default audit engine, so a native (non-Docker) install on such a Node version can
crash at any time under normal use. `engines.node` is now `>=24.0.0 <24.19.0`,
and `INSTALL.md` shows how to install and hold a suitable version.

**Check your hosts:** run `node -v`; if it reports 24.19.0 or later, downgrade to
24.18.x and reinstall the dependencies (`npm install --ignore-scripts && npm rebuild`)
so the SQLite driver is rebuilt against the older headers. A NodeSource `setup_24.x` install or a routine `apt upgrade` lands on the
latest 24.x. The Docker image is not affected (it pins Node 24.18.0).

### Fixed

- **Concurrent logins with the same `appId` no longer hand back a dead token.**
  When two `auth.login` calls for the same user and app raced while the app's
  previous session had expired, both minted a fresh session and each overwrote
  the personal access token, so the losing call returned a token that was on no
  access and its first API request answered `403 Cannot find access from token`.
  The token rotation is now a compare-and-swap: the concurrent logins converge on
  a single live token, and the losing call drops its orphan session.
### Security: invitation tokens are stored hashed in the platform store

- **Invitation tokens are no longer stored as usable keys in PlatformDB.** They
  were keyed by their raw value, so every core's replicated PlatformDB (and its
  backups) held live invitation tokens, and `GET /reg/admin/invitations` returned
  each token as the entry `id`. Tokens are now stored under their SHA-256; the
  admin listing exposes the hash plus the description and creation info, never a
  usable token (the token is shown once, to the admin, at generation). Existing
  tokens keep working: a one-time boot migration re-keys them to their hash.

## 2.0.0-rc.21 — 2026-09-17

### CMC: an invite reports its outcome, and a refusal reaches the requester

- **Added.** The `consent/request-cmc` trigger now reports what happened to the
  invite. Its `content.status`, which used to stay `pending` / `delivered` for
  good, moves to `accepted` (with `acceptedBy`, `acceptedAt`,
  `backChannelAccessId`), `refused` (`refusedBy`, `refusedAt`, `reason`) or
  `revoked` (`revokedAt`) for a single-use invite, and to `invalidated`
  (`invalidatedAt`) for an open-link invite; `reason` is copied when the refusal
  or invalidation carries one. An open-link invite stays `pending` while it
  accepts joiners (request triggers are no longer stamped `delivered`). A socket.io monitor on the
  trigger stream sees each change.
- **Fixed.** A refusal sent through an invite link never arrived: the requester's
  core refused the delivery (`400`), so the refusing side ended `failed` with
  `cmc-handler-delivery-failed` and the requester was never told. The delivered
  `consent/refuse-cmc` now carries `capabilityUrl` (without its token) and omits
  an empty `reason`, and the requester's core records the refusal on the invite.
  Both cores need this release: an older requester core receiving the new shape
  still does not record the refusal, and the refusing side's trigger ends `failed`
  with `cmc-capability-invalid`. A refusal does not consume a single-use link: the
  same party may still accept it later (the invite then moves to `accepted` and
  loses its refusal fields).
- **Changed.** An accept or refuse whose capability URL no longer authenticates
  (`cmc-capability-invalid`: unknown or expired token) is no longer retried; the
  trigger is marked `failed` at once instead of after six attempts.
- **Changed.** Who joined an open-link invite is now the set of the requester's
  relationship accesses carrying the invite's `capabilityId`
  (`clientData.cmc.role: 'counterparty'`). The capability access's
  `clientData.cmc.capability.acceptedBy` list is no longer written or read;
  arrays on existing capability accesses are left as they are. Joins no longer
  rewrite the capability access, so concurrent accepts can no longer lose one
  another and the access stops growing. A same-party re-accept is still refused
  with `cmc-capability-already-accepted-by-you` while that relationship exists;
  `error.data.acceptedAt` is now the relationship access's creation time. Apps that
  read `acceptedBy` should list the relationship accesses instead, or use
  `@pryv/cmc` `listInviteAccepters`.
- Documentation corrected: capability accesses are listed by `accesses.get` like
  any other access (they were documented as hidden).

### CMC: open-link invites can be issued without expiry

An `open-link` invite (`capability.mode: 'open-link'`) may now be published with
`request.expiresAt: null`: the capability access is minted with no expiry and the
link keeps working until the requester ends it with `consent/invalidate-link-cmc`.
The trigger reports `capabilityExpiresAt: null`. Until now every capability was
capped at 30 days, which forced a public registration link to be re-minted and
republished monthly. Reported in
[#137](https://github.com/pryv/open-pryv.io/issues/137).

- Bounds are now per mode. `single-use` keeps [60 s, 30 d]. `open-link` accepts
  any `request.expiresAt` at least 60 s ahead, with no upper bound, or `null`.
  `cmc-capability-ttl-out-of-range` details now carry `mode`, and
  `maxTtlSeconds` is `null` for open-link. `request.expiresAt: null` on a
  single-use invite is refused with the new error id
  `cmc-capability-no-expiry-not-allowed`.
- An accept through an expired or unknown capability URL now fails with
  `cmc-capability-invalid`; current cores answer 403 there, which was previously
  reported as `cmc-handler-offer-read-failed`.
- An accept refused by the capability itself (consumed, invalidated, or already
  accepted by you) now reports that typed id as the trigger's `failure.reason`,
  instead of the generic `cmc-handler-delivery-rejected` with the id buried in
  `failure.detail`.
- Documentation corrected: the default lifetime (7 days) is a code constant, not
  an operator setting; the per-invite field is `content.request.expiresAt`
  (previously documented as `content.expiresAt`); capability accesses are not
  garbage-collected (consumed and invalidated ones are kept so a later click on
  the same URL gets a typed error, expired ones stop authenticating like any
  expired access).
- Requires event-types catalogue 1.1.2 (`consent/request-cmc` `request.expiresAt`
  is now `number | null`). A core still validating against an older catalogue
  refuses `null` with `invalid-parameters-format` at `#/request/expiresAt`;
  restart the core after the catalogue is published, or update the runtime seed
  (this release ships it).

### `contact/facebook`, `audiogram/data` and `clinical/fhir` events are accepted again

The schemas of these three event types in the event-types catalogue were malformed
(a string where a boolean belongs, and misnested properties), so the validator could
not compile them and every event of these types was refused with
`invalid-parameters-format`, whatever its content. The published catalogue is repaired
and both copies bundled with the server are refreshed from it: valid events of these
types are now accepted, and their content is validated (`contact/facebook` requires
`id`; `audiogram/data` requires `sensitivityPoints`, `start` and `end`, each point a
`frequency`; `clinical/fhir` requires `displayName` and `clinicalType`, and its `fhir`
object `identifier` and `resourceType`). A core running an earlier release that loads
the published catalogue at startup is fixed for `contact/facebook` only: it merged the
download into its bundled list deeply, which kept the misplaced keys of the other two
types. A core now applies each downloaded type (and extras, classes and sets entry)
whole instead, still keeping entries the download does not carry, so a schema repaired
upstream reaches it. The catalogue's `numset/*` schema was also rewritten;
`numset/...` types remain unvalidated, as before.

### HF series requests on raw deploys answer 504 when the HFS worker stalls

On deployments where the API process itself routes HF series traffic to the
co-located HFS worker (no nginx in front), a worker that stays silent for 60 s on a
request now gets that request answered with `504` and the JSON error
`unexpected-error` ("HFS upstream timed out"), or the response cut if the worker
stalls after it started answering. Before, the client waited until its own timeout.
The bound is idle time on the worker connection, so long uploads and long query
answers whose bytes keep flowing are never cut; a client that itself stops sending or
reading for 60 s is cut the same way. It matches the 60 s the documented nginx front
applies to the same traffic. nginx-fronted deployments are unaffected.

### Event content validation no longer falls back to a 2023 type list

A core validates event content against its built-in event-type list until its
startup download of the published catalogue succeeds, and for as long as it runs
if that download fails. The built-in list dated from October 2023, so on a core
that could not reach the catalogue, and on every core during its startup window:

- 23 current types were unknown, and unknown types are accepted with ANY content.
  They are now validated: for example a `concentration/mmol-l` event whose content
  is not a number was accepted and is now refused with `invalid-parameters-format`.
  The affected types include `concentration/*`, `consent/*-cmc`,
  `notification/*-cmc`, `message/chat-cmc`, `calendar/ical-event`,
  `encrypted/aes-256-gcm`, `encrypted/ecies-aes-256-gcm` and `shared-secret/item`.
- `series:` events of those 23 types were refused as an unknown series type; they
  are now accepted.

Cores that reached the catalogue at startup already behaved this way after the
download, so nothing changes for them past startup. The legacy
`density/g-dl`, `density/mmol-l` and `density/mg-dl` types, renamed to
`concentration/*` in the catalogue, remain accepted everywhere.

### CMC: two legacy lookups read the wrong event

Two fallback paths looked an event up by id with a query that does not filter
on id, so they read the account's newest event instead:
- a peer accept that carries neither the requester's origin stream nor its app
  code (older accepters) could be anchored under an unrelated app scope;
- a withdrawal on an open link for a relationship minted before the capability
  id was recorded could fail to clear the subject from that link (so they could
  not consent again through it), or clear them from another offer.
Both now read exactly the event named, and only when it is a
`consent/request-cmc`.

### CMC: approving a collector's scope request now changes the grant

A user answering a collector's `consent/scope-request-cmc` with
`consent/scope-update-cmc` `{ scopeRequestEventId, accept: true }` saw the
trigger reach `status: 'completed'`, and the approval page report success, while
the data-grant kept its old permissions: only answers that restated `accessId`
and `newPermissions` were applied, and `completed` reflected delivery to the
collector, not a change. Reported in
[#136](https://github.com/pryv/open-pryv.io/issues/136).

Now:
- The answer is resolved against the request **as it arrived on the user's
  account**. The permission set and the grant to change come from that request,
  never from the answer. The request must have been written by the collector's
  grant serving that collectors stream, and the answer must be written on the
  same stream, so one collector's request can never widen another collector's
  grant, and a request the user wrote themself cannot be approved into a grant.
- The trigger records `accessId`, `newPermissions` (the user-facing set now in
  force) and `applied: true`; **`completed` means the grant changed**. A
  refusal (`accept: false`) completes with `applied: false`. The collector
  receives the same content.
- The collector's completed `consent/scope-request-cmc` trigger carries
  `content.remoteEventId`: the id the request has on the user's account. That is
  the id the user side must answer (and the one to put in a hand-off link);
  answering the collector-side id fails with `cmc-scope-request-not-found`.
- New failure reasons on the trigger: `cmc-scope-request-not-found`,
  `cmc-scope-request-not-from-peer`, `cmc-scope-request-stream-mismatch`,
  `cmc-scope-request-expired`, `cmc-scope-request-already-answered`,
  `cmc-scope-request-invalid`, `cmc-scope-update-target-not-counterparty`,
  `cmc-scope-update-target-stream-mismatch`, `cmc-scope-update-nothing-to-apply`.
- A scope update that names nothing to apply (no request reference and no
  `newPermissions`, or an answer without `accept`) now fails instead of
  completing. A self-initiated update with an explicit `accessId` must name the
  CMC counterparty grant serving the collectors stream it is written on.
- The outcome (`applied`, `accessId`, `newPermissions`) is written to the
  trigger before the collector is contacted, so a client polling the trigger
  sees it while delivery is still in flight.

### CMC: accepting no longer fails when the app scope stream does not exist

`consent/accept-cmc` written on a `:_cmc:apps:<app>[:<path>]` stream the
accepter never created failed with `unknown-referenced-resource`, naming the
stream rather than the cause, for every participant of a collector that had not
arranged for it. When written with a **personal** token, `consent/accept-cmc`
and `consent/refuse-cmc` now create the missing scope chain (marked
`clientData.cmc.autoProvisioned`). App and shared tokens get no provisioning.
Reported in [pryv/app-web-user-account#2](https://github.com/pryv/app-web-user-account/issues/2).

### Auth requests: a `consent` sidecar, and the grant is now checked

`POST /reg/access` accepts one new optional top-level object:

```json
{
  "requestingAppId": "my-app",
  "requestedPermissions": [
    { "streamId": "diary",  "level": "read", "defaultName": "Journal" },
    { "streamId": "weight", "level": "read", "defaultName": "Weight" }
  ],
  "consent": { "allowUserChoice": true, "mandatory": ["diary"], "optIn": ["weight"] }
}
```

`consent.mandatory` and `consent.optIn` name permission ids (a stream
permission's `streamId`, a feature permission's `feature`);
`consent.allowUserChoice` means the same thing it means in an OAuth2 or CMC
offer. The annotations travel BESIDE the entries rather than inside them so
that `requestedPermissions` stays exactly what it has always been: the auth
page forwards those entries verbatim to `accesses.checkApp`, whose schema
rejects unknown per-entry fields, and an annotation written inside an entry
would fail there against servers and auth pages already deployed.

The server resolves the pair into a consent form and echoes it, as
`consent`, on the `201` and on the `NEED_SIGNIN` poll. That echo is also how
an app can tell whether the server understood the annotations: an older core
ignores the field and answers without it, and the flow degrades to
all-or-nothing rather than failing.

**`POST /reg/access/:key` with `status: ACCEPTED` now verifies the grant, but
only for a request that carried a `consent` sidecar.** The server reads the
access behind the posted token (locally, or on the user's own core when the
platform hosts them elsewhere, never at the host named in the posted
`apiEndpoint`) and checks it against the consent form with the same rule the
OAuth2 and CMC accept paths use. Two new answers:

- `400 invalid-consent-grant` with `data.reason` one of `token-invalid`,
  `not-app-access`, `empty-grant`, `not-subset`, `choice-not-allowed`,
  `mandatory-refused`, and `data.offending` listing the entries at fault for
  the last three. The access request is left open, so a page can correct the
  grant and post again.
- `503 consent-check-unavailable` with `data.reason` one of
  `core-unresolvable`, `core-unreachable`, `storage-error`, when this server
  could not perform the check at all. The request is unchanged and the post
  can be retried. This is deliberately not a `400`: a check that could not
  run says nothing about the access, and a page that deletes the access it
  just minted on a rejection must not be told a good access is bad.

**A request without `consent` is unaffected in every respect**: no new
validation on create, no `consent` key in either response body (absent, not
`null`), and no check on accept, so the long-standing opaque-token contract
of the accept endpoint still holds for existing integrator UIs.

### Consent offers: an `optIn` annotation beside `mandatory`

A permission entry in a consent request or offer (`consent/request-cmc`,
`consent/scope-request-cmc`, and the offer embedded in an OAuth2 authorization)
may now carry `optIn: true` beside the existing `mandatory: true`. The two
annotations give a requester three ways to present an entry to the user:

| annotation | meaning on the consent screen |
|---|---|
| `mandatory: true` | required: the user cannot leave it out, the screen locks it |
| neither | optional, shown pre-selected (unchanged: what every optional entry does today) |
| `optIn: true` | optional, shown NOT pre-selected |

`optIn` is display-only. It decides how the screen opens, never what may be
granted, so the accept check returns the same verdict with or without it: an
opt-in entry the user leaves unticked is simply an entry that is not in the
grant. Setting both annotations on one entry is a contradiction and is rejected
where the offer is read (`400 invalid_scope` on the OAuth2 path,
`cmc-offer-invalid-permissions` on the CMC path).

Nothing changes for a request that carries no annotation, and neither annotation
ever reaches a minted access: both are stripped before the access is created.
Cherry-picking still requires the offer's `allowUserChoice`; without it a consent
remains all-or-nothing.

### SECURITY — the PostgreSQL audit engine returned audit rows across accesses

Reading the audit trail applied **no stream filter** when `storages.audit.engine`
is `postgresql`. Any access could therefore retrieve the account's audit rows for
**other** accesses: an app granted one narrow permission could see which API
methods the account owner called, when, and with what query. Accounts on the
default `sqlite` audit engine were never affected, and no data outside the audit
trail was exposed.

⚑ **Who is affected:** deployments where `storages.audit.engine` is
`postgresql`. The install wizard selects that engine whenever PostgreSQL is
chosen, so a platform installed with PostgreSQL through the wizard is affected
unless the setting was changed. Check `storages.audit.engine` in your
configuration; if it is `sqlite` (the default), you were not affected.

The filter was read as a flat list while every store is handed the normalised
nested form, so no condition was built — and the code treated "no condition" as
"no filter" rather than as an error. Fixed by reading the normalised form, and by
making an unreadable filter **deny** instead of returning everything: a filter
that degrades to "return all rows" is the wrong failure mode for an
authorization boundary.

The same change anchors stream-id matching between separators. Before it, a
stream id that was a suffix of another could match it.

**No action is required beyond upgrading**; no stored data is altered.

### Cross-core delegation no longer requires an explicit `core.url`

On a multi-core platform, every cross-core `delegations.*` call failed with
`400 delegation-unknown-core` ("Could not resolve the delegate account core
endpoint") unless the operator had configured an explicit `core.url` on each
core. Resolving the delegate's core read the peer's registry entry directly,
where a URL is recorded only when that peer was given an explicit `core.url` —
which neither the configuration wizard nor the bootstrap bundle writes. So on a
dns-active platform the lookup could not succeed, and the relationship could
never be created. Same-core delegation was unaffected.

Resolution now goes through the same helper the rest of the API uses, which
prefers a peer's advertised URL and otherwise derives it from the core id and
the platform DNS domain. Deployments that had set `core.url` as a workaround
keep working unchanged and may now drop it. Where neither an advertised URL nor
a domain is available the call is still refused with `delegation-unknown-core`,
rather than being delivered to the calling core itself. Reported via
[#134](https://github.com/pryv/open-pryv.io/issues/134).

### Account email can no longer be written through the events API

- **BREAKING**: `events.create` and `events.update` targeting the account email
  stream (`:system:email`) are now refused with `400 invalid-operation`
  (`forbidden-account-email-event`, `data.streamId` set to the stream id). The
  primary email carries account-wide coordination — platform uniqueness, the
  multi-email container lockstep, the verification lifecycle and format
  validation — that only `account.update` performs. Writing it through the
  events API bypassed that coordination; a delegated (app/shared) access holding
  `contribute` on the visible email stream could change the login email and,
  with it, where a password-reset mail is sent. Use `account.update` (its
  `email` field, or the `emails` operations object) to change the address.
  **Reading** `:system:email` is unchanged. Refused for all access types,
  personal included, so `account.update` is the single coordinated writer.

### `accesses.update` now validates account-stream permissions like `accesses.create`

- **BREAKING**: `accesses.update` now applies the same account/system-stream
  permission validation as `accesses.create` — an unknown system stream, a
  non-visible account stream, or a level higher than `contribute` on a visible
  account stream is refused with `400 invalid-operation` (same messages and
  `data.param` as create). Previously the update path accepted permission
  changes without these checks, so a permission that create refuses could be set
  via `PUT`. The request fails identically for the account owner's own personal
  token, so this is a validation gap rather than an authorization change. An
  update that omits `permissions` leaves the stored permissions untouched; when
  `permissions` is present the whole submitted set is validated.

### Account-stream permissions: clearer error, corrected docs

- **BREAKING (error contract)**: `accesses.create` with a permission on an
  account stream id that is not defined on the platform (`:_system:...` or
  `:system:...`) now returns `400 invalid-operation`, with a message stating the
  prefix rule and `data.param` set to the offending id, instead of a bare
  `403 forbidden`. The request failed identically for the account owner's own
  personal token, so it was never an authorization failure. A permission on a
  hidden account field still returns `400 invalid-operation` with the
  `denied-stream-access` message, so the two cases stay distinguishable, now by
  message and `param` rather than by status. Reported via
  [#131](https://github.com/pryv/open-pryv.io/issues/131).

### Docs corrected

**Correction to the "System streams refactor" notes further down:** they listed
`:_system:email` among unchanged system stream ids. That id does not exist. The
email account field is platform-defined and its id is `:system:email` (customer
prefix); only built-in fields such as `language`, `appId`, `invitationToken`,
`referer` and `storageUsed` take `:_system:`. The original line is annotated in
place. The same wrong spelling has been corrected in the CMC README, in the
email constants module header, and in the account datastore's field-name
examples. Reported via
[#131](https://github.com/pryv/open-pryv.io/issues/131).

### `service/info.version` now reports the released build, not a frozen value

`GET /service/info` returned `version: "2.0.0-pre.4"` on every Docker release, and
the same stale value went out as the `API-Version` response header and as
`meta.apiVersion` on every response body. The value is there for capability
negotiation (SDKs branch on `>= 1.6.0`), so a version that never advanced meant a
client could not tell which build a core was running, and any future version gate
would have compared against a frozen number.

- Docker release images now stamp their version file from the image tag at build
  time, so the three surfaces above report the released tag (e.g. `2.0.0-rc.21`).
  Local and from-source runs are unchanged: they keep the checked-in dev-line
  value, which is honest for a non-release build.
- No API shape change: the fields are the same, they now carry an accurate value.
  Operators who read `service/info.version` (or the `API-Version` header) to
  identify a deployed build can now trust it on released images.

### A core that cannot load the event-types dictionary now refuses unknown types

If the boot-time fetch of the published event-types dictionary
(`service.eventTypes`) failed, the core started up healthy and ran for the rest of
its lifetime on the embedded fallback set. Because unknown types were accepted
without content validation, this surfaced as a silent, permanent loss of
validation rather than an error: every type present in the published dictionary
but absent from the embedded set was written with no schema check.

- **BREAKING (degraded state only)**: while the published dictionary has never
  loaded, `events.create` / `events.update` now **refuse** an unknown event type
  with `400 invalid-operation` (`data.type` set to the type) instead of accepting
  it unvalidated. A core that loaded the dictionary is unaffected: an unknown type
  is still accepted there as a genuinely new free type. In other words, the change
  is visible only on a core that booted without its dictionary, and it converts a
  silent under-validation into an explicit refusal.
- The core no longer stays silently degraded: a failed initial fetch is logged at
  `error` (not `warn`) and retried in the background with backoff until it loads,
  at which point unknown types are validated again.
- **New admin endpoint** `GET /system/event-types-status` (admin-key gated) reports
  the dictionary's loaded state (`degraded`, `source`, `version`, `embeddedVersion`,
  `lastSuccessAt`, `lastAttemptAt`, `lastError`) so operators can alert on a core
  running on its fallback. On a clustered core each worker holds its own dictionary
  state, so during a partial recovery successive calls may report `degraded`
  differently until every worker's retry has landed. Reported via
  [#138](https://github.com/pryv/open-pryv.io/issues/138).

## 2.0.0-rc.20 — 2026-09-15

### CMC: a revocation now ends both halves of the relationship

Withdrawing consent was only half enforced. Each side deleted the access the
PEER was using against its own account, but the access the withdrawing side
itself held on the peer's account survived, because the receiving server ran no
teardown. So after a withdrawal both parties considered the relationship over
while a live token still read the counterparty's data, until that side's app got
around to deleting it. The implementers' guide documented this and asked
integrators to delete their own half; that is no longer necessary.

- When a `consent/revoke-cmc` arrives, the receiving server deletes the access it
  arrived through, plus any sibling access serving the same relationship (same
  stamped counterparty and same `scopeStreamId`). A relationship can be served by
  several grants, and each of those handed out a working token.
- Identity comes only from the access the arrival authenticated with, never from
  the event's content, so a peer can only ever destroy what it already holds on
  that account. Legacy accesses that carry no scope are never swept.
- ⚑ **Behaviour change for integrators:** an access you hold for a relationship
  is deleted out from under you when the peer withdraws. Drop cached endpoints on
  seeing a `consent/revoke-cmc` arrival; a request with such a token now fails
  authentication rather than returning data. Deleting your own half is still
  harmless (it is idempotent) but no longer required.
- Unchanged: anchor streams are preserved, delivery stays best-effort, and a
  revocation that cannot be delivered leaves the peer's half standing.

### CMC: forwarded revocations carry ids the receiving side can match

`content.accessId` on a revoke arrival is the sender's access id on the sender's
own account, so it matches nothing the receiver holds. The receiving server now
adds the receiver's own handles for the relationship, using the names each side's
app already knows: `backChannelAccessId` + `inviteEventId` on the requester side,
`dataGrantAccessId` + `offerEventId` + `acceptEventId` on the accepter side, and
on both `scopeStreamId` (derived from the receiver's own state, not the peer's
claim) plus `revokedAccessIds`, the accesses the teardown destroyed.

Ids that cannot be resolved are absent rather than null, a value the peer supplied
is never overwritten, and `accessId` keeps its meaning. The requester's
back-channel access is also stamped with `offerEventId` / `inviteEventId` at mint,
so a peer running an older build still receives something matchable.
## 2.0.0-rc.18 — 2026-09-15

### Account delegation — guardian/caregiver-controlled accounts (`delegation:active`, default on)

An account can now be controlled by one or more other accounts ("delegates") — for
example a parent managing a child's account until majority, or a trusted adult
managing a dependent person's account. A delegate holds a personal-class token over
the controlled account that is owner-equivalent for data and account management,
with one reserved exception: it cannot remove a delegation. Removing a delegation
("detach") requires a genuine login on the controlled account (a personal token
obtained from that account's own credentials), so the owner always keeps ultimate
control.

- New `delegations.*` methods (routes under `/<username>/delegations`):
  `requestAttach`, `acceptAttach`, `refuseAttach`, `cancelInvite`, `listDelegates`,
  `listControlled`, `getToken`, `createAccount`, `detachDelegate`,
  `dismissControlled`. `detachDelegate` and `cancelInvite` require a genuine
  (non-delegated) personal login; `getToken` and `createAccount` are delegate-side.
- Attaching an existing account is controlled-account-initiated: the account that
  wants to be controlled requests attachment (status `invite`); the prospective
  delegate accepts (`active`). An account may have multiple delegates.
- Create-from-delegate: a delegate can create a brand-new controlled account, active
  immediately, with optional email and optional password (an email is not required;
  without a password the account is reachable only through its delegates until a
  credential is set).
- Cross-core (same platform): a delegate and the controlled account may live on
  different cores; the two core-to-core steps are admin-key gated.
- `access-info` gains an additive `delegation` field describing a delegated access
  (controlled username + delegate identity); the audit trail attributes each
  delegate's actions (each delegate acts through its own token, audited on the
  controlled account, on both same-core and cross-core issuance).
- New config `delegation:active` (default true); when off, the methods are not
  registered and the feature is inert.
### Email verification is now on by default (general availability)

This supersedes the 2.0.0-rc.17 entry "Email verification now ships OFF by
default (beta)": that entry stays as the record of what rc.17 did, but its
guidance no longer applies. The "(beta)" qualifier on the rc.17 entry "Multiple
emails per account (beta)" is likewise lifted: the feature, its templates, its
verification page in the reference account app and its API surface are now
general availability.

`services.email.enabled.verifyEmail` defaults to `true`. **Upgrading does not
stop a working configuration from booting:**

- If your configuration sets `verifyEmail: true` explicitly, nothing changes:
  `auth.emailVerificationPageURL` remains required and the core refuses to boot
  without it, as before.
- If your configuration does not mention `verifyEmail`, the default now applies.
  When `auth.emailVerificationPageURL` is set and mail is configured,
  verification links are sent for addresses added to an account. When the URL
  is missing, or `services.email` is incomplete, the core boots, logs one
  warning at every start, and keeps the feature off until the missing keys are
  set (`bin/check-config.js` reports the same warning). Set
  `verifyEmail: false` to turn the feature off without the warning.
- If your configuration sets `verifyEmail: false`, nothing changes.

"Mail is configured" is decided from config alone, with no SMTP probe: for
`method: in-process` it means `services.email.smtp.host` is set; for
`microservice` and `mandrill` it means `services.email.url` and
`services.email.key` are set. The sender (`services.email.from`) is NOT part of
that test — it matters for deliverability, but a deployment that was sending
mail without one keeps sending mail. The same predicate now answers for the boot
check, `bin/check-config.js`, the runtime send path and `service.info`, so those
four can no longer disagree about whether a verification mail would go out.

`GET /service/info` now always carries `features.emailVerification:
{ atRegistration, onAccount }`. `onAccount` is `true` only when the
verification-link flow is live on this platform (flag on, page URL set, mail
configured); clients use it to show or hide "send verification link" actions.
`atRegistration` is `true` when a verified address is required to create an
account (see the registration gate entry).

### Email verification at sign-up (optional)

Operators can now require a verified email address before an account is
created. Off by default; a stock deployment is unchanged.

- New config `account.emailVerification.requireAtRegistration` (default
  `false`). When `true`, `POST /users` refuses a registration that does not
  carry an `emailProof` obtained through the two new public endpoints below
  (`403 forbidden`, `data.emailVerificationRequired: true`), and refuses an
  empty email address (`400 invalid-parameters-format`). Admin-created
  accounts (`system.createUser`) are never gated. The core refuses to boot when
  the gate is on and `services.email` is incomplete, and a mail delivery
  failure at request time blocks that registration rather than letting an
  unverified account through. Tuning keys, all under
  `account.emailVerification`: `registrationCodeMaxAgeMs` (10 min),
  `registrationCodeMaxAttempts` (5), `registrationCodeResendCooldownMs`
  (60 s), `registrationCodeDailyLimit` (10), `registrationCodeFailuresPerDay`
  (20), `registrationProofMaxAgeMs` (30 min).
- `POST {register}/email-challenge` `{ email, language? }` mails a one-time
  8-character code to the address (`200 { sent: true }`; `409
  item-already-exists` when an account already owns the address; `429
  too-many-attempts` with `data.retryAfterSeconds` on the per-address
  cooldown, daily cap or failure budget). `POST
  {register}/email-challenge/verify` `{ email, code }` exchanges a correct code
  for a single-use `emailProof` (`401 invalid-access-token` with
  `data.attemptsRemaining` on a wrong or expired code; `429` once the code's
  attempts are exhausted). Both answer `403 forbidden` with
  `data.emailVerificationRequired: false` while the gate is off. The code is
  never stored, only its hash; a proof is bound to the address it was issued
  for and to one registration.
- **Rate limits are keyed on the target address**, because the endpoint is public
  and carries no caller identity. That is a deliberate trade-off with a
  consequence worth knowing before you enable the gate: someone who knows an
  address that has no account yet can spend its daily budget, which both mails
  that address a few codes and keeps it from signing up until the window rolls.
  The caps are sized to stop bulk abuse, not a targeted nuisance. Put a per-IP
  rate limit in front of the registration endpoints at your edge if that matters
  to you.
- `GET /service/info` `features.emailVerification.atRegistration` is `true`
  while the gate is on (the field itself is always present, see the general
  availability entry above).
- An address proved this way is recorded with `verificationMethod:
  'email-code'`, a new proved value alongside `'email-link'` and `'operator'`
  (it counts as proved ownership for third-party sign-in linking). Accounts
  created while the gate is off keep `'registration'`, as before.
- The mailed verification link for addresses added to an existing account now
  also carries `username` (`<emailVerificationPageURL>?verifyToken=…&username=…`)
  so a landing page can address `/:username/account/verify-email` without an
  email lookup. Existing links keep working. The parameters are appended with
  the right separator, so a page URL that already carries a query keeps its own
  parameters intact.
- New template key `services.email.emailChallengeTemplate` (default
  `email-challenge`).

### Mail templates now ship with the server

In-process mail (`services.email.method: in-process`) previously relied on an
operator-provided Pug directory; the documented "bundled default set" did not
exist, so a fresh deployment could not send any mail until templates were
added by hand. The server now ships `welcome-email`, `reset-password`,
`verify-email` and `email-challenge` templates in English and French and seeds
them into PlatformDB on first boot when `services.email.templatesRootDir` is
empty. Deployments that already hold templates are untouched (seeding only
runs on an empty store). `bin/mail.js templates seed` defaults to the bundled
set when `--from` is omitted.

## 2.0.0-rc.17 — 2026-09-11

### Third-party sign-in (OIDC relying party) — OFF by default (beta)

Pryv.io can now act as an OpenID Connect **client**, letting an account holder
sign in through an external identity provider (e.g. Google) that the operator
configures. Inert unless enabled (`sso.enabled: true`) with at least one
provider; a stock deployment is unaffected.

- New config `sso.*`: `enabled` (default false), `landingPageURL` (the auth-app
  page that receives the sign-in hand-off; required when enabled),
  `callbackBaseURL` (optional; the IdP-registered redirect base), and a
  `providers` allow-list keyed by provider id (`issuer`, `clientId`,
  `clientSecret`, `label`). Distinct from the legacy `auth.ssoCookie*`
  trusted-app keys (a name collision to be aware of).
- New routes `GET /auth/sso/:provider/start` and `/callback`, plus a public
  `GET /auth/sso/providers` descriptor (id + label only) for the sign-in buttons.
- A first successful sign-in links `(provider, subject)` to the matching account,
  and ONLY when that account has PROVED ownership of the IdP's verified email;
  later sign-ins ride the link. Fail-closed: an account whose address was never
  inbox-proved cannot be taken over by an IdP identity.
- The minted session is handed to the auth app through a one-time shared secret,
  so the session token never appears in a redirect URL; `sharedSecrets.enabled`
  is therefore required (boot-refused otherwise). With MFA active, only the
  factor-gated `mfaToken` is handed off and the real token is released after
  `mfa.verify`.
- Operator link management: `bin/sso-link.js` (list / show / unlink).
- id_token authenticity relies on TLS + client-secret (openid-client default per
  OIDC §3.1.3.7); the per-validation JWS signature check is an opt-in
  defense-in-depth option.

### Fixes

- **Consent enforcement:** an OAuth2 authorization accept no longer mints an access
  through a consent that is refused or via an invalidated link. The accept keys on the
  consent handshake's terminal outcome, so a data-grant that is rolled back on a peer
  refusal is never observed as a success.
- **Consent revoke notification:** when several data-grants serve one relationship (a new
  grant is minted on each re-accept), the peer back-channel is now stamped on the newest
  grant awaiting one, and delivery/revocation resolve to the grant that knows the peer, so
  a revoke reliably notifies the peer instead of reporting `peerNotified: false`
  ([#129](https://github.com/pryv/open-pryv.io/issues/129)).
- **Stream-id validation:** `accesses.create` now rejects a creation stream-id with
  non-forbidden junk after a valid prefix, or longer than 100 characters, as its error
  message already promised (the validation regex was unanchored)
  ([#130](https://github.com/pryv/open-pryv.io/issues/130)).
- **Security:** runtime dependency bumps off high-severity advisories (multer, nodemailer,
  sharp; plus morgan).

## 2.0.0-rc.16 — 2026-09-04

_(supersedes the 2.0.0-rc.15 tag, which was cut from a commit that failed CI and was never published.)_

### MFA: per-account failed-attempt limit (brute-force hardening)

The failed-second-factor limiter now also accrues PER ACCOUNT, not only per pending
MFA session. Repeated wrong codes across repeated logins no longer reset the budget:
once an account reaches `services.mfa.attempts.perAccount` failed verifications within
`perAccountWindowSeconds`, the MFA step is locked for `lockoutSeconds` and `mfa.verify`,
`mfa.confirm` and `mfa.challenge` return `429 too-many-attempts` (with a `Retry-After`
header). Password login itself is not locked, and already-issued access tokens keep
working; only the second-factor step is throttled, so a password-holder cannot use it
to lock a user out.

- New config `services.mfa.attempts`: `perSession` (default 5, the previous fixed
  limit), `perAccount` (default 20; set `0` to disable the per-account limit),
  `perAccountWindowSeconds` (default 900), `lockoutSeconds` (default 900). Defaults
  preserve existing per-session behaviour; the per-account limit is new but generous.
- New error `too-many-attempts` (HTTP 429) on the MFA verify/confirm/challenge endpoints.
- A locked account recovers automatically when `lockoutSeconds` elapses, or immediately
  via `mfa.recover` (recovery code + password) or the admin `system.deactivateMfa`.
- This supersedes the "Known limitation" noted under 2.0.0-rc.14: the per-account limit
  described there now ships, so an edge rate-limiter is no longer the only remedy.

## 2.0.0-rc.14 — 2026-09-02

### MFA: server-side TOTP (authenticator apps) enabled by default, over SMS

MFA is no longer SMS-only, and it is now **on by default**. A server-side TOTP
factor (RFC 6238, authenticator apps such as Google Authenticator / 1Password)
is built in and works out of the box with no configuration (in-process, no
external service). It is the default method; SMS continues to work unchanged and
stays off until an operator configures it.

**Behavior change: MFA is active by default.** `services.mfa.active` now ships
`true`, so the `mfa.*` endpoints are live and any user can self-enrol TOTP.
Nothing is forced: a user with no enrolled factor logs in exactly as before
(login only challenges confirmed enrolments). To turn MFA off entirely, set
`services.mfa.active: false`. **Legacy deployments upgrade unchanged:** a config
with the legacy `services.mfa.mode: single|challenge-verify` takes precedence
over the new default, so an SMS deployment keeps its SMS second factor
(byte-identical) until it migrates off `mode`. `auth.login` now performs one
extra profile read per login (to detect enrolment) that was previously skipped
when MFA was off.

**service-info advertises active MFA methods.** `service.info().features.mfa =
{ methods: [...] }` lists the active methods, default-method first (`[]` when
MFA is off; the field is absent only on older cores). Clients (e.g. the account
UI) use it to offer only the methods the operator actually enabled rather than
advertising SMS on a server with no SMS provider.

- `mfa.activate` accepts an optional `method` (`totp` | `sms`, defaulting to the
  operator's configured `defaultMethod`). For TOTP it returns, alongside the
  `mfaToken`, an `otpauthUri` (for a QR code) and the Base32 `secret` (for
  manual entry). `mfa.confirm` then verifies the first code and returns the
  recovery codes, as before.
- `auth.login` now also returns `mfaMethod` (`totp` | `sms`) next to `mfaToken`
  so clients can prompt for the right factor; `mfa.challenge` echoes `method`.
- New config `services.mfa`: `active` + `defaultMethod` + `methods.{totp,sms}`
  (TOTP `digits`/`periodSeconds`/`driftSteps`/`issuer`/`secretsKey`). The legacy
  single-valued `services.mfa.mode` (`disabled`/`challenge-verify`/`single`) is
  still honoured via an in-memory shim and takes precedence over the
  active-by-default, so existing deployments need no change.
- TOTP secrets are stored encrypted at rest; a wrong code is rejected as
  `invalid-mfa-code`, a used code cannot be replayed (guard is enforced against
  the stored step, so concurrent sessions cannot re-use a code), and repeated
  failures invalidate the pending MFA session. TOTP raises the deployment to a
  clean NIST 800-63B AAL2 posture without any third-party service.

**Migration note.** A legacy `services.mfa.mode: single|challenge-verify` config
keeps working unchanged: the normalizer gives `mode` precedence over the
active-by-default, so SMS-enrolled users keep their SMS factor. To adopt the
multi-method model (and gain TOTP), remove `mode` and use
`active`/`defaultMethod`/`methods`. **To keep MFA off after upgrading, set
`services.mfa.active: false`** — a bare `mode: disabled` no longer suffices (it
is indistinguishable from the shipped default, which also carries
`mode: disabled`). If a deployment ends up MFA-active with a
user whose enrolled method is not active server-side, that login proceeds
without a second factor and logs a `warn` (a config mistake to catch, not a
silent state).

**Known limitation.** The failed-attempt limiter is per MFA session (5 tries),
not a per-user rate limit; a caller who can re-authenticate gets a fresh budget.
Front with login/rate-limiting at the edge for high-assurance deployments.

### Concurrent `streams.create` of the same id returns `item-already-exists`, not a raw DB error

When two clients raced to create the same stream id, the loser could receive a
`500 unexpected-error` leaking the storage engine's unique-constraint violation
(e.g. `duplicate key value violates unique constraint "streams_pkey"`) instead of
the documented `item-already-exists`. The database constraint is now mapped to a
`409 item-already-exists` on the concurrent path too, identically to a sequential
duplicate create, so clients no longer have to match on an unstable database
message string. Fixes #126.

### Attachment uploads are now bounded by `uploads.maxSizeMb` (413 on overflow)

`uploads.maxSizeMb` previously bounded only JSON request bodies; multipart
attachment parts were unbounded at the application level, so a deployment
without a size-limiting reverse proxy in front accepted attachments of arbitrary
size. The configured limit now applies to the multipart path as well: both the
uploaded file part and the non-file (JSON) part are capped at `uploads.maxSizeMb`
(the latter previously fell under multer's silent 1 MB default). Previously an
oversized file part was accepted outright and an oversized multipart JSON part
surfaced as an opaque `500`; both now return a readable
`413 { error: { id: 'payload-too-large' } }` carrying `data.limitMb`.

**Operator note:** a deployment that was relying on unbounded attachment uploads
(over 50 MB, no proxy limit) will now receive `413` until `uploads.maxSizeMb` is
raised. Fixes #125.

### OAuth2 accept: a peer-rejected consent accept now returns 400, not 500

When the data holder rejects the consent accept during the OAuth2 authorize
flow (for example the shareable link already recorded this accepter, or a
single-use link was already consumed), the `/oauth2/accept` endpoint now returns
`400 { error: 'invalid_grant', error_description: 'consent accept rejected: <id>' }`
carrying the peer's machine-readable reason (a `cmc-capability-*` id), instead of
a bare `500 server_error`. Delivery timeouts and other genuine server faults
still return 500.

### Consent withdrawal no longer blocks re-consent through the same shareable link

A subject who withdrew consent for a relationship established through an open
(multi-use) shareable link was left recorded as an accepter of that link, so a
later attempt to re-consent through the same link was refused. Withdrawal now
clears that record, so re-consent through the same link works again. Consumed
single-use links are unaffected (they stay spent by design).

### Email verification now ships OFF by default (beta) — opt in explicitly

⚠ **Read this if your configuration does not set
`services.email.enabled.verifyEmail`.** Enabling that sub-feature makes
`auth.emailVerificationPageURL` a **required** configuration key, and the core
refuses to boot when a required key is unset. Because the sub-feature shipped
`true` by default, a deployment that had been valid for months could stop
booting on upgrade without its operator changing anything. It is now `false` by
default, so an upgrade can no longer invalidate a working configuration.

**Opt in with both keys — neither works without the other:**

```yaml
services:
  email:
    enabled:
      verifyEmail: true
auth:
  emailVerificationPageURL: 'https://<your-auth-ui>/verify-email'
```

**If you rely on email verification today, this flips it OFF for you.** That
includes deployments layering the shipped production configuration, where the
sub-feature was previously on. Add the two keys above to keep the behaviour.

**Behaviour while it is off:** `account.update` still records an added address
as pending, but no verification mail is sent, and the resend operation reports
success without delivering anything. Addresses therefore stay unverifiable
until the feature is turned on. This is unchanged logic — only the default
moved — but it is easy to mistake for a mail-delivery fault.

Operators who worked around the boot failure by pinning
`services.email.enabled.verifyEmail: false` in a host configuration can drop
that pin; it now matches the default.

### Observability rebuilt: no third-party agent, telemetry built from a fixed allow-list, any OTLP backend

⚠ **If you enabled the optional APM integration in an earlier version, read
this.** The vendor agent's scrubbing configuration was placed in a file the
agent does not look for, so it was **never loaded**, and affected deployments
ran on the agent's built-in defaults: the vendor received request URLs, the
`Host` header, route parameters (including the username as a first-class
attribute), obfuscated SQL, and **forwarded application log records including
their message text**. Assume that behaviour applied for as long as the
integration was enabled, and check what your provider account holds; ingested
telemetry usually cannot be deleted on demand.

That defect is fixed, but the response went further than a fix. Configuring an
agent that instruments everything means enumerating what must *not* leave, and
anything overlooked (or added by the next agent release) leaves by default.
**The integration is now built the other way round: no third-party agent runs
in the process, nothing is auto-instrumented, and telemetry is constructed by
the platform from a closed vocabulary.** What can be emitted is the vocabulary,
so the answer to "could a URL, a username or a message body reach the backend?"
is structural rather than a matter of configuration.

**This replaces the previous integration.** Upgrading is enough to inherit it;
there is nothing to re-scrub and no vendor-agent settings to review.

- **What is sent**, and nothing else can be: per-API-method call counts,
  duration histograms and error counts, labelled only with an API method id (a
  registered identifier from the platform's own method registry), a status class
  (`2xx`/`3xx`/`4xx`/`5xx`) and an error code from the API's documented error id
  list; plus the service name, service version, the machine hostname and a
  worker index. Server-side faults additionally carry a hard-coded message
  chosen by error code and a stack trace rebuilt from repository-relative
  frames.
- **What cannot be sent**: request URLs, query and route parameters, request and
  response bodies, headers of any kind, usernames, stream and event identifiers,
  log records, and error *messages*. None has a representation in the emitted
  schema. Error messages are excluded deliberately and permanently: they
  routinely interpolate file paths and client input, so the code travels and the
  message stays in your own logs.
- **Error reports are aggregated and time-coarsened.** Reports are grouped by
  fault with a count and stamped at the reporting interval, not at the instant
  of failure. A precise timestamp is a re-identification handle: "this method
  failed at 14:32:07.123" singles out one action to anyone holding a second
  timestamped signal, your own audit log included. The deliberate cost is that
  sub-interval ordering and exact error times are not available from telemetry.
- **The instance identifier is the machine hostname**, never derived from your
  service URL or DNS domain. In DNS-based deployments user-facing hosts are
  `<username>.<domain>`, so a URL-derived hostname would have been one config
  change away from attaching a username to every datapoint.
- **Outbound host names are gone.** The previous integration could not stop the
  agent reporting the destination host of outbound calls, which for webhooks is
  an endpoint the operator chose and may itself identify. Nothing observes
  outbound calls now, so this disappears.
- **Transport is OTLP over HTTP**, so the destination is a URL plus whatever
  auth header the backend expects. New Relic, Grafana, Datadog, Honeycomb,
  Elastic and a self-hosted OpenTelemetry Collector all ingest it. Pointing at a
  collector inside your own infrastructure keeps telemetry within your trust
  boundary entirely.
- **Configuration commands changed** (`bin/observability.js`): `set-endpoint
  <url>`, `set-header <name> <value>`, `clear-headers` and `set-interval
  <seconds>` replace the vendor-specific `newrelic set-license-key` and
  `newrelic set-high-security`, and `enable` no longer takes a provider
  argument. Headers carry the backend credential and are stored AES-256-GCM
  encrypted at rest; `show` never echoes them. `set-endpoint` accepts plain
  `http://` to a host-local collector (loopback, RFC1918 or link-local) and
  refuses cleartext to any routable address; the emitter applies the same rule
  at startup, so the constraint holds however the endpoint was configured.
- **`set-interval` is a privacy control**, not just a tuning knob: it sets the
  granularity at which activity is observable and is the only lever on the
  low-traffic residual noted below. Default 300s, clamped to 60-3600.
- **Honest limit**: the emitted content is anonymous by construction, but on a
  very low-traffic instance "one error in this interval" can still correlate to
  the only active user. That is a property of traffic volume rather than of the
  schema, and widening the reporting interval reduces it. We state it rather
  than claim an unqualified guarantee.

### Multiple emails per account (beta)

An account can now hold more than one email address, each with its own
verification state, while the singular `email` field stays authoritative as the
primary. **This feature is beta** — the surface may still change.

- `GET /:username/account` returns an `emails` array alongside the legacy
  `email` scalar: `[{ value, primary, status: 'pending'|'verified', verifiedAt,
  verificationMethod }]`. Accounts that never used the feature report their
  single primary as one verified entry. `verificationMethod` records how an
  address reached its status: `'email-link'` (the holder clicked a mailed
  token) and `'operator'` are proved ownership; `'registration'` (the founding
  email) and `'legacy'` (set via the singular `email` field) are asserted but
  not proved. A `verified` status alone therefore does not imply proven
  ownership: check `verificationMethod` for that.
- `PUT /:username/account` accepts an `emails` operations object, applied in the
  order add, setPrimary, remove, resend:
  `{ emails: { add?: [value], remove?: [value], setPrimary?: value, resend?: [value] } }`.
  – `add` reserves the address (409 `item-already-exists` if another account
    holds it), records it as `pending`, and mails a verification link.
  – `remove` refuses the primary; releases the address and drops it.
  – `setPrimary` refuses unless the target is already `verified`, then swaps the
    primary (the old primary stays as a verified secondary).
  – `resend` re-sends the verification mail for a pending address, subject to a
    cooldown; each send rotates the token so older links stop working.
- `POST /:username/account/verify-email` — public (the token in the body is the
  credential, mailed to the address). A valid token marks that address
  `verified`; unknown, expired and already-used tokens all return the same
  `invalid-access-token` error. The token is a one-time secret bound to the
  account and address; the server stores only its hash.
- Addresses resolve to the account for registration/routing whether primary or
  secondary; password reset still mails the primary only (unchanged).
- Existing accounts need no migration: the primary is synthesized from the
  singular `email` field until the container is first written, so `account.get`
  returns the same result before and after the container is populated.
- Config: `account.maxEmails` (default 5, hard cap 20),
  `account.emailVerification.tokenMaxAgeMs` (default 24h),
  `account.emailVerification.resendCooldownMs` (default 5 min),
  `services.email.enabled.verifyEmail` + `services.email.verifyEmailTemplate`,
  and `auth.emailVerificationPageURL` (required when the verification mail is
  enabled).

### Fixed — the OTLP endpoint guard blocked the collector layout it recommends

Reported as [#119](https://github.com/pryv/open-pryv.io/issues/119). Pointing
telemetry at a self-hosted collector is the way to keep it out of a third
party's hands, but `set-endpoint` only accepted plain `http://` for exactly
`localhost` or `127.0.0.1`. In a containerised deployment the collector is a
separate container, so the core reaches it on the bridge gateway (for instance
`172.17.0.1:4318`), which the check treated as remote and refused. The
recommended architecture therefore required a certificate for a hop that never
leaves the machine.

Cleartext is now decided by whether the destination is reachable from off the
network: loopback, RFC1918 private space and link-local (plus the IPv6
equivalents) are accepted, anything routable still requires `https:`.

The same report noted that the check lived only in the CLI, so an operator
writing the value straight into PlatformDB, or exporting `PRYV_OBS_ENDPOINT`,
got plaintext telemetry with nothing to stop it. The rule now belongs to the
emitter: startup refuses a cleartext remote endpoint and reports why, leaving
telemetry off rather than putting a credentialed payload on the wire. If you
configured such an endpoint by one of those paths, it will stop activating.

### Fixed — a method disabled by the operator no longer blames the licence

`451 unavailable-method` always answered "API method unavailable in current
version. This method is only available in the commercial license.", whatever the
caller's actual reason: the error builder accepted an explanatory message and
discarded it. A method can be unavailable for reasons unrelated to licensing,
such as an operator turning an optional feature off, and the licence text sent
readers chasing the wrong thing. The caller's message now reaches the response;
the licence wording remains the default where no message is given. Calling a
shared-secrets endpoint on a platform with `sharedSecrets.enabled: false` now
answers "Shared secrets are disabled on this platform."

### Shared secrets: hand a secret to a third party by one-time key

Passing a secret to a third party — typically an apiEndpoint carrying an access
token — has meant putting it in a URL, where it survives in browser history,
referrer headers and server access logs. A shared secret stores the payload on
the account and hands over a random key that can be redeemed exactly once.

- `POST /:username/shared-secrets` — create. Requires `ttl` (seconds) and a
  `title`, an `onConsumed.message` (shown once the secret is spent) with an
  optional http(s) `returnUrl`, and the `secret` itself (any JSON, capped by
  `sharedSecrets.maxSizeBytes`). Returns the key exactly once; the server keeps
  only its SHA-256, so the key cannot be recovered later, by anyone.
- `POST /:username/shared-secrets/retrieve` — redeem. Takes no token: the key
  is the credential, since the third party has nothing else yet. Succeeds once;
  every later attempt returns the creator's message and `returnUrl`. The key
  travels in the request body, never the URL.
- `POST /:username/shared-secrets/status` — inspect without consuming
  (creating access or personal token).
- Optional `signature` binds redemption to a proof: `secret` compares a
  passphrase, `hmac-sha256` verifies HMAC(verifier, key material) computed by
  the client, so the verifier secret never reaches the server. A wrong proof
  burns the secret; a missing one does not, so a client can prompt and retry.
- Items live as events under `:_shared-secrets:<accessId>`, readable only by
  the access that created them (personal tokens see everything, as usual) and
  excluded from wildcard `events.get` — they answer only when their stream is
  named explicitly. They cannot be created, modified or moved through the
  events API; deleting a pending one discards it, deleting a consumed or
  discarded one purges the record outright (the erasure path — the payload is
  long gone), and the payload plus any signature passphrase are scrubbed as soon
  as the item stops being pending. `POST /shared-secrets/status` reports an item
  whose TTL has passed as expired, not pending.
- An access can be barred from minting them with the `secretSharing` feature
  permission (`{ feature: 'secretSharing', setting: 'forbidden' }`, default
  allowed), which is inherited by any access it creates.
- Config: `sharedSecrets.enabled` (default `true`), `maxSizeBytes` (4096),
  `maxTtl` (30 days). Read per request, so an operator toggle takes effect
  without a restart.

### OAuth2: DPoP — sender-constrained tokens (RFC 9449) (beta)

An OAuth2 client can now bind its tokens to a key pair it holds, so a stolen
bearer token alone is useless: every API call must also carry a `DPoP` proof —
a short-lived JWS over the request method and URI, signed with the bound key.
Opt-in per session and fully backward compatible — a client that sends no
`DPoP` header gets plain bearer tokens exactly as before.

- Binding happens at the token endpoint: a valid proof on the code exchange
  yields `token_type: DPoP`, and every refresh must prove the **same** key —
  a rotation attempted under a different key burns the refresh chain.
- Proofs are single-use: the `jti` is spent atomically cluster-wide, so a
  captured proof cannot be replayed, not even concurrently on two cores.
- Enforcement sits in the shared access-validation path, so it covers REST,
  batch calls, socket.io and HF series alike, fail-closed: a DPoP-bound access
  arriving without a valid proof is rejected with `403` and a
  `WWW-Authenticate: DPoP` challenge. The attachment `readToken` (previews,
  file downloads, drag-and-drop) stays exempt — it is scoped to file reads and
  cannot be upgraded into an API credential.
- `accesses.create` / `accesses.update` refuse to forge or silently drop a
  binding, and `.well-known` discovery advertises
  `dpop_signing_alg_values_supported` (ES256).
- A binding mismatch at the token endpoint emits an `oauth.token.dpop_mismatch`
  audit event.
- Config: `oauth.dpop.clockSkewSeconds` (default `120`) — accepted proof-age
  window around the server clock.
- ⚠️ Deployment requirement: proofs bind to the **client-facing** URI, which
  the server reconstructs from `X-Forwarded-Host` / `X-Forwarded-Proto`. A
  deployment accepting DPoP must sit behind a reverse proxy that overwrites
  (never appends to) these headers — see the note in `default-config.yml`.

Client support ships in the `pryv` JS library 3.10.0 (`SignedConnection`,
`OAuth2Client` with `dpop: true`).

### OAuth2: operator key-revocation (`revoke-key`) + key inventory (beta)

When a client's key is compromised, the operator can now kill everything bound
to it, cluster-wide, with one command: `bin/oauth-client.js revoke-key <jkt>
--yes` (where `<jkt>` is the RFC 7638 key thumbprint) writes a platform-wide
tombstone. Revocation is by key **presence**, not epoch: any token bound to the
key dies — including refresh rotations attempted after the revoke — and the
token endpoint refuses to mint or rotate for it. Each core re-reads the revoked
set within `oauth.dpop.keyRevokeCheckSeconds` (default `30`), so live tokens
are cut within that window without any cross-core bus. Rejections use the same
uniform DPoP `403` as a binding failure, so the endpoint leaks no
revoked-vs-not signal. `unrevoke-key` restores; `list-revoked-keys` and
`list-keys [<clientId>]` inspect — the latter joins an advisory per-client
inventory of keys seen at token issuance, so an operator can tell what a
revocation will hit before running it.

### OAuth2: client revocation now reaches live tokens cluster-wide (beta)

`bin/oauth-client.js revoke <clientId>` used to stop new grants while already-
issued access tokens lived out their TTL. Revoking a client now also writes a
platform-wide tombstone carrying the revocation moment; every core rejects
accesses minted before it at validation time, within
`oauth.clientRevokeCheckSeconds` (default `30`). Long-lived transports are
covered too: open socket.io connections are re-validated on a sweep and dropped
when their client is revoked, and the HF series token cache is capped so a
revocation cannot outlive it. The revocation is a token **epoch**: re-registering
the same `client_id` works and its freshly-minted tokens are honoured, but the
tombstone stays, so sessions from before the revoke can never be resurrected.

### OAuth2: `private_key_jwt` client authentication (RFC 7521/7523) (beta)

A confidential client can now authenticate at the token endpoint with a signed
JWT instead of a shared secret — no `client_secret` to distribute, store, or
rotate. Register the client's **public** JWK Set
(`bin/oauth-client.js create|update … --jwks-file <path>` or
`--jwks-json <json>`; EC P-256 / ES256 keys only, and any key carrying private
material is rejected outright), then send
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
+ `client_assertion` on any grant (authorization code, refresh,
client_credentials). The assertion must be ES256-signed by a registered key,
with `iss` = `sub` = `client_id`, `aud` naming the issuer or token-endpoint
URL, `exp` at most 5 minutes out, and a single-use `jti` (replays are rejected
atomically, cluster-wide). Verification failures are answered uniformly, so
the endpoint leaks nothing about why. A client may hold both a secret and a
JWKS; a presented assertion takes precedence and is fully verified. Discovery
now advertises `private_key_jwt` and
`token_endpoint_auth_signing_alg_values_supported: ["ES256"]`. `show` prints
per-key RFC 7638 thumbprints rather than key material.

### OAuth2: an abandoned authorization code no longer leaves its access alive

The access behind an OAuth2 grant is minted when the user accepts, and delivered
at the `/token` exchange. If that exchange never succeeds — the code expires
unexchanged, or the exchange fails after the code is consumed (wrong PKCE
verifier, client-auth failure, DPoP binding failure) — the pre-minted access
used to linger until its own TTL (≤1h). It is now revoked proactively: a failed
exchange revokes it on the spot, and a platform sweep catches expired
unexchanged codes. Best-effort by design — if a revoke attempt fails, the access
still dies by its own TTL, so the previous behavior is the worst case. The
durable consent record (the data-grant) is never touched: only the ephemeral
session credential dies.

Two supporting API-visible changes:
- Session accesses now carry an explicit `{ feature: 'selfRevoke', setting:
  'allowed' }` permission, overriding any `selfRevoke: forbidden` inherited
  from the consent offer. The offer's restriction binds the durable data-grant
  (which keeps it verbatim), not the ephemeral session credential — a client
  may always revoke its own token (RFC 7009), and the server itself relies on
  that to delete orphans.
- `accesses.create` now accepts `setting: 'allowed'` on feature permissions —
  the explicit form of the default (absence has always meant allowed).

### Fixed — a CMC back-channel handshake could be dropped, silently and permanently

`2.0.0-rc.10` began stamping the requester's app-code on the data-grant minted at
acceptance. That activated a guard in the accepter-side back-channel handler
which rejected the delivery whenever the app-code on the grant differed from the
one on the delivery — and the two sides derive that value independently, the
sender falling back to the literal `unknown` when it cannot resolve its own
request scope. A mismatch discarded the only candidate, so the handshake never
completed, `backChannelApiEndpoint` stayed null, and **every subsequent
consent-revocation on that relationship was undeliverable, with nothing logged
and no way to recover short of a fresh request/accept cycle.**

The app-code is now a disambiguator and never a rejector: it selects between
several candidate grants but can no longer eliminate the only one. Relationships
established before this release are unaffected in their selection — the ordering
for every previously-succeeding case is unchanged.

Affects `2.0.0-rc.10` and `2.0.0-rc.11`. Relationships whose handshake was
already dropped do **not** heal on upgrade: nothing re-drives the delivery, so
each affected relationship needs a fresh request → accept.

### Fixed — several relationships with one counterparty under one app

Two concurrent relationships with the same counterparty under the same app-code
were not told apart. The app-code derives from the app scope rather than the
per-request scope, and every resolution site keyed on it, so the newest
relationship was the one they all agreed on: the second handshake's back-channel
overwrote the first relationship's stream pointers, deliveries on the older
relationship were routed to the newer one's streams, and a consent-revocation on
it could not reach the counterparty at all.

Relationships are now keyed on their per-request scope stream (e.g.
`:_cmc:apps:my-app:study-a`) — the one identifier both accounts already share,
since each side anchors its chat and collector streams under it. The inbound
back-channel matcher and every outbound selector resolve through a single shared
function, so which grant serves a relationship cannot be answered two different
ways.

Accepting a relationship also used to name the requester-side back-channel access
per (app, counterparty), so a second acceptance updated the first relationship's
access in place. Names are now qualified by scope, and an existing access is
matched by scope rather than by name — so re-delivery still updates in place
while a genuinely new relationship gets its own.

Backward compatible: grants minted before this release carry no scope field, but
one is derived from the access's own channel permissions; where even that is
absent, resolution falls back to the previous app-code behaviour. No migration is
required, and single-relationship deployments are unaffected.

Relationships whose back-channel was already lost still do not heal on upgrade —
nothing re-drives a delivery that was dropped — so each needs a fresh
request → accept. Deliveries on such a relationship now fail visibly instead of
being silently misrouted.

## 2.0.0-rc.11 — 2026-07-21

### OAuth2: refresh-token reuse detection (chain revoke)

Replaying an already-rotated refresh token — the signature of a stolen token
chain — now revokes the whole chain rather than merely rejecting the call. Each
rotation is shadowed by a short-lived consumed-marker (no credentials stored),
which distinguishes genuine reuse from a token that simply expired or never
existed. A benign double-submit inside a grace window
(`oauth:refreshReuseGraceSeconds`, default 10s) is tolerated without revoking.
Beyond it, the chain is revoked: the durable data-grant and all live OAuth
session accesses for that (user, client) pair — plus their descendants — are
soft-deleted, dependent webhooks are cascaded, the access cache is invalidated
cluster-wide, and a `consent/revoke-cmc` is delivered to the counterparty on a
best-effort basis. The error response is byte-identical whether reuse was
detected or not, so the endpoint cannot be used as an oracle.

### OAuth2: `oauth.*` events reach the audit trail

The nine `oauth.*` audit events are now emitted into the audit subsystem instead
of a no-op stub, gated on `audit:active`. Five user-scoped events
(including the new `oauth.token.reuse_detected`) persist to the user's audit
storage and are readable through the usual `:_audit:*` streams; four user-less
events (`consent.shown`, `consent.refused`, `code.reused`,
`token.issued.client_credentials`) go to syslog only, since they have no user to
attribute. Audit emission never fails a token grant — a backend hiccup is logged,
not propagated.

### Fixed — audit input validation was silently dead

`eventForUser`'s validation could never reject anything: the validators return a
diagnostic *string* on failure, which the guard treated as success. The guard now
trips on any non-`true` result, user-less events are validated against the event
(not the user id), and the real `audit-log/*` type family is accepted — the
previous rule would have rejected every framework event the moment the guard
started working.

### Docs corrected — CMC revoke was never a "dual delete"

`INTERNALS.md` and the CMC implementers guide described revocation as a
server-orchestrated dual delete in which the peer's plugin deletes its half. That
has never been implemented: a revoke tears down only the accesses on the account
where the trigger was written, and the forwarded `consent/revoke-cmc` is
classified as peer-delivered, so the receiving side runs no teardown handler and
its access survives. The docs now state this plainly and instruct integrators to
delete their own half when they observe a revoke arrival. **Revocation is
therefore advisory in the trigger-writer → peer direction**; the enforcing
direction is the local one (an accepter revoking destroys the data-grant on their
own account, which is what cuts the requester's read). Server-side teardown on
the receiving side is planned.

**Correction to the 2.0.0-rc.10 notes below:** they state that the forwarded
revoke's `offerEventId` lets the counterparty "correlate the revocation with the
originating invite". That is wrong — `offerEventId` is the id of the plugin's
internal offer *copy*, not the `inviteEventId` a client holds, and the forwarded
`accessId` is the sender's own id, which the receiver never sees. Carrying a
genuinely matchable identifier is still outstanding (#109).

## 2.0.0-rc.10 — 2026-07-21

### CMC: revocation reaches the counterparty whatever path performs it

Deleting a CMC relationship access with a plain `accesses.delete` (e.g. from a
generic "connected apps" screen) now delivers the same `consent/revoke-cmc` to
the counterparty's `:_cmc:inbox` as the CMC revoke helpers do — consent
withdrawal is observable on the other side regardless of how it was performed
(#109). The forwarded event always carries `content.accessId` (previously
missing, which made the receiving side reject the delivery as schema-invalid),
plus `appCode` / `offerEventId` / `acceptEventId` when resolvable, so the
counterparty can correlate the revocation with the originating invite.

`consent/revoke-cmc` triggers now honour `content.accessId` as the
authoritative selector of the relationship to revoke (the client helpers
already send it): with several relationships to the same counterparty, the
previous (username, host) matching could tear down the wrong one, and triggers
written to a plain app-scope stream (the helpers' default placement) could not
resolve the counterparty at all. A revoke whose `accessId` no longer resolves
fails cleanly (`cmc-revoke-counterparty-access-not-found`) instead of falling
back to a different relationship — so a duplicate revoke after a raw delete
never produces a second inbox event on the peer side.

Data-grant accesses minted at acceptance now carry `clientData.cmc.appCode`
(the requester's app-code), matching what the requester-side back-channel
access has always stored.

The never-functional pre-acceptance revoke branch (`content.capabilityUrl` on
a `consent/revoke-cmc` trigger) was removed: no client emits it — cancelling
an open invite is `consent/invalidate-link-cmc`, declining one is
`consent/refuse-cmc` — and the capability access could not have delivered the
notification anyway. Such a trigger now simply fails with
`cmc-revoke-counterparty-access-not-found`.

### CMC: the `:_cmc:*` namespace now materialises on reads too

An account's reserved CMC streams (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, …)
are created lazily, on the account's first CMC operation. That trigger covered
writes only, so a consumer whose **first** CMC action was a read — typically an
inbox watcher calling `events.get {streams: [':_cmc:inbox']}` — got
`unknown-referenced-resource` on every poll and could never bootstrap:
the read that needed the streams was also the thing that refused to create
them (#111). Reads that reference a `:_cmc:*` stream (plain ids, `{streamId}`
objects, or `{any|all|not}` logical queries) now provision the namespace like
writes do, and so does minting an access carrying an `:_cmc:apps:<app>`
permission (grant-first flows). No configuration is required — the namespace is
never something a deployment has to register.

Because this puts provisioning on a polling path, repeat calls are guarded: a
per-process memo of already-provisioned accounts short-circuits, and on a memo
miss a single stream read decides whether anything needs creating.

### CMC: scope edits made with plain `accesses.update` now reach the counterparty

The same any-path principle applies to scope changes: editing a CMC
relationship access directly with `accesses.update` (no CMC trigger event)
now delivers the `consent/scope-update-cmc` notification to the
counterparty's collectors stream, like the helper flow does. The post-hook
previously targeted the counterparty's `:_cmc:inbox`, which only admits
lifecycle events — the delivery was silently rejected there, so peers never
learned of raw scope edits. The peer endpoint resolution also gained the
same `backChannelApiEndpoint` fallback as the revocation paths.

## 2.0.0-rc.9 — 2026-07-18

### CMC: request a delegable (`app`) data-grant

A `consent/request-cmc` offer may now carry `request.accessType: "app"`
(default `"shared"`). When set, the accepted **data-grant** is minted as a Pryv
`app` access instead of `shared`, so the approved requester can
`accesses.create` scoped, individually-named **sub-accesses** (permissions ⊆ the
grant) — the least-privilege re-delegation pattern with per-actor audit
attribution. `shared` grants (the default) cannot call `accesses.*`; nothing
changes for existing offers or for the OAuth2 flow (whose data-grants stay
`shared`). Any other `accessType` is rejected (`cmc-offer-invalid-access-type`).

## 2.0.0-rc.8 — 2026-07-17

### Fixed — api-server no longer crash-loops on production (`--omit=dev`) builds

`components/api-server/src/routes/oauth2.ts` did a top-level `require('cuid')`,
but `cuid` is a `devDependency` (the codebase uses `@paralleldrive/cuid2`). A
production image built with `npm install --omit=dev` prunes `cuid`, so the
`require` threw at module load and crash-looped every api worker (the core never
served). Switched to the production `@paralleldrive/cuid2`. **rc.7 is dead on
arrival — operators must use rc.8.** (#106)

## 2.0.0-rc.7 — 2026-07-17

### OAuth2 authorization-code flow (server-side)

Pryv can now act as an **OAuth2 authorization server** (RFC 6749 + PKCE / RFC 7636).
Third-party applications obtain access tokens through the standard authorization-code
redirect flow instead of the Pryv-native access-request polling flow (both flows remain
supported). New endpoints: `GET /.well-known/oauth-authorization-server` (RFC 8414
discovery), `GET /oauth2/authorize`, `POST /oauth2/token` (authorization_code,
refresh_token, client_credentials grants). The token response carries a Pryv
`apiEndpoint` extension so multi-core clients build a working connection; vanilla RFC
6749 clients that call the wrong core receive `421` with the correct `coreUrl`.
`Authorization: Bearer <token>` is accepted alongside the bare-token and Basic forms.
Application accounts are registered out-of-band by the operator (`bin/oauth-client.js`;
curated registration only). Short-TTL access tokens plus rotating refresh tokens; nine
`oauth.*` audit event types. Configured under the `oauth:` block (disabled by default).
See `docs/oauth2.md`.

**Granular consent-offer scopes.** There are no coarse wildcard scopes: the `scope`
parameter carries exactly one consent-offer reference (`cmc:<offer-name>`), resolved
through the client registration to an open-link `consent/request-cmc` offer published
by the app's account. The offer's permission set covers the full `accesses.create`
grammar (per-stream levels AND feature permissions such as `selfRevoke`); the consent
screen lets the user untick individual permissions and the minted session access
carries exactly the kept subset. The durable consent record is a cross-account
data-grant access on the user's account: revoking it invalidates the refresh chain
(`invalid_grant`), and narrowing it propagates to the next refreshed access — widening
always requires a fresh authorization. `client_credentials` treats scope tokens as
opaque and always serves the app's own account. Consent event-type schemas
(`consent/*-cmc`) accept the full permission grammar accordingly, and accept triggers
support an optional `grantedPermissions` consent-downgrade subset.

## 2.0.0-rc.6 — 2026-07-11

### Access aliases (`randomAlias`) — de-identifying endpoints

`accesses.create` accepts an optional `randomAlias: true`. When set, the new
access is issued a platform-unique, routable alias (`r-` followed by 8
characters) that replaces the username everywhere the access is addressed: the
returned `apiEndpoint`, and `access-info` (`user.username` reports the alias).
The real username never appears for that access, so accesses handed to
different parties cannot be cross-matched back to one account. The alias routes
to the user exactly like the username (including across cores) and is released
when the access is deleted. The resolved value is returned as the access's
`alias` property.

### Changeable username (`account.changeUsername`)

A new personal-token endpoint `POST /account/change-username` lets a user choose
a new username. Accesses already issued under the previous username keep
working — the old name is kept as a routable alias — and `access-info` for those
accesses reports the new (current) username. The number of changes is capped by
the operator (default 2); `GET /account/username-changes` returns how many
changes have been used, the limit, and how many remain.

### CMC: accept no longer fails permanently on data-grant access-name collision (#105)

Accepting a CMC invite with an `accessName` already used by an existing access
(typical for apps passing a fixed app name on every accept) used to fail
permanently with the raw database duplicate-key message, and the internal
retry loop kept re-attempting an accept that could never succeed. The handler
now retries once with a deterministic per-accept suffix (`<name> (<8 chars of
the accept event id>)`), so distinct accepts never fight over one name. A
re-dispatch of the same accept (after a delivery failure) reuses its own prior
data-grant instead of colliding with it. If the uniquified name still
collides, the accept fails fast with the new typed, non-retryable error id
`cmc-handler-data-grant-name-conflict` — no raw database text is echoed.

### Mail-delivery failures no longer leak internal detail in 500 errors (#104)

When a transactional email (password reset, welcome) fails to send, the API
previously returned a `500` whose message included the configured mail-service
URL and the raw upstream HTTP status or transport error — visible to
unauthenticated callers of `account.requestPasswordReset`. The client-facing
message is now a generic "Sending email failed. Please try again later or
contact support."; the full diagnostic (URL, upstream status/error, SMTP
transport failures) is logged server-side instead.

## 2.0.0-rc.5 — 2026-06-25

### On-demand encrypted backups (`bin/backup.js`)

The full-platform backup tool can now **encrypt its output on demand** so that
plaintext PHI/PII never touches the destination disk — the bytes written to the
backup media are ciphertext only. Encryption is **opt-in**: without the flags
below, backups behave exactly as before (plaintext JSONL, same filenames).

Two key models:

- **Recipient public key (recommended)** — `--recipient-pubkey <pem>`. A fresh
  random data key encrypts the backup and is itself wrapped with the recipient's
  RSA public key (RSA-OAEP, SHA-256). The backup-producing host holds **no secret
  that can decrypt its own output**; only the holder of the matching private key
  can restore (`--private-key <pem>`, plus `--private-key-passphrase` if the key
  is protected).
- **Passphrase** — `--encrypt-passphrase <s>` (or the `PRYV_BACKUP_PASSPHRASE`
  env var, which keeps the secret out of the process list). The data key is
  scrypt-derived from the passphrase. Simpler, but the operator can decrypt its
  own backups. Restore with `--decrypt-passphrase <s>` / `PRYV_BACKUP_PASSPHRASE`.

Format: each file is encrypted independently (streaming AES-256-GCM in
authenticated chunks; a per-file subkey is HKDF-derived from a random salt), so
chunking, `--incremental`, `--no-compress` and single-`--user` restore all keep
working. A small cleartext `encryption.json` at the backup root records the key
model and the wrapped data key — crypto headers only, never user data;
`manifest.json` and every per-user file (including the user manifest and
attachments) are encrypted. Restore auto-detects an encrypted backup from that
file.

Disaster-recovery note: **a lost key (or passphrase) makes the backup
unrecoverable** — that is the point of the feature. For an `--incremental` run
over an already-encrypted backup, supply the matching secret so the tool can read
the previous manifest.

### Optional encryption-at-rest image variant

A new published image variant `pryvio/open-pryv.io-encrypted` adds optional
encryption at rest for the data directories (events, attachments, series, audit,
platform DB). It layers the `container-encrypted-volume` facility onto the stock
image and mounts an encrypted volume inside the container on boot. The base
`pryvio/open-pryv.io` image is unchanged, and the variant is off by default
(`CEV_ENABLED=false`) so it boots identically until opted in. Pluggable backends
(LUKS / gocryptfs) and key providers (env / file / exec / clevis / aws-kms). See
the "Encryption at rest" section of `INSTALL.md`.

### `/service/info` can advertise adapters

`/service/info` may now carry an optional `adapters` array — a list of adapter
base URLs. Adapters are transient converters between Pryv and an external
standard (for example iCalendar). Each URL serves the adapter's web UI and a
`manifest.json` describing its name, type, version and capabilities; clients
fetch `<url>/manifest.json` for the details. `{username}` templating is
supported, as for the `api` field. Fully additive — the field is absent unless
configured.

### BREAKING — CMC trigger writes that mint or widen accesses now require a personal token; revoke is access-permission-gated

Writing `consent/accept-cmc` or `consent/scope-update-cmc` to a `:_cmc:apps:*`
stream now requires the calling access to be **personal**. These two trigger
types mint (`accept`) or widen (`scope-update`) data-grant accesses on the
user's account; requiring a personal token enforces user-presence at the
moment the action is recorded — closing a scope-escalation surface where an
app token with narrow `:_cmc:apps:*` write permission could trigger creation
of a much broader `shared` data-grant access derived from a colluding
requester's offer.

**Revoke uses the standard access-permission gate, not a token-class check.**
`consent/revoke-cmc` is a contraction (deletion), not an escalation — the
access being deleted bounds the impact. The `handleRevoke` orchestrator now
runs `triggerAccess.canDeleteAccess(target)` (the same primitive
`accesses.delete` uses) before deleting each access in the counterparty pair.
This honours the `selfRevoke` feature permission on the target accesses, so:

- a personal token can always revoke (covers everything);
- a relationship's data-grant access can be used by its holder to **self-revoke** the relationship (default `selfRevoke: allow`), without bouncing through `app-web-auth3` — the natural Pryv access-management model;
- an app token that **created** the access can revoke it;
- everything else is rejected with `error.data.id === "cmc-revoke-forbidden"`.

Operators who set `selfRevoke: forbidden` on a counterparty access at mint
time block the self-revoke path explicitly — the existing feature-permission
contract carries over unchanged.

- **Wire-level rejection (accept + scope-update):** non-personal tokens receive
  `HTTP 400 invalid-operation` with
  `error.data.id = "cmc-accept-requires-personal-token"` and
  `error.data.eventType = "<the rejected event type>"`.
- **Wire-level rejection (revoke):** `HTTP 400 invalid-operation` with
  `error.data.id = "cmc-revoke-forbidden"` returned by the orchestrator (the
  trigger event is persisted with `content.status = "failed"` +
  `content.failure.reason = "cmc-revoke-forbidden"`).
- **Un-gated trigger types** are unchanged: `consent/request-cmc`,
  `consent/refuse-cmc`, `consent/invalidate-link-cmc`,
  `consent/scope-request-cmc`, and the chat / system / notification families
  continue to accept any token class with the appropriate stream-write
  permission.
- **Plugin-managed access exemption (accept + scope-update):** the gate passes
  through cross-platform protocol deliveries — capability accesses
  (`clientData.cmc.kind === "capability"`) and counterparty data-grant accesses
  (`clientData.cmc.role === "counterparty"`). The cross-user handshake is
  unaffected.
- **Defense-in-depth chain checks inside handlers** — closing the long-standing
  bypass where `mall.accesses.*` calls skipped what the api-server's routes
  enforce in `applyPrerequisitesFor{Creation,Update}`:
  - `handleAccept` runs `triggerAccess.canCreateAccess(dataGrantPayload)` before
    `mall.accesses.create`.
  - `handleSystemScopeUpdate` runs `triggerAccess.canUpdateAccess(target)` +
    `triggerAccess.canCreateAccess({permissions: mergedPerms, type: 'shared'})`
    before `mall.accesses.update`.
  - `handleRevoke` runs `triggerAccess.canDeleteAccess(target)` (see revoke
    behaviour above) before each `mall.accesses.delete`.

**Upgrade path for apps without a personal token** — adopt the new
`@pryv/cmc.requestAccept` / `requestScopeUpdate` helpers (lib-js ≥ next
minor), which open `app-web-auth3` (≥ next minor) so the user authenticates,
the personal token writes the trigger, and the data-grant apiEndpoint is
returned to the app via popup `postMessage` or `returnUrl` redirect. **No
`requestRevoke` is needed** — apps holding the relationship access can
self-revoke directly via `cmc.revokeAcceptance(...)` / `cmc.revokeRelationship(...)`
without bouncing through the auth pages.

## 2.0.0-rc.4 — 2026-06-18

### Multi-core: non-voter join by default

This release hardens multi-core operations: cores now join the cluster as **non-voters by default**, so adding a core can no longer take an existing core's control plane offline (see CHANGELOG-v2-back.md for the full description and the new `--bootstrap-as-voter` / `bin/bootstrap.js promote-core` operator surface).

(On-demand encrypted backups were listed here until 2026-10; they first shipped in 2.0.0-rc.5 and are described there.)

## 2.0.0-rc.3 — 2026-06-17

### Scoped notifications — filter socket.io + webhook delivery by named scopes

Real-time change notifications can now be filtered to **named scopes** instead of
the coarse "something changed" signal. Each scope is an `events.get`-shaped query
of one resource `kind` (`events` — default, `streams`, or `accesses`). The
delivery carries only the **matched scope key names** — never an id or content.
Fully additive: existing socket clients and webhooks behave exactly as before.

- **Socket.io:** a connection registers scopes over the socket with
  `subscribe({ key, kind, query })` / `unsubscribe({ key | keys | all })` /
  `getSubscriptions`. Matching changes arrive as a single
  `notificationsChanged({ keys: [...] })`. A connection that has registered at
  least one scope receives only `notificationsChanged` (it opted out of the legacy
  `eventsChanged` / `streamsChanged` / `accessesChanged` broadcast); connections
  with no scopes are unchanged.
- **Webhooks:** `webhooks.create` / `webhooks.update` accept an optional `scopes`
  map (`{ <key>: { kind, query } }`); `webhooks.get` / `getOne` return it. A scoped
  webhook fires only when a change matches one of its scopes, delivering the
  matched keys in `messages`. A webhook with no `scopes` keeps firing on every
  change. The webhook POST body shape is unchanged.
- **Query shape:** `events` scopes use the `events.get` filter (`streams` recursive,
  `types`, `content` / `clientData` JSON conditions; optional `state`). `streams`
  scopes watch a stream subtree (a newly-created child of a watched parent matches).
  `accesses` scopes filter by `streams` / `types` / `accessIds` and require a
  **personal** access (account-wide lifecycle, not per-stream data).
- **Security:** every scope is bound at registration to what the token can read
  (the same permission + recursive stream-expansion `events.get` performs); an
  unreadable stream is rejected. When an access is later **narrowed**, its out-of-
  permission scopes are pruned; when an access is **revoked/deleted**, its socket
  connections are dropped.
- **Storage:** PostgreSQL adds a `webhooks.scopes` JSONB column (migration
  included; existing deployments unaffected until they create a scoped webhook);
  SQLite stores scopes in its existing JSON document column.

### BREAKING: HMAC pseudonymisation of PlatformDB rows is now the default (`platform.piiMode: hashed`)

Every PlatformDB identification + uniqueness row is now stored as a
deterministic HMAC-SHA-256 token derived from a cluster pepper, instead
of cleartext. In multi-region clusters, the rqlite Raft ring carries
opaque tokens for usernames (`user-core/`, `user-indexed/`) + every
`isUnique` system-stream field value (default `email`, in `user-unique/`)
— cleartext never crosses jurisdictions as a side effect of the routing
index. Persistent DNS-record subdomains (`_acme-challenge`, `www`, static
infra records) are operator infrastructure names, NOT user PII, so they
stay cleartext. Usernames used as `<username>.<domain>` DNS names resolve
through the hashed `user-core/` mapping, so that path is covered too.
Lookups still work by-value (the writer derives the same HMAC the reader
queries with); the inverse is infeasible without the cluster pepper.

- Closes pryv/open-pryv.io#80 + pryv/open-pryv.io#97.
- **Upgrade path for existing cleartext deployments**: before booting
  rc.3, either (a) set `platform.piiHmacKey` (base64 32-byte pepper —
  same value on every core in a cluster) in `override-config.yml` and
  run `node bin/platform-pii-migrate.js up` to rehash existing
  PlatformDB rows in place, OR (b) explicitly opt out by setting
  `platform.piiMode: cleartext` in `override-config.yml`. New installs
  get a fresh pepper generated by `bin/init.js` automatically.
- Config block: `platform.piiMode: hashed | cleartext` (default
  `hashed`; `cleartext` is a legacy opt-out for single-region
  deployments) + `platform.piiHmacKey` (base64-encoded 32-byte cluster
  pepper, operator-sync responsibility like `letsEncrypt.atRestKey`).
  Bundle schema bumped to v3 to ship the pepper to joining cores.
- Operator tooling:
  - `bin/platform-pii-migrate.js status | up [--dry-run]` — one-shot
    cleartext → hashed cutover of existing PlatformDB rows. Idempotent
    + restartable.
  - `bin/platform-pii-rotate.js up --old-pepper <BASE64>` — rotate
    the pepper end-to-end on a single core (multi-core: run on each
    core in turn). Re-derives HMACs from the home core's user-account
    storage.
- Email → username recovery in hashed mode:
  - `GET /reg/:email/username` + `GET /reg/:email/uid` resolve the
    cleartext username from the user's **home core**. Any node hashes
    the email to find the home core; if that is a different node it
    answers **307** with the home node's URL (`Location` header + a
    `{ server }` JSON body for clients that do not auto-follow
    redirects). The home node reverse-resolves the HMAC token to the
    cleartext username from its own in-region, non-replicated user
    index — cleartext never crosses jurisdictions. Single-core
    deployments resolve locally with no redirect. Unknown email → 404.
  - `auth.cores` with an `email` query single-core surface returns
    `unknown-resource` rather than try a HMAC username against the
    local users index.
  - `/reg/admin/servers/:server/users` returns `username` fields as
    HMAC tokens (admin tooling that consumes this must recognise the
    hashed shape).
- Legal framing: this is **pseudonymisation** under EDPB / WP29
  Opinion 05/2014 — strengthens GDPR Art.32(1)(a) + Art.5(1)(f)
  evidence and ISO 27001 A.8.11 / A.8.24. It does NOT lift the
  requirement for an Art.46 mechanism (SCCs / BCRs) for cross-border
  replication of HMAC'd PII (Recital 26 still applies). See
  `INSTALL.md § PlatformDB PII hashing (multi-region clusters)` for
  the full operator runbook.

### BREAKING: removed the deprecated `GET /audit/logs` route (`audit.getLogs`)

The legacy audit-logs route has been removed. Audit logs are queried through the **Events API** exactly as documented in the [Audit logs guide](https://pryv.github.io/guides/audit-logs/): call `events.get` with the audit streams in the `streams` parameter — `:_audit:` for everything, `:_audit:access-<access-id>` for a given access, `:_audit:action-<method-id>` for a given action. The same access-scoping rules apply (a personal token sees all audit logs; an app/shared token sees only the access it authorizes, plus any `:_audit:access-*` permissions explicitly granted to it).

- The route had no capability the Events API lacks — it was a thin wrapper over the same audit store. Migration is a one-to-one swap of `GET /audit/logs` for `GET /events?streams[]=:_audit:…`; the returned objects are standard audit events (`audit-log/pryv-api` / `audit-log/pryv-api-error`) rather than the old `auditLogs` envelope.
- No official SDK (lib-js) used the route, so no SDK upgrade is required.

## 2.0.0-rc.2 — 2026-06-12

### PostgreSQL attachment storage (low file volume)

- **`storages.file.engine: postgresql`** — event attachments stored as chunked rows (1 MiB) in an `attachment_files` table in the same PostgreSQL instance as user data; no extra service. Completes the diskless shape without an S3 dependency: combined with `storages.platform.engine: postgresql`, every durable byte lives in PostgreSQL and a single `pg_dump` covers the whole deployment.
- Intended for installations where **low attachment volume** is foreseen — attachment bytes inflate the database, its WAL and every backup; the server logs a warning at boot to that effect. Pick the s3 engine for attachment-heavy deployments.
- **Install wizard** — the attachments question now comes before the platform-storage question and offers `filesystem` / `s3` / `postgresql`; the diskless platform option is only proposed once attachments are off the local disk (it previously could be enabled with filesystem attachments, which is not actually diskless).
- **Fix: missing attachment content returns 404 instead of crashing the worker** — `GET /events/<id>/<fileId>` for an attachment whose content is absent from the store crashed the api-server worker with the s3 engine (and would have with postgresql): the attachment-access middleware didn't catch async rejections, and unlike the filesystem engine those engines reject up front. Now a regular `unknown-resource` (404).

### Client-selectable auth page on access requests (`access.trustedAuthUrls`)

`POST /reg/access` accepts an optional **`authUrl`** body field: apps can request that the sign-in popup open THEIR auth page instead of the platform-wide `access.defaultAuthUrl`. Honored only when the URL matches an operator-configured **`access.trustedAuthUrls`** entry (array of URL prefixes) — the endpoint is unauthenticated, so an open passthrough would be a phishing/redirect vector.

- Matching is strict: same protocol, same host(:port), and the path must equal the entry's path or extend it on a `/` segment boundary (`https://a.com/auth` does not trust `https://a.com/auth-evil`, nor `https://a.com.evil.io`); URLs carrying credentials are rejected.
- An `authUrl` that matches no entry (or any `authUrl` when the list is unset) is **rejected with `400 invalid-parameters`** rather than silently falling back — silent fallback is exactly the integration trap this feature removes.
- The same flow query parameters (`key`, `poll`, `lang`, …) are appended to the client page as to the default one; `GET /reg/access/:key` echoes the resulting `authUrl` unchanged.

### Structured JSON log output (`logs.console.format.json` / `LOG_FORMAT=json`)

Console logs can be emitted as one JSON object per line — `{timestamp, level, name, pid, message, context}` — for log collectors and log-based alerting (`WHERE level = 'error'` matches nothing against the human-readable lines). Enable per-config (`logs.console.format.json: true`) or per-run (`LOG_FORMAT=json` env, no config change). Sensitive-value masking (tokens, passwords) applies unchanged; the default human-readable format is untouched.

### Fix: full-platform backup export (`bin/backup.js`) on both engines

- **PostgreSQL:** the per-user events export forwarded the raw driver result object instead of the row array, crashing every full-platform backup on the first user with `Backup export shape mismatch … from "events"`. Events now export as canonical event objects (the exact shape the restore path consumes).
- **SQLite:** backups silently contained **zero events** and restores dropped them (the engine had no events export and a no-op import) — both now wired to the live per-user events store; `--restore` round-trips events on both engines.
- The post-restore `--verify` integrity pass read events the same broken ways (crash on PostgreSQL, silent skip on SQLite) — now engine-agnostic via the same store.
- The admin partial-delete endpoint's guidance message now points at the existing full cascading delete (`DELETE /users/:username` with the admin key, enabled by default via `user-account.delete: ['adminToken']`) instead of claiming none exists.

### Diskless deployment: PostgreSQL platform storage + S3 attachments

Single-core dnsLess deployments in full PostgreSQL mode can now run with **no persistent filesystem on the app host** — every durable byte lives in PostgreSQL and an S3-compatible object store. Verified end-to-end with the app container on a `--read-only` rootfs (tmpfs for caches only).

- **`storages.platform.engine: postgresql`** — platform data (registrations index, user-core map, DNS records, ACME account + TLS certs, observability values, mail templates, invitation tokens, access-request states) is stored in a `platform_kv` table in the same PostgreSQL instance as user data. No rqlited process, no Raft ports, no platform data dir. Boot-time validation refuses the option outside the single-core dnsLess full-PG shape (multi-core keeps rqlite); `check-config` mirrors the same rules.
- **`storages.file.engine: s3`** — new attachment storage engine for AWS S3 / MinIO / Ceph RGW / any S3-compatible store, configured under `storages.engines.s3` (`endpoint`, `region`, `bucket`, credentials or IAM chain, `forcePathStyle`, `keyPrefix`). Streaming multipart uploads; one object per attachment at `<keyPrefix><userId>/<eventId>/<fileId>`.
- **`bin/migrate-platform.js`** — one-shot migration of all platform data between rqlite and PostgreSQL, both directions (`--from/--to`, `--dry-run`, `--force`); adopt the diskless shape on an existing deployment, or move back to rqlite before going multi-core.
- **`bin/config-to-env.js`** (+ `config-to-env` docker subcommand) — converts a YAML config into an env file (`KEY=VALUE`, nested paths joined with `__`, type-exact round-trip) so a deployment can run from `docker run --env-file …` with no config file mounted.
- **Install wizard** — picking dnsLess + postgresql now offers both diskless options; the generated config carries the choices (audit storage follows onto PostgreSQL) or documents them as commented-out appendix blocks when declined, and a sibling `config-to-env.sh` launcher is generated alongside `check-config.sh`.
- **`auth.delete` erases attachments through the storage engine** — account deletion now routes attachment removal through the fileStorage interface, so remote stores (S3) are emptied too; previously only the local user directory wipe covered them (filesystem engine unaffected).
- INSTALL.md gains a "Diskless (PostgreSQL + S3)" section: config recipe, tmpfs guidance for the remaining cache paths, migration runbook, read-only container example.

### Content queries: filter `events.get` by `content` / `clientData`

Two new `events.get` parameters — `content` and `clientData` — each an array of conditions on dot-paths into the corresponding event field, e.g. `[{"path":"drug.codes.atc","in":["G03DA04","B01AC06"]},{"path":"taken","eq":true}]`. Conditions AND together and compose with all existing parameters (`streams`, `types`, time bounds, paging).

- **Operators:** `eq`, `neq`, `in`, `exists`, `gt`, `gte`, `lt`, `lte`, `prefix` (`prefix` covers hierarchical code classes, e.g. ATC `"G03DA"`). Paths use dot-separated segments (`[a-zA-Z0-9_:-]`; colon-namespaced `clientData` keys are queryable) or the reserved `$` addressing the root value of scalar content.
- **Strict JSON-type matching** on both engines: `eq: true` matches JSON `true` only — never `1`, never `"true"`; numbers likewise. A missing path never matches; current event versions only.
- **Always available, indexes optional.** Queries are correct on every deployment with no migration (engines scan). The new platform-wide `storages.contentIndexes` config declares paths to accelerate; the PostgreSQL engine reconciles partial expression indexes against the declaration at startup (created `CONCURRENTLY`, dropped when undeclared). SQLite serves content queries by scan.
- **Capability discovery.** `GET /service/info` advertises `features.contentQueries: true`; custom data stores declare per-field/per-operator support via the new `DataStore.supports` (`@pryv/datastore` 1.1.0), surfaced to clients in the `clientData` of the store's root pseudo-stream (`pryv-datastore:supports`). Conditions aimed at a store without the capability are rejected with `invalid-operation` instead of returning silently-unfiltered results.
- **Errors:** malformed conditions yield `invalid-parameters-format` naming the offending condition; older servers reject the unknown parameters with the same hard 400 signal.
- **lib-js** (`pryv` npm, unreleased branch): conditions pass through `events.get`/`getEventsStreamed`; new `Connection.getLatestByContent(path, values, baseQuery)` (latest event per value, paged — typical form-prefill) and `Service.supportsContentQueries()`.
- **Cross-reference convention:** outbound event references live under the bare `related` key of `clientData` as `{ "<eventId>": "<relation-label>" }`; reverse lookup is an ordinary `clientData` query (`{"path":"related.<eventId>","exists":true}`).

## 2.0.0-rc.1 — 2026-06-03

First Release Candidate of open-pryv.io v2. The runtime has been production-deployed since 2026-04-23 on pryv.me (two-core cluster, 14 real users, 28K events, 264 attachments). lib-js conformance against deployed infra: 168/169 (the missing one is the documented HF case on raw deploys without nginx ingress, see "Known gaps in v2.0.0" below).

### New in `2.0.0-rc.1`: install wizard

```bash
mkdir -p /opt/pryv && cd /opt/pryv
docker run -it --rm -v "$(pwd):/app/pryv" \
  pryvio/open-pryv.io:2.0.0-rc.1 init
```

Interactive single-core install wizard. Hardcodes the in-container mount target to `/app/pryv` (avoids the `/app/config` collision that masks the image's bundled config plugins), auto-discovers the host path from `/proc/self/mountinfo`, and writes three artefacts into the operator's chosen directory:

- `pryv-config.yml` — section-grouped + commented YAML covering service identity, DNS topology (dnsLess or dns-active), HTTP+TLS, Let's Encrypt, auth secrets, app-web-auth3 integration, cluster sizing, and storage engines. Followed by a commented-out optional-sections block (`services.email`, `services.mfa`, `hostings`, `custom.systemStreams`, `observability`, …) operators can uncomment in place.
- `run-pryv.sh` — self-locating launcher (`cd "$(dirname "$0")" && pwd`) that mounts the install dir to `/app/pryv` and runs master.js.
- `check-config.sh` — sibling launcher that validates the config without booting; companion subcommand `check-config <path>` runs the same structural checks (REQUIRED service fields, REQUIRED_WHEN auth secrets, dnsLess vs dns.active, PG creds when applicable).

User-data lives under `<install-dir>/data/` (sibling to the config); the wizard auto-derives this path so the operator answers fewer questions. Both directories ride the same single `-v` mount.

No-arg `docker run pryvio/open-pryv.io` continues to behave exactly as before (boots `bin/master.js`). Anything else passes through (`node --version`, `bash`, …).

### What an implementer pinning to `2.0.0-rc.1` gets

- **Single-binary topology.** One `bin/master.js` process manages API + HFS + Previews workers in one Docker image (`pryvio/open-pryv.io:2.0.0-rc.1`). No more MongoDB, no separate `service-register` / `service-mfa` / `service-mail` containers — all merged into core.
- **Two production-grade user-data engines.** PostgreSQL (default, cross-user queries via shared tables) or SQLite (per-user files, cleaner GDPR Art.17 erasure semantics). Both pass the same 2351-test matrix at parity.
- **Multi-core cluster bootstrap.** `bin/bootstrap.js new-core` issues a passphrase-encrypted bundle on an existing core; new core boots and joins over mTLS-protected Raft. DNS discovery + LE wildcard cert auto-renewal across the cluster, hot-swap via cluster IPC.
- **Built-in observability.** Opt-in New Relic APM provider via `letsEncrypt.atRestKey`-protected secret store (provider façade; second concrete provider plugs in cleanly).
- **Cross-account Messaging & Consent (CMC) plugin.** Federated consent + chat + system notifications between two Pryv accounts. `pryv@3.5.0` + `@pryv/cmc@1.0.1` on npm.
- **Versioned accesses.** `accesses.update` is back with composite-id versioning + audit history; `accesses.getOne` accepts `?includeHistory=true`. socket.io emits `accessUpdated` events.
- **Engine-agnostic schema migrations.** `bin/migrate.js status` / `up` primitive; per-engine `schema_migrations` tracking. Forward-only, integer-versioned, timestamp-named.
- **v1 → v2 migration path.** `dev-migrate-v1-v2` repo + `bin/backup.js --restore`. Production-validated on pryv.me (14 users restored from v1.9.0).

### BREAKING changes since `2.0.0-pre`

Two breaking surface changes have landed since the rolling `:2.0.0-pre` line and the implementer should plan for them up-front. Both have full migration guides below:

- **`/reg/access` polling endpoint response shapes trimmed.** SDK callers using `pryv@>=3.5.0` are unaffected (the SDK speaks the new shape). Pre-3.5.0 SDKs that read `body.url` / `body.returnUrl` / `body.code` / `body.reasonID` need to switch to `authUrl` / `returnURL` / HTTP status / `reasonId`. See the dedicated entry below.
- **MongoDB removed as a user-data storage engine.** Operators running MongoDB-backed deployments must export via `bin/backup.js --export` and re-import into a fresh PostgreSQL (or SQLite) deployment via `bin/backup.js --restore`. See the dedicated entry below.

Additional smaller breaking changes already landed in `2.0.0-pre`: `accesses.create` managed-shared expiry now capped by parent, ID minting algorithm changed cuid v1 → cuid2, `accesses.delete` personal-access no longer cascades, `/reg/hostings` returns slash-terminated URLs. All documented in the per-feature entries.

### Recommended SDK pin

- `pryv@3.5.0` (npm) — handles both `/reg/access` shape changes and the cuid2 ID format.
- `@pryv/cmc@1.0.1` if using CMC.
- `@pryv/monitor@3.5.0` + `@pryv/socket.io@3.5.0` for live updates including the new `accessUpdated` event.

### Known gaps in `2.0.0-rc.1`

- HF-series ingress on raw deploys requires the optional in-process dispatcher (Plan 67) or an nginx vhost (sample at `docs/nginx-ingress-sample.conf`). The deployed-infra lib-js `[CHFA]` case fails without one; the in-process dispatcher closes it for low-volume deployments. Documented in `faq-infra.md`.
- `[ASTE][AS02][TJ8S]` audit time-range test is an intermittent matrix flake (passes in isolation, fires occasionally in the full sequential matrix). Same family as the existing `[ZD22]` baseline noise. Not a runtime bug. Tracked in workspace bug log.
- `[CMCHS-AP][AP01]` CMC back-channel access integrity test is an intermittent matrix flake (~1/2 on test infra; runtime behaviour on deployed infra is unverified pending the RC cut's deploy-validation pass).
- OAuth2 RFC 6749 surface is deferred to post-v2. The current `/reg/access` flow is Pryv-native; OAuth2 will be additive. **(Superseded in a later 2.x release: the OAuth2 authorization-code / PKCE flow shipped additively, along with DPoP, `private_key_jwt` client auth, and token revocation — see the OAuth2 entries above and `docs/oauth2.md`. The `/reg/access` flow remains supported.)**

### Compliance posture

Compliance-matrix work (regulator-row coverage, primitive-citation lattice) is a parallel deliverable. The latest published matrix lives at https://pryv.github.io/compliance-matrix/.

---

## **BREAKING** — `/reg/access` polling endpoint response shapes trimmed

The access-request polling endpoints have been narrowed to expose only the fields each consumer audience actually needs. SDKs (lib-js + downstream apps) get the minimum needed to drive the flow; the auth UI (app-web-auth3 + equivalents) keeps a richer poll response.

### What changed

**`POST /reg/access`** (SDK-facing — create access request):

The response now contains only `{ status, key, authUrl, poll, poll_rate_ms }`. Removed fields: `code`, `url` (was a v1 alias of `authUrl`), `returnUrl` (camelCase duplicate of `returnURL`), `requestingAppId`, `requestedPermissions`, `lang`, `returnURL`, `oauthState`, `clientData`, `serviceInfo`. Echoed inputs and service metadata are reachable via the GET poll path or `/service/info`.

**`GET /reg/access/:key`** (auth-UI-facing on `NEED_SIGNIN`, SDK-facing on terminal states):

- `code` field dropped from the body (it was always the HTTP status, already conveyed by `res.status`).
- `url` (v1 alias of `authUrl`) and `returnUrl` (camelCase duplicate of `returnURL`) dropped.
- `serviceInfo` is now embedded only on the `NEED_SIGNIN` poll — the only response the auth UI actually consumes for that field. SDK polling does not need it (the SDK fetches `/service/info` directly when it wants service metadata).
- `REDIRECTED` responses now emit both `poll` (back-compat with existing SDK rehydration) and a new explicit `redirectUrl` field so consumers don't have to overload `poll`.

**Refused/Error responses** (POST + GET, all forms):

- The `reasonID` field has been renamed to `reasonId` to match the camelCase convention used by the auth UI and by every consumer that actually reads the field. The old `reasonID` spelling never reached any reader and was effectively dead.

### Migration

- SDK callers using `pryv@>=3.5.0` are unaffected — the SDK already speaks the new shapes.
- SDK callers on `pryv@<3.5.0` that read `body.url`, `body.returnUrl`, `body.code`, or `body.reasonID` from `/reg/access` responses must switch to `authUrl` / `returnURL` / HTTP status / `reasonId` respectively, or upgrade.
- Custom auth UIs that depend on `serviceInfo` being present on every poll must read it from the initial `NEED_SIGNIN` poll (still emitted) and cache, or fetch from `/service/info` directly. The `app-web-auth3` build shipped alongside this server release derives a fallback `/service/info` URL from the poll URL.

## **BREAKING** — MongoDB removed as a user-data storage engine

The MongoDB engine has been dropped from open-pryv.io. Supported user-data engines are now **PostgreSQL** (default) and **SQLite** (alternative). InfluxDB remains optional for high-frequency seriesStorage; rqlited remains the only platformStorage.

### What changed at the operator surface

- `storages.base.engine: mongodb` and `storages.engines.mongodb.*` config keys are gone — startup fails with a clear plugin-loader error if `engine: mongodb` is set.
- `STORAGE_ENGINE=mongodb` test harness override is gone.
- The `mongodb` npm dependency is removed from `package.json`; the install footprint shrinks accordingly.
- The `storages/engines/mongodb/` plugin directory is deleted entirely.

### Migration path for existing MongoDB deployments

Use the engine-agnostic backup tool that has been part of the V2 release line:

```bash
# On the MongoDB-backed deployment (this build's predecessor)
bin/backup.js --export --userid <userid>     # exports user data as a JSONL bundle

# On a fresh PostgreSQL-backed deployment of this build
bin/backup.js --restore --bundle <path>      # reads the bundle into PG
```

This is the same path used for the V1→V2 migration and for production MongoDB→PostgreSQL cutovers. Bundles include accounts, streams, events, accesses, profiles, webhooks, and attachments.

### Code-level removals

`components/storage/src/index.ts` drops `getDatabaseSync` + `_ensureMongoDatabase`; test-helpers `dependencies.ts` no longer imports the MongoDB collection classes; `databaseFixture.ts` drops the legacy raw-DB branches; `storages/index.ts` drops the `baseEngine === 'mongodb'` connection bootstrap branch.

### Platform.deleteUser hardening

Shipped alongside the engine removal: `Platform.deleteUser` now discovers PlatformDB entries by username prefix and deletes whatever is present, instead of iterating the mutable `accountStreams.{uniqueFieldNames,indexedFieldNames}` module-level lists at call time. Fixes a latent leak where a fixture user created under one `systemStreams` config couldn't be fully removed after a config change (test-only impact, but the root cause was a production-side fragility).

## SQLite baseStorage — now a complete V2 alternative engine

Counterpart to the MongoDB removal: the SQLite engine is now a real user-data option, not the "not yet implemented" stub that throws at init.

### Engine-choice tradeoff: backup/deletion semantics, not volume

The PG and SQLite engines have **different data-layout shapes**:

- **PostgreSQL** holds all users' data in shared tables keyed by `user_id`. Cross-user queries are cheap; backups via `pg_dump` are a single artefact; a user's data is interspersed with other users' rows in any backup taken before that user's deletion.
- **SQLite** (new) holds each user's data in a **per-user file** at `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`. Deleting a user is an `unlink` — the user's data goes away cleanly, and historical backups that haven't yet included this user (or are taken per-user) don't carry the deleted user's rows by default.

This shape difference matters under **GDPR Art.17 / right-to-be-forgotten** + similar privacy-preserving deletion regimes. Operators with stricter deletion semantics, per-user backup orchestration, or per-user retention policies may prefer SQLite. Operators with high-volume cross-user analytics or who already have PG operational tooling stay on PG. Neither is a "low-volume only" choice.

### What ships under `storages/engines/sqlite/src/`

- **Shared baseStorage SQLite** (`DatabaseSQLite`, `LocalTransactionSQLite`): single file at `<sqlite.path>/_shared/baseStorage.sqlite` for cross-user collections (Sessions, PasswordResetRequests).
- **Per-user baseStorage** (`UserBaseStorageDb` + `BaseStorageSQLite`): per-user file at `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`. Tables for `accesses`, `profile`, `streams`, `webhooks` with minimal schema (id / headId / deleted as columns + JSON `data` column). MongoDB-style query translation (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$type`/`$or`) and update operators (`$set`/`$unset`/`$inc`/`$min`/`$max` with dotted-path nested-object semantics).
- **Collection subclasses**: `AccessesSQLite` (full mirror including integrity-batch delete + `findHistory`/`snapshotHead`), `ProfileSQLite`, `StreamsSQLite` (path computation + treeUtils tree-shape), `WebhooksSQLite` (soft-delete with the same unset list as PostgreSQL).
- **dataStore streams** (`localUserStreamsSQLite`) wired in `localDataStoreSQLite`. Events were already implemented; the engine now ships full dataStore.

Per-test SQLite matrix is clean across `audit`, `business`, `cmc`, `hfs-server`, `mall`, `storages`, etc (1225+ tests passing under `STORAGE_ENGINE=sqlite`). The `api-server` component shares a pre-existing test-helper crash with the now-removed Mongo matrix run (tracked separately) and is verified component-by-component until that is closed.

## `accesses.create` — accepts `:_cmc:*` stream-ids in permissions

`accesses.create` was rejecting permissions referencing the CMC plugin's reserved namespace (e.g. `:_cmc:apps:<app-code>`, `:_cmc:inbox`) with `invalid-request-structure`: *"forbidden character(s) in streamId ':_cmc:...'"*. The auto-create-stream side-effect of personal-access app authorization was hitting the local-store streamId regex (`^[a-z0-9-]{1,100}`), which rejects the leading colon.

The fix skips the auto-create step for `:_cmc:*` stream-ids — the CMC plugin owns provisioning of that namespace (reserved parents auto-provisioned at user creation; user-creatable scopes under `:_cmc:apps:<app>` lazy-provisioned by the plugin or by user-side `streams.create`). Same-shaped permissions on other namespaces (e.g. `:_system:`/`:system:`) are unchanged; truly invalid local stream-ids are still rejected with the same error.

This unblocks app onboarding flows whose `accesses.create` payload mixes local + CMC permissions (e.g. doctor-dashboard via app-web-auth-3, third-party bridges).

Also: the error message for that path is now spelled *"forbidden character(s)"* (was *"forbidden chartacter(s)"*). Clients matching on the message text need to update — matching on `error.id === 'invalid-request-structure'` was always the correct path.

## CMC plugin — features-negotiation now correctly stamped on data-grant `clientData.cmc.features`

Coordinated fix with `@pryv/cmc@1.1.1` (lib-js): the accept handshake now persists the offer-resolved features onto the accepter's data-grant access in `clientData.cmc.features`. Previously the patient-side data-grant ended up with `clientData.cmc.features: null` even when the offer specified default-true values, because the plugin read the negotiated features from the wrong field of the accept trigger (`content.extra`, which is the SDK's user-supplied free-form pass-through) instead of `content.features`.

- **CHANGED** `components/cmc/src/handleAccept.ts`: reads `triggerEvent.content?.features` (was `triggerEvent.content?.extra`). The handler still defaults to `null` when the field is absent, so older `@pryv/cmc < 1.1.1` clients (which don't write `content.features` yet) keep producing `clientData.cmc.features: null` — bump the SDK to get the full negotiation persisted.
- **NO IMPACT** on the offer side (`createInvite` already writes `request.features` verbatim), on doctor-side delivery (`handleIncomingAccept` already mirrors features onto the doctor's inbox event), or on the feature-gating hooks (`handleChat` / `handleSystem` honour `clientData.cmc.features.chat` / `.systemMessaging` exactly as before).

## CMC plugin — security hardening (forge-prevention + reserved-root immutability + internal-stream filtering)

Four route-level guards added to close enforcement gaps in the CMC plugin's `clientData.cmc.*` namespace, reserved-stream lifecycle, peer-side `content.from` stamping, and `:_cmc:_internal:*` visibility. None of these change the wire shape for valid CMC traffic; they add `4xx` rejections for misuse and prune internal events from read responses.

- **NEW** rejection on `accesses.create` / `accesses.update` when `clientData.cmc` is supplied by user code — error id `cmc-clientdata-cmc-forbidden`. The `clientData.cmc.*` namespace (`role`, `appCode`, `counterparty`, `capability`, `requestEventId`, `features`) is populated end-to-end by the plugin via `mall.accesses.{create,update}`; allowing user-supplied values would let a malicious app forge a counterparty role on its own access (bypassing the handshake) or stamp a fake `capability.state`. The CMC plugin's own internal calls go through the mall, bypassing the route hook — no impact on the handshake.
- **NEW** rejection on `streams.delete` when the target is one of the five plugin-auto-provisioned reserved parents (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, `:_cmc:_internal`, `:_cmc:_internal:retries`), under `:_cmc:_internal:*`, or at/under a plugin-managed `chats|collectors` segment of `:_cmc:apps:*` — error id `cmc-reserved-stream-undeletable`. The base permission model (`AccessLogic._canManageStream`) returns `true` for personal accesses, so before this guard a personal token could `DELETE :_cmc:` and silently break every active CMC relationship. User-creatable `:_cmc:apps:<app>:<sub>` streams remain deletable.
- **NEW** `content.from` stamping for non-inbox CMC writes by counterparty-marked accesses. `inboxWriteHook` already stamped from-field on `:_cmc:inbox` writes; the new `cmcCounterpartyFromStampingHook` covers the per-app `chats:*` / `collectors:*` streams so a peer cannot forge `content.from` on `message/chat-cmc`, `notification/alert-cmc`, `notification/ack-cmc`, `consent/scope-request-cmc`, `consent/scope-update-cmc`. The access's stored `clientData.cmc.counterparty.{username, host}` (stamped at handshake from server-derived offer metadata) is the canonical identity that overwrites any user-supplied `from`.
- **NEW** defense-in-depth filter on `events.get` / `events.getOne` / `streams.get` that strips `:_cmc:_internal:*` from query inputs (events.get), returns 404 if a fetched event has any internal `streamIds` (events.getOne — info-leak parity with the existing hidden-system-stream pattern), and prunes the `:_cmc:_internal` subtree from the response tree (streams.get). Today the plugin auto-provisions internal streams with no app-visible permissions so explicit queries return empty anyway; the filter guards against future regressions in the permission system.

## Boot-time `REQUIRED_WHEN` validation — refuse to start on misconfigured feature gates

The boiler's `config-validation` plugin now refuses to boot when a feature-gated configuration key is missing or carries a sentinel value (`REPLACE …`, unresolved `${VAR}`, empty string, `null`). Replaces the previous silent-degradation behaviour — e.g. password-reset emails rendered with a broken `<a href="?resetToken=…">` when `auth.passwordResetPageURL` was absent at request time.

**Upgrade check before `2.0.0-pre.4`** — confirm your `override-config.yml` (or the platform-issued bootstrap bundle) sets:

| Key | Required when |
|---|---|
| `auth.adminAccessKey` | Always |
| `auth.filesReadTokenSecret` | Always (multi-core bootstrap bundles already set this; single-core deploys had no equivalent guard) |
| `auth.passwordResetPageURL` | `services.email.enabled` is `true` OR `services.email.enabled.resetPassword !== false` |
| `letsEncrypt.atRestKey` | `letsEncrypt.enabled: true` |
| `letsEncrypt.email` | `letsEncrypt.enabled: true` |

If any of these were unset or carried a `REPLACE_WITH_…` sentinel on `2.0.0-pre.3`, the core will exit with a non-zero status on `pre.4` boot. The error log names every missing key in a single pass so the fix is one config edit + one restart.

Pryv.me production (use1 + euc1) and HDS production deploys (api-ch1, demo-api-se1) have all five keys populated — no operator action expected. Dokku quickstart / `INSTALL.md` deploys that booted with `default-config.yml` placeholders left in place will need to fill them in before upgrading.

Follow-up to PR #71 (see "Password-reset email" entry below) — the request-time fallback shipped in `pre.3` has been removed; boot-time `REQUIRED_WHEN` makes it structurally unreachable in valid deployments.

## Password-reset email: robust against late-bound `auth.passwordResetPageURL`

> Superseded as of `2.0.0-pre.4` — the request-time fallback documented here was removed and replaced by the boot-time `REQUIRED_WHEN` check above. The `RESET_LINK` Pug substitution is retained.

The `account.requestPasswordReset` mail-sending step now re-reads `auth.passwordResetPageURL` from the config store at request time instead of relying on the module-init `auth` slice capture. The captured slice can be missing values populated later by override-config or extraConfig plugins; when that happened, the Pug template rendered `<a href="?resetToken=…">` — a relative URL with no scheme/host that Outlook/Apple Mail QuickLook silently dropped, leaving the user with an invisible link. Observed in HDS production.

- **Re-read at request time** with a fallback to the captured value (back-compat). — *removed in `pre.4`; the boot-time check above replaces it.*
- **Warn at request time** when `auth.passwordResetPageURL` is missing, so operators see a clear server-side signal instead of debugging from user inboxes. — *removed in `pre.4`; the boot-time check above replaces it.*
- **NEW Pug substitution `RESET_LINK`** — pre-composed full URL (`passwordResetPageURL + '?resetToken=' + encodeURIComponent(token)`). Existing templates that use the two-substitution form `#{RESET_URL}?resetToken=#{RESET_TOKEN}` keep working unchanged; new/updated templates can switch to the single `#{RESET_LINK}` form for robustness against the same class of bug.

## Cross-account Messaging & Consent (CMC plugin)

**Public-facing namespace addition.** The api-server now reserves the `:_cmc:` stream-id namespace for the Cross-account Messaging & Consent plugin. Reserved roots auto-create on-demand at first use; per-app and per-counterparty sub-streams are auto-created by the plugin at acceptance time.

- **NEW reserved namespace** `:_cmc:` — five auto-managed parents:
  - `:_cmc:` (root), `:_cmc:inbox` (one-shot lifecycle, cross-app), `:_cmc:apps` (user-creatable app scopes), `:_cmc:_internal` (plugin-managed), `:_cmc:_internal:retries` (retry queue events).
  - Apps freely create their own app-scope sub-trees under `:_cmc:apps:<app-code>:[<user-path>:]`. The plugin auto-creates `chats` and `collectors` segments below the trigger's stream at acceptance — these names are reserved as plugin-managed.
- **NEW event types** (validated by the api-server's CMC content-validation hook):
  - Lifecycle: `consent/request-cmc`, `consent/accept-cmc`, `consent/refuse-cmc`, `consent/revoke-cmc`.
  - Chat: `message/chat-cmc` (per user-pair stream under the app scope).
  - System channel: `notification/alert-cmc`, `notification/ack-cmc`, `consent/scope-request-cmc`, `consent/scope-update-cmc`.
- **NEW events.create write-hooks**:
  - `cmc-content-validation` — validates `content` against the per-type schema.
  - `cmc-capability-mint` — on `consent/request-cmc`, mints a single-use capability access + per-capability offer / responses streams, stamps `content.capabilityUrl` + `content.capabilityExpiresAt` + `status: 'pending'`.
  - `cmc-inbox-write` — for writes on `:_cmc:inbox` only: validates the access's `clientData.cmc.role === 'counterparty'`, restricts to lifecycle event types, and **server-stamps `content.from` from the access's stored counterparty identity** (unforgeable — any client-supplied `content.from` is overwritten).
  - `cmc-dispatch` — fire-and-forget orchestration loop that fires post-create for every `cmc/*` event: type-routes to the right handler, performs local state changes + outbound HTTPS delivery to the peer, updates the trigger event's `content.status` (`pending → delivered → completed | failed`), and pushes `pubsub.USERNAME_BASED_EVENTS_CHANGED` so the app's socket.io subscription sees every status flip.
- **NEW accesses.update post-hook** — auto-notifies CMC counterparties when a scope-changed access is detected. Writes a local audit event under the user's collectors stream + delivers `consent/scope-update-cmc` to the peer via the access's stored apiEndpoint. The hook is suppressed when the update is initiated by a CMC handler (AsyncLocalStorage-based, runWithSuppression).
- **Federation**: cross-platform AND cross-core deliveries take the standard HTTPS path with the access token in the apiEndpoint URL. No mTLS, no shared CA, no federation auth needed.
- **Retry queue**: zero new storage primitive — retry events live in `:_cmc:_internal:retries` with exponential backoff (1s → 5s → 25s → 125s → 600s cap, max 6 attempts) before being marked `failed-permanent` for operator review.
- **Backwards-compat**: nothing legacy is changed; deployments that don't use CMC see the namespace as inert. No migration required.

See `components/cmc/README.md` for the canonical design, `IMPLEMENTERS-GUIDE.md` for app integration, and `INTERNALS.md` for the orchestration flow diagrams.

## Audit + socket.io for versioned accesses (Plan 66 Phase E)

- **NEW** every audit row written under a **versioned** access (one whose `serial` is non-null) now carries **two** access-stream ids: the bare `access-<base>` (unchanged shape) AND the composite `access-<base>:<serial>` (specific contract version). Audit queries by `streamIds: ['access-<base>']` keep returning every record across all versions — fully backwards-compatible. New version-specific queries can target `access-<base>:<K>` directly. Never-updated accesses keep emitting only the bare streamId, so this is a no-op until `accesses.update` is first invoked.
- **NEW socket.io event** `accessUpdated` — fired on the user's socket.io namespace right after a successful `accesses.update`, alongside the existing coarse-grained `accessesChanged` event. The new event carries a structured payload `{ type: 'access-updated', accessId: '<base>:<serial>', serial }` so fine-grained subscribers can react to a specific update without refetching. The legacy `accessesChanged` event continues to fire (arg-less) for any access change — existing SDK consumers keep working unchanged.
- **Why the dual emission**: Plan 66 §7.1 — coarse-grained event for backwards compat, fine-grained event with serial for new consumers that want to act on the specific update. Token-scoped notification (broadcast to the shared-access recipient on a separate device) remains out of scope; backlogged at `XXX-Backlog/SCOPED-NOTIFICATION.md`.

## `accesses.getOne` + composite-id wire format applied (Plan 66 Phase D)

- **NEW** `GET /accesses/:id` → `accesses.getOne`. Returns the access identified by the path id. The id can be either bare `<base>` (returns the current head) or composite `<base>:<serial>`:
  - composite matching current serial → current head.
  - composite for an older serial → the historical snapshot row + a `current: '<base>:<currentSerial>'` hint pointing at the live head. Mirrors GitHub's `GET /repos/X/Y/commits/<sha>` behaviour for ref-by-version.
  - composite for a serial that never existed (or bare on a versioned access whose serial doesn't match) → `404 unknown-resource`.
- **NEW** `accesses.getOne ?includeHistory=true` — opt-in flag (default `false`, mirrors `events.getOne`). When set, the response includes a `history: [...]` array of every historical snapshot in chronological order (oldest first). Each history entry uses the composite id of the frozen version. The list endpoint `accesses.get` does NOT take this flag today (singular case covers the typical "audit this access" use case; list-side support is intentionally deferred).
- **Composite wire format now consistently applied.** Every `accesses.*` response (get, getOne, create, update, checkApp, accessDeletions) now serialises `id`, `createdBy`, and `modifiedBy` using the new composite format when a corresponding `serial` exists in storage. Never-updated accesses still serialise as bare cuids — fully backwards-compatible. The previously-internal `serial` / `createdBySerial` / `modifiedBySerial` fields are kept off the wire (stripped at the api-server seam to stay within the schema's `additionalProperties: false` whitelist).
- **App visibility on `getOne`:** an `app` caller can fetch only its own access (self) or shareds it directly manages (chain match by `base`). Other accesses return `unknown-resource` — no info leak via differentiated error.
- **`accesses.checkApp` unchanged in semantics**: still matches against current heads only (no opt-in for historical matching). Plan 66 Q12.3=a — the whole point of revoking/narrowing is the app loses scope, not that it can silently re-claim it.

## `accesses.update` is back — versioned, chain-checked, composite-id (Plan 66 Phase C)

- **NEW** `PUT /accesses/:id` — `accesses.update` is no longer a `goneResource` stub. It mutates the head row, snapshots the prior state into history (single-collection `headId` shape), and bumps the access's `serial`. The returned access carries the new wire-format composite id `<base>:<serial>` (or bare `<base>` when never updated).
- **Mutable fields:** `name`, `deviceName`, `permissions`, `expireAfter` / `expires`, `clientData`. Immutable: `token`, `type`, `createdBy`, `id`, `lastUsed`, `created`, `modified`, `modifiedBy`. Sending any field outside the mutable whitelist returns `invalid-parameters-format`.
- **Who can update what:** `personal` accesses are immutable (no caller can update them). An `app` access can update only the `shared` accesses it directly manages (chain match by `base`, so a future-versioned app still matches). `shared` accesses cannot update anything. No self-update is permitted via this method (selfrevoke stays available via `accesses.delete`).
- **Chain rules enforced on update:**
  - **A** — a managed `shared`'s new `permissions` must remain a subset of its managing `app`'s permissions.
  - **B / C** — narrowing an `app`'s permissions (or `expires`) is strict-rejected if any of its managed shareds would now sit outside the new scope or outlive the new expiry. Error includes `data.offendingChildren: [ids]` so the caller can resolve children first and retry.
  - **D** — a managed `shared`'s `expires` cannot exceed its managing `app`'s `expires` (parent with `expires: null` imposes no cap).
- **Composite-id conflict (NEW error)** — `accesses.update` and `accesses.delete` now require the caller's id to match the current head's `serial`. A stale composite returns **`409 stale-resource`** with `data: { provided, currentSerial }`; refetch the access and retry with the current head id. Bare `<base>` is only valid on a never-updated access; the same `409` fires if the access has since been versioned.
- **Soft-deleted access → `unknownResource`** — no info leak via differentiated error.
- **NEW pubsub event** — every successful update emits both `USERNAME_BASED_ACCESSES_CHANGED` (existing, backwards-compat) and `ACCESS_UPDATED { accessId: '<base>:<serial>', serial }` on the owner's channel. Recipients of shared-token credentials see the new scope on their next API call (token-scoped notification is out of scope, backlogged at `SCOPED-NOTIFICATION.md`).
- **Cache invalidation** — `cache.unsetAccessLogic` fires for the updated base alongside the storage write, parallel to the existing `accesses.delete` pattern. Auth-by-token lookups observe the new permissions immediately.
- **Composite-id conflict also on `accesses.delete`** — `DELETE /accesses/:id` validates the same way; pass the composite id you last read or accept a `409 stale-resource`. The subsequent delete path still operates on the bare base internally.

## `accesses.create` — managed shared expiry now capped by parent (Plan 66 Phase B, BREAKING)

- **BREAKING** When an `app` access creates a `shared` access scoped under it, the new shared's `expires` (resolved from `expireAfter` if provided) now cannot exceed the managing app's `expires`. Violations return `invalid-operation` with `data: { parentExpires, requestedExpires }`. This was previously allowed and would silently produce a shared access that outlived its managing parent — confusing audit and breaking the symmetry with `accesses.update`'s chain rules.
- **Edge case unchanged**: when the managing access has no `expires` (e.g. typical personal-issued app accesses), no cap applies. Practically this means the vast majority of integrations — which create accesses with `expireAfter` under a personal token — are unaffected.
- **What to change**: integrations that issue shared accesses with a longer lifetime than the managing app must instead extend the managing app's expiry first (or reissue both).
- **Why now**: Plan 66 introduces `accesses.update` with the same chain rule, and applying it only on update would have produced asymmetric behavior. Retrofitting `create` is the consistency call.

## High-frequency series — in-process dispatch from the public port

- **CHANGE** `POST /<user>/events/<id>/series` and `POST /<user>/series/batch` are now reachable on the **same public port** as the rest of the API (typically `:443` or `http.port`), routed in-process to the HFS worker on `:4000` by a dispatcher in front of api-server. Previously these endpoints only worked if (a) clients reached port `:4000` directly, or (b) an external reverse-proxy (nginx etc.) routed them. Setting `cluster.hfsWorkers: 1` is sufficient — no extra ingress required.
- **CHANGE** SDKs that read `features.noHF` on `/service/info` short-circuit cleanly when the deployment isn't serving HF (i.e. `cluster.hfsWorkers === 0` and no explicit `service.features.noHF: false` override). Combined with this in-process dispatcher, the previous opaque "Failed loading serie: undefined" failure mode no longer occurs on either path: HFS is either reachable on the same port as the API or explicitly advertised as unavailable.
- **Deployment notes**: this is the **quick / out-of-the-box** ingress for raw deploys (`node bin/master.js` under systemd, etc.). For long-term high-throughput installs, front the cluster with nginx — a reference vhost ships under `docs/nginx-ingress-sample.conf`. nginx is more efficient and unlocks edge features (rate-limiting, header munging, static assets); the in-process dispatcher stays present but is bypassed because external traffic doesn't hit it.
- **Why**: customers running raw deploys (no Dokku, no nginx) and wanting HF were previously stuck with workers that started cleanly on `:4000` but were unreachable from outside the host. The Dokku-flavoured installs sidestepped this with a per-app nginx snippet; raw deploys had no equivalent. The in-process dispatcher closes that gap.

## `accesses.delete` — personal-access delete no longer cascades

- **CHANGE** `DELETE /accesses/:id` on a `personal`-type access no longer cascade-deletes the app/shared accesses it created (the ones with `createdBy === <that personal access id>`). The response's `relatedDeletions` is empty/absent in that case, and the descendant accesses survive in storage.
- **Unchanged** for `app` and `shared` deletes: cascade still applies — every descendant access (filtered to not-self + not-expired) is included in `relatedDeletions` and removed alongside the parent.
- **Why** the in-source comment ("deleting a personal access does not delete the accesses it created") has been the documented intent since 2023, but an operator-precedence typo (`!type === 'personal'` parses as `(!type) === 'personal'` → always false) made the early-return branch dead and personal deletes silently cascaded. Personal access tokens are session tokens; cascading on session-delete wiped out every app/shared the user had granted while logged in, which surprises users on logout/session-rotation flows. Comment and behavior now match.
- **Migration note** for callers that relied on the cascade-on-personal-delete behavior: explicitly delete each child access (`DELETE /accesses/:childId`) before deleting the personal access, or use `app`/`shared` deletes which still cascade.

## `audit.syslog.active` defaults to `false`

- **CHANGE** `config/default-config.yml`: `audit.syslog.active` now defaults to `false`. Operators on bare-metal hosts with a syslog daemon listening on `/dev/log` (rsyslog / journald) who want the host-syslog mirror must set `audit.syslog.active: true` in `override-config.yml`. The per-user audited streams (`audit.storage.*`) are unaffected — the existing audit data path keeps emitting unchanged.
- **Why**: containerized deploys are now the dominant install shape and typically have no syslog daemon. The previous default crashed api-server workers on the first audited request (`ENOENT` from `sendto(2)` on a missing socket path bubbled to `uncaughtException` because `winston-syslog` emits `'error'` with no listener). The transport now also has a defensive `'error'` listener that downgrades these to a `warn` log line, so accidental misconfiguration no longer crashes workers regardless of this flag.

## `POST /system/admin/certs/force-renew` — admin route

- **NEW** `POST /system/admin/certs/force-renew` — triggers an immediate ACME renewal of the cluster's TLS cert, bypassing the daily `renewBeforeDays` check. Body `{ "hostname": string? }` (optional — defaults to the configured primary hostname). Response on success: `200 { ok: true, hostname, issuedAt, expiresAt }`. Response on operator-grade failure: `400 { ok: false, error: string }` (e.g. core is not the renewer, ACME upstream rejection, timeout). Auth: `auth.adminAccessKey` via the `Authorization` header (unauth → 404, same contract as every other `/system/*` route).
- **BEHAVIOUR**: only the core configured with `letsEncrypt.certRenewer: true` runs the renewal; calling the route on a non-renewer core returns `400 { error: "core is not the renewer" }`. Newly-issued cert + account material is replicated to peers via the existing rqlite `tls-cert/<hostname>` keyspace, hot-swapped into the running `https.Server` via `setSecureContext` IPC, and materialized to disk by every core.
- **TIMEOUT**: master replies within 180 s — long enough to absorb DNS-01 propagation + LE issuance round-trip in normal conditions. A timeout returns `400` with an `error` describing the upstream failure mode.
- **Why**: previously operators had to wait until the cert hit `renewBeforeDays` or stop+restart the renewer with a clock skew to force an early renewal. Useful for incident response (compromised key, hostname change, missed expiry alarm) and for drilling the renewal path in staging.

## `bin/bootstrap.js init-ca-holder` — new subcommand

- **NEW** `node bin/bootstrap.js init-ca-holder` mints the CA-holder core's own cluster-CA-signed node cert + key and merges `storages.engines.rqlite.tls.{caFile,certFile,keyFile,verifyClient:true}` into `override-config.yml`. Operators promoting a single-core deploy to multi-core run this once on the existing core before issuing the first `new-core` bundle to a peer.
- **Flags**: `--ca-dir <path>` (default `/etc/pryv/ca` or `cluster.ca.path`), `--tls-dir <path>` (default `/etc/pryv/tls` or `http.ssl.tlsDir`), `--no-write-config` (skip the override-config merge if you want to manage TLS pointers by hand).
- **Idempotent**: re-running on a host that already has CA + TLS material + matching config exits with `(existing)` notes and no rewrites — safe to script.
- **Why**: previously the CA-holder core's rqlited served plain TCP while joiners' rqlited tried mTLS with `verifyClient:true`, so cluster formation stalled until the operator hand-minted the holder's cert (the Plan-36 one-off `issue-use1-cert.js` workaround). Now the same code path that joiners use produces the holder's cert.

## Bootstrap bundle now propagates `letsEncrypt.atRestKey`

- **CHANGE** `bin/bootstrap.js new-core` reads `letsEncrypt.atRestKey` from the issuing core's resolved config and embeds it in the encrypted bundle. The joining core's `bin/master.js --bootstrap` writes it into `override-config.yml` automatically — operators no longer need to copy the value into every core's config by hand.
- **Backwards-compat**: when the issuer hasn't set `letsEncrypt.atRestKey` (or it's still on `REPLACE ME`), the field is omitted and operators continue to sync by hand. Existing clusters bootstrapped before this change keep working unchanged.
- **Operator caveat**: once `atRestKey` is set on a cluster, every core must agree forever; rotating it would require re-encrypting every cert + ACME-account row in rqlite. Losing it means re-issuing every LE cert.
- **Why**: removes one operator-sync step + a class of bugs where two cores ended up encrypting cert rows with different keys, blocking cross-core decryption.

## `/reg/hostings` — `availableCore` URLs are now slash-terminated

- **CHANGE** `GET /reg/hostings` response: every `regions.<region>.zones.<zone>.hostings.<h>.availableCore` now ends with `/`, matching the long-standing `serviceInfo.{register,api,access}` convention. Empty-string for unavailable hostings is unchanged.
- **CHANGE** `GET /reg/cores` response: `core.url` is also slash-terminated. Same convention.
- **CHANGE** wrong-core 421 response (`error.coreUrl`) follows the same convention.
- **Client compatibility**: clients that did `host + 'users'` previously produced `https://single.example.devusers`. Doing `host + 'users'` now produces `https://single.example.dev/users` — the *intended* behaviour. Clients that pre-strip-and-re-add the trailing slash continue to work unchanged.
- **Why**: a deploy session surfaced the malformed-URL pattern (`https://single.api.datasafe.devusers`) on a fresh single-core; same drift was confirmed on `reg.pryv.me`. Centralized in `Platform.coreIdToUrl()`.

## ID minting algorithm — cuid v1/v2 → cuid2

- New event / stream / access / webhook / session / password-reset IDs are now minted with `@paralleldrive/cuid2`. Format is **24 lowercase alphanumeric characters, first char a letter, no prefix** — distinct from the legacy cuid v1/v2 format (`c` prefix + 24 chars, 25 total).
- Existing IDs in production databases remain valid; this is purely a forward-going change.
- **Client compatibility**: clients that locally validate IDs against the legacy `^c[a-z0-9-]{24}$` pattern need to relax their regex to accept the new shape too. The recommended permissive pattern is `^([a-z][a-z0-9]{23}|c[a-z0-9-]{24})$`. Server-side schema validation already accepts both.
- **Why**: the original `cuid` package is deprecated by its author in favour of cuid2; cuid2 has cluster-aware entropy and a stronger collision profile.

## 2.0.0-pre — Publication as open-pryv.io

### In-process mail delivery — optional replacement for the external service-mail process

- **NEW**: `services.email.method: in-process` — render + send welcome + reset-password emails inside the api-server workers, no separate `service-mail` process. Templates live in PlatformDB, cluster-wide.
- **CONFIG** (unchanged back-compat path) — `services.email.method: microservice` keeps calling the external `pryv/service-mail` over HTTP for deployments that still run it. Default stays `microservice` in this release; a follow-up release flips the default to `in-process` once both modes have had production exposure.
- **CONFIG** — `services.email.{smtp,from,defaultLang,templatesRootDir,welcomeTemplate,resetPasswordTemplate,enabled}`. SMTP creds + sender stay per-core in `override-config.yml` (operator-local, not replicated); template content lives in PlatformDB (cluster-wide, rqlite-replicated).
- **NEW**: admin HTTP API under `/system/admin/mail/` for editing templates without a deploy:
  - `GET /system/admin/mail/templates` — list `[{type, lang, part, length}]`.
  - `GET /system/admin/mail/templates/:type/:lang/:part` — raw Pug source (`text/plain`).
  - `PUT /system/admin/mail/templates/:type/:lang/:part` — body `{ pug: string }`; triggers cross-worker refresh.
  - `DELETE /system/admin/mail/templates/:type/:lang/:part` — removes one part; `DELETE .../:type/:lang/` (no part) wipes both html + subject for that lang.
  - `POST /system/admin/mail/send-test` — body `{ type, lang, recipient }` — triggers a real SMTP send with stub substitutions. Handy for smoke-testing a new template.
  - Auth: `auth.adminAccessKey` via the `Authorization` header. Unauthorized requests return 404 (same contract as every other `/system/*` route — deliberate, to avoid advertising the surface).
- **NEW**: `bin/mail.js` standalone admin CLI — same shape as `bin/observability.js`. Subcommands: `templates list`, `templates get <type> <lang> <part>`, `templates set <type> <lang> <part> --file <path>`, `templates delete <type> <lang> [part]`, `templates seed --from <dir>`, `send-test <type> <lang> <recipient>`.
- **BEHAVIOUR** — in-process mode uses `nodemailer` under the hood. `smtp.sendmail: true` + `smtp.path: /usr/sbin/sendmail` supported for dev. High-frequency mail (bulk) is still out of scope; fail-fast semantics unchanged (existing callers treat mail failures as non-fatal).
- **DOC**: [Email configuration](https://pryv.github.io/customer-resources/emails-setup/) rewritten for both modes, with the PlatformDB keyspace + CLI + admin-API + cluster propagation notes.

### Optional observability (APM) — New Relic as first provider

- **NEW**: opt-in observability layer with a provider-agnostic façade (`components/business/src/observability/`) and a single concrete provider today — **New Relic**. Other backends (Datadog / OpenTelemetry / Sentry) can be added later without touching business code or the admin CLI base.
- **CONFIG** (PlatformDB keyspace `observability/*`, cluster-wide, AES-256-GCM encrypted at rest for secrets):
  - `observability.enabled` — boolean. Default off.
  - `observability.provider` — `"newrelic"` (only option in this release).
  - `observability.appName` — cluster-wide label. Defaults to `open-pryv.io (<dns.domain>)`.
  - `observability.logLevel` — `error` | `warn` | `info` | `debug`. **Default `error`** — only errors ship to the provider; raise explicitly to capture warns/info during incidents.
  - `observability.newrelic.licenseKey` — ingest license key. Encrypted via HKDF-derived key from `auth.adminAccessKey`.
- **CONFIG**: local `observability.enabled: false` in `override-config.yml` always wins over PlatformDB — emergency kill-switch for a single misbehaving core.
- **NEW**: `bin/observability.js` admin CLI — standalone (no HTTP dep), manages PlatformDB directly. Subcommands: `show`, `enable <provider>`, `disable`, `set-log-level`, `set-app-name`, `newrelic set-license-key`. License key value never echoed.
- **BEHAVIOUR**: reported APM hostname = `new URL(core.url).hostname` (e.g. `core-use1.pryv.me`) — matches `/reg/hostings`, LE cert SAN, and operator dashboards. No separate "APM host name" field to curate.
- **BEHAVIOUR**: agent enforces `high_security: true`. Authorization / cookie / proxy-authorization headers and request bodies are never forwarded to the provider.
- **DEPENDENCY**: `newrelic` added under `optionalDependencies`. Installs that can't fetch it still succeed; observability simply refuses to activate.
- **DOC**: [Observability (APM)](https://pryv.github.io/customer-resources/observability/) — operator guide covering enable / rotate / log levels / disable / NRQL validation queries.

### Multi-core registration + `/service/info` + `/reg/access` (dnsLess=false)

- **BEHAVIOUR**: Cross-core `POST /users` is now a server-side transparent HTTPS forward — landing core HTTPS-proxies the POST to the selected hosting's core and returns its response verbatim. Clients receive a single normal registration response (`{username, apiEndpoint}`) regardless of which core DNS round-robin directed them to. The legacy `{core: {url: …}}` redirect response shape is no longer emitted in multi-core mode; v1-era SDKs that relied on re-POSTing should be updated to ignore `res.body.core` — the new shape is compatible (target's response has no `core.url`).
- **NEW**: `service.version` field in `/service/info`. Populated from the server's API version (e.g. `"2.0.0-pre.2"`). SDKs (lib-js, app-web-auth3) read this to select the direct-core `/users` registration endpoint. Older SDKs without the gate fall back harmlessly.
- **CHANGED (multi-core only)**: `/service/info`'s `register` and `access` URLs now use the distribution-reserved subdomains — `register: https://reg.{domain}/`, `access: https://access.{domain}/access/` — instead of the core-specific FQDN. The embedded DNS auto-publishes `reg.{domain}`, `access.{domain}`, `mfa.{domain}` to every available core, so these URLs are core-symmetric and load-balanced by DNS. `dnsLess.isActive: true` deployments are unchanged.
- **NEW (multi-core only)**: `GET /service/info` at the root of reserved subdomains (e.g. `https://reg.{domain}/service/info`, `https://access.{domain}/service/info`). Alias for `/reg/service/info`. Lets SDKs bootstrap from the register subdomain directly without knowing the `/reg/` path prefix.
- **NEW (multi-core only)**: Hostname-path mapping — requests to `reg.{domain}/<path>`, `access.{domain}/<path>`, `mfa.{domain}/<path>` are handled as `/reg/<path>` internally. Lets clients use v1-style rootless URLs (`reg.pryv.me/perki/server`) while the internal routing stays under `/reg/*`. Idempotent — clients that still send the `/reg/` prefix continue to work.
- **CHANGED**: `POST /reg/:uid/server` now looks up the user's home core via the replicated PlatformDB (`user-core/<username>`) instead of the per-core SQLite index, so any core in a multi-core cluster answers correctly. Returns 404 with `unknown-user` when no mapping exists, same shape as before.
- **CHANGED**: `POST /reg/access` response includes `authUrl` (popup sign-in URL, built from `access.defaultAuthUrl` + query params) alongside `status`, `key`, `poll`, and `poll_rate_ms`. `poll` is built from the local `core.url` rather than the cluster-wide `service.register`, making it core-affine: subsequent poll GETs reliably hit the core that owns the in-memory state.
- **CHANGED**: `GET /reg/access/:key` NEED_SIGNIN response also includes `poll`, `authUrl`, `lang`, `returnURL`, and `serviceInfo`. Clients that re-hydrate their state from the poll body (some lib-js / app-web-auth3 code paths) now see a complete state shape.
- **CONFIG (multi-core only)**: `service.{name,serial,home,support,terms,eventTypes}` are now **required** — master fails fast at startup with a clear "Configuration is invalid at [service]" error listing the missing fields. Previously a missing `service:` block resulted in an api-server crash loop with no surfaced cause.
- **CONFIG**: `access.defaultAuthUrl` — URL of the deployed auth UI (e.g. `https://pryv.github.io/app-web-auth3/access/access.html` for the public static build, or your own fork). Populated into the `authUrl` field of `/reg/access` responses.
- **CONFIG**: Unresolved `${VAR}` env-var placeholders in any config string now fail startup fast with a clear error naming the missing variable. Previously `path: "${PRYV_LOGSDIR}/api-server.errors.log"` with `PRYV_LOGSDIR` unset would silently create a literal `${PRYV_LOGSDIR}` directory on disk. Respects the `active: false` / `enabled: false` block-skip (placeholders inside disabled blocks are ignored).
- **FIX (regression)**: Welcome-mail and other account-stream-derived fields (`email`, etc.) now work under `NODE_ENV=production` even when `production-config.yml` does not override `custom.systemStreams.account`. Previously the `systemStreams` plugin ran synchronously before `@pryv/boiler` loaded `default-config.yml`, so `accountMap` missed `:system:email` and `POST /users` silently returned 201 without ever reaching `sendWelcomeMail` with a valid recipient. Plugin is now registered as `pluginAsync` so it sees the fully-loaded config.

### Schema migrations — engine-agnostic runner + CLI
- **BREAKING (upgrade path)**: v1 → v2 is **not** an in-place upgrade. To bring a v1 install to v2:
  1. Bring the v1 install up to **v1.9.3** using the code on the `release/1.9.3` branch (its MongoDB migrations handle that hop).
  2. Export v1.9.3 data with **`dev-migrate-v1-v2`** (see that repo's README).
  3. Restore the produced archive into v2 via `node bin/backup.js --restore`.

  All legacy in-place MongoDB migrations (`1.9.0`–`1.9.4`) and the `versions` collection/table have been removed from the v2 codebase. Attempting a direct `git pull + npm install` from a v1 data directory into v2 will leave orphaned data that v2 does not understand.
- **NEW**: Engine-agnostic schema migration runner. Each migration-capable engine (currently PostgreSQL and rqlite) tracks its own integer version in a `schema_migrations` table/row; each migration bumps it by +1. Filename format is `YYYYMMDD_HHMMSS_<slug>.js` (timestamped for branch-safety). See `storages/interfaces/migrations/README.md` for conventions. Forward-only — `down()` is not executed by the runner.
- **NEW**: `bin/migrate.js` admin CLI for standalone migration operations. Subcommands:
  - `status` — per-engine current version + pending migrations (YAML)
  - `up [--target N] [--dry-run]` — apply pending migrations, optionally up to version N, optionally preview-only
- **CHANGED**: Config key `cluster.runMigrations` (default true) → `migrations.autoRunOnStart` (default true). Master applies pending migrations across all migration-capable engines before forking workers. Set to `false` to run them manually with `bin/migrate.js`.

### Persistent DNS records — management endpoints and CLI
- **NEW**: `DELETE /reg/records/:subdomain` — admin-key protected route to remove a persisted runtime DNS record. Symmetric to `POST /reg/records`. Returns 404 when the subdomain has no persisted record, 403 without admin auth. Master process is nudged over IPC so the local DnsServer drops the entry immediately; remote cores see the change on their next periodic refresh.
- **NEW**: `bin/dns-records.js` admin CLI for managing persistent DNS records directly in PlatformDB — useful during bootstrap, disaster recovery, or when the API itself is misconfigured and cannot be reached. Subcommands:
  - `list` — print all persisted records as YAML.
  - `load <file>` — upsert records from a YAML file. `--dry-run` to preview, `--replace` to delete records not present in the file.
  - `delete <subdomain>` — remove one record.
  - `export [file]` — dump to a YAML file (stdout if omitted).

  File format:
  ```yaml
  records:
    - subdomain: _acme-challenge
      records:
        txt: ["validation-token"]
    - subdomain: www
      records:
        a: ["1.2.3.4"]
  ```
  The CLI opens the storages barrel directly so it works with or without `master.js` running; a running DnsServer picks up changes within its refresh interval (default 30 s).

### Auto-renewed public TLS certificates (Let's Encrypt)
- **NEW**: Opt-in `letsEncrypt.*` config block. When `letsEncrypt.enabled: true`, the core issues and auto-renews the public-facing SSL certificate on its own — no more `certbot` cron / manual cert rotation. Supports both HTTP-01 (single-host) and DNS-01 (wildcard) challenges. Challenge type and hostnames are **derived from the existing topology config** (`dnsLess.publicUrl` → single host HTTP-01, `core.url` → single host HTTP-01, `dns.domain` → `*.{domain}` + apex via DNS-01), so there is no separate `hostnames` list to keep in sync.
- **Defaults:** feature is OFF (`enabled: false`) — existing deployments see no behaviour change. Operators who already terminate TLS in a reverse proxy (Caddy / Traefik / nginx-proxy-manager handling ACME on its own) keep doing that and leave `letsEncrypt.enabled: false`.
- **NEW**: Certificate material — the ACME account key plus every cert's private key — is **encrypted at rest** in rqlite (AES-256-GCM with a key derived from an operator-supplied `letsEncrypt.atRestKey`). A stolen rqlite snapshot alone does not yield a usable private key.
- **NEW**: `letsEncrypt.certRenewer: true` — set on **exactly one** core (typically the cluster CA holder) to designate it as the ACME renewer. That core runs the daily check; on renewal it writes the new cert row to rqlite, which replicates to every other core, which then picks it up on its next file-materialization tick.
- **NEW**: `letsEncrypt.onRotateScript` — optional absolute path to a script invoked on every successful cert rotation on that core. Receives `PRYV_CERT_HOSTNAME` / `PRYV_CERT_PATH` / `PRYV_CERT_KEYPATH` in env. Typical contents: `nginx -t && nginx -s reload` or `systemctl reload caddy`. Non-zero exit logs and keeps going; no retry.
- **NEW**: `bin/master.js` broadcasts a cluster IPC message after each rotation so HTTPS workers hot-swap the TLS context via `https.Server.setSecureContext()` — new TLS handshakes use the new cert, in-flight connections continue uninterrupted, no worker restart.
- **NEW**: `GET /system/admin/certs` — admin-key-protected route returning `{ certs: [{ hostname, issuedAt, expiresAt, daysUntilExpiry }] }`. PlatformDB metadata only — never the PEM material itself.

### Multi-core bootstrap CLI + Raft mTLS
- **NEW**: `bin/bootstrap.js` — operator CLI that issues a sealed bundle for a new core joining a multi-core cluster. Subcommands:
  - `new-core --id <coreId> --ip <ip> [--url <url>] [--hosting <h>] [--out <path>] [--token-ttl <ms>]` — generates the cluster CA on first call, signs a node cert for the new core, mints a one-time join token, pre-registers the new core in PlatformDB (`available:false`) and DNS (`{core-id}.{domain}` + appends to `lsc.{domain}`), assembles + encrypts the bundle (AES-256-GCM, scrypt KDF) and writes it to `--out` (default `./bootstrap-<id>.json.age`). Prints the passphrase, file path and expiry.
  - `list-tokens` — prints active (un-consumed, un-expired) tokens.
  - `revoke-token <coreId> [--ip <ip>]` — revokes active tokens for a core; with `--ip`, also unwinds the DNS + PlatformDB pre-registration.
- **NEW**: `bin/master.js --bootstrap <bundle> --bootstrap-passphrase-file <pass>` — consume mode for a fresh core. Decrypts and validates the bundle, writes `override-config.yml` and TLS files (`/etc/pryv/tls/{ca,node}.{crt,key}`), POSTs an ack to the bundle's ack URL with TLS pinned to the bundled CA, deletes the bundle on success, then chains into normal startup.
- **NEW**: `POST /system/admin/cores/ack` — endpoint the new core POSTs to. Authenticated by the one-time join token in the request body (NOT the admin key — the new core authenticates by token). Body: `{ coreId, token, tlsFingerprint }`. On success, flips PlatformDB's `available:true` for the core and returns a snapshot of the cluster's cores. Replays return HTTP 401.
- **NEW**: `storages.engines.rqlite.tls.{caFile, certFile, keyFile, verifyClient, verifyServerName}` config — enables mutually-authenticated TLS on the Raft channel. When unset (default `tls: null`), rqlited spawns with plain TCP exactly as before — single-core and existing VPN-protected multi-core deployments are unchanged.
- **NEW**: `cluster.ca.path` (default `/etc/pryv/ca`) and `cluster.tokens.path` (default `/var/lib/pryv/bootstrap-tokens.json`) config — used only by `bin/bootstrap.js` and the matching ack endpoint.

### Docker image
- **RENAMED**: Docker image `pryvio/core` → `pryvio/open-pryv.io` for the v2 line. Pull `pryvio/open-pryv.io:2.0.0-pre` (and the per-commit `pryvio/open-pryv.io:2.0.0-pre-<sha>` tag) instead of `pryvio/core:*`. The `pryvio/core` repository is preserved for the v1 line (`1.9.3` and earlier) and is no longer updated.

## Multi-core (DNSless variant)

- **NEW**: `core.url` config override (per-core, top-priority). Set explicit URLs in DNSless multi-core deployments where DNS is managed externally and FQDNs cannot be derived from `{core.id}.{dns.domain}`. Other cores discover this URL via `Platform.coreIdToUrl()`, which now reads from a PlatformDB-backed in-memory cache populated on `Platform.registerSelf()`.
- **NEW**: `Platform.registerSelf()` now writes `url` into core info in PlatformDB so other cores can resolve the explicit URL via `/reg/cores`, `/system/admin/cores`, and the wrong-core middleware.
- **NEW**: HTTP 421 Misdirected Request returned by `/:username/*` routes when the user is hosted on a different core in a multi-core deployment. Response shape: `{ error: { id: 'wrong-core', message, coreUrl } }`. Clients (SDKs) MUST retry against `coreUrl` directly — there is no HTTP redirect (cross-origin redirects strip Authorization headers, WebSockets cannot follow). The middleware is mounted on `/:username/*` only; `/reg/*` and `/system/*` are intentionally load-balanced. No-op in single-core mode.
- **CHANGED**: `GET /system/admin/cores` and `/reg/cores` now return the explicit `core.url` when set; otherwise fall back to `https://{core.id}.{dns.domain}` derivation as before.

## Known gaps in v2.0.0

- **OAuth2 authorization code flow** (RFC 6749 `/oauth2/authorize`, `/oauth2/token`, client registration, refresh tokens, PKCE) is **not** in v2. Clients that need OAuth2-style authorization must continue using the existing `/reg/access` polling flow (ported from the former `service-register`). **(Superseded: this flow shipped additively in a later 2.x release — `/oauth2/authorize`, `/oauth2/token`, PKCE, refresh tokens, DPoP, and client revocation are now available; see the OAuth2 entries above and `docs/oauth2.md`. The `/reg/access` polling flow remains supported.)**

## Multi-factor authentication (merged from former service-mfa)

- **NEW**: `POST /{username}/mfa/activate` — start MFA setup; personal access token required. Body carries the profile content (e.g. `{ phone: '+41...' }`) used as template substitutions for the SMS provider. Returns `{ mfaToken }` (HTTP 302).
- **NEW**: `POST /{username}/mfa/confirm` — confirm MFA activation. Authorization header is the `mfaToken` from activate. Body has the SMS `code`. On success returns 10 recovery codes and persists `profile.private.data.mfa`.
- **NEW**: `POST /{username}/mfa/challenge` — re-trigger the SMS challenge for a pending MFA login. Authorization header is the `mfaToken`.
- **NEW**: `POST /{username}/mfa/verify` — verify the SMS code and release the Pryv access token stashed by `auth.login`. Authorization header is the `mfaToken`.
- **NEW**: `POST /{username}/mfa/deactivate` — disable MFA for the calling user. Personal access token required.
- **NEW**: `POST /{username}/mfa/recover` — disable MFA using a recovery code. Unauthenticated; body is `{ username, password, recoveryCode }`.
- **CHANGED**: `auth.login` — when the user has MFA active (`profile.private.data.mfa` set) and the server has MFA enabled, the login response is `{ mfaToken }` instead of `{ token, apiEndpoint, ... }`. The caller must follow up with `mfa.verify` to receive the real access token.
- **KEPT**: `system.deactivateMfa` (admin override) remains available alongside the new user-facing `mfa.deactivate`.
- **CONFIG**: new `services.mfa` block — `mode` (`disabled`/`challenge-verify`/`single`), `sms.endpoints.{challenge,verify,single}.{url,method,body,headers}`, `sessions.ttlSeconds`. Default `mode: disabled` — backwards-compatible; existing deployments see no behaviour change.

## Registration service merged into core (formerly service-register)

### Registration & user management
- **NEW**: `GET /reg/cores?username=X|email=X` — core discovery endpoint. Returns `{ core: { url } }` for the core hosting the given user. Single-instance always returns self.
- **NEW**: `GET /system/admin/users` — list all registered users (admin-key protected). Returns `{ users: [{ username, id, email, language }] }`.
- **NEW**: `POST /system/users/validate` — pre-registration validation with unique field reservation.
- **NEW**: `PUT /system/users` — system-level user field update (indexed/unique fields in PlatformDB).
- **NEW**: `DELETE /system/users/:username?onlyReg=true&dryRun=true` — system-level platform deletion with dry-run support.
- **CHANGED**: Registration (`POST /users`, `POST /reg/user`) now validates locally via PlatformDB instead of forwarding to external service-register.
- **CHANGED**: `GET /reg/:username/check_username` and `GET /reg/:email/check_email` routes are now always available (previously DNS-less only).

### Multi-core deployment
- **NEW**: `core.id` config — core identity for multi-core deployments (FQDN = `{core.id}.{dns.domain}`).
- **NEW**: `GET /system/admin/cores` — list all cores with user counts.
- **NEW**: `GET /reg/hostings` — regions/zones/hostings hierarchy with core availability.
- **NEW**: `/reg/access` REDIRECTED status — auth page redirects to user's home core.
- **NEW**: rqlite process management in master.js — auto-starts rqlited for multi-core PlatformDB.

### DNS server
- **NEW**: Optional embedded DNS server (`dns.active: true`) for resolving `{username}.{domain}` to core IPs.
- **NEW**: `POST /reg/records` — admin endpoint for runtime DNS entry updates (e.g. ACME challenges).

### Service info & apps
- **NEW**: `GET /:username/service/infos` — backward-compatible alias for `service/info`.
- **NEW**: `GET /apps`, `GET /apps/:appid` — config-based application listing.
- **NEW**: `POST /access/invitationtoken/check` — check invitation token validity.

### Legacy backward-compatible routes
- **NEW**: `GET /reg/:email/username` and `GET /reg/:email/uid` — email → username lookup.
- **NEW**: `GET /reg/:uid/server` (redirect) and `POST /reg/:uid/server` (JSON) — server discovery.
- **NEW**: `GET /reg/admin/users/:username` — individual user details.
- **NEW**: `GET /reg/admin/servers`, `GET /reg/admin/servers/:name/users`, `GET /reg/admin/servers/:src/rename/:dst` — core management.

### Invitations
- **NEW**: `GET /reg/admin/invitations` — list all invitation tokens.
- **NEW**: `GET /reg/admin/invitations/post?count=N` — generate new invitation tokens.
- **CHANGED**: Invitation tokens stored in PlatformDB instead of static config. Config `invitationTokens` seeds PlatformDB on first boot. Tokens consumed on successful registration.

### Removed
- **REMOVED**: External service-register dependency — all registration logic is self-contained in the core binary.

## Consolidated master process (single Docker image)

- **CHANGED**: Socket.IO connections now use WebSocket transport only when running in cluster mode. HTTP long-polling fallback is no longer available in clustered deployments. Single-process mode (development, tests) is unaffected.
- **REMOVED**: Separate `pryvio/hfs` and `pryvio/preview` Docker images — all services now run in a single `pryvio/open-pryv.io` container via `node bin/master.js`.

## System streams refactor

- **REMOVED**: `:_system:helpers` stream and its children (`:_system:active`, `:_system:unique`) — these internal marker streams are no longer part of the system streams tree. Account field uniqueness and indexing are now enforced directly by the platform coordination layer.
- **No other API changes**: All other system stream IDs (`:_system:language`, `:system:email`, etc.) remain unchanged. Events, permissions, and stream queries work identically. *(Corrected 2026-09-15: this line originally also listed `:_system:email`, which has never been a valid id; on a default configuration the email field is `:system:email`. See the "Account-stream permissions: clearer error, corrected docs" entry, in the first release after 2.0.0-rc.17.)*

## Removed: `openSource:isActive` flag

- **REMOVED**: `openSource:isActive` configuration key — no longer recognized. All features (webhooks, HFS/series events, distributed cache sync, registration email check) are now always enabled regardless of deployment mode.

## Removed deprecated features from v1

### Stream ID prefix backward compatibility
- **REMOVED**: The old dot-prefix (`.`) notation for system stream IDs is no longer accepted or returned. Use the standard prefixes (`:_system:` for private, `:system:` for custom) exclusively.
- **REMOVED**: The `disable-backward-compatibility-prefix` HTTP header is no longer supported (no longer needed since prefix conversion is removed).

### Deprecated endpoint `/register/create-user`
- **REMOVED**: `POST /register/create-user` endpoint. Use `POST /system/create-user` instead.

### `streamId` (singular) backward compatibility
- **REMOVED**: Events no longer return `streamId` (singular). Only `streamIds` (array) is returned.
- **REMOVED**: Event creation/update no longer accepts `streamId`. Use `streamIds: [...]` instead.

### Tags backward compatibility
- **REMOVED**: `tags` property on events (input and output). Tags were previously converted to prefixed streamIds.
- **REMOVED**: `tags` query parameter for events.get.
- **REMOVED**: Tag-based access permissions (`{ tag: ..., level: ... }`).

### Final cleanup
- **REMOVED**: `/service/infos` endpoint (use `/service/info` instead).

### FollowedSlices
- **REMOVED**: FollowedSlices feature — API methods (`followedSlices.create`, `followedSlices.get`, `followedSlices.delete`), routes, and storage backends have been fully removed.
