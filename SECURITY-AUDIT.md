# Security Audit Report: open-pryv.io

**Report revision:** 2 (2026-10-15), covering releases 2.0.0-rc.40 to 2.0.0-rc.53.
**Refresh:** this report is revised with every release that carries a security fix, once that
release is deployed on the platforms the maintainers operate (section 7 has the procedure and the
revision table).
**Audience:** operators running open-pryv.io, implementers building on its API, and auditors
evaluating it.
**Reporting a vulnerability:** see [SECURITY.md](SECURITY.md); please do not open a public issue
for a vulnerability.

This report describes a code-level security review of open-pryv.io carried out by its maintainers,
what it found, what was changed, and what operators need to do. It is a first-party audit: the
people who reviewed the code also maintain it. It is not a certification and does not replace an
independent assessment.

**Publication rule.** A defect with practical impact is described here only once its fix is
released **and** deployed on the platforms the maintainers operate (pryv.me included). Until then,
the release's `CHANGELOG-v2.md` entry carries the operator instructions in neutral wording, and this
report describes the fix at a later revision. Methodology, scope, the surface inventory and the
areas where no defect was found are published without delay. At this revision every finding counted
in section 1 is fixed, released and deployed, so none is withheld under this rule; the
lower-severity defects still open are noted in section 5.

---

## 1. Summary

**What was audited.** The open-pryv.io server source code: the API server (HTTP, batch calls and
socket.io), the high-frequency series and previews servers, the embedded DNS server, the
registration, administration and multi-core planes, the storage engines, and the operator tools
shipped in the Docker image.

**When.** June to October 2026. The work started in June 2026 with the attack-surface inventory and
ran in full from 7 to 14 October 2026, release by release. A follow-up review of the consent (CMC)
plugin, of delegation and of access teardown, made in October 2026 alongside the work on group
accounts in consent, added the findings fixed in 2.0.0-rc.52 and rc.53; they were fixed under the
same rules (tests that fail without the fix, independent review before merge).

**How.** A staged, read-first code review (section 2): inventory, then focused review stages, each
candidate finding re-examined by a second reviewer whose task was to refute it, then fixes with
tests on both storage engines and an independent review before every merge.

**Outcome.** The review recorded findings rated from Low to Critical, plus about 150 lower-severity
observations triaged at the end (section 4.2). Every finding has a released fix, and every fix is
deployed on the platforms the maintainers operate.

The review and its follow-up recorded 50 findings, each rated and described individually in
section 4 and counted below; the further lower-severity fixes listed under each release are
described but not counted:

| Severity | Fixed | Open | Accepted |
|---|---|---|---|
| Critical | 6 | 0 | 0 |
| High | 20 | 0 | 0 |
| Medium | 23 | 0 | 0 |
| Low | 1 | 0 | 0 |
| **Total** | **50** | **0** | **0** |

Seven of the fixed findings have a second, longer-term step planned for a later major version
(section 5).

**Severity scale.** *Critical*: account takeover, data of another account, or a server-side file or
process compromised, by a caller with little or no privilege. *High*: the same class with a
significant precondition, or an unauthenticated loss of availability. *Medium*: a bounded
disclosure, an integrity or erasure gap, or a loss of availability that needs a valid credential.
*Low*: hardening with a narrow or theoretical impact. Several findings only apply to some
configurations; each is rated at the highest severity it reaches in a supported configuration, and
its applicability is stated with it.

**Releases carrying the fixes.**

| Release | Date | Findings fixed (by severity) | Deployed on the maintainers' platforms |
|---|---|---|---|
| 2.0.0-rc.40 | 2026-10-07 | 2 Critical, 3 High | yes (2026-10-07) |
| 2.0.0-rc.41 | 2026-10-07 | 2 Critical, 3 High, 2 Medium | yes (2026-10-07) |
| 2.0.0-rc.42 | 2026-10-07 | none (not an audit release) | yes (with rc.43) |
| 2.0.0-rc.43 | 2026-10-07 | 2 High, 8 Medium | yes (2026-10-07) |
| 2.0.0-rc.44 | 2026-10-08 | 2 High, 5 Medium | yes (2026-10-08) |
| 2.0.0-rc.45 | 2026-10-09 | completion steps of earlier findings, lower-severity fixes | yes (2026-10-14) |
| 2.0.0-rc.46 | 2026-10-10 | 2 Critical, 2 High | yes (2026-10-14) |
| 2.0.0-rc.47 | 2026-10-10 | 6 High, 5 Medium | yes (2026-10-14) |
| 2.0.0-rc.48 | 2026-10-11 | 1 Low | yes (2026-10-14) |
| 2.0.0-rc.49 | 2026-10-12 | 1 Medium, lower-severity fixes | yes (2026-10-14) |
| 2.0.0-rc.50 | 2026-10-13 | lower-severity fixes | yes (2026-10-14) |
| 2.0.0-rc.51 | 2026-10-13 | 1 High, lower-severity fixes | yes (2026-10-14) |
| 2.0.0-rc.52 | 2026-10-14 | 1 High, 2 Medium, lower-severity fixes | yes (2026-10-15) |
| 2.0.0-rc.53 | 2026-10-15 | completion steps of earlier findings, lower-severity fixes | yes (2026-10-15) |

Each release contains the previous ones: upgrading to the latest release applies every fix. The
upgrade notes of each release still apply (read them in `CHANGELOG-v2.md` for every release you
skip).

---

## 2. Scope and method

### 2.1 In scope

- **Server code** of the `open-pryv.io` repository: the API server (REST routes, batch calls,
  socket.io), the business layer (authentication, sessions, MFA, registration, accesses and
  permissions, webhooks, account deletion, e-mail verification, password reset, multi-core
  bootstrap), the high-frequency (HF) series server, the previews server, attachments, the
  embedded DNS server, the mail component, OAuth2 and third-party sign-in, account delegation,
  consent and cross-account messaging, shared secrets, the audit trail, caches and their
  invalidation, and the storage engines (PostgreSQL, SQLite, filesystem, S3, InfluxDB, and the
  rqlite platform database).
- **Operator entry points**: the command-line tools under `bin/`, configuration loading and boot
  validation, the Docker image and its entrypoint.
- **Trust boundaries**: every kind of caller (section 3.1) and every path that creates or widens an
  access.

### 2.2 Method

The review ran in stages, each a set of parallel, read-only reviews of one theme:

1. **Inventory**: every listening socket, route, API method, inter-process and inter-core channel,
   operator tool and file path built from input, plus a trust model of every kind of caller and
   every path that creates or widens an access.
2. **Authentication and authorization**: tokens and sessions, access scoping, MFA, registration and
   the administration plane, multi-core join and core-to-core calls.
3. **Input handling**: file paths, query parsers, JSON bodies and headers, SQL construction, DNS
   message parsing.
4. **Cryptography and secret handling**: primitives and their use, secrets reaching logs, error
   answers or other clients.
5. **State**: caches and invalidation, account deletion and erasure semantics, account (system)
   streams.
6. **Limits and rate limiting**: resource bounds, per-account and per-address budgets.
7. **Triage** of every remaining lower-severity observation, with a decision per item.

Verification and fixing followed fixed rules:

- **Refutation before recording.** Each candidate finding was handed to a separate reviewer whose
  task was to disprove it by reading the full code path. Only findings that survived were
  recorded; several were refuted or narrowed this way (section 4.1). Some were also confirmed by
  execution against a local server.
- **Severity-driven handling.** Critical and High findings were fixed immediately, in dedicated
  releases; Medium findings in the following releases; lower-severity items through the final
  triage.
- **Tests that assert the refusal.** Every fix ships with tests that fail without it, and the
  pre-merge review checked that each new security test asserts the refusal itself (not only a
  success path).
- **Both storage engines.** The full test suites run on PostgreSQL and on SQLite before each
  merge; several findings were specific to one engine.
- **Independent review before merge.** Each release was reviewed before merging by a second
  reviewer working independently from the implementer (a different review model), and the
  must-fix items of that review were applied before release.
- **Neutral public wording.** Release notes describe the change and the operator steps without
  detailing the defect before the fix is deployed.

### 2.3 Out of scope

- Third-party dependencies and their advisories (supply-chain scanning is a separate effort; see
  section 5 for the container image).
- Deployment hosts, their operating systems, firewalls and reverse proxies.
- Client applications and libraries (web apps, the JavaScript library), except where a server
  change needed a compatibility check.
- Load and denial-of-service testing: resource limits were reviewed in code, not measured under
  load.
- Third-party plugins and custom data stores.

---

## 3. Surface inventory

A summary of what the inventory covered. The full tables are internal working documents.

### 3.1 Callers (trust model)

Anonymous callers; personal accesses (a login session); MFA-pending sessions; app accesses; shared
accesses; delegated accesses acting for another account; consent and cross-account messaging
accesses; capability URLs and bearer keys that are not accesses (access-request poll keys,
attachment read tokens, shared-secret keys, e-mail and password-reset links); OAuth2 clients and
tokens; the admin key holder; another core of the same platform; the master process and its
workers; the operator's custom authentication step; and the caller id carried for attribution.

### 3.2 Network surfaces

| Surface | Exposure |
|---|---|
| API server: REST routes per account (events, streams, accesses, account, profile, MFA, webhooks, shared secrets, delegations, consent), batch calls, socket.io | public, access token |
| Registration and access requests (`/reg/*`, `/users`, `/access/*`) | public, partly unauthenticated |
| Administration (`/system/*`, `/reg/admin/*`, `/reg/records`, account deletion with the admin key) | admin key |
| OAuth2 authorization server and third-party sign-in callbacks | public |
| HF series server (series reads and writes, batch) | public, access token |
| Previews server and attachment downloads | public, access token or read token |
| Hosted sites and proxy sites | public |
| Embedded DNS (UDP and TCP) | public when enabled |
| ACME HTTP-01 responder | public when Let's Encrypt is enabled |
| rqlite platform database: HTTP API (loopback) and Raft (peer cores, mutual TLS) | local / peer cores |
| Local pub/sub broker for cache invalidation | loopback |
| PostgreSQL, InfluxDB, SQLite files | local |

**Outbound calls:** webhooks, mail (SMTP or a mail service), SMS providers for MFA, core-to-core
calls, cluster join acknowledgement, ACME, S3, the observability exporter.

### 3.3 Operator tools and boot

Server start and cluster join (`bin/master.js`, including `--bootstrap`), cluster administration
(`bin/bootstrap.js`), backup and restore (`bin/backup.js`), install wizard and configuration
helpers (`bin/init.js`, `bin/check-config.js`, `bin/config-to-env.js`), DNS records and mail
templates (`bin/dns-records.js`, `bin/mail.js`), migrations, PII hashing migration and rotation,
OAuth2 clients, observability, breach scope, integrity checks and index reconciliation. The
configuration loader, the boot validation, and config-driven code loading were part of the review.
The Docker image and its entrypoint (user, capabilities, owned directories) were reviewed as well.

### 3.4 File paths built from input

Per-account directories (SQLite databases, attachments, audit, HF series files), the previews
cache, upload temporary files, backup trees on write and on restore, cluster join material (bundle,
passphrase file, keys and certificates), configuration files written by tools, and log files.

---

## 4. Results

Section 4.1 lists the areas where the review found no defect, section 4.2 how the lower-severity
observations were handled, and the sections after them the fixed findings, release by release. Each fixed
finding gives its severity and where it applies, what a caller or a mistake could do, what changed,
the release that fixed it, and what operators must do. Operator steps are summarised from the
release notes; `CHANGELOG-v2.md` has the complete text.

### 4.1 Areas reviewed with no defect found

These are the main checks that held, summarised:

- **Access scoping for writes:** moving an event needs contribute rights on every added and removed
  stream; reserved roots (e-mails, shared secrets, consent, delegation) are guarded on create,
  update and delete; `create-only` never reads; an explicit `none` wins over a parent grant.
- **The `*` scope** never reaches the account or audit stores; non-personal tokens read only their
  own audit stream.
- **Access creation rules:** personal accesses cannot be created through the API; apps create shared
  accesses only; expiry is capped by the creator; tracking fields are set by the server.
- **Token lookup** is scoped to the account named in the path; deleted and history rows are never
  matched; expiry is re-checked on every use, including cache hits; the personal session is checked
  uncached and bound to the account.
- **DPoP-bound tokens** are enforced at one shared check for every transport and fail closed where
  no proof can be presented.
- **Wrong-core requests** answer `421` without forwarding, so no credential leaves the core.
- **Administration plane:** one gate with a constant-time admin key check in front of every system
  route; system methods are not reachable through batch calls or socket.io.
- **Registration e-mail challenge and e-mail verification:** hashed codes and tokens, attempt
  budgets, constant-time comparison, expiry, links built from configuration, never from the `Host`
  header.
- **SQL construction:** every PostgreSQL statement is scoped by user id and parameterised (content
  conditions, type wildcards and stream lists included); the SQLite engine quotes and escapes the
  values it inlines (moving it to placeholders is planned, section 5).
- **Query validation:** stream ids in queries refuse quotes, control characters and unknown
  properties; content conditions use a fixed operator set and path grammar.
- **Prototype pollution:** no path was found by which request data (JSON bodies, multipart bodies,
  query strings, socket.io payloads) changes the shared object prototype.
- **Cryptography:** cluster join bundles (AES-256-GCM, scrypt, generated passphrase), join tokens
  (256-bit, stored hashed, one-shot), TOTP (RFC 6238, constant-time, replay guard), PII hashing
  (HMAC-SHA-256 with a dedicated key).
- **Secrets in public answers:** `/service/info` exposes no secret; the audit trail never records
  request bodies; observability telemetry is built from a closed allow-list.
- **Caches:** keys cannot collide across accounts; cached stream trees are handed out as copies.
- **Account deletion** removes the account's base-store rows, attachments, previews and sessions;
  OAuth2 grants of a deleted account are refused.
- **Regular expressions** on client input: none built from client data; repeated patterns are
  bounded.
- **Client address** for per-address budgets honours forwarding headers only from configured
  trusted proxies.
- **DNS:** out-of-zone queries are refused; lookups from the query name are exact-key and
  parameterised; platform names take precedence over usernames.

Candidate findings refuted during verification include: a batch or socket.io call switching the
account context during registration or deletion; an MFA token exposed in a redirect URL (it travels
in the fragment and is scrubbed by the landing app); a personal token issued before the second
factor (never returned before verification, and unguessable).

### 4.2 Lower-severity observations

About 150 lower-severity observations (Low and Info, plus some Medium resource-limit items) were
triaged one by one at the end of the review. Each ended in one of: fixed, tracked as a known
defect, planned work, or accepted. Items accepted as they are, with the reason:

- The embedded DNS answers one message per TCP connection (no pipelining): permitted by RFC 7766;
  clients reconnect.
- Names of consent back-channel accesses are derived from a short hash: a collision can only clash
  on a name, never grant access, and changing the derivation would break existing names.
- A few boot-time settings loaders stop the boot on failure: fail-stop at boot is the intended
  behaviour.

### Fixed in 2.0.0-rc.40 (deployed)

#### Registration accepted server-managed account fields

- **Severity:** Critical (the target's internal account id was needed; no path disclosing it to an
  unauthenticated caller was found).
- **What could happen:** a registration request could carry the internal user id, a password hash
  and initial account events. With another account's internal id, the request could overwrite or
  delete that account's data, depending on the storage engine; the password hash bypassed the
  password rules.
- **What changed:** registration ignores `id`, `passwordHash` and `events`; creating a user whose id
  already exists is refused, and the clean-up after a failed registration only removes what that
  registration created.
- **Operator action:** none.

#### `accesses.update` did not enforce its list of updatable fields

- **Severity:** Critical.
- **What could happen:** an app allowed to manage an access could change fields the schema
  documented as immutable (`type`, `token`, `id`, `createdBy`, `alias`), and so turn an access into
  something it was never granted. Separately, a personal access was accepted with a session that
  belonged to another account.
- **What changed:** only `name`, `deviceName`, `permissions`, `expireAfter`, `expires` and
  `clientData` can be updated; anything else is refused with `403 forbidden` and the access is left
  unchanged. A personal access is valid only with a session of the same account.
- **Operator action:** none.

#### HF series writes recorded the caller's credential as the event author

- **Severity:** High.
- **What could happen:** writing to a high-frequency series stored the request's authorization
  value in the series event's `modifiedBy`, so any access able to read the event could read that
  credential.
- **What changed:** the access id is recorded, like every other write.
- **Operator action:** once per core after upgrading, `node bin/hfs-author-scrub.js --dry-run`, then
  `--revoke` (rewrites the stored values and deletes the accesses concerned), then restart. Event
  history and kept deletions are not rewritten, which is why `--revoke` is needed.

#### Event id validation was not anchored

- **Severity:** High (validation gap; no write outside the account's directory was demonstrated).
- **What could happen:** the store-prefixed event id form accepted trailing characters, so ids
  containing path separators reached the storage layer, where attachment paths are built from the
  id.
- **What changed:** the pattern is anchored; as defence in depth, the filesystem attachment store
  and the previews worker refuse any id that would resolve outside the account's directory.
- **Operator action:** none.

#### Placeholder secrets passed boot validation

- **Severity:** High for an installation that kept the shipped placeholders; not applicable
  otherwise.
- **What could happen:** `config/production-config.yml` carried placeholder values for
  `auth.adminAccessKey` and `auth.filesReadTokenSecret`, and the boot checks did not recognise them,
  so a deployment that did not override them ran with a publicly known admin key.
- **What changed:** 2.0.0-rc.40 refuses to boot with a placeholder secret, in every environment, or
  with a secret shorter than 16 characters in production. 2.0.0-rc.43 removed every
  platform-specific value from the production layer and made `auth.trustedApps` required and
  matched as origins.
- **Operator action:** set long random values of your own (for example `openssl rand -hex 32`);
  `bin/check-config.js` reports the problem. From 2.0.0-rc.43, set `auth.trustedApps`, the reset and
  verification page URLs and `services.email` in your own override if you relied on the production
  layer (see the rc.43 notes).

### Fixed in 2.0.0-rc.41 (deployed)

#### SMS MFA in `single` mode could accept a verification without the code

- **Severity:** Critical where SMS MFA runs in `single` mode; not applicable to TOTP or SMS
  `challenge-verify`. No deployment known to the maintainers was exposed.
- **What could happen:** the pending code was held per API worker, and a verification reaching a
  worker that held no code was accepted without one. Anyone holding an account's password could
  pass its second factor.
- **What changed:** the pending code is shared by the workers and required; a missing or wrong code
  is refused. Side effect: a correct code is no longer refused when the verification reaches another
  worker.
- **Operator action:** none.

#### A delegate could turn the owner's MFA off or replace it

- **Severity:** High (account delegation and MFA are both on by default).
- **What could happen:** a delegated personal access could deactivate or re-enrol the owner's MFA,
  and so lock the owner out of the login that ends the delegation.
- **What changed:** `mfa.activate` and `mfa.deactivate` require a personal token from the account's
  own login (`403 delegation-genuine-login-required` otherwise).
- **Operator action:** none.

#### Access aliases could be chosen by the client and released without an owner check

- **Severity:** High on multi-core platforms, Medium on a single core.
- **What could happen:** `accesses.create` accepted a client-chosen `alias`, and deleting an access
  released its alias without checking that it belonged to the same account. One account could
  remove another account's alias or, on a multi-core platform, its routing entry.
- **What changed:** aliases are set by the server only (an `alias` in `accesses.create` is refused
  with `403`); deleting an access releases an alias only when it is one of the same account's.
- **Operator action:** none.

#### Login sessions were bound to a username, not to an account

- **Severity:** Medium (higher in combination with the previous item).
- **What could happen:** a session left under a username by a former holder of that name could be
  reused for the account that holds the name later.
- **What changed:** sessions record the account they belong to and are reused and accepted only for
  that account. Existing sessions keep working.
- **Operator action:** none.

#### Delegated accesses could read the owner's tokens

- **Severity:** High (where account delegation is used).
- **What could happen:** `accesses.get`, `accesses.getOne`, `accesses.update` and
  `accesses.checkApp` returned the owner's access tokens to a delegated personal access.
- **What changed:** a delegated access sees the tokens of itself and of the accesses it created
  only.
- **Operator action:** none.

#### Account deletion with a personal token over batch or socket.io

- **Severity:** Critical where `user-account.delete` lists `personalToken`; not applicable with the
  default (`adminToken` only). No deployment known to the maintainers was exposed.
- **What could happen:** through a batch call or socket.io, a personal token could delete an
  account other than its own; an access that had failed its checks (logged out, expired) could
  still delete its account.
- **What changed:** a personal token only deletes its own account, whatever the transport, and a
  refused access can no longer delete.
- **Operator action:** none.

### Fixed in 2.0.0-rc.43 (deployed)

#### Platform database HTTP API exposed on multi-core; executable mail templates

- **Severity:** High for a default multi-core installation.
- **What could happen:** on multi-core nodes, the rqlite HTTP API listened on all interfaces with no
  authentication, so a host reaching that port could read and write the platform database. Mail
  templates stored in the platform database were compiled without restriction in the API workers,
  so whoever could write that database could run code there.
- **What changed:** the rqlite HTTP API binds to loopback on every core (an explicit
  `storages.engines.rqlite.httpBindAddr` exposes it, with a boot warning); `promote-core` no longer
  calls a peer's HTTP port; stored mail templates are validated against a safe subset before use.
- **Operator action:** run `node bin/check-config.js` and `node bin/mail.js templates validate`
  before restarting; `storages.engines.rqlite.url` must point at the local loopback; keep the
  rqlite ports firewalled.

- **Completed in 2.0.0-rc.45:** a multi-core node (`core.ip` set) running its own rqlited without
  `storages.engines.rqlite.tls` now refuses to start (it was a boot warning): without TLS, a host
  reaching the Raft port could join or address the cluster. Run `node bin/check-config.js` on every
  core before restarting on rc.45 or later; a single-core dns-active node that set `core.ip` for its
  A record moves it to `dns.publicIp`.

#### Shared accesses created by an app could reach further than the app

- **Severity:** Medium.
- **What could happen:** a shared access created or widened by an app did not inherit the app's
  narrower rules (`none` or `create-only`) on sub-streams, so it could read what its creator could
  not.
- **What changed:** the creator's narrower rules are carried into the access it creates and appear
  in its `permissions`.
- **Operator action:** `node bin/access-scope-audit.js` (read only) reports existing accesses that
  reach further than their creator; narrowing them is the operator's decision.

#### MFA attempt limits could be exceeded with parallel requests

- **Severity:** High where SMS MFA runs (short codes), Medium for TOTP.
- **What could happen:** the attempt limiter checked before verifying and counted after, so parallel
  attempts were not bounded.
- **What changed:** `mfa.verify` and `mfa.confirm` reserve their attempt on the MFA session and on
  the account before the code is checked.
- **Operator action:** none.

#### Cached accesses could outlive their deletion or narrowing

- **Severity:** Medium.
- **What could happen:** cached access data had no lifetime, and invalidation messages could be
  missed, so a deleted or narrowed access could keep working on a worker until eviction or restart.
- **What changed:** cached accesses expire after `caching.accessMaxAgeSeconds` (default 60 s);
  invalidation is followed before reading, kept across stream writes and replayed on reconnection;
  account deletion always broadcasts its invalidation.
- **Operator action:** none.

#### Single-event reads skipped the exclusions of `events.get`

- **Severity:** Medium.
- **What could happen:** `events.getOne`, attachments, previews and HF series accepted any readable
  stream of the event, so a token could read an individual event it could not list (for example an
  internal record) when it knew its id.
- **What changed:** single-event reads apply the same exclusions as `events.get` (`403` otherwise).
- **Operator action:** none.

#### Stream deletion and event updates bypassed some write checks

- **Severity:** Medium.
- **What could happen:** `events.update` lacked the consent-inbox and internal-stream guards of
  `events.create` (fixed in 2.0.0-rc.43); `streams.delete` needed manage rights on the target only,
  so descendant events could be deleted or merged into a parent without rights on them (fixed in
  2.0.0-rc.44).
- **What changed:** app and shared tokens can no longer update or move events into or out of
  protected streams; deleting a trashed stream needs manage rights on every stream of its subtree,
  and create rights on the parent when merging.
- **Operator action:** none.

#### Cluster join bundles were broader and harder to revoke than documented

- **Severity:** Medium.
- **What could happen:** a join bundle with its passphrase amounts to the admin key plus a cluster
  identity; the documented back-out (`revoke-token`) did not undo a delivered bundle, and a failed
  acknowledgement left the secrets on disk.
- **What changed:** the joiner stages the bundle and moves it into place only after an accepted
  acknowledgement bound to its certificate fingerprint; `new-core` refuses an existing id without
  `--replace`; the documentation states what a bundle is equivalent to and what to do if one may
  have been exposed (`SINGLE-TO-MULTIPLE.md`).
- **Operator action:** treat a bundle and its passphrase as the admin key; follow
  `SINGLE-TO-MULTIPLE.md`, "If a bundle may have been exposed".

#### Core-to-core calls sent the admin key to unvalidated URLs

- **Severity:** Medium where a core URL used plain HTTP, Low otherwise.
- **What could happen:** core-to-core calls carry the admin key; core URLs were not validated,
  `http:` was accepted, and calls had no timeout or redirect policy.
- **What changed:** core ids and URLs are validated (https origins only, except for development),
  core-to-core calls time out and refuse redirects.
- **Operator action:** none, unless a core URL used `http:` (switch to https).

#### Credentials in logs

- **Severity:** Medium.
- **What could happen:** error logs carried request bodies, including reset tokens, old passwords,
  recovery codes, invitation tokens and e-mail proofs; some token formats escaped the URL masking.
- **What changed:** error logs keep request body keys and a few harmless values, never credential
  values; credential keys are masked wherever they are logged; URL redaction covers current access
  tokens and one-time link tokens.
- **Operator action:** check the retention of logs written by earlier releases (they may hold reset
  tokens or passwords from refused requests).

#### Password reset could be abused and did not end existing access

- **Severity:** Medium.
- **What could happen:** reset requests were not throttled, reset tokens were stored in clear and
  stayed valid after a later reset or password change, and a reset did not revoke existing sessions
  or accesses.
- **What changed:** requests are throttled per account and per client address; tokens are stored
  hashed, single use, one per account; a completed reset revokes every personal session and
  personal access, and a password change revokes the other personal sessions.
- **Operator action:** none (links mailed before the upgrade must be requested again).

#### A test-only registration path was active in production

- **Severity:** Medium on a single core, Low on multi-core.
- **What could happen:** a hard-coded test registration path reserved an e-mail address without
  creating a user and consumed the invitation token used.
- **What changed:** the path is gone and its name is reserved.
- **Operator action:** once per platform, `node bin/platform-backloop-cleanup.js` (report), then
  `--apply`.

#### Admin key comparison and invitation tokens (lower severity)

- **Severity:** Low.
- **What changed:** the admin key is compared in constant time everywhere and read only from the
  `Authorization` header on account deletion; invitation tokens are claimed atomically (one
  registration per token) and given back if the registration fails; the invitation check answers
  errors instead of stopping the worker.
- **Operator action:** none.

### Fixed in 2.0.0-rc.44 (deployed)

#### MFA could be turned off or replaced without a step-up

- **Severity:** Medium.
- **What could happen:** a personal token alone could deactivate MFA or replace the enrolment,
  unlike other credential changes, which ask for the current password.
- **What changed:** `mfa.deactivate`, and `mfa.activate` over an active enrolment, require the
  account password or a code of the current factor; the account address gets an e-mail notice on
  every MFA change. The migration opt-out offered in rc.44 was removed in rc.45.
- **Operator action:** update the account web app at the same time (it sends the step-up); add the
  `mfa-change` mail template for `in-process` mail (see the rc.44 notes).

#### SMS provider requests built from raw client values

- **Severity:** High for providers configured with URL or string templates, Medium otherwise.
- **What could happen:** client values (phone number, extra keys) were inserted unencoded into the
  provider request templates, and the whole verification body was forwarded, so a client could
  alter the request the server sends to the SMS provider.
- **What changed:** SMS enrolment takes an E.164 phone number and only the configured content keys;
  placeholders are substituted once and encoded for where they land.
- **Operator action:** list any extra keys you need in `services.mfa.methods.sms.contentKeys`.

#### SMS codes were weak and sends were unlimited

- **Severity:** Medium where SMS MFA runs.
- **What could happen:** server-generated codes had 4 digits and lived 30 minutes shared between
  sessions; nothing limited the number of SMS sent (cost and toll fraud); a `challenge-verify`
  provider's 2xx answer counted as success whatever it said.
- **What changed:** 6-digit single-use codes valid 300 s and bound to their session; send limits per
  session, per user and per destination; `challenge-verify` success is matched explicitly
  (`endpoints.verify.success`).
- **Operator action:** set `services.mfa.methods.sms.endpoints.verify.success` if your provider
  answers `200` with a body.

#### MFA failed open when a method was switched off

- **Severity:** Medium.
- **What could happen:** an account enrolled in a method that was later disabled in the
  configuration logged in with its password only (for example when moving off the legacy
  `services.mfa.mode`).
- **What changed:** such a login is refused (`403 mfa-method-inactive`);
  `services.mfa.allowLoginWhenMethodInactive: true` restores the old behaviour with warnings.
- **Operator action:** on the legacy `services.mfa.mode`, set
  `services.mfa.methods.sms.active: true` before removing `mode`.

#### MFA session handling (lower severity)

- **Severity:** Low.
- **What changed:** pending MFA sessions are capped per core and have a fixed lifetime; an
  `mfaToken` is only accepted on its own account's path; a login session is refused once the
  enrolment it was opened against was replaced, turned off or recovered; recovery and admin resets
  are recorded in the account's audit trail.
- **Operator action:** none.

#### Webhooks could make the server call internal addresses

- **Severity:** High (any app or shared token could register a webhook).
- **What could happen:** webhook URLs were not restricted, redirects were followed and calls had no
  timeout, so a token could make the server call hosts on its internal network, and the result of
  `webhooks.test` revealed whether they answered.
- **What changed:** http(s) only, no credentials in the URL; the destination is resolved at each
  call and private, loopback, link-local (cloud metadata included) and other reserved ranges are
  refused unless listed in `webhooks.allowedPrivateHosts`; redirects are not followed; calls time
  out; `webhooks.test` answers one uniform error.
- **Operator action:** list webhook receivers on a private network in
  `webhooks.allowedPrivateHosts`.

#### Webhook creation accepted server-managed fields

- **Severity:** Medium.
- **What could happen:** `webhooks.create` accepted fields such as the owning access id, retry
  counts, interval and state, so a webhook could be bound to another access or retry without
  bound.
- **What changed:** `webhooks.create` accepts `url` and `scopes` only; `webhooks.update` accepts
  `state` `active` or `inactive` only.
- **Operator action:** none.

#### SQLite engine kept deleted or replaced files in use

- **Severity:** Medium (SQLite deployments; erasure).
- **What could happen:** a worker kept its handle on a user's SQLite file after another process
  deleted or replaced it (account deletion, restore): erased series points stayed readable on that
  worker, and new points were written into the removed file and lost.
- **What changed:** handles are checked against the file's identity and reopened.
- **Operator action:** none.
- **Completed in 2.0.0-rc.51:** the per-account account file (password hash and account fields),
  not covered by the rc.44 change, now follows its file on disk too (see 2.0.0-rc.51 below).

### Further hardening in 2.0.0-rc.45 (deployed)

- **Webhooks feature permission.** An app or shared access carrying
  `{ feature: 'webhooks', setting: 'forbidden' }` cannot create, update or test webhooks, and every
  access it creates inherits the restriction; meant for tokens handed out publicly. Without the
  entry nothing changes.
- **Webhook listing scoped for shared accesses** (Low-Medium): `webhooks.get` with a shared access
  listed every webhook of the account (URLs and scopes); it now lists the ones that access created.
- **Legacy sign-in cookie removed** (Low-Medium): login set a signed cookie carrying the session
  token that nothing read any more; it is no longer set.
- **Admin pre-registration** (Low): `POST /system/users/validate` now consumes invitation tokens and
  refuses reserved names; reservations are released when the request fails.
- **Failed MFA login** (Low): a login that fails after its MFA session was opened now ends that
  session.
- **Operator action:** run `node bin/check-config.js` before restarting (see the platform database
  item under 2.0.0-rc.43); clients that turn MFA off or replace an enrolment must send the step-up.

### Fixed in 2.0.0-rc.46 (deployed)

#### Attachment parameters were honoured outside the upload routes

- **Severity:** Critical (any token allowed to create events; open registration makes such tokens
  easy to obtain).
- **What could happen:** the attachment parameters that only the multipart upload route should
  produce were also accepted through batch calls and socket.io, so a caller could make the server
  attach a file from its own file system to an event and then read it.
- **What changed:** `events.create` and `events.update` validate their parameters strictly;
  attachments come only from multipart uploads on the REST routes.
- **Operator action:** none for the fix. A read-only check for past use (attachments created through
  batch calls or socket.io) is recommended; any hit is handled case by case (secret rotation,
  access revocation). The maintainers ran this check on the platforms they operate after the
  deploy and found no trace of past use.

#### Malformed DNS messages could stop the embedded DNS server

- **Severity:** Critical where the embedded DNS is enabled; not applicable otherwise.
- **What could happen:** malformed messages could keep the master process busy indefinitely or end
  it, and the server answered messages that were themselves responses.
- **What changed:** stricter request validation, size-limited responses (truncation over UDP),
  bounded TCP connections (`dns.tcpMaxConnections`, default 64), validated stored DNS records.
- **Operator action:** check stored records with `node bin/dns-records.js list` before restarting a
  dns-active core; a record that does not validate is not served and is named in the log.

#### Internal plugin data reachable through a parent stream

- **Severity:** High where an account holds a delegation record (delegation is on by default),
  Medium for consent data.
- **What could happen:** `events.get` on the parent of an internal plugin area returned that hidden
  subtree to any token with broad read rights; a delegation record there carries a control
  credential able to issue a personal token on the controlled account.
- **What changed:** `events.get` never returns events of internal plugin streams, whatever stream
  ids are queried.
- **Operator action:** a read-only check for past reads of these streams is recommended; any hit is
  handled case by case. The maintainers ran this check on the platforms they operate after the
  deploy and found no trace of past use.

#### socket.io calls could end an API worker

- **Severity:** High (availability; any valid token, read-only shared tokens included).
- **What could happen:** a malformed reply argument in a socket.io call raised an error outside the
  handler, which ended the API worker; the master restarted it at once, without limit.
- **What changed:** each call site is guarded; a call whose reply argument is not a function is
  answered without affecting the server.
- **Operator action:** none.

#### SQLite audit erased despite `audit.onUserDelete: keep`

- **Severity:** Low (retention policy not honoured; SQLite audit engine only). Reported publicly in
  open-pryv.io#154.
- **What changed:** the per-user audit is kept on the SQLite audit engine too, as on PostgreSQL.
- **Operator action:** none.

### Fixed in 2.0.0-rc.47 (deployed)

#### Concurrent permission loading on SQLite

- **Severity:** Medium on the SQLite engine (a token could escape its own restrictions), Info on
  PostgreSQL. Confirmed by execution.
- **What could happen:** an access's permission maps were rebuilt in place on a shared cached
  object; with SQLite's synchronous index, two batched socket.io messages could interleave a read
  with the rebuild and see the restrictions missing (for example, write to a read-only stream).
- **What changed:** permissions are loaded once per access and published as a whole.
- **Operator action:** none.

#### OAuth2 signed state could end an API worker

- **Severity:** High (availability; unauthenticated, wherever the OAuth2 routes are enabled).
- **What could happen:** a signed `state` whose signature held a non-ASCII character made the
  comparison throw in a handler without error handling, which ended the worker.
- **What changed:** such a state is refused with `400`; an unexpected failure on an OAuth2 route
  answers `500` instead of leaving the request open. Related hardening: passwords are hashed with a
  fresh salt for every hash (one salt was shared per worker process); a restore refuses a plaintext
  backup when a decryption secret was supplied.
- **Operator action:** none.

#### Access-request poll keys written to logs

- **Severity:** Medium (for log readers and shippers).
- **What could happen:** the poll key of `/reg/access/:key`, which retrieves the delivered token,
  appeared in the request trace and in some error and warning lines.
- **What changed:** the key is masked in the request trace and logged URLs, and named by a short
  digest elsewhere; the request trace no longer prints the Basic-auth user name; `500` answers no
  longer carry the fault's own text (a reference links the answer to the server log line).
- **Operator action:** check the retention of logs written by earlier releases.

#### HF series not fully erased after an alias or a username change

- **Severity:** Medium (erasure; aliases and username changes are on by default).
- **What could happen:** a deletion addressed by an alias erased that alias's series, not the
  canonical ones; series written before a username change stayed under the former name. The next
  holder of the name could reach them. Pending password-reset requests also survived a rename or
  deletion and could reset the next holder's password.
- **What changed:** account deletion erases the series under every name the account holds (current
  username, aliases, former usernames); `events.delete` of a series event erases its points under
  every name; a rename or deletion destroys the pending reset requests of every name.
- **Operator action:** none for the fix. Series that earlier deletions or renames left behind are
  not swept automatically; a read-only check is recommended. The maintainers ran it on the
  platforms they operate at the deploy and found none.

#### Unproved e-mail claims reserved addresses platform-wide

- **Severity:** Medium where e-mail proof is required at registration, Low-Medium otherwise
  (denial, no takeover).
- **What could happen:** an address added but never verified reserved it on the platform with no
  expiry, so an account could block registrations and challenges for addresses it did not own.
  Concurrent updates of the same unique value could both succeed.
- **What changed:** an address is claimed only at verification; with
  `account.emailVerification.requireAtRegistration`, the legacy primary field accepts only a
  verified address; concurrent claims of a unique value are serialised; a failed registration
  releases what it reserved.
- **Operator action:** `node bin/emails-unproved-report.js` (read only) lists pending claims from
  before the upgrade that still hold an address.

#### Credential methods callable inside batch calls and socket.io

- **Severity:** High where no reverse-proxy rate limiting applies, Medium behind the documented
  recipe.
- **What could happen:** `auth.login`, `mfa.recover` and other credential methods could be called
  many times inside one batch call or over socket.io with any token of the account, allowing fast
  password guessing invisible to per-request proxy limits; batch calls had no size limit.
- **What changed:** credential methods are served over their own HTTP routes only; a batch holds at
  most 1000 calls with a bound on total results; failed passwords are delayed per account (never
  locked out) and budgeted per client address across cores.
- **Operator action:** behind a reverse proxy, list it in `http.trustedProxies`, or every client
  shares the proxy's budget.

#### Anonymous access requests could fill the per-core ceiling

- **Severity:** High where no reverse-proxy rate limiting applies, Medium behind the recipe.
- **What could happen:** unauthenticated `POST /reg/access` calls at a low rate could fill the
  per-core ceiling of pending access requests, blocking sign-in through access requests on that
  core.
- **What changed:** live requests per client address are capped (`access.maxLiveRequestsPerIp`,
  default 50), and a request nobody has read expires sooner (`access.unopenedRequestTtl`, default
  600 s).
- **Operator action:** as above, `http.trustedProxies` behind a proxy.

#### One account could fill the MFA session ceiling

- **Severity:** High (availability of MFA sign-in on a core).
- **What could happen:** one MFA-enrolled account could fill the per-core ceiling of pending MFA
  login sessions and block every other MFA sign-in.
- **What changed:** at most `services.mfa.sessions.maxPendingPerUser` (default 5) pending sessions
  per account; a further login ends the oldest.
- **Operator action:** none.

#### socket.io namespaces created before authentication

- **Severity:** High (availability; unauthenticated).
- **What could happen:** a namespace was created for any name before authentication and never
  removed, so worker memory could grow until the worker died.
- **What changed:** only account namespaces of a valid shape are created, before any other work; a
  namespace is released when its last socket leaves; message size is bounded
  (`socketIO.maxMessageBytes`).
- **Operator action:** none.

#### Unbounded `events.get` results on PostgreSQL

- **Severity:** High (availability; any read token).
- **What could happen:** every matching row was loaded before the answer was streamed, and `limit` /
  `skip` were not bounded.
- **What changed:** rows are read through a server-side cursor; `limit` and `skip` must be integers
  from 0 to 100000.
- **Operator action:** none.

#### Further hardening in 2.0.0-rc.47

- An access's excluded streams stay excluded when they are trashed (Medium-Low: such events were
  returned).
- Multipart uploads are bounded (one JSON part, `uploads.maxFiles` files) and their temporary files
  are deleted after each request.
- Deleting an account ends its delegation and consent relationships with other accounts; a saved
  delegation control credential stops issuing tokens once the delegate account is gone.
- `streams.get` refuses undeclared parameters; access tokens named after built-in object properties
  are refused.
- **Accepted design choice:** the per-address failed-password budget fails open when the platform
  database cannot be reached (the per-account delay still applies), so a platform outage does not
  stop sign-in.
- **Operator action:** once after the upgrade, remove the upload temporary files earlier versions
  left in the system temp directory (32-hex names).

### Fixed in 2.0.0-rc.48 (deployed)

#### Server-written events lacked creation and modification fields

- **Severity:** Low.
- **What could happen:** events the server writes itself (consent inbox copies, e-mail and
  delegation records) were stored without `created`, `createdBy`, `modified` and `modifiedBy`:
  clients got `null` in fields documented as always present, `modifiedSince` never returned them,
  and the audit could not attribute them.
- **What changed:** they carry the four fields, with `system` as the author.
- **Operator action:** once per core, `node bin/events-stamp-backfill.js --dry-run`, then without
  `--dry-run`.

### Fixed in 2.0.0-rc.49 (deployed)

#### Backup restore trusted paths from the backup manifest

- **Severity:** Medium (operator tool; matters when backups are stored with a third party).
- **What could happen:** a restore built paths from the manifest's user ids, usernames and
  attachment entries without containment and followed symbolic links, so a tampered backup could
  make the restore write or delete outside its target.
- **What changed:** ids and names must be one safe path segment; per-user paths are contained;
  symbolic links and special files are refused.
- **Operator action:** backups written by the server restore as before; a backup that keeps data
  behind symbolic links, or has unsafe names, is refused (see the rc.49 notes).

#### Lower-severity fixes in 2.0.0-rc.49

The first triage batch (about 35 items), none changing the API contract except where the release
notes say so: JSON answers carry `Cache-Control: no-store` and `Vary: Origin`; a path id always
wins over an `id` query parameter; HF points and query bounds are checked strictly; feature
permissions are compared in `accesses.checkApp`; access deletion records no longer carry the token;
an object merge helper skips prototype keys; attachment read tokens are compared in constant time;
more values are masked in logs; backups, reports and generated env files are written owner-only;
DNS discovery answers only available cores; cache invalidation also runs when an update fails
after its write.

### Lower-severity fixes in 2.0.0-rc.50 (deployed)

The second triage batch (behaviour changes with a release note each): stream queries whose `all`
entry resolves to nothing match nothing (they matched everything in the other clauses); deletion
records go only to accesses that read the whole store; the account root stream cannot be granted
above `read`; account fields written through events follow the field's rules; query-string keys
cannot shadow built-in object properties; the first decision on an access request wins; OAuth2
PKCE values must have the RFC 7636 form; reserved username shapes; webhook and socket.io scopes
follow the stream tree and their access; proxy sites refuse encoded separators; previews bound the
image size and render concurrency; logs mask `Error` objects and more credential names, and log
files are created `0640`; the admin key fingerprint in the boot log is keyed; `md5` and `sha1` are
refused as integrity algorithms; worker restarts back off; the Docker image no longer ships `npm`.
**Operator action:** run the read-only counts listed in the rc.50 notes before deploying (on the
maintainers' platforms every count was zero).

### Fixed in 2.0.0-rc.51 (deployed)

#### Incremental backups overwrote the full backup they continued

- **Severity:** High (operator tool; backup recoverability). Applies only to backup directories
  that received `bin/backup.js --incremental` with an earlier release; full backups are not
  affected.
- **What could happen:** an incremental run wrote the changes since the previous run into the same
  files as the full backup, replacing them; with encryption, each run also minted a new key, so
  files the delta did not rewrite were left under a key no longer described by the envelope. A
  restore of such a directory reported success while restoring only the last delta: the earlier
  data was gone. Two more defects of the same feature were found by reading and fixed with it:
  items changed between the start and the end of the previous run were in no run, and deletions of
  streams, accesses and webhooks were skipped by every incremental.
- **What changed:** an incremental run writes only its own `incrementals/<runId>/` directory (its
  own manifest and encryption envelope) and the run index `chain.json`; no file of an earlier run
  is opened for writing. A restore applies the full backup and then every incremental in order (a
  newer version of an item replaces the older one, deletions included); `--through-run` restores up
  to a given run and `--inspect` lists a directory and says whether it is sound. Two runs into the
  same directory at the same time: the second to finish is refused and left aside. A directory
  damaged by the old behaviour cannot be repaired: a restore refuses it with a message
  (`--allow-incomplete` restores the delta anyway, so that the loss is visible, not hidden). Full
  backups written by earlier releases restore unchanged.
- **Operator action:** inspect every directory that ever received `--incremental` before this
  release (`node bin/backup.js --inspect <dir>`, with the restore secret for an encrypted one); a
  directory reported `DAMAGED` holds only its last delta: take a new full backup into a new
  directory and continue with `--incremental` from there.

#### Lower-severity fixes in 2.0.0-rc.51

- **SQLite account store kept reading a deleted or replaced account file** (Medium; completes the
  rc.44 item "SQLite engine kept deleted or replaced files in use", which covered the other
  per-account files). A core running while a restore or another process deleted or replaced an
  account's file kept reading the old one through its open connection: the account looked unknown
  or kept its former password and fields, and a change made in that window was written into the
  deleted file and lost. The store now follows the file on disk, like the other per-account files.
  Residual at this release: on SQLite, a request still in flight when its account is deleted can
  re-create that account's directory with an empty file (an opaque id, no account data). Closed in
  2.0.0-rc.53 by preventing the re-creation (see 2.0.0-rc.53 below).
- **A login refused after its MFA session was opened** (Low): a storage error while the session or
  the personal access was written left the MFA session pending until it expired, holding one of the
  account's pending-session places; the login now ends it.
- **Two concurrent failed MFA activations** (Low): two `mfa.activate` calls that both failed
  (provider error) discarded the enrolment that was pending before them; it is kept.
- **Custom "other" system streams without storage** (Low): a configuration declaring
  `custom.systemStreams.other` streams listed them among the system streams although nothing could
  be stored in them; such a configuration is now refused at boot and by `bin/check-config.js`.
- **Operator action:** remove any `custom.systemStreams.other` section from your configuration
  (account fields belong under `custom.systemStreams.account`); otherwise none.

### Fixed in 2.0.0-rc.52 (deployed)

#### Withdrawing a consent left the grant's sub-accesses working

- **Severity:** High (where a consent grant is delegable: an offer that asked
  `request.accessType: 'app'`, which lets the requester create `shared` sub-accesses on the
  accepter's account).
- **What could happen:** only a plain `accesses.delete` of the grant removed the sub-accesses
  created through it. A withdrawal written as `consent/revoke-cmc` (by either side), a revocation
  received from the counterparty, the end of a delegation and the deletion of the counterparty's
  account removed the grant alone: the sub-accesses kept opening the accepter's data after the
  consent was withdrawn, until their own expiry, which they need not have.
- **What changed:** every one of these paths removes the grant's live sub-accesses first, then the
  grant, and drops each from the access cache of every worker; a sub-access created through the
  grant while it was being removed is removed by a final pass (the same pass was added to
  `accesses.delete`). A revocation received from the counterparty whose local deletion fails is
  reported as a failure and retried, instead of being recorded as applied.
- **Operator action:** sub-accesses left behind by earlier withdrawals are not removed
  automatically. After the upgrade, run `node bin/access-scope-audit.js` (read only) on each core:
  it lists every live access whose creator is gone and not known to be personal, under "no longer
  managed", with its expiry; review them with the account owners and delete them with
  `accesses.delete`. The maintainers ran it on the platforms they operate after the deploy and
  found none.
- **Completed in 2.0.0-rc.53:** every consent and delegation teardown (the paths above, a
  capability collected by an operator, the teardown at account deletion) is now the
  `accesses.delete` deletion. Until then these teardowns removed the access rows outright (Low: no
  deletion record of the removed access, its aliases still held, the access index used by the
  breach-scope tool not updated; its webhooks were stopped at their next call by an existing
  check). The removed accesses now leave a deletion record (readable with `includeDeletions`, name
  kept, token never), their webhooks are deleted, their aliases released and the access index
  updated. Apps that list deletions will see these records.

#### Delegates could read consent counterparties' tokens and webhook URL credentials

- **Severity:** Medium (where account delegation and consent or webhooks are both used). What a
  delegate could obtain is bounded: the counterparty's grant to the owner (data the owner was
  already given, within the consented scope) and a receiver secret, both outliving the
  delegation; the 2.0.0-rc.41 item handed a delegate the owner's own tokens, login sessions
  included.
- **What could happen:** a delegated personal access is handed no credential of the owner's
  accesses (see 2.0.0-rc.41), but a consent relationship access also keeps the counterparty's
  endpoints in `clientData.cmc`, with their tokens, and these were returned as stored by
  `accesses.get`, `getOne`, `update` and `checkApp`. Likewise `webhooks.get`, `getOne`, `update`
  and `test` returned every webhook's `url` as stored, a receiver secret included.
- **What changed:** wherever an access is returned without its credentials, every URL inside its
  `clientData` comes without its user part (as a whole string, inside a longer text,
  percent-encoded, or in a lenient spelling the URL parser accepts); host and path are kept. A
  webhook returned to a caller that neither owns the webhook's access nor created it carries its
  `url` reduced to scheme, host and path. Deletion records are redacted the same way for every
  caller. Limits: only URL user parts are redacted in `clientData` (a bare token an app stores
  there is returned as stored), and a secret placed in a webhook URL's path is not recognised.
  Until 2.0.0-rc.53 a delegate writing back a `clientData` it had read stored the redacted URLs
  over the owner's; such an update is now refused (see 2.0.0-rc.53 below). The owner's own reads
  are unchanged.
- **Operator action:** none.
- **Completed in 2.0.0-rc.53:** the credentials also leave the stored rows. Once a relationship
  access is deleted, every URL user part in its `clientData` is removed from the deletion row and
  from the history rows its earlier updates kept, and that deletion row loses its own token, so a
  backup or an export of deletion records holds no credential of a consent relationship.

#### Accesses created under a caller id escaped their creator's revocation

- **Severity:** Medium (accesses created with a caller id, `Authorization: <token> <callerId>`).
- **What could happen:** an access created under a caller id records the caller id next to its
  creator, and was not recognised as created by that access: deleting the creating access did not
  delete it, and the revocation that answers a reused OAuth2 refresh token did not reach it, so it
  kept working after its creator was revoked. Its creator could also neither list nor delete it.
- **What changed:** these paths match on the creating access's id, as `accesses.update` already
  did. What a caller may see or delete is unchanged: its own creations only.
- **Operator action:** none for the fix; `node bin/access-scope-audit.js` (above) also lists such
  accesses whose creator is gone.

#### Lower-severity fixes in 2.0.0-rc.52

- **Admin pre-registration reserved badly shaped usernames** (Low; follows the 2.0.0-rc.45 item):
  `POST /system/users/validate` reserved a username that account creation then refused, with its
  unique fields, and consumed the invitation token; such a name is now refused before anything is
  reserved.
- **Log file size settings that never applied** (Low): the size keys of the production
  configuration (`logs.file.maxFileBytes`, `maxNbFiles`) were passed under names the logging
  library ignores, so daily rotation was the only bound. `logs.file.rotation.maxSize` now caps each
  daily file (unset by default), and the dead keys are removed.
- **Operator action:** run `node bin/access-scope-audit.js` as described above; remove
  `logs.file.maxFileBytes` and `maxNbFiles` from your own configuration (setting `maxSize` starts a
  new list of files to prune: see the rc.52 notes).

### Lower-severity fixes in 2.0.0-rc.53 (deployed)

The completion steps of two 2.0.0-rc.52 findings are described with them above. Also:

- **Withdrawal notices that could not be delivered were never re-sent** (Low; reported publicly in
  open-pryv.io#157): when the counterparty's core could not be reached at the moment of a
  withdrawal (`consent/revoke-cmc`, a deletion of the relationship access, a delegation detach),
  the counterparty was never told, and its side of the relationship stayed in place. The notice is
  now queued and re-sent by the retry loop (8 re-sends over about 27 hours, then marked failed for
  the operator), and, between cores running this release, a notice that lands late never ends a
  relationship re-established meanwhile.
  The notices of an account being deleted are not queued (no account is left to hold them).
- **A consent offer could name streams the consent plugin manages** (Low; no read was possible): an
  offer asking access to the accepter's `:_cmc:inbox` (which holds the grant endpoints the accepter
  received) or to the plugin's internal streams was accepted; the grant then also carried the
  plugin's own `create-only` rule on the inbox, and only the order of the two entries kept the inbox
  unreadable (checked end to end: no event was readable). Such an offer is now refused at write,
  and again by the accepter's core at accept.
- **Invite links could be closed from another app scope** (Low; denial only):
  `consent/invalidate-link-cmc` accepted any capability id, so a token able to write in one app
  scope of an account could close the invites published in another. It must now be written on the
  invite's stream or an ancestor of it.
- **The consent record on an access could be removed by an update** (Low): `accesses.update` with
  `clientData: null` or a `cmc` key removed the consent plugin's record from an access carrying
  one; it is now refused (other `clientData` keys merge as before). With the same release, an app
  token deletes only the `shared` accesses it created, as `accesses.update` already required.
- **An erased account's directory could be re-created on SQLite** (Low; closes the residual noted
  under 2.0.0-rc.51): the erasure now marks the account id and tells every worker, and no per-user
  directory is created again for that id; a request racing its own account's erasure now fails
  instead of answering from an empty file. Residual: a worker reached within the short propagation
  window of the mark, and a backup run started before the erasure; HF series storage is not
  covered by the mark and relies on the erasure's second removal pass. A per-account SQLite handle
  whose close is refused now still leaves its cache instead of staying in use.
- **Operator action:** `cmc.retryLoop.enabled` now defaults to `true` (the loop that re-sends the
  notices above); set it to `false` to keep it off, in which case nothing is queued. On a core that
  ran with the loop off, size its retry backlog before upgrading: records older than their whole
  schedule are retired as `failed-permanent` (`cmc-retry-stale`) without being sent, and stay
  readable for 30 days (see the rc.53 notes). No migration.

---

## 5. Known residual risks and planned work

**Rate limiting at the edge.** The server enforces in-code limits on several sensitive operations
(see the release notes), but connection-level and per-route rate limiting is best done by a
reverse proxy in front of every core. Deploy one, follow the operator rate-limiting guide, and list
it in `http.trustedProxies`.

**Resource quotas.** Some resources have no per-account or per-connection bound yet (connections,
streams, webhooks, storage), and database statements have no default timeout. These are planned as
a limits-hardening batch; a reverse proxy and the operator's own database settings mitigate most of
them meanwhile.

**Container image.** The Debian 12 base image carries operating-system package advisories for which
the distribution has published no fix, and the bundled rqlite binary follows upstream releases for
its own library advisories. `npm` / `npx` were removed from the image in rc.50. Planned: image
scanning in CI, evaluation of a newer base image, and an rqlite update once upstream ships the
fixed libraries. The rqlite ports listen on loopback (HTTP) and behind mutual TLS (Raft).

**Planned for the next major version:**

- Cluster join: a certificate-signing-request flow (the joiner generates its key; short-lived node
  certificates), replacing bundles that carry the admin key.
- rqlite HTTP API authentication.
- A core-to-core credential distinct from the admin key.
- Use-time clipping of a child access to its managing access, which also narrows children created
  before rc.43 (today `bin/access-scope-audit.js` reports them).
- Feature permission names as a closed list (an unknown name is accepted today and restricts
  nothing).
- HF series keyed by account id instead of username; until then, series written before a username
  change stay under the former name (erased with the account, not reachable by the owner under the
  new name).
- Encrypted backups: a signed manifest and authenticated frames (hybrid encryption gives
  confidentiality, not authenticity). Until then: the backup chain index and the per-run manifests
  introduced in rc.51 are checked for consistency but not signed, and an encrypted backup file that
  is empty or truncated at a frame boundary is not detected as such. Both are closed by the signed
  manifest.
- Access requests: a second secret held by the requester, so that the poll key alone no longer
  retrieves the delivered token.
- Delegation teardown across cores: a peer check of the delegate's identity.
- Token hardening: a minimum length for caller-chosen access tokens and hashed token storage;
  authenticated data on encryption envelopes; signed webhook deliveries.
- The SQLite event engine moving from escaped inline values to placeholders, as the PostgreSQL
  engine does.

**Access deletion records.** A deleted access leaves a deletion record (its name, permissions and
timestamps) that is kept until the account is erased; API answers never return its token, and
since 2.0.0-rc.53 the stored record of a consent relationship holds none of its credentials. Since
2.0.0-rc.53 every consent and delegation teardown leaves such a record too. An opt-in retention
setting is planned.

**Open lower-severity defects.** A small number of Low and Low-Medium defects found during the
review and its follow-up remain open and tracked; they will be described here once fixed. Operators
should keep daily log rotation on (the default); since 2.0.0-rc.52, `logs.file.rotation.maxSize`
also caps the size of each daily file. A log file without daily rotation is one growing file, to be
rotated outside the server.

---

## 6. How to report a vulnerability

See [SECURITY.md](SECURITY.md): GitHub private vulnerability reporting (preferred) or
**security-dev@pryv.com**. Please do not open a public issue for a vulnerability.

---

## 7. Refresh policy

This report is updated with every release that carries a security fix:

- a fix is described once it is released and deployed on the platforms the maintainers operate;
- each update revises the summary counts, adds the new findings in the same post-mortem form, and
  moves items from section 5 to section 4 when they ship;
- areas reviewed again with no defect found are added to section 4.1;
- the revision table below records each update.

### Report revisions

| Revision | Date | Releases covered | Change |
|---|---|---|---|
| 1 | 2026-10-14 | 2.0.0-rc.40 to 2.0.0-rc.51 | First publication. Every finding fixed, released and deployed on the maintainers' platforms (2.0.0-rc.51 deployed 2026-10-14). |
| 2 | 2026-10-15 | 2.0.0-rc.40 to 2.0.0-rc.53 | Adds 2.0.0-rc.52 and rc.53 (follow-up review of consent, delegation and access teardown): 1 High and 2 Medium findings, their completion steps and lower-severity fixes; the SQLite erasure residual noted under rc.51 is closed. Both releases deployed on the maintainers' platforms (2026-10-15). |
