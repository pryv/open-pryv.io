# Security Audit Report: open-pryv.io

**Report revision:** 28 (2026-11-27), covering releases 2.0.0-rc.40 to 2.0.0-rc.91.
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
in section 1 is fixed, released and deployed, so none is withheld under this rule; section 5 says
what remains open.

---

## 1. Summary

**What was audited.** The open-pryv.io server source code: the API server (HTTP, batch calls and
socket.io), the high-frequency series and previews servers, the embedded DNS server, the
registration, administration and multi-core planes, the storage engines, and the operator tools
shipped in the Docker image.

**When.** June to October 2026. The work started in June 2026 with the attack-surface inventory and
ran in full from 7 to 14 October 2026, release by release. A follow-up review of the consent (CMC)
plugin, of delegation and of access teardown, made in October 2026 alongside the work on group
accounts in consent, added the findings fixed in 2.0.0-rc.52 and rc.53, and a further review of
how stream ids are compared by the access guards, together with the server's calls to consent
counterparties, added those fixed in 2.0.0-rc.56, and a review of the OAuth2 consent and session
lifecycle and of event history reads, made in October 2026 alongside work on OAuth2 extensions,
added those fixed in 2.0.0-rc.64, and a review of the permissions that consents and app accesses
can carry on account fields, of the consent retry path and of deletion listings, made in October
2026, added those fixed in 2.0.0-rc.65, and a review of access aliases and username changes, and
of how consent grants and refreshed OAuth2 sessions combine permissions, made in October 2026,
added those fixed in 2.0.0-rc.66, and a review of the OAuth2 consent flow, made in October 2026
alongside the work on OAuth2 clients registered by the operator, added the lower-severity fixes of
2.0.0-rc.68, and a review of the OAuth2 refresh chain and of pseudonymous access aliases, made in
October and November 2026 alongside the work on token introspection, revocation and pseudonymous
OAuth2 subjects, added those fixed in 2.0.0-rc.69, and a review of OAuth2 client authentication,
of what an OAuth2 session may create and of the authorization request's audience, made in November
2026 alongside the work on client key sets, grant state and resource indicators, added those fixed
in 2.0.0-rc.70, and a review of the suspension and lifecycle of OAuth2 clients, made in November
2026 alongside the work on the vetting status of clients registered by the operator, added those
fixed in 2.0.0-rc.71, and a review of backup restore on multi-core platforms, of the mails sent to
an account's stored address and of the background work of an account being erased, made in November
2026, added those fixed in 2.0.0-rc.72, and a follow-up review of email uniqueness in cleartext PII
mode and of backup restore, made in November 2026, added the one fixed in 2.0.0-rc.73, and a
review of the OAuth2 client revoke, made in November 2026 alongside the work on client metadata
documents, added the one fixed in 2.0.0-rc.74, and a review of how the SQLite storage engine builds
its queries and matches stream ids, made in November 2026 alongside the planned move of that engine
to bound values, added those fixed in 2.0.0-rc.85, and the independent review of the fix of a
consent issue reported through the public issue tracker, made in November 2026, added the one fixed
in 2.0.0-rc.90; they were fixed under the same rules (tests that fail without the fix, independent
review before merge).

**How.** A staged, read-first code review (section 2): inventory, then focused review stages, each
candidate finding re-examined by a second reviewer whose task was to refute it, then fixes with
tests on both storage engines and an independent review before every merge.

**Outcome.** The review recorded findings rated from Low to Critical, plus about 150 lower-severity
observations triaged at the end (section 4.2). Every finding has a released fix, and every fix is
deployed on the platforms the maintainers operate.

The review and its follow-ups recorded 74 findings, each rated and described individually in
section 4 and counted below; the further lower-severity fixes listed under each release, and the
items reported through the public issue tracker, are described but not counted:

| Severity | Fixed | Open | Accepted |
|---|---|---|---|
| Critical | 6 | 0 | 0 |
| High | 24 | 0 | 0 |
| Medium | 40 | 0 | 0 |
| Low | 4 | 0 | 0 |
| **Total** | **74** | **0** | **0** |

Six of the fixed findings have a second, longer-term step planned for a later major version
(section 5); the second step of a seventh, the 2.0.0-rc.51 backup finding, shipped in
2.0.0-rc.86.

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
| 2.0.0-rc.54 | 2026-10-15 | none (not an audit release) | yes (with rc.56) |
| 2.0.0-rc.55 | 2026-10-15 | lower-severity fixes | yes (with rc.56) |
| 2.0.0-rc.56 | 2026-10-16 | 2 High, lower-severity fixes | yes (2026-10-16 to 2026-10-23) |
| 2.0.0-rc.57 | 2026-10-23 | runtime update, not an audit finding: Node.js 24.22.1 for the Node.js security release of 2026-10-21 (Brotli decoder out-of-bounds write reachable through outbound HTTP response decoding; TLS hostname-check bypasses); operator action: pull the new image, or upgrade Node.js to 24.22.1 and run `npm rebuild` on a native install | yes (2026-10-23) |
| 2.0.0-rc.58 | 2026-10-26 | dependency updates, not audit findings: `body-parser` 1.20.9 (GHSA-27r3-jxmh-p828, denial of service through trailing bytes after a compressed request body), `multer` 2.5.0 (GHSA-q7qp-rjg7-q26m, denial of service through a pending upload filter), `undici` 6.29.1 (GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c, denial of service), `fast-uri` 3.1.9 (moderate URI parsing advisories); operator action: pull the new image, or `npm install` on a native install | yes (2026-10-26) |
| 2.0.0-rc.59 | 2026-10-26 | dependency update, not an audit finding: `nodemailer` 10.2.1 (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h, moderate: address-parser flaws that could turn display text into a recipient); operator action: pull the new image, or `npm install` on a native install | yes (2026-10-26) |
| 2.0.0-rc.63 | 2026-10-28 | dependency updates, not audit findings: `node-forge` 1.4.2 (GHSA-86w9-cpqp-85rv, high: RSA PKCS#1 v1.5 signature verification; no patched release existed before 1.4.2), `qs` 6.16.1 (GHSA-6pq8-jhm2-2vcw, moderate: denial of service in `qs.stringify` with `arrayFormat: 'comma'`, a function the server does not call at runtime); operator action: pull the new image, or `npm install` on a native install | yes (2026-10-28) |
| 2.0.0-rc.64 | 2026-10-29 | 2 Medium | yes (2026-10-29) |
| 2.0.0-rc.65 | 2026-10-29 | 3 Medium, lower-severity fixes | yes (2026-10-29) |
| 2.0.0-rc.66 | 2026-10-30 | 3 Medium, lower-severity fixes, completion step of an earlier finding | yes (2026-10-30) |
| 2.0.0-rc.67 | 2026-10-30 | none (not an audit release: the 2.0.0-rc.66 server, with the Docker image that release lacked) | yes (with rc.68) |
| 2.0.0-rc.68 | 2026-10-30 | lower-severity fixes, completion steps of earlier findings | yes (2026-10-30) |
| 2.0.0-rc.69 | 2026-11-02 | 2 Medium, lower-severity fixes; dependency update, not an audit finding: `follow-redirects` 1.16.2 (GHSA-mrwp-f3q8-3g9p, high: a custom credential header could follow a cross-origin redirect; reached through the ACME certificate client); operator action: set the two new per-core state keys (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-02) |
| 2.0.0-rc.70 | 2026-11-02 | 2 Medium, lower-severity fixes, completion step of an earlier finding (the state keys are required; the admin-key fallback is removed); operator action: set both state keys where their feature is on, allow `accessCreation` on the registry OAuth2 clients whose sessions create accesses, webhooks or CMC capability requests, give a distinct `kid` to every key of a multi-key inline client key set (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-02) |
| 2.0.0-rc.71 | 2026-11-03 | 1 Low, lower-severity fixes, completion step of an earlier hardening (a client's suspension reaches the data API); operator action: set `oauth.logoHosts` before upgrading where registry OAuth2 clients have logos, approve vetted client changes with `update --approve`, run `purge-grants` after a revoke (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-03) |
| 2.0.0-rc.72 | 2026-11-04 | 2 Medium, 1 Low, lower-severity fixes; operator action: run `bin/reconcile-user-cores.js --emails` on each core where accounts were restored with `--user` by an earlier release, look for leftover records with the queries of that release (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-04) |
| 2.0.0-rc.73 | 2026-11-05 | 1 Medium, lower-severity fixes; operator action: on a platform run with `platform.piiMode: cleartext`, run `bin/reconcile-user-cores.js --emails --dry-run` on each core and resolve the pairs of accounts it lists (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-05) |
| 2.0.0-rc.74 | 2026-11-06 | 1 Low, lower-severity fixes; operator action: none beyond the upgrade for the fixes; keep the host that runs `bin/oauth-client.js` and the cores NTP-synced; before turning on `oauth.clientMetadataDocuments`, read `docs/oauth2.md` (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-06) |
| 2.0.0-rc.75 | 2026-11-06 | lower-severity fixes; operator action: on a platform with several cores, upgrade every core before adding per-user audience entries to OAuth2 clients, and each core before the adapter sidecar next to it reads the addressed-account headers; route adapter paths through the core where per-user addresses are wanted (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-07) |
| 2.0.0-rc.76 | 2026-11-08 | no finding (new surface: address aliases); dependency update, not an audit finding: `html-to-text` 10 under `email-templates`, which drops `deepmerge` 4.3.1 (GHSA-gcqx-w48m-w2h4, low: prototype poisoning in `mergeObject()`); operator action: right after the upgrade, run `bin/reconcile-user-cores.js --address-alias-shape` on each core and look at any account it lists (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-08) |
| 2.0.0-rc.77 | 2026-11-09 | no finding (new opt-in surface: a per-user OAuth2 issuer, off by default); lower-severity fix: a streamed call the client cut short was audited as a success; operator action: none beyond the upgrade; before turning `oauth.perUserIssuer` on, read `docs/oauth2.md` (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-09) |
| 2.0.0-rc.78 | 2026-11-09 | lower-severity fixes: public email lookups were not limited per client address; a single-use consent link could be accepted by two people writing at once; operator action: a client that tests many addresses in a burst must throttle or handle the `429` (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-11) |
| 2.0.0-rc.79 | 2026-11-11 | no finding (changed limit: the group-account member access budgets); lower-severity fix: a failed member access request held its patient's in-flight lock for a minute; operator action: where `cmc.memberAccess.ratePerMinute` was tuned to be strict, set `mintBurst` too (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-11) |
| 2.0.0-rc.80 | 2026-11-11 | none (not an audit release) | yes (2026-11-11) |
| 2.0.0-rc.81 | 2026-11-11 | none (not an audit release) | yes (2026-11-11) |
| 2.0.0-rc.82 | 2026-11-12 | no finding; default change: `oauth.audienceBoundSessions` is `true`; operator action: set it to `false` explicitly on a core whose resource servers do not exchange yet (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-12) |
| 2.0.0-rc.83 | 2026-11-12 | none (not an audit release) | yes (2026-11-12) |
| 2.0.0-rc.84 | 2026-11-13 | none (not an audit release); lower-severity fixes: the `integrity` of an updated access verifies on the form the API returns (stored hashes recomputed once at upgrade, no operator action beyond the migration run at boot), history snapshots of an access no longer carry its internal call counters | yes (2026-11-13) |
| 2.0.0-rc.85 | 2026-11-17 | 1 High, 2 Medium (SQLite storage engine), lower-severity fixes; operator action: none beyond the upgrade for the fixes; before upgrading a SQLite core, look for access permissions on lower-cased `:_audit:action-` ids and for stream ids holding whitespace or equal to `..` (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-17) |
| 2.0.0-rc.86 | 2026-11-17 | no new finding; completion steps of earlier findings (every file of a backup run authenticated and runs signed, planned in section 5 since the first revision; cache invalidation between the processes of a core), lower-severity fixes (among them a `custom.dataStores` entry named after a built-in store, which came within reach of `*` permissions); operator action: a backup written by this release restores with this release or later, keep the backup directory for the backup only, sign backups taken with a recipient public key (`--signing-key`, `--signing-pubkey`); on a multi-core platform a new core joins with a bootstrap bundle only on this release or later; a `custom.dataStores` entry named `local`, `account` or `_audit` is no longer loaded without `override: true` (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-17) |
| 2.0.0-rc.87 | 2026-11-18 | no new finding; two items of the limits work planned in section 5 since the first revision (a time limit on the PostgreSQL work of API requests, on by default; a bound on the password checks running at once in each API worker), lower-severity fix reported through the public issue tracker (the session of a composed OAuth2 re-consent holds the request only); operator action: behind a PostgreSQL connection pooler, let it pass the two new connection parameters or set both keys to `0` and the limits on the database role, leave 2 more connections per pool in `max_connections`; clients handle the new `429` and `503` answers of password checks (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-18) |
| 2.0.0-rc.88 | 2026-11-25 | runtime update, not an audit finding: Node.js 24.22.3 for the Node.js security release of 2026-11-10 (seven high-severity fixes, among them disclosure of process memory to an HTTP peer and an uncaught exception a remote client can trigger in a TLS server, so a core that terminates TLS itself, the default, was directly exposed), with Debian's fixed glibc in the image; the CI actions are pinned to commits; no finding (new: a consent offer can require a verified email address); operator action: pull the new image, or upgrade Node.js to 24.22.3 and run `npm rebuild` on a native install | yes (2026-11-25) |
| 2.0.0-rc.89 | 2026-11-26 | none (not an audit release: the erasure ledger, a durable record of each erased account, and a restore that refuses an account erased after its backup was taken); operator action: set the same `accountErasure.ledger.retentionDays` on every core, at least as long as the longest backup retention; scripts that check the exit code of `bin/backup.js --restore` handle the new codes `3` and `4` (see `CHANGELOG-v2.md`), pull the new image, or `npm install` on a native install | yes (with rc.90) |
| 2.0.0-rc.90 | 2026-11-26 | 1 High, lower-severity fixes (two rated Medium and not counted: a second consent accept on the same scope left the first working; platform writes lost during a leader change), completion steps of earlier findings, and most of the limits and token work planned in section 5 since the first revision (per-account, per-access and per-connection limits; cached routing lookups with a DNS response rate limit; a floor on chosen tokens; keyed store hashes; signed webhook calls; the authenticated at-rest envelope written; feature permission names a closed set); dependency update, not an audit finding: rqlite 10.7.5 (GHSA-f4f3-px5g-gm4x, GHSA-j62w-8865-2h7x, `x/net` 0.63.0); operator action: every core of a platform on 2.0.0-rc.86 or later before deploying this release on any of them, and every process of a core on this release together; deploy an auth page that takes 10-symbol registration codes first; a production core refuses the published development admin key and files-read secret (run `bin/check-config.js` before); upgrade the rqlite followers first and the leader last, native installs replace `bin-ext/rqlited`; audit filters that list methods one by one add the new record names; clients handle the new `429`, `400` and `503` answers (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-26) |
| 2.0.0-rc.91 | 2026-11-27 | no new finding; new administration surface, reviewed before merge (platform setup with a one-time code, administrator sessions with step-up and roles on every `/system` route, an origin rule on `/system`, an opt-in break-glass scope for the admin key) and OAuth2 client validation levels; hardening: a fresh install keeps registration closed until its setup is finished, MFA confirmation and sign-in sessions are checked by kind, storage engines' interface versions are checked at boot; lower-severity fixes (the reference nginx sample's OAuth2 locations missed other spellings of the routes; the audit trail kept under `audit.onUserDelete: keep` records deletions and restores, keeps no username and is no longer removed by a restore; `bin/migrate-platform.js` copies every platform row; a mail switch that is not a boolean is refused); operator action: replace a `services.email.enabled` object with the flat `services.email.send...` switches before upgrading (the core refuses to start otherwise; `bin/check-config.js` reports it); an existing platform is recorded as set up at its first boot, with nothing to do; update a copy of `docs/nginx-ingress-sample.conf`; update or remove engine folders under `storages/engines/` that this release does not ship; audit filters that list methods one by one add `account.deleted` and `account.restored`; scripts that parse `bin/oauth-client.js list` handle two more columns (see that release below), pull the new image, or `npm install` on a native install | yes (2026-11-27) |

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
tokens; the admin key holder; administrators holding an administrator session, and the holder of a
platform's one-time setup code (since 2.0.0-rc.91); another core of the same platform; the master
process and its workers; the operator's custom authentication step; and the caller id carried for
attribution.

### 3.2 Network surfaces

| Surface | Exposure |
|---|---|
| API server: REST routes per account (events, streams, accesses, account, profile, MFA, webhooks, shared secrets, delegations, consent), batch calls, socket.io | public, access token |
| Registration and access requests (`/reg/*`, `/users`, `/access/*`) | public, partly unauthenticated |
| Administration (`/system/*`, `/reg/admin/*`, `/reg/records`, account deletion with the admin key) | admin key; on `/system/*`, since 2.0.0-rc.91, also an administrator session holding the route's permission, and a call carrying a foreign `Origin` without the admin key is refused |
| Platform setup (`/system/setup/*`, the built-in setup page `GET /system/setup/`, since 2.0.0-rc.91) | public; the setup steps need the one-time setup code while setup is pending, and the page answers `404` once setup is done |
| OAuth2 authorization server and third-party sign-in callbacks | public |
| HF series server (series reads and writes, batch) | public, access token |
| Previews server and attachment downloads | public, access token or read token |
| Hosted sites and proxy sites | public |
| Embedded DNS (UDP and TCP) | public when enabled |
| ACME HTTP-01 responder | public when Let's Encrypt is enabled |
| rqlite platform database: HTTP API (loopback) and Raft (peer cores, mutual TLS) | local / peer cores |
| Adapter routes (`/adapter/<name>/` on every host, since 2.0.0-rc.73, off unless configured): forwarded to a sidecar on the same host; on a per-user host (`<username>.<dns.domain>`, since 2.0.0-rc.75) the core names the addressed account to the sidecar (`X-Adapter-Name`, `X-Adapter-Base`, set by the core only, client-sent copies dropped) and answers `421` for an account of another core | public, authenticated by the sidecar, not by the core (the two headers are an address, not an identity) |
| Address aliases (`<alias>.<dns.domain>`, since 2.0.0-rc.76): names of an account minted by the server at its owner's request (`a-` + 8 letters or digits, at most 10), routed to the account's core and answered by the embedded DNS like a username; an OAuth2 consent at one adopts it for that client's grant | public addresses of the account; minted, listed and deleted with the owner's personal token only |
| Per-user OAuth2 issuer (`oauth.perUserIssuer`, since 2.0.0-rc.77, off unless configured): on an account's own host (`<name>.<dns.domain>`) the OAuth2 issuer is that host; its discovery documents, consent, code, refresh token, id_token and client assertions are bound to it | public, like the configured issuer; only the account the host names consents there |
| OAuth2 client metadata documents (an https URL as `client_id`, since 2.0.0-rc.74, off unless configured): the core fetches the document, and the key set it names, from the client's host | public: any party can present such a client to the consent screen of the hosts the operator allows |
| Local pub/sub broker for cache invalidation | loopback |
| PostgreSQL, InfluxDB, SQLite files | local |

**Outbound calls:** webhooks, mail (SMTP or a mail service), SMS providers for MFA, core-to-core
calls, cluster join acknowledgement, ACME, S3, the observability exporter, and (when turned on)
the OAuth2 client metadata documents and their key sets (https only, no redirect followed,
private addresses refused, size, time and rate bounds).

### 3.3 Operator tools and boot

Server start and cluster join (`bin/master.js`, including `--bootstrap`), cluster administration
(`bin/bootstrap.js`), backup and restore (`bin/backup.js`), install wizard and configuration
helpers (`bin/init.js`, `bin/check-config.js`, `bin/config-to-env.js`), DNS records and mail
templates (`bin/dns-records.js`, `bin/mail.js`), migrations, PII hashing migration and rotation,
OAuth2 clients, observability, breach scope, integrity checks and index reconciliation, and since
2.0.0-rc.91 platform administration (`bin/admin.js`: setup code, claim codes, roles, administrator
sessions, on the platform database directly). The
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
  update and delete (for a stream id written with its store prefix, only since 2.0.0-rc.56: see
  that release below); `create-only` never reads; an explicit `none` wins over a parent grant.
- **Reads through store-prefixed stream ids** (checked again in the 2.0.0-rc.56 follow-up): query
  stream ids are resolved to their store before the query runs, so the exclusions of internal
  plugin streams and of hidden account fields apply whatever spelling is used; no read path
  around them was found.
- **The `*` scope** never reaches the account or audit stores (with a custom data store configured
  under the id of a built-in store, only since 2.0.0-rc.86: see that release below); non-personal
  tokens read only their own audit stream (for deletion records, only since 2.0.0-rc.65: see that
  release below).
- **Access aliases** (checked in the 2.0.0-rc.66 follow-up): an access created with `randomAlias`
  cannot obtain the account's username or former usernames through any account stream of the
  shipped configuration (for a custom account stream named after a server-managed field, only
  since 2.0.0-rc.66: see that release below); since 2.0.0-rc.69 it is used at its alias only, and
  sign-in at an alias gives one answer, so neither confirms the account behind the alias (see that
  release below).
- **Access creation rules:** personal accesses cannot be created through the API; apps create shared
  accesses only; expiry is capped by the creator; tracking fields are set by the server.
- **Token lookup** is scoped to the account named in the path; deleted and history rows are never
  matched; expiry is re-checked on every use, including cache hits; the personal session is checked
  uncached and bound to the account.
- **DPoP-bound tokens** are enforced at one shared check for every transport and fail closed where
  no proof can be presented.
- **Wrong-core requests** answer `421` without forwarding, so no credential leaves the core.
- **Administration plane:** one gate with a constant-time admin key check in front of every system
  route; system methods are not reachable through batch calls or socket.io. Since 2.0.0-rc.91 the
  same gate accepts an administrator session, checked against the account's role on every request,
  and every `/system` route names the permission it needs (a route without one fails the test
  suite).
- **Registration e-mail challenge and e-mail verification:** hashed codes and tokens, attempt
  budgets, constant-time comparison, expiry, links built from configuration, never from the `Host`
  header.
- **SQL construction:** every PostgreSQL statement is scoped by user id and parameterised (content
  conditions, type wildcards and stream lists included); the SQLite engine quoted and escaped the
  values it inlined, and binds every value since 2.0.0-rc.85 (its stream-id matching was not exact
  until then: see that release below).
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
- **Completed in 2.0.0-rc.90:** a production core also refuses to boot with the admin key and the
  files-read secret of this repository's development and test configurations (see that release
  below).

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
- **Completed in 2.0.0-rc.86:** the cases where a process could still miss an invalidation, and
  serve the old value until its maximum age, are closed (see 2.0.0-rc.86 below).

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
- **Completed in 2.0.0-rc.86:** every file of a backup run is now authenticated, and runs can be
  signed (the step planned in section 5 since the first revision; see 2.0.0-rc.86 below).

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

2.0.0-rc.54 carries no security fix (logging behaviour changes only).

### Lower-severity fixes in 2.0.0-rc.55 (deployed with 2.0.0-rc.56)

- **Log masking missed some contexts** (Low; completes the 2.0.0-rc.43 item "Credentials in
  logs"): a logged context holding a BigInt value, or one that cannot be converted to JSON (a
  circular object, or one whose conversion throws), was written without its credential keys
  masked (on every log target for a BigInt, on the text console for a context that does not
  convert); a log message that was not a string (such as a URL object) was not masked; credential
  keys inside a logged text were matched case-sensitively and for a shorter list of names. Every context and message now goes through the same masking,
  whatever its shape, with bounded cost; credential keys inside a text are matched for every name
  masked as an object property, whatever their case.
- **Container image:** based on Debian 13 instead of Debian 12, whose remaining critical and high
  operating-system package advisories had no fix; the bundled rqlite is 10.6.0 (10.7.5 since
  2.0.0-rc.90), built with a patched toolchain, and the native install script checks the rqlite
  archive's checksum. Every
  release image is now scanned in CI before it is published, and a critical advisory that has a
  fix stops the release (see section 5).
- **Operator action:** as for the earlier log items, logs written by earlier releases may hold
  such values: check their retention. Native installs replace `bin-ext/rqlited` themselves
  (`INSTALL.md`, "Upgrading the bundled rqlite"); images built `FROM` the open-pryv.io image that
  install packages now resolve them against Debian 13.

### Fixed in 2.0.0-rc.56 (deployed)

A stream id can be written with the prefix of the store that holds it: `:local:<id>` names the same
stream as `<id>`, and an account field can be named through the account store's prefix. Both
findings below come from guards that compared the stream id as written, while the storage layer
resolved the prefixed spelling to the protected stream.

#### Store-prefixed stream ids passed the guards of the consent and delegation areas

- **Severity:** High (an app or shared access with `contribute` reaching the consent plugin's
  internal area, which a `*` grant at `contribute` or above does; the effect described below needs
  the consent retry loop, on by default since 2.0.0-rc.53). Applies to every release carrying the
  consent and delegation plugins; on releases before 2.0.0-rc.53, the dispatch part applies only
  where the operator turned the retry loop on.
- **What could happen:** the guards that close the consent (`:_cmc:`) and delegation
  (`:_delegation:`) plugin areas to user writes did not recognise a store-prefixed spelling of a
  protected stream id. A token allowed to manage streams could create a stream inside, or move one
  into, the plugins' internal areas (the owner's personal token included, which these guards also
  bind), and an app or shared access could write an event into the consent retry queue. The retry
  loop then processed such an event as a pending consent action of the account, outside any
  request and its checks: an app or shared access could have the server carry out consent actions
  on the account's behalf, such as accepting an offer (which grants a counterparty access to the
  account's data) or withdrawing a relationship. Reads were not affected (section 4.1).
- **What changed:** stream ids are brought to their canonical spelling before any guard runs, on
  `streams.create`, `streams.update`, `events.create` and `events.update`, and the plugins' own
  checks judge the canonical id. A new or moved stream inside the plugin-managed regions of
  `:_cmc:` (everything except `:_cmc:apps` and the user-created streams under it) or of
  `:_delegation:` is refused with `400 invalid-operation` (`cmc-reserved-stream` /
  `delegation-reserved-stream`),
  for every token, the owner's personal token included; a plugin-managed stream can no longer be
  moved or trashed. The retry loop processes only records the server wrote itself (author, stream
  and type checked) and retires any other record without processing it
  (`cmc-retry-foreign-record`); as defence in depth, it also never replays an accept the server
  itself authored. Streams under `:_cmc:apps` are unchanged.
- **Operator action:** upgrade. Until then, on 2.0.0-rc.53 to rc.55 (or an earlier release with
  the loop turned on), set `cmc.retryLoop.enabled: false` and restart: the loop then processes no
  record. This covers only the retry-queue part: placing or moving a stream inside the plugins'
  areas is refused only by the upgrade. While it is off, a consent delivery that fails is not queued and is not retried later,
  and expired group memberships are not swept (member accesses end at their own expiry); set it
  back to its default (`true`) after the upgrade. A read-only check for past use is recommended
  (streams placed inside the plugins' internal areas; retry records the server did not write,
  which the upgraded loop retires as `cmc-retry-foreign-record`); any hit is handled case by case.

#### Store-prefixed stream ids passed the account-field guards

- **Severity:** High (an app or shared access holding `contribute` on the account's e-mail field,
  a permission an account owner can grant). Applies to every 2.0.0 release candidate before
  rc.56.
- **What could happen:** the account fields are protected by guards: the primary e-mail is
  written only through `account.update`, some fields are not editable or are hidden, and
  permissions on account fields are capped by level. These guards did not recognise an account
  field named through a store prefix, so a request using such a spelling reached the field around
  them. In particular, an access holding `contribute` on the e-mail field could change the
  account's primary e-mail, the address password-reset links are sent to, through the events API:
  a path to taking over the account. With a personal token, the same gap let the owner write
  fields that are not editable.
- **What changed:** the account-field guards judge the canonical spelling of a stream id on
  `events.create`, `events.update`, `events.delete`, `accesses.create` and `accesses.update`; an
  id that routes to the account store without naming a known account field is refused as an
  unknown stream; a permission given through a prefixed spelling is stored under the canonical id,
  and the creator's own permission check judges that canonical id, so an app holding only a `*`
  grant on the regular streams cannot hand out a permission on an account field (`403
  forbidden`). Every permission-level check also judges the canonical id; an account field named
  through a prefix in a permission stored before the upgrade stays as ineffective as it was.
  Requests that use canonical ids are unchanged.
- **Operator action:** upgrade; there is no configuration workaround.

#### Further fixes in 2.0.0-rc.56

- **Stream moves carried children granted at a lower level** (Low-Medium): `streams.update` with
  a new `parentId` needed manage rights on the moved stream and on the target parent only, so a
  child granted to the caller at a lower level (`read`, `create-only`, `none`) moved along with
  its parent into the reach of the accesses that inherit from the target parent. A move by a
  non-personal access now needs manage rights on every stream of the moved subtree, trashed ones
  included, as the deletion of a trashed stream already did (2.0.0-rc.44). Residual: an access
  created before a move keeps the exceptions it inherited from the stream tree as it was then,
  which after this fix concerns only streams the mover manages.
- **A stream could be moved under its own descendant** (Low): such a move was accepted and left
  the streams concerned unreachable from the root; it is refused with `400 invalid-operation`, and
  the permission walk now stops on a parent chain that loops, should one exist in stored data.
- **Calls to consent counterparties could reach internal addresses** (Low): consent deliveries,
  revocations, scope updates, the reading of an offer at accept, delegation notices and OAuth
  revocation notices go to URLs the other side of the relationship supplies, and these calls had
  no destination policy. The method, path and body of such a call are fixed by the server and its
  answer is not returned to the counterparty. These calls now follow the webhook rules
  (2.0.0-rc.44): a destination that is or resolves to a loopback, private, link-local or otherwise
  reserved address is refused before any connection, as are `http:` (unless
  `cluster.allowInsecurePeerUrl`), credentials in the URL, redirects and answers larger than 1 MiB;
  the platform's own host names are always allowed. A refused delivery is permanent and reported
  on the triggering event (`cmc-handler-destination-refused`, `cmc-capability-destination-refused`).
- **A single-use invite could not be withdrawn** (Medium; reported publicly in open-pryv.io#160):
  `consent/invalidate-link-cmc` was a no-op on a single-use invite, so an invite sent to the wrong
  person stayed usable until it expired. An invite nobody accepted yet is now withdrawn (a later
  accept is refused with `cmc-capability-invalidated`), and a withdrawal that races an accept
  wins. The offer text stays readable through the link until it expires: give sensitive invites a
  short `expiresAt`.
- **Usernames and platform names could collide** (Low): an account whose username equalled a
  core id, a static DNS entry or a runtime DNS record was unreachable at `<username>.<domain>`
  (those names are answered first), and a new DNS record or core id (administration actions) could
  take the name of an existing account. Each side now refuses a name the other holds; existing
  accounts and records keep working.
- **Access deletion records can be purged** (planned at revision 2, section 5): the new per-core
  setting `accesses.deletionRecords.retentionDays` (default `0`, kept until the account is
  erased) removes, once a day, the deletion records of accesses deleted longer ago, with their
  earlier versions and index rows. Past it, an audit entry or an event author shows such an access
  by id only, and breach scoping no longer resolves it.
- **Operator action:** list counterparties on a private network, and a `core.url` given as a
  private IP address, in the new `cmc.allowedPrivateHosts` (same grammar as
  `webhooks.allowedPrivateHosts`; checked at boot). Relationships whose counterparty is reached
  over `http:` or answers with a redirect stop receiving deliveries; check them before the
  upgrade. Choose a deletion-record retention, if any, with the attribution trade-off above in
  mind. Clients that enumerate invite statuses: `invalidated` now also applies to single-use
  invites.

### Fixed in 2.0.0-rc.64 (deployed)

#### Withdrawing an OAuth2 consent left the app's live session tokens working

- **Severity:** Medium (deployments that serve OAuth2 clients). The exposure is bounded by the
  lifetime of a session token (`oauth.accessTokenTTL`, one hour by default); the comparable
  consent item of 2.0.0-rc.52 was High because its sub-accesses had no such bound.
- **What could happen:** deleting the data grant behind an OAuth2 consent (from the account app,
  with `accesses.delete`, or through a revocation sent by the client) ended the refresh chain, but
  the client's current session accesses were not linked to the grant and stayed valid until their
  own expiry, with the accesses they had created. An app whose consent was withdrawn could keep
  reading and writing within the consented scope for up to one session lifetime.
- **What changed:** a session access names its grant (`clientData.oauth.dataGrantId`, which
  `accesses.update` refuses to change or remove, `403`), and deleting the grant deletes its live
  sessions and the accesses they created, reported in the answer's `relatedDeletions` and dropped
  from the access cache of every worker. The revocation that answers a reused refresh token now
  goes through the same teardown as `accesses.delete`, so aliases are released, credentials are
  removed from the deletion records and running webhooks are stopped there too.
- **Operator action:** none. Sessions minted before the upgrade carry no link to their grant and
  expire on their own, one session lifetime at most after the upgrade.

#### `events.getOne` with `includeHistory` returned versions the access cannot read

- **Severity:** Medium (deployments that keep event history, `versioning.forceKeepHistory: true`).
  A caller needs read access to the event as it is now.
- **What could happen:** the earlier versions of an event were returned as stored, without the read
  check applied to the event itself. An event moved out of a stream the access cannot read, or out
  of a stream it holds at `none`, still showed its earlier content and stream ids in `history`.
- **What changed:** every earlier version goes through the same check as the current event
  (forbidden, internal and hidden streams, forced streams, readable streams); a version that fails
  it is left out of `history`.
- **Operator action:** none.

### Fixed in 2.0.0-rc.65 (deployed)

#### Apps and consents could be granted write access to account fields

- **Severity:** Medium (an app or shared access granted `contribute`, `manage` or `create-only` on
  an account field; the user agrees to such a grant when accepting an app access request, a
  consent offer between accounts or an OAuth authorization, whose permissions the requesting
  party writes). Rated below the account-field item of 2.0.0-rc.56 because the primary e-mail was
  not reachable this way (its own guard already refused writes by app and shared accesses), so
  the effect is an integrity gap on the other account fields and a bounded disclosure, not a path
  to the account.
- **What could happen:** a third party could ask for, and after the user's acceptance obtain, a
  write level on a visible account field (the language, or a field the platform defines) and then
  rewrite it with `events.create` or `events.update`. Accepting a consent offer, or a collector's
  scope request, also applied none of the account-field rules of `accesses.create`: an offer could
  grant a hidden account field at `read` (for example the invitation token used at registration),
  an unknown account stream, or the account root above `read`.
- **What changed:** every access other than the personal one is limited to `read` (or `none`) on
  account streams. `accesses.create` and `accesses.update` refuse a higher level with
  `400 invalid-operation`, whoever creates the access, so an app access request asking for one
  fails the same way; a consent accept or a scope update applies the same rules as
  `accesses.create` and refuses a non-conforming set with `cmc-offer-invalid-permissions`, granting
  nothing (an OAuth authorization asking for a write level is refused there). An access already
  stored with a write level keeps reading the field, but its writes on account streams (events and
  attachments) are refused with `403 forbidden`; a write on the e-mail field by an app or shared
  access now answers `403 forbidden` too, instead of `400`.
- **Operator action:** upgrade. The change is BREAKING for apps that set account fields for the
  user: they must ask for `read` only and let the user change those fields with a personal session
  (the account app or `account.update`). Stored accesses need no migration.

#### A consent refused for its permissions could complete on retry

- **Severity:** Medium (consent integrity; the retry loop is on by default since 2.0.0-rc.53, and
  applies to earlier releases only where the operator turned it on). Accepting a consent is open
  to a personal token only, and that gate held: the checks skipped on retry are the ones behind
  it, so the effect is a grant minted against the server's refusal, not a grant obtained by a
  less privileged access.
- **What could happen:** a consent accept or a collector's scope update refused for its
  permission set (`cmc-granted-permissions-not-subset`, `cmc-insufficient-permissions`) was queued
  for retry like a delivery failure. The retry replays the request outside its original context,
  without the access that made it, so the checks that depend on that access did not run: about a
  second after the consent was reported as failed, the grant could be minted, or the collector's
  access widened. The effective-permission check skipped this way is the one that refuses a
  narrowed grant which, by leaving out a restrictive entry of the offer, would reach further than
  the offer.
- **What changed:** these refusals, and `cmc-offer-invalid-permissions`, are final and never
  retried, and the account-field rules of the accept and of the scope update (previous item) run
  on every attempt, a retry included.
- **Operator action:** upgrade. Until then, setting `cmc.retryLoop.enabled: false` stops new
  refusals from being queued, with the side effects described under 2.0.0-rc.56 (failed consent
  deliveries are not retried while it is off).

#### Deletion records of internal streams were returned to accesses reading the whole store

- **Severity:** Medium where `versioning.deletionMode: keep-everything` is set (not the default,
  `keep-nothing`), as deletion records then keep the content of the deleted events; Low in the
  other modes, where only stream ids were concerned. An app or shared access reading the whole
  store (`*` at `read` or above) was needed.
- **What could happen:** `events.get` with `includeDeletions` skipped the read check on deletion
  records for an access reading the whole store, so such an access received the deleted events of
  hidden account fields, of the e-mails area, of plugin-internal streams and of other accesses'
  shared secrets, which a `*` grant does not reach for live events. `streams.get` with
  `includeDeletionsSince` likewise returned the deletion records of e-mails, plugin-internal and
  other accesses' shared-secret streams, whose ids name internal objects (for instance the
  per-link streams removed when a consent capability is cleaned up).
- **What changed:** every access but the personal one gets only the event deletion records it
  could read as live events, and only the stream deletion records it could see as live streams;
  records that keep no streams are still returned to an access reading the whole store, as
  before.
- **Operator action:** none. Client developers: the filter applies after `limit` and `skip`, so a
  page of deletions can hold fewer records than `limit`, or none; a sync client must not treat a
  short page as the end of the listing.

#### Lower-severity fixes in 2.0.0-rc.65

- **An expired OAuth2 consent grant stayed usable for refresh for up to one second** (Low): the
  refresh grant compared the grant's expiry with the current time rounded down to the second. It
  now answers `invalid_grant` as soon as the grant has expired, and the authorization-code exchange
  applies the same exact comparison.
- **SQLite engine: `events.getOne` served an earlier version of an event by its own storage id**
  (Low, SQLite deployments with event history kept): the API never returns that id, but asking for
  it answered with the stored version, where the PostgreSQL engine answers `404 unknown-resource`.
  The SQLite engine now answers `unknown-resource` too, for reads and updates; history stays
  available through `includeHistory` on the current event (filtered since 2.0.0-rc.64).
- **Deletion listings hold current events only** (defence in depth): both engines now leave earlier
  versions of an event out of deletion listings, as the single-event lookups already did. No API
  path marks an earlier version as deleted; this covers a restored or hand-edited store.
- Not a security fix, listed for operators: an OAuth2 token issued within the same second as an
  operator revoke of its client (after the client was registered again) was refused as revoked;
  the accesses minted by the `refresh_token` and `client_credentials` grants now carry a
  millisecond creation time, like every other access.

### Fixed in 2.0.0-rc.66 (deployed)

This release also refuses to boot a configuration that sets `dns.domain` but leaves
`dnsLess.isActive` out (BREAKING for such configurations, not a security fix: run
`node bin/check-config.js` on the configuration before restarting on it; `CHANGELOG-v2.md` has the
details).

#### A narrowed OAuth2 consent grant did not reach refreshed sessions

- **Severity:** Medium (deployments that serve OAuth2 clients). The app keeps only what the user
  consented to at some point, and the user can still withdraw the whole consent (2.0.0-rc.64); what
  failed is a partial withdrawal, which every refresh ignored for as long as the refresh chain
  lived (`oauth.refreshTokenAbsoluteTTL`, 90 days by default).
- **What could happen:** a refresh mints the new session from what both the session's own consent
  and the app's consent grant allow, but compared them entry by entry, ignoring the stream tree and
  the grant's feature restrictions. An exclusion the user added to the grant below a stream the
  session holds (`none`, or `create-only` under a readable stream) did not reach refreshed sessions,
  which kept reaching the excluded stream through its parent; a restriction added to the grant (for
  example `webhooks: forbidden`) never reached them; and when a session held a child stream at a
  narrower level than its parent and the grant stopped listing the child, the refreshed session
  got the parent's level on it, above its own consent.
- **What changed:** the refresh meets the two permission sets stream by stream and then applies
  the exclusions of the grant and of the session's own consent below every stream it keeps, as
  `accesses.create` does for a child access; a stream the two sides grant at levels sharing no
  capability (`read` and `create-only`) is held at `none`; the grant's restrictions reach the
  refreshed session. A re-authorization at another level now merges into the grant stream by
  stream (one entry per stream); a level that would combine `read` and `create-only` is refused
  with `400 invalid_scope`, since the only level covering both adds `update`, which neither consent
  gave.
- **Operator action:** none. A narrowing reaches a session already issued at its next refresh, one
  session lifetime at most (`oauth.accessTokenTTL`, one hour by default).

#### Backup and restore did not keep the account aliases

- **Severity:** Medium (platforms that restore accounts from a backup into a platform where the
  names are free, for example a disaster recovery or a migration; aliases and username changes are
  on by default).
- **What could happen:** the aliases of an account (those of its `randomAlias` accesses and its
  former usernames) were not part of the backup. After a restore, the aliased accesses and the
  endpoints under a former username answered `404`, and a former username was free for anyone to
  register: links and endpoints the account had handed out under that name then led to another
  person's account.
- **What changed:** the backup manifest lists each account's aliases and the restore reserves them
  again; an alias another account or core took meanwhile stays with its holder and is reported.
- **Operator action:** take a new backup after upgrading. Backups written by earlier releases list
  no aliases, and a restore from one still leaves them free.

#### A username change could overwrite a name taken while it ran, or stop half-way

- **Severity:** Medium (integrity of another account's name; it needs a registration, or another
  change, of the same name on the same core within the short window of the change).
- **What could happen:** `account.changeUsername` checked that the new name was free, then wrote
  the platform rows, the users index and the account in turn, without a step able to refuse a
  taken name and without undo. A name registered or taken as an alias by another account in
  between was overwritten in the platform rows and the change then failed with `500`, leaving both
  accounts inconsistent; a storage failure after the checks left the account split between its
  former and new name; two concurrent changes of one account could both apply, exceeding the
  change limit.
- **What changed:** the change holds the current name as an alias first, and the local rename and
  the alias check refuse a taken name (`409 item-already-exists`) before anything else is written;
  a failure after the checks undoes every step made (`500`, the account whole under its former
  name, the new name free); concurrent changes of one account apply once, the others answer
  `400 invalid-operation`.
- **Operator action:** none.

#### Lower-severity fixes in 2.0.0-rc.66

- **Access aliases could outlive refused requests and were minted without bound** (Low-Medium):
  with `randomAlias`, the alias was reserved before the request's checks, so a refused
  `accesses.create` left a routing name to the account until its erasure, and an access created
  during the deletion of its parent kept its alias. Any access able to create accesses could thus
  add platform rows without limit (replicated to every core on a multi-core platform). The alias
  is now reserved after every check and released when the access cannot be stored, the late
  deletion releases it, and an account holds at most `accesses.maxAliasesPerAccount` aliases
  (default `1000`, access aliases and former usernames together).
- **Duplicate stream entries in a permission list** (Low): an access holds one level per stream,
  but `accesses.create` and `accesses.update` accepted two entries for the same stream (in any
  spelling, `a` and `:local:a`), stored and listed both and applied only the last one, so a
  listing could show a level that was not in force. Such a request now answers
  `400 invalid-request-structure`; stored accesses keep their behaviour (the last entry applies).
  At an OAuth2 consent, `grantedPermissions` naming one stream twice is refused with
  `400 invalid_scope`.
- **Custom account streams could expose server-managed account fields** (Low, configuration
  dependent): a custom account stream named `username` or `usernameChangeCount` would have exposed
  the values the server keeps under those names, to an aliased access too, defeating the purpose
  of the alias. Such a configuration is refused at boot. The shipped configuration defines no such
  stream.
- **The platform integrity check missed rows of unknown accounts** (Low): the users-index part of
  `system.checkPlatformIntegrity` never reported anything, so rows that a deleted account left
  behind passed it. It now reports each user id unknown to the users index (PostgreSQL engine; on
  SQLite the check lists the accounts from the users index itself, so it cannot see such rows).
- **An account erasure that failed half-way was never completed** (Low-Medium, erasure): a failure
  or a crash at or after the removal of the account from the users index left its remaining data
  (user directory, SQLite files, series) in place with nothing able to find it again. Every erasure
  now keeps a progress record, and an interrupted one is completed by a later pass of the
  background sweep, which runs on every core whatever the auto-deletion setting.
- **HF series follow a username change** (completion of the 2.0.0-rc.47 item on HF series and
  aliases): points written before a username change stayed under the former name, out of the
  owner's reach under the new one (they were erased with the account). The change now moves them,
  and the backup exports, and the restore re-imports, the series kept under former names. Operator
  action: run `node bin/gather-former-series.js` once per core after upgrading, every API and HF
  worker on this release, to gather the series of accounts renamed before it.
- Not security fixes, listed for operators: on a single core serving its own DNS, aliases and
  changed usernames now resolve (run `node bin/reconcile-user-cores.js` once per core to add the
  names minted before this release); sign-in works with a former username; sockets opened before a
  username change are disconnected instead of staying silent; `account.changeUsername` reports the
  steps that did not complete in `warnings`.

2.0.0-rc.67 carries no security fix: it is the 2.0.0-rc.66 server, with the Docker image that
release lacked.

### Lower-severity fixes in 2.0.0-rc.68 (deployed)

2.0.0-rc.68 adds OAuth2 clients registered by the operator, without an app account, and an OAuth2
extension entry point. Both are opt-in (without an extension module, every such client is refused)
and are new features, described in `CHANGELOG-v2.md`, not fixes. The review of the consent flow
made alongside them found the following in earlier releases:

- **The first OAuth2 session after a consent ignored the restrictions the owner had set on the
  grant** (Low-Medium; deployments that serve OAuth2 clients): the session minted when the user
  consented carried exactly the permissions ticked on the consent screen, without the exclusions
  (`none` below a granted stream) or the feature restrictions (for example `webhooks: forbidden`)
  that the account owner had added to the app's consent grant; they reached the session only at
  its first refresh (since 2.0.0-rc.66). The exposure was bounded by one session lifetime
  (`oauth.accessTokenTTL`, one hour by default) and needed a new consent by the user. The session
  minted at consent now starts under the grant's restrictions, as its refreshes do.
- **A change to a consent grant now reaches the live OAuth2 sessions at once** (hardening;
  completes the 2.0.0-rc.66 item on narrowed grants): a narrowing of the grant (by the owner with
  `accesses.update`, by a re-consent, or by a consent scope update) reached a session already
  issued at its next refresh, one session lifetime at most. Each live session of the grant is now
  brought to what its next refresh would mint as soon as the grant changes, and deleted when it is
  left with no reach.
- **A feature restriction in a consent offer could be left unticked** (Low): a consent offer
  (OAuth2, consent between accounts, or the consent part of an app access request) could mark a
  forbidden feature as optional, so a user who left it unticked granted the feature. No party
  obtained more than its own offer allowed, but unticking a restriction widened the access, the
  opposite of what the consent screen suggests. A forbidden feature is now always mandatory in an
  offer, and one marked optional is refused.
- **OAuth2 sessions were missing from the access index used to scope a breach** (Low; incident
  response): the cluster-wide index that resolves an access id to its account
  (`GET /system/accesses/:accessId`, admin key) had no row for the sessions minted by a refresh or
  by the `client_credentials` grant, and these sessions emitted no access-change notification.
  Every session the OAuth2 flow mints is now indexed and notified as `accesses.create` does, and a
  session removed after a failed code exchange is marked deleted there. Sessions minted by earlier
  releases expire on their own, one session lifetime at most after the upgrade.
- **Only the account owner can consent** (defence in depth): the OAuth2 consent endpoint accepted
  any valid token of the account and relied on the access-creation rules further on to refuse a
  token other than the personal one, which they did (a token obtained through delegation was
  already refused at once). Such a token is now refused at once with `403 access_denied`.
- **`clientData.oauth` is written by the server only** (hardening; completes the 2.0.0-rc.64 item
  on withdrawn consents): `accesses.create` refuses an access carrying it and `accesses.update`
  refuses any change to it (`403`), where only its `dataGrantId` was protected on update before.
  BREAKING for a client that wrote this key; none is known.
- **A consent offer naming one stream twice** (Low; completes the 2.0.0-rc.66 item on duplicate
  stream entries): a `consent/request-cmc` offer naming a stream twice, in any spelling, is refused
  at write, and one already stored is refused at authorization (`invalid_scope`).
- Not security fixes, listed for operators: a refresh that failed on the server side (a storage
  error, or an extension hook failing or timing out) used up the refresh token, so the app's retry
  was taken for the reuse of a stolen token, which ends the grant; the refresh token now stays
  usable. The session minted at consent is written by the server (`createdBy: system`), so the
  consent appears in the audit log as `oauth.consent.granted` and as the grant's own rows, no
  longer as an `accesses.create` row.
- **Operator action:** none. The new optional key `oauth.extensionHookTimeoutMs` (default `5000`)
  bounds each extension hook; the operator CLI `bin/oauth-client.js create-registry` registers the
  new clients (`--subject-type` and at least one `--audience`, or `--any-audience`, are required).

### Fixed in 2.0.0-rc.69 (deployed)

2.0.0-rc.69 adds OAuth2 token introspection (RFC 7662) and revocation (RFC 7009), OpenID Connect
for the clients registered by the operator, and pseudonymous OAuth2 subjects (the app knows the
account by an alias only). These are new features, opt-in per client or per configuration and
described in `CHANGELOG-v2.md`, not fixes. The review of the refresh chain and of access aliases
made alongside them found the following in earlier releases.

#### A refused refresh used up the refresh token and could end the user's consent

- **Severity:** Medium (deployments that serve OAuth2 confidential clients). It needs a refresh
  token of the client, without its secret or key, for example from a leaked log line; the gain is
  a loss of availability, not data.
- **What could happen:** the token endpoint used up the refresh token before it checked the
  client's authentication and that the token was issued to the calling client. A request with the
  right client id and a wrong secret, or with any other client id, was refused, but the token was
  spent. The legitimate app's next refresh then looked like the reuse of a stolen token, which
  ends the refresh chain and withdraws the user's consent grant on every device, with a theft
  notice. A refresh token without its client's secret could thus end a user's consent at will.
- **What changed:** the client's authentication, its suspension and the token's client binding
  are checked before the token is used up, so a refused request leaves the token working for the
  client it was issued to. A rotated refresh token presented by another client is refused without
  ending the chain.
- **Operator action:** none.

#### An access alias could be linked to the account behind it

- **Severity:** Medium (accounts holding accesses created with `randomAlias`; aliases are on by
  default). It needs the alias, which the aliased access's own `apiEndpoint` carries, and for the
  first path a guessed username; the gain is a confirmation of who is behind a pseudonym.
- **What could happen:** two paths confirmed the account behind an alias. Sign-in addressed by the
  alias (`POST /<alias>/auth/login`) answered differently when the username in the body was the
  account's, before any password check, so wrong guesses were not counted and could be repeated
  without limit; the matching guess was counted as a failed sign-in of the owner, so repeating it
  could also delay the owner's sign-in. And a token of the account was accepted at any of its
  names (username, former usernames, aliases), so the holders of two aliased accesses could learn
  whether their aliases were one person. A password reset could also be requested at an alias,
  sending reset mails to the owner.
- **What changed:** sign-in and password reset addressed by an access alias are refused with one
  fixed answer (`400 invalid-operation`), whatever the credentials, before any password check and
  without counting a failed sign-in. An aliased access is used at its own alias only, and an access
  without an alias at the account's username and former usernames only; any other use answers as an
  unknown token (`403 invalid-access-token`). An access created by an aliased access carries the
  creator's alias. Sign-in and password reset are unchanged at the username and at former
  usernames, and the owner's personal token is accepted at every name of the account.
- **Operator action:** none. BREAKING for a client that called the username, or another alias,
  with an aliased token: it must use the access's own `apiEndpoint`. Accesses such an app created
  before this release keep their username-based `apiEndpoint`.

#### Lower-severity fixes in 2.0.0-rc.69

- **The consent-flow state and the third-party sign-in state were keyed on the admin key**
  (hardening): the state carried from `/oauth2/authorize` to the consent page and back, and the
  state cookie of third-party sign-in, were signed with keys derived from `auth.adminAccessKey`.
  Forging either needed that key, which already grants the platform's administration, but the
  admin key lives in deployment tooling and operator shells, and its exposure should not also
  open what a browser flow trusts. Each is now signed with its own per-core secret
  (`oauth.stateKey`, `sso.stateKey`), used for nothing else; while one is empty the admin-derived
  key is still used and every boot logs a warning. A set value that is a placeholder or a
  published example refuses the boot.
- **Deleting an OAuth2 session did not end its refresh chain** (hardening): a session the user
  deleted from the account's access list was replaced at the app's next refresh (the consent
  grant, the documented withdrawal, was enforced). Deleting a session now also ends the refresh token
  issued with it. A refresh now also retires the access token it replaces, after
  `oauth.refreshRetireGraceSeconds` (default `60`), instead of letting it live out
  `oauth.accessTokenTTL`, and a refresh whose session was deleted while it ran ends the tokens it
  had just issued. Sessions minted by earlier releases are not linked to their refresh token and
  expire on their own, one session lifetime at most.
- **Audit rows carried the first characters of refresh tokens** (Low): the refresh audit rows
  identified a token by its first six characters, which is not enough to use or guess it but has
  no place in a log. They now carry a short digest of the token (this also changes the format of
  the existing refresh audit rows). The scope recorded for a consent of a registered client is the
  scope granted, no longer the requested one.
- **Operator CLI** (Low; operator side): `bin/oauth-client.js show` printed the client secret's
  hash, an offline-guessable value in terminal scrollback; it now prints `(set)`.
  `create-registry` stored a key set next to a client secret or with no authentication method,
  which the token endpoint then accepted as a second credential; a key set is now accepted with
  `private_key_jwt` only, and `update` applies the authentication method with its credentials,
  dropping the previous ones.
- Not security fixes, listed for operators: a refresh refused for good after its token was used no
  longer makes a later replay look like theft; on a re-authorization of a registered client, an
  entry the user declined before is offered unticked; the composed consent screen shows a feature
  the client may not be given as the restriction it becomes. `oauth.audAllowList` is removed (it
  was never enforced; the audiences a client may name are registered per client).
- **Operator action:** set `oauth.stateKey` on every core, and `sso.stateKey` on every core where
  `sso.enabled` is true: each a random value of at least 32 characters (for example
  `openssl rand -base64 32`), distinct from each other and from the admin key. Setting one only
  cancels the consent screens or sign-ins open at that moment. 2.0.0-rc.70 requires `oauth.stateKey`
  when `oauth.consentUrl` is set and `sso.stateKey` when `sso.enabled` is true.

### Fixed in 2.0.0-rc.70 (deployed)

2.0.0-rc.70 adds key sets by reference (`jwks_uri`) and RS384 / ES384 for `private_key_jwt`
client authentication, per-client token lifetimes, a client secret rotation window, the extension's
grant state and RFC 8707 resource indicators. These are new features, described in
`CHANGELOG-v2.md`, not fixes. The review made alongside them found the following in earlier
releases.

#### A long audience value could hold an API worker at the authorization endpoint

- **Severity:** Medium (deployments with an OAuth2 client registered with a list of audiences,
  `bin/oauth-client.js create-registry --audience`). Unauthenticated: it needs only that client's
  id, which is public; the gain is a loss of availability, not data, bounded to the deployments
  that register such a client. Affected: 2.0.0-rc.68 and rc.69.
- **What could happen:** before comparing the `aud` of an authorization request with the client's
  registered audiences, `GET` / `POST /oauth2/authorize` removed its trailing slashes with a regular
  expression whose running time grows with the square of a run of slashes. One request with a form
  body of about 100 kB held an API worker for several seconds; repeated requests could keep a core's
  workers busy.
- **What changed:** the trim is a linear loop, and an `aud` or `resource` value is size-capped
  (512 bytes, or the longest registered audience) before any comparison, at `/oauth2/authorize` and
  at `/oauth2/token`.
- **Operator action:** none beyond the upgrade. Deployments without a client registered with
  audiences were not reachable. A reverse proxy with a request-body limit (section 5) also bounds it.

#### Accesses created by an OAuth2 session kept their reach when the consent was narrowed

- **Severity:** Medium (deployments that serve OAuth2 clients whose sessions create accesses). It
  needs a session of the app, before the user narrows the consent; the gain is continued access to
  data the user withdrew from the app.
- **What could happen:** an access created by an OAuth2 session (a shared access, a child access)
  was deleted with the consent grant since 2.0.0-rc.64, but a narrowing of the grant (a re-consent
  with fewer permissions, the owner's update of the grant, a CMC scope update) reached the sessions
  only. An access the app had created before the narrowing kept its earlier permissions, so the app
  could go on reading or writing what the user had just withdrawn from it.
- **What changed:** such an access is bound to the session's consent grant (`clientData.oauth`,
  written by the server and not removable by `accesses.update`) and, when the grant changes, is
  narrowed to what the grant still reaches, stream by stream, or deleted when nothing is left; the
  webhooks of the narrowed accesses and sessions are rescoped with them. Accesses created before
  this release are matched by their creator (a session of the grant, expired ones included).
- **Operator action:** none.

#### Lower-severity fixes in 2.0.0-rc.70

- **The state keys are required; the admin-key fallback is removed** (completion step of the
  2.0.0-rc.69 hardening): a core refuses to boot when `oauth.consentUrl` is set without
  `oauth.stateKey`, or `sso.enabled` is true without `sso.stateKey` (an empty, placeholder or
  unexpanded value, in production also one shorter than 16 characters); `bin/check-config.js`
  reports the same. A consent state or a sign-in state cookie signed with the admin-derived key is
  refused, so the admin key no longer opens anything a browser flow trusts.
- **What an OAuth2 session may create** (hardening): a new feature permission, `accessCreation`,
  forbids creating accesses, webhooks and CMC capability requests (invitations). The grants of
  clients registered by the operator forbid it by default (with `webhooks` and `secretSharing`),
  unless the client's row allows it, so an app reached through such a grant no longer mints
  credentials or outgoing calls from the user's account by default. The forbid is handed down to
  every access it reaches.
- **Reuse detection kept after a session is deleted during the refresh grace** (hardening): deleting
  the session a refresh had just replaced (the account lists both for a minute) erased the record
  that the replaced refresh token had been used, so its replay was no longer detected as reuse. The
  record now survives that deletion.
- **`private_key_jwt` client authentication** (hardening): an assertion is verified only with a key
  of its algorithm's type, and with the client's pinned algorithms when set; a key set of more than
  one key needs a distinct `kid` on every key, and an assertion against such a set must name its key
  (before, an assertion without `kid` was tried against every key). A key set by reference
  (`jwks_uri`) is fetched as an outgoing call to a counterparty: `https` only, no redirect, a size
  and time limit, and loopback, private and link-local addresses refused before any connection.
  The reason of every refused assertion is in the server log; the answer stays uniform.
- **Client secret rotation** (hardening): `rotate-secret --previous-valid-for` keeps the replaced
  secret valid for a bounded window (at most 30 days); without it the replaced secret is refused at
  once, as before. A second rotation or a change of authentication method ends it.
- **Scope cap** (hardening): `/oauth2/authorize` refuses a `scope` longer than 8192 bytes; every
  scope token travels in the signed state and the consent redirect.
- Not security fixes, listed for operators: `accesses.create` refuses `lastUsed` (it was stored as
  given, so an account holder could keep the account looking in use past its inactivity deletion
  date), and the inactivity schedule ignores a use time more than an hour in the future; the
  id_token `auth_time` is the user's last completed sign-in; a `private_key_jwt` request no longer
  needs `client_id` next to the assertion.
- **Operator action:** before deploying, (1) set `oauth.stateKey` on every core where
  `oauth.consentUrl` is set and `sso.stateKey` on every core where `sso.enabled` is true, if not done
  for 2.0.0-rc.69 (a core whose rc.69 boot log showed no state-key warning has them); (2) allow
  `accessCreation` on every registry client whose sessions create accesses, webhooks or CMC
  capability requests (`node bin/oauth-client.js update <clientId> --allow-feature
  accessCreation`, keeping the features already allowed); (3) give a distinct `kid` to every key of
  an inline client key set holding several keys (every core reports such rows at boot).

### Fixed in 2.0.0-rc.71 (deployed)

2.0.0-rc.71 adds a vetting status for the OAuth2 clients registered by the operator (a change of
where a client's codes and tokens land, how it authenticates or what it reaches waits for the
operator's approval), profile fields, regions, an entry ceiling per client, grouped consent entries
and `http://localhost` as a loopback redirect host. These are new features, described in
`CHANGELOG-v2.md`, not fixes. The review of client suspension and of the client lifecycle made
alongside them found the following in earlier releases.

#### A suspended OAuth2 client kept obtaining tokens with the `client_credentials` grant

- **Severity:** Low (deployments that serve OAuth2 clients with an app account registered for the
  `client_credentials` grant, and only while the operator holds such a client suspended). It needs
  the client's own credential (its secret or signing key); the gain is continued use of the app's
  own account after the operator stopped the app, not access to another account. Affected:
  2.0.0-rc.68 to rc.70 (suspension appeared in rc.68).
- **What could happen:** `bin/oauth-client.js suspend` is the operator's way to stop an app at
  once. The authorization code and refresh grants and introspection refused a suspended client,
  but the `client_credentials` grant did not check the client's status: a suspended client could
  go on minting access tokens on its own app account, as its registration allowed, and use them on
  the data API for as long as it stayed suspended.
- **What changed:** the grant checks the client's status once the client is authenticated and
  refuses a suspended client, or one under review, with `400 unauthorized_client`, minting
  nothing. The data API also refuses the live tokens of such a client (below).
- **Operator action:** none beyond the upgrade. The tokens a client suspended before the upgrade
  minted meanwhile are refused by the data API once the upgrade is deployed; `purge-grants` deletes
  them.

#### Lower-severity fixes in 2.0.0-rc.71

- **A client's suspension reaches the data API** (completion step of the 2.0.0-rc.68 suspension):
  the live access tokens of a suspended client were refused at the token endpoint and by
  introspection, but went on working on the data API until they expired (one access-token lifetime
  at most). The data API now refuses them (`403 invalid-access-token`) within
  `oauth.clientRevokeCheckSeconds` (default 30 s), as for a revoke; the sessions are kept and work
  again after `resume`. A suspended client also gets no redirect from `/oauth2/authorize` (an HTML
  400).
- **Grants left after a revoke** (operator tool): `revoke` refuses a client's live tokens
  everywhere but left the users' consent grants, the accesses they created and the client's
  `client_credentials` tokens in place. `node bin/oauth-client.js purge-grants <clientId> --yes`
  deletes them on a core, with the CMC data-grants the client's sessions are bound to; `revoke`
  and `suspend` print it as the next step.
- **A consent could grow a grant past the platform bound** (hardening): the bound on the
  permission entries of one authorization applied to each request, not to the grant a consent
  leaves, so a consent page that never asked for the composed offer could grow a grant past it by
  repeated consents. `/oauth2/authorize/accept` now refuses a consent whose resulting grant exceeds
  the client's entry ceiling (`400 invalid_scope`, `grant-too-large`), writing nothing, and the
  signed-in offer refuses such a re-consent too.
- **Client logos from listed hosts only** (hardening): the consent offer handed the consent page
  any logo URL stored for a client, `http` included, so the user's browser fetched it from that
  host. A logo is now served only when it is `https` on a host of the new `oauth.logoHosts` list;
  `--logo-uri` is refused otherwise, and a stored non-https logo is removed at the client's next
  `update` or `rotate-secret`.
- **Consent-screen texts** (hardening): the client names and descriptions shown on the consent
  screen refuse control and direction-override characters, which could make a name read as
  another; a registry client's offer is bounded (256 KiB of JSON, labels included, where
  `entryLabels` had no bound).
- **Redirect URIs with a control character** (hardening): the URL parser drops tabs and newlines,
  so a presented redirect URI containing one could match a registered URI and then fail as the
  redirect's `Location`. Such a URI is now refused.
- Not security fixes, listed for operators: the setting `oauth.requireAppAccountMfa` is removed:
  it was never enforced, so a core that set it did not require multi-factor authentication on
  app accounts, and such a core now logs a warning at boot; the platform integrity check reports
  orphan rows on SQLite too.
- **Operator action:** before deploying, set `oauth.logoHosts` on every core (identical everywhere)
  if any registry client has a logo, or no logo is served; after deploying, add `--approve` to the
  `update` commands that change a vetted field of an active registry client (otherwise the client
  moves to `review` and is refused until approved), and run `purge-grants` on each core after a
  `revoke`, or after a `suspend` whose users' grants should go too.

### Fixed in 2.0.0-rc.72 (deployed)

2.0.0-rc.72 makes backup restore aware of multi-core routing, has a restore withdraw the stopped
erasure of the accounts it restores, adds faster SQLite audit export pages and lets the chat and
collector streams of an ended consent relationship be deleted. These are described in
`CHANGELOG-v2.md`. The review of backup restore on multi-core platforms, of the mails sent to an
account's stored address and of the background work of an account being erased, made alongside
them, found the following in earlier releases.

#### A whole-backup restore gave a unique value that had changed hands back to the restored account

- **Severity:** Medium (impact: sign-in to another account for the value's current holder; low
  likelihood: it needs the operator to restore a whole backup older than the change of hands of an
  email or SSO binding, and the holder to be one who signs in by SSO for the first time or is found
  by an email lookup). Affected: 2.0.0-rc.71 and earlier releases with whole-backup restore.
- **What could happen:** a whole-backup restore wrote the backup's platform rows as they were. A
  value that another account had taken since the backup (an email the backed-up account gave up,
  an SSO binding) went back to the restored account: the value's current holder signing in by SSO
  for the first time was linked to, and logged into, the restored account, and lookups by email
  answered the restored account. The same restore also wrote the platform rows of accounts it did
  not restore, and on a multi-core platform could restore an account the platform routes to another
  core.
- **What changed:** a value held by another account stays with it (the restore logs the fields and
  accounts concerned and counts them in its report); only the restored accounts' platform rows are
  written; an account routed to another core is refused (`--user`) or treated as a conflict (whole
  backup) before anything is written.
- **Operator action:** none beyond the upgrade. A restore made with an earlier release may have
  re-pointed such values: the restore report of that run, or `bin/reconcile-user-cores.js --emails
  --dry-run` for emails, shows the accounts concerned.

#### Password-reset mails of a restored account could reach the new holder of its old address

- **Severity:** Medium (impact: a reset link for the account in the hands of another person, which
  is an account takeover; low likelihood: it needs an account restored from a backup older than a
  change of hands of its email, and that address registered since by someone else). Affected:
  2.0.0-rc.71 and earlier releases.
- **What could happen:** a restored account kept the email stored in its backup. When that address
  had changed hands, the platform reserved it for another account, but the password reset (and the
  MFA-change and account auto-deletion notices) still mailed the stored address, so its new holder
  received a reset link for the restored account. A `--user` restore also wrote no email row at
  all, so the restored account's address was not reserved and anyone could register it, which
  then led to the same case.
- **What changed:** no password-reset mail, MFA-change notice or account auto-deletion notice is
  sent to an address another account holds (in cleartext mode three spellings of the address are
  looked up); the caller of a reset gets the same answer as when the mail is sent, and a warning
  names the account. A `--user` restore now writes the account's platform rows, a value another
  account holds staying with it. The restore report lists the restored accounts whose email
  another account holds.
- **Operator action:** on each core where accounts were restored with `--user` by an earlier
  release, run `node bin/reconcile-user-cores.js --emails --dry-run`, then without `--dry-run`: it
  claims the missing email rows (never over another account) and lists the accounts whose email
  another account holds; change those accounts' email.

#### An account erased during a consent operation kept a record holding a peer's capability token

- **Severity:** Low (erasure completeness: the record was invisible through the API and never
  processed; it needs an account erased within the seconds a CMC accept or refuse reads the
  requester's offer). Affected: 2.0.0-rc.71 and earlier releases with the CMC plugin.
- **What could happen:** when the account was erased while that read ran, the plugin then wrote a
  retry record for the erased account holding the trigger's content, the requester's invite URL
  with its token included. On PostgreSQL it stayed as an `events` row of a deleted account; on
  SQLite with `audit.onUserDelete: keep` it re-created an events database in the directory kept
  for the audit. The erasure was therefore not complete, and a peer's capability token outlived it.
- **What changed:** the work that runs after a request (dispatch, retry loop, member sweep, the
  follow-ups of access, delegation and stream changes) writes nothing for an account that no longer
  exists or whose erasure has started; the write is dropped and logged without its content. Known
  residue on SQLite with `audit.onUserDelete: keep`: late reads can re-open empty databases (no
  row) in the kept directory. Closed in 2.0.0-rc.90 (see that release below).
- **Operator action:** records left by earlier erasures are not removed automatically. On
  PostgreSQL,
  `SELECT user_id, id FROM events WHERE type = 'cmc-internal/retry-cmc' AND user_id NOT IN (SELECT user_id FROM users_index) AND user_id NOT IN (SELECT user_id FROM account_erasures);`
  lists them; delete those rows (the requester can also invalidate its invite). Since 2.0.0-rc.90,
  `node bin/reconcile-user-cores.js --cmc-retries` lists them and, with `--apply`, deletes them,
  replacing this query. On SQLite with `audit.onUserDelete: keep`, the files of an erased account's
  directory other than its `audit-*` files are leftovers and may be removed.

#### Lower-severity fixes in 2.0.0-rc.72

- **A change of a registry client's launch types was not vetted** (completion step of the 2.0.0-rc.71
  vetting status): the core does not act on launch types, but an extension may grant on them, so
  `bin/oauth-client.js update --launch-type` on an active client gave it what the extension grants
  without the operator's approval. It is now a vetted change (the client moves to `review` unless
  the command carries `--approve`), and `update` says when it narrows what a client may be granted,
  with the `purge-grants` step that ends the grants given before.
- **A withdrawn `refresh_token` grant type did not stop refreshes** (completion step of the client
  lifecycle): a registry client whose grant types no longer listed `refresh_token` could still
  refresh the chains issued before. Such a refresh is now refused (`unauthorized_client`).
- **Deletion on a multi-core platform removed another core's platform rows**: deleting or erasing
  an account removed the platform rows of its username even when the platform routes that name to
  another core, whose account of the name lost its routing, email and other unique values. A name
  routed elsewhere now keeps them.
- Reported through the public issue tracker, not counted: the chat and collector streams of an
  ended consent relationship could not be deleted, so the former counterparty's messages could not
  be erased by the account (open-pryv.io#166); they can now be deleted once no relationship access
  serves them.
- Not security fixes, listed for operators: a restore withdraws the stopped erasure of the
  accounts it restores (before, the next sweep erased a restored account again); the release notes
  give the query that finds the records left on accounts restored earlier.
- **Operator action:** run `bin/reconcile-user-cores.js --emails` as above; look for leftover CMC
  retry records and leftover erasure records with the queries in `CHANGELOG-v2.md`; add `--approve`
  to `update --launch-type` on vetted clients; run `purge-grants` for a client whose launch type was
  removed in an earlier release.

### Fixed in 2.0.0-rc.73 (deployed)

2.0.0-rc.73 adds OAuth token exchange for resource servers, with sessions bound to the resource
server they were issued for (`oauth.audienceBoundSessions`), and adapter routes; it serves the OAuth
endpoints on a vanity issuer host of a platform with the embedded DNS and completes the backup
restore work of 2.0.0-rc.72. These are described in `CHANGELOG-v2.md`. A follow-up review of email
uniqueness in cleartext PII mode and of backup restore, made alongside them, found the following in
earlier releases.

#### In cleartext PII mode, an email address was unique only as written

- **Severity:** Medium (impact: a password-reset link for an account in another person's inbox,
  which is an account takeover; low likelihood: it needs a platform run with `platform.piiMode:
  cleartext`, the opt-out of the default hashed mode, and an address held by one account and
  written in another case by another). Affected: 2.0.0-rc.72 and earlier releases run in cleartext
  mode.
- **What could happen:** on a platform run with `platform.piiMode: cleartext`, an email address was
  unique only as written: another account could register, add or be sent a verification code or
  link for an address an account held, written in another case, and a password-reset mail for an
  account could reach the inbox of another account holding its address in another case. The check
  added in 2.0.0-rc.72 that sends no reset or notice mail to an address another account holds looked
  up three spellings of the address, not every one.
- **What changed:** an address is compared in any case, and without surrounding white space, on
  every check (registration and its email challenge, the availability check, an email change,
  adding an email and its resend, the `/system` reservations, a restore), and nothing is mailed to
  an address another account holds in any spelling. Hashed mode, the default, already compared the
  normalised address and is unchanged.
- **Operator action:** on a cleartext platform, run `node bin/reconcile-user-cores.js --emails
  --dry-run` on each core: it lists the accounts whose address another account holds in another
  case and names that other holder. Change the email of one account of each pair: until then
  neither gets a password-reset, MFA-change or auto-deletion mail, and the auto-deletion sweep
  treats each as an account without an address, so resolve the pairs before its next pass. Hashed
  platforms need no step.

#### Lower-severity fixes in 2.0.0-rc.73

- **A unique platform value holding `/` was cut at its first `/` when read back** (an email local
  part such as `a/b@example.com`, an identity provider subject such as `https://idp.example/u/1`):
  deleting the account removed the row of the cut value and left the real one, so the address or
  the subject stayed reserved for an account that no longer existed (in cleartext mode, the address
  itself stayed stored), and backups exported the cut value. Both platform engines now read the
  value whole.
- Reported through the public issue tracker, not counted: on a platform with the embedded DNS, the
  OAuth endpoints, the third-party sign-in routes and the account creation and deletion routes
  answered 404 on a vanity issuer host such as `auth-eu.<domain>`, whose first label was read as a
  username, and that label could be registered as a username (open-pryv.io#167). These routes are
  now served on every host the core answers, the issuer's label is refused as a username, and
  `bin/check-config.js` checks the issuer host.
- Not security fixes, listed for operators: a `bin/backup.js --restore --verify-integrity` rollback
  now removes the accounts the restore created (it left them without data, their name and address
  still taken); a single-account backup now carries the account's SSO bindings.
- New in this release, not findings: adapter routes forward `/adapter/<name>/` on every host to a
  sidecar on the same host, and the core authenticates nothing on those paths (section 3.2; off
  unless configured); OAuth token exchange lets a resource server exchange the token a user's
  client sent it, and `oauth.audienceBoundSessions: true` refuses at the data API the sessions
  issued for a resource server (off by default in this release; a later release is planned to turn it
  on by default; done in 2.0.0-rc.82).
- **Operator action:** run `bin/reconcile-user-cores.js --emails --dry-run` on cleartext platforms
  as above. Before configuring an adapter route, read `docs/adapter-routes.md`: the sidecar must
  authenticate every request, and its port must not be reachable from outside the host.

### Fixed in 2.0.0-rc.74 (deployed)

2.0.0-rc.74 adds OAuth2 client metadata documents: a client may name itself, as `client_id`, by
the https URL of a document it publishes, and the core serves it with the reach of a template the
operator sets (off unless configured). It also accepts `RS256` client assertions. These are new
features, described in `CHANGELOG-v2.md`, not fixes. The review of the client revoke made
alongside them found the following in earlier releases.

#### A revoked OAuth2 client's codes and refresh tokens worked again once its id was registered again

- **Severity:** Low (it needs the operator to register again, under the same id, a client they
  revoked; the gain is the revoked client's own grants, not access to another account). Affected:
  2.0.0-rc.73 and earlier releases.
- **What could happen:** `bin/oauth-client.js revoke` refused the client's live sessions and
  removed the client. When the operator later registered a client under the same id, the refresh
  tokens issued to the revoked client, and the authorization codes issued in the minutes before the
  revoke, were accepted again and minted new sessions, and the users' earlier consents were reused
  without asking them.
- **What changed:** a revoke is a point in time: no authorization code, refresh token, session or
  consent issued for that client id before it is honoured again, whatever is registered under the
  id later. The users of a client registered again are asked for a new consent. The revoke time
  carries a five-second margin against clock differences between the host that ran `revoke` and
  the cores.
- **Operator action:** none beyond the upgrade. Keep the host that runs `bin/oauth-client.js` and
  the cores NTP-synced.

#### Lower-severity fixes in 2.0.0-rc.74

- **An access permission on a trashed stream of another data store untrashed a local stream**
  (data stores that support trash only; the stores shipped with the server do not): an access
  created with a permission naming such a stream (`:<store>:<id>`, with `defaultName`) took a local
  stream with the same id out of the trash instead, or failed when there was none. The stream is
  now taken out of the trash in its own store.
- **The OAuth endpoints and the discovery documents answer CORS with their own policy**
  (hardening): any origin, no credentials, a fixed list of methods and headers. They answered the
  API's CORS before, which echoed the caller's origin on a preflight and added
  `Access-Control-Allow-Credentials: true`.
- Not security fixes, listed for operators: on a multi-core platform, the consent of an account
  served by another core answers `421 wrong_core` with that core's URL instead of a sign-in loop
  (the answer says no more than the wrong-core answer of the account routes already says); server-created
  streams carry the tracking properties the stream schema requires; with `platform.piiMode:
  cleartext`, the lookups of the account holding an email find it in any case; a Socket.IO client
  no longer loses its change notifications when it connects while another client of the account
  leaves.
- New in this release, not findings: OAuth2 client metadata documents (section 3.2): with
  `oauth.clientMetadataDocuments` turned on, the core fetches a document from the client's host
  (https only, no redirect followed, private addresses refused, size, time and rate bounds), takes
  the client's name and redirect URIs from it and what the client may be granted from the
  operator's template only; such a client gets no introspection, no token exchange and no allowed
  feature, and the consent screen must show the document's host next to the client's name. With
  `mode: any`, any party can present a client to the consent screen: the host shown, the template,
  the deny-list and the fetch bounds are the controls.
- **Operator action:** before turning on `oauth.clientMetadataDocuments`, read `docs/oauth2.md`
  (client metadata documents), prefer `mode: allowList`, and make sure the consent UI shows the
  client's host.

### Fixed in 2.0.0-rc.75 (deployed)

2.0.0-rc.75 adds per-user resource addresses for OAuth2 (an audience entry
`https://{username}.<host>/...` names each account's own address and is bound at consent to the
signed-in account; token exchange accepts `subject_token_resource`) and names the addressed account
to adapter sidecars on per-user hosts. These are new features, described in `CHANGELOG-v2.md`, not
fixes. The review made alongside them found the following in earlier releases.

#### Lower-severity fixes in 2.0.0-rc.75

- **A name another core of the platform answers itself could be taken as a username** (platforms
  with several cores; hardening): each core refused, at registration and at a username change, its
  own `dns.staticEntries` keys and its own OAuth issuer label, but not those of its siblings unless
  they also existed as runtime DNS records. Such an account was unreachable at its host (the DNS
  answers these names first) and its name could be read as an account where the platform meant its
  own service. Every core now advertises these names to the others, refuses them as usernames and
  never reads them as an account's host. An account created under such a name by an earlier
  release is kept; it has no per-user host.
- Not security fixes, listed for operators: `accesses.checkApp` reads `:local:<id>` as `<id>`, as
  `accesses.create` stores it (an app requesting it was asked for consent again at every sign-in).
- New in this release, not findings: per-user resource addresses and adapter routes on per-user
  hosts (section 3.2). The core binds a per-user audience to the signed-in account at consent and
  refuses one naming another account or a name the platform answers itself; on a per-user host it
  sets `X-Adapter-Name` and `X-Adapter-Base` itself and drops every client-sent copy, in any `-` /
  `_` spelling, a trusted proxy's included, and it recognises only one label under `dns.domain`, so
  no address under a domain the platform does not own reaches a sidecar. The two headers are an
  address, not an identity: the sidecar authenticates the token and checks that its audience is
  `X-Adapter-Base` plus its own path. A core of an earlier release forwards client-sent copies of
  the two headers, and an ingress that routes adapter paths around the core sets neither: through
  such an ingress every request is a platform address.
- **Operator action:** upgrade every core before adding per-user audience entries to OAuth2
  clients (an older core matches them to nothing); upgrade each core before the adapter sidecar
  next to it starts reading `X-Adapter-Name` / `X-Adapter-Base`; where per-user addresses are
  wanted, let the core forward adapter paths (`docs/adapter-routes.md`, "Behind nginx").

### Fixed in 2.0.0-rc.76 (deployed)

2.0.0-rc.76 adds address aliases: addresses of an account other than its username, which its owner
mints and an OAuth2 grant adopts at consent. This is a new feature, described in
`CHANGELOG-v2.md`, not a fix. The review made alongside it found no defect in earlier releases.

#### Lower-severity fixes in 2.0.0-rc.76

- Dependency update, not an audit finding: `html-to-text` 10 under `email-templates` replaces
  `deepmerge` 4.3.1 (GHSA-gcqx-w48m-w2h4, low: prototype poisoning in `mergeObject()`, no patched
  `deepmerge` release). `npm audit --omit=dev` reports no advisory for this release.
- Not security fixes, listed for operators: an adapter sidecar that answers before reading a large
  upload (a `401` ahead of the body, for example) could reach the client as `502 adapter <name>
  unreachable`; its own answer is relayed now. The status code was wrong; nothing else was exposed.
- New in this release, not findings: address aliases (section 3.2). The server chooses the name
  (`a-` + 8 lower-case letters or digits; nothing is taken from the request), at most 10 per
  account, through methods that only the owner's personal token can call. An address alias is an
  address of the account like its username: the platform routes it to the account's core and the
  embedded DNS answers it. An OAuth2 consent at an address alias adopts it for that client's grant
  only: one grant per alias; an alias another grant holds, another account's alias and a former
  username are refused (`403 audience-account-mismatch`). The tokens of an adopted grant are used
  at that address only and their subject is the alias, never the username. Signing in at an
  address alias, or using a token there that does not carry it, is refused. Deleting an alias
  releases the name first, then withdraws the grant that holds it (its sessions and refresh chains
  end); a consent adopting it at that moment is refused. A consent at the username over a grant
  that adopted an alias is a change of subject the user must acknowledge. A new username of the
  alias shape is refused, so no account can take such a name; a former username of that shape (an
  account renamed before this release) is read as an address alias of its account.
- **Operator action:** right after the upgrade, before account owners mint address aliases, run
  `node bin/reconcile-user-cores.js --address-alias-shape` on each core (read only). Zero usernames
  and zero aliases of that shape is the expected result; an alias it lists is a former username,
  now an address alias of its account (listed to the owner, adoptable by an OAuth2 consent).

### Fixed in 2.0.0-rc.77 (deployed)

2.0.0-rc.77 adds an opt-in per-user OAuth2 issuer (`oauth.perUserIssuer`, off by default). This is
a new feature, described in `CHANGELOG-v2.md`, not a fix. The review made alongside it found no
defect in earlier releases.

#### Lower-severity fixes in 2.0.0-rc.77

- A streamed call (`events.get` and other calls answered as a stream) that the client cut short
  was audited, and counted, as a successful call, although its result was never delivered whole;
  a store failing on its first row was counted as a success too. It is now audited as an error
  (`audit-log/pryv-api-error`, error id `client-closed-request`, never sent to a client) and
  counted by how it ended. The audit trail recorded the call; only its outcome was wrong.
- Not security fixes, listed for operators: HF points written through a former username right
  after a username change are gathered under the new one (they were read under neither name until
  the next change); `bin/reconcile-user-cores.js` keeps the routing row of a registration in flight
  (it could free a name for another core for a moment) and no longer needs the API stopped.
- New in this release, not findings: the per-user issuer (section 3.2). Off, nothing changes. On,
  a request at an account's own host is served by the issuer of that host: the authorization, its
  code and refresh token, the id_token and client assertions are bound to it (`invalid_grant` or
  `issuer-mismatch` elsewhere), and only the account the host names (its username, or a consent
  adopting the address alias of that host) consents there (`403 audience-account-mismatch`,
  audited `issuer-account-mismatch`). Introspection, revocation and the token exchange keep the
  configured issuer.
- **Operator action:** none beyond the upgrade. Before turning `oauth.perUserIssuer` on, make the
  consent UI accept `pryvApi` on every account host and turn it on on every core: turning it off
  later, or leaving one core off, ends the refresh chains issued at a per-user issuer.

### Fixed in 2.0.0-rc.78 (deployed)

#### Lower-severity fixes in 2.0.0-rc.78

- The public email lookups (`GET /reg/{email}/check_email`, `/reg/{email}/username`,
  `/reg/{email}/uid`, `/reg/cores?email=`, and the registration email gate's challenge for an
  address that has an account) answered at request rate, so a client could test many addresses,
  and the username routes map an address to a username. They now share one budget per client
  address (an IPv4 address, or the /64 of an IPv6 one): 30 requests a minute through them
  together, then `429` with `Retry-After`. The budget is counted per core and fails open when its
  store cannot answer. `auth.emailCheck` and `auth.cores` are refused inside a batch call and over
  socket.io, as the credential methods already were, so the budget cannot be bypassed there.
  Residual: registration still answers that an address is taken.
- Two accepts written at the same moment by two different people on one single-use consent link
  could both pass the link's check and both open a relationship, since the link only turned
  consumed once the first accept was handled. The first accept now takes the link as it is
  written (a claim held a short while in the core's shared store); another accepter is refused as
  consumed. An open-link invite is unchanged.
- **Operator action:** none beyond the upgrade; a client that tests many addresses in a burst (a
  bulk import, a sign-up form that checks on each keystroke) must throttle or handle the `429`.

### Fixed in 2.0.0-rc.79 (deployed)

2.0.0-rc.79 changes a limit rather than fixing one: the group-account member access budgets (a
membership reading many patients). The review made alongside it found no defect in earlier
releases.

#### Lower-severity fixes in 2.0.0-rc.79

- A member access request whose event could not be stored after the write-time check (an event id
  already taken, a storage error) kept its patient's in-flight lock for a minute and the request's
  share of the budget: during that minute the membership could not open that patient. Both are now
  released on the failure.
- Not security fixes, listed for operators: asking again for a patient once the previous member
  access had expired failed (`409 item-already-exists` from the patient's core); the expired access
  of that name is now deleted through the grant and a new one minted. A live access holding the
  name is never deleted. `Access-Control-Expose-Headers` now lists `Retry-After`, so a browser
  client can read the wait of a `429`.
- Changed in this release, not a finding: each membership has two budgets counted for the whole
  core (new member accesses: 5000 at once, then `ratePerMinute`, now 1000 a minute; requests of any
  kind: 10000 at once, then 3000 a minute); asking again for a live access spends no new-access
  budget, and a spent budget answers `429` with `Retry-After`. Before, every request counted, 30 a
  minute per membership and per worker process. The budgets pace a membership; they do not bound
  what it may read: a membership that may read a patient may read all of its patients, and what
  ends the exposure of a misused membership is its expiry and its revocation (the patient's audit
  log names the member on every read). One `info` log line marks a membership past half its
  new-access burst, for operators who alert on bulk reads.
- **Operator action:** where `cmc.memberAccess.ratePerMinute` was tuned to be strict, set
  `cmc.memberAccess.mintBurst` too (the former "at most N from idle" is `mintBurst: N`).

### Fixed in 2.0.0-rc.82 (deployed)

2.0.0-rc.82 changes a default rather than fixing a defect.

- Changed in this release, not a finding: `oauth.audienceBoundSessions` defaults to `true`. The
  direct use at the data API of a token issued for a resource server, described with 2.0.0-rc.73
  as off by default, is now refused by default: such a token works only through the resource
  server's token exchange. Sessions minted before the upgrade keep working until they expire or
  refresh. The residual is a core where the operator sets `false` explicitly; the boot log names
  the clients concerned on such a core, and on a core where a client may obtain such tokens while
  no resource server is registered for token exchange.
- **Operator action:** on a core where a resource server does not exchange yet, set
  `oauth.audienceBoundSessions: false` explicitly before upgrading; otherwise none beyond the
  upgrade.

### Fixed in 2.0.0-rc.85 (deployed)

2.0.0-rc.85 is a security release for platforms on the SQLite storage engine. It ships the move of
that engine's queries to bound values, planned in section 5 since the first revision. The review of
how the engine builds its queries and matches stream ids, made alongside that work, found the
following in earlier releases. PostgreSQL platforms are not affected by them; they get only the
stream-id rule of the third item.

#### On SQLite, a stream named `..` gave an access the events of the account's other streams

- **Severity:** High (SQLite storage engine only; an app or shared access allowed to create a
  stream, that is holding `manage` on one of the account's streams). Affected: 2.0.0-rc.84 and
  earlier releases on the SQLite engine.
- **What could happen:** the SQLite engine tags every stored event with the id `..` and found the
  events of a stream by full-text matching, so a stream query naming `..` matched every event of
  the account. `..` was not a reserved stream id: an access allowed to create a stream could create
  one named `..` under a stream it manages, which its event reads then covered, and these reads
  returned the events of the account's other streams too, beyond the access's permissions. Once
  such a stream existed, every access allowed to read its parent stream got the same events, a
  read-only one included. The exclusions applied to every read (internal plugin streams, shared
  secrets, e-mails, the streams the access is refused) still held, and account fields were not
  reachable this way. With the PostgreSQL engine `..` was an ordinary id and returned nothing
  extra.
- **What changed:** `..` is a reserved stream id (`streams.create` answers `invalid-item-id`, on
  every storage engine), and the SQLite engine compares stream ids whole: `..` and the empty id
  match no event.
- **Operator action:** none beyond the upgrade. A read-only check for past use is recommended on
  SQLite cores: a stream whose id is `..` (writing an event into an existing one is refused after
  the upgrade); any hit is handled case by case. The maintainers ran this check on the platforms
  they operate before the deploy and found none.

#### On SQLite, stream ids were matched without regard to letter case

- **Severity:** Medium (SQLite storage engine only; an account holding two streams whose ids
  differ only by case, and an access allowed on one of them and not the other). Affected: every
  release on the SQLite engine before 2.0.0-rc.85.
- **What could happen:** stream ids are case-sensitive in the API (`diary` and `Diary` are two
  streams), but with the SQLite engine `events.get` and the stream scope of an access matched them
  in any case: an access allowed on `diary` also read the events of `Diary`.
- **What changed:** stream ids are compared whole and case-sensitively, as the PostgreSQL engine
  always did, the audit store included. With the SQLite engine, the children of `:_audit:actions`
  are now listed with the method's own spelling (`:_audit:action-callBatch`, previously
  `:_audit:action-callbatch`), and an audit query needs that spelling.
- **Operator action:** none for the fix. An access permission stored on a lower-cased
  `:_audit:action-` id (copied from an earlier listing) grants nothing after the upgrade: before
  upgrading a SQLite core, look for permissions whose `streamId` starts with `:_audit:action-` and
  is not an exact method id, and give them the method's spelling. The maintainers ran this check
  on the platforms they operate before the deploy and found none.

#### On SQLite, a stream id holding a space filed its events into other streams

- **Severity:** Medium (SQLite storage engine only; a caller able to create a stream under the
  consent plugin's app area, `:_cmc:apps`). Affected: 2.0.0-rc.84 and earlier releases on the
  SQLite engine.
- **What could happen:** the SQLite engine stores the stream ids of an event as one text separated
  by spaces. `streams.create` kept a path-style id (`:_cmc:apps:...`) as given, a space included, so
  the events written into a stream `:_cmc:apps:x a` were stored, and read back, as filed in both
  `:_cmc:apps:x` and `a`: they appeared in stream `a`, readable by the accesses scoped to it and
  returned by its queries. This was a write into a stream the caller held no permission on.
- **What changed:** `streams.create` answers `invalid-item-id` for an id holding whitespace or a
  control character, and for the id `..`, on every storage engine; a CMC membership offer naming
  such a stream id is refused (`cmc-membership-permissions-invalid`), since accepting it creates
  the stream. With the SQLite engine, writing or restoring an event whose stream id is empty, `..`,
  or holds a space or NUL is refused with an error naming the event. **Breaking** only for a client
  that created such ids; existing streams are unchanged. A backup taken from a PostgreSQL platform
  (or a v1 export) that holds such an id does not restore onto SQLite until the stream is renamed.
- **Operator action:** none for the fix. Before upgrading a SQLite core, look for stream ids
  holding whitespace: writing an event into such a stream is refused after the upgrade, and its
  events stored earlier stay filed under each part of the id. The maintainers ran this check on the
  platforms they operate before the deploy and found none.

#### Lower-severity fixes in 2.0.0-rc.85

- **SQLite query values are bound** (planned at revision 1, section 5): the SQLite events and
  audit queries carried their values as quoted and escaped SQL text; every value is now a bound
  parameter (condition values, JSON paths, `LIKE` patterns, the full-text argument, paging), and
  column names are checked against the events schema. No injection path through the escaped form
  was found (section 4.1); binding removes the dependence on escaping.
- **The SQLite stream filter matched part of a longer id** (Low): full-text matching found a stream
  id inside a longer one, so `abc` matched an event of a stream `abc/def`. Full text is now only a
  prefilter, and the stored ids are compared whole; an id holding no letter, digit or `-_:.` (such
  as `/`) now finds its events (it found none).
- Not security fixes, listed for operators: with the SQLite engine, `%` and `_` in a `types` class
  (`note_x/*`) are literal characters, no longer wildcards, and `/*` alone is an exact type, not a
  class; the SQLite audit store rebuilds its list of access and action children once per file at
  its first open (no migration, no configuration change). A client that stored an audit child id
  from an earlier listing must list again.
- **Operator action:** none beyond the upgrade; the checks of the items above concern SQLite cores
  only.

### Fixed in 2.0.0-rc.86 (deployed)

2.0.0-rc.86 carries no new counted finding. It ships the backup step planned in section 5 since the
first revision (the second step of the 2.0.0-rc.51 backup finding) and completes the 2.0.0-rc.43
cache item; each was reviewed independently before merge, and the reviews made alongside found the
lower-severity items listed last.

#### Encrypted backups: authenticated files and signed runs

- **Completes** the 2.0.0-rc.51 finding "Incremental backups overwrote the full backup they
  continued" (High; not counted again).
- **What changed:** each backup run's manifest now lists every file with its size and hash, and the
  manifest is bound to its run; an encrypted file ends with a marked final block and each block is
  tied to its file, position and run. A restore refuses a run whose files were added, removed,
  changed, swapped between accounts or cut at a block boundary, and a `chain.json` entry that
  disagrees with the run's manifest. With a recipient public key the host holds no decrypt secret,
  so authenticity against a writer who holds that public key comes from an optional Ed25519
  signature of each run (`--signing-key` at backup, `--signing-pubkey` at restore; the backup warns
  when it is not signed). Runs written by earlier releases are restored as before and reported as
  unverified; a run of an earlier release appended after a run of this one is refused. The server
  now reads at-rest envelopes (TLS and ACME keys, authenticator secrets, observability credentials,
  transfer identities) that carry authenticated data naming their purpose and row, with the tag
  length pinned; it writes them since 2.0.0-rc.90, once every core can read them. The bootstrap
  bundle is authenticated with its version, salt and nonce from this release on.
- **Operator action:** none for existing backups, which restore as before. Keep the backup
  directory for the backup only: a file the backup did not write is refused at restore (files that
  operating systems and storage appliances create by themselves are ignored with a notice), and a
  backup refuses to start in a directory that holds other files. With a recipient public key, sign
  the backups: generate an Ed25519 pair once, pass `--signing-key` at backup and `--signing-pubkey`
  at restore and `--inspect`; a chain is signed from its full backup on, so start signing with a new
  full backup into a new directory. A backup written by this release is restored with this release
  or later; after going back to an earlier release, start a new chain in a new directory. On a
  multi-core platform, a new core must run this release or later to read a bootstrap bundle, and
  every core must run this release or later before 2.0.0-rc.90, which writes the new at-rest
  envelope, is deployed on any of them.

#### Cache invalidation between the processes of a core

- **Completes** the 2.0.0-rc.43 finding "Cached accesses could outlive their deletion or narrowing"
  (Medium; not counted again). Since that release every cached value has a maximum age
  (`caching.accessMaxAgeSeconds`, 60 s by default); the review of what still rested on that maximum
  age alone found the cases below, each bounded by it.
- **What could happen:** a process could keep, until its maximum age, an access, a stream tree or a
  username mapping whose invalidation it missed, so a deleted or narrowed access could keep working
  on that process for up to that age: when the value was read while the process was subscribing to
  its account's invalidations, before the broker had registered the subscription; when the broker
  was stalled without closing its connections; when the invalidation was published by a process
  that was disconnected from the broker at that moment (it was dropped); when a process stopped
  following an account that it still served from its cache; and, for usernames, when a lookup
  straddled a rename or a deletion.
- **What changed:** the broker acknowledges each subscription, and a value read from storage is
  cached only if its account's subscription was acknowledged before the read started; each process
  pings the broker every second and suspends its caches (every request reads storage) when about
  5 s pass without an answer, until the broker answers again; an invalidation published while its
  process is disconnected is sent once the connection is back; an account no longer followed has its
  cached accesses and streams dropped; the username map takes the same guard, and account deletion
  clears the account's cache entries again once every removal has completed. Debug logs of the
  message bus no longer print message payloads (an invalidation carries the token of an access that
  is still valid).
- **Residual:** a process holds at most 10000 invalidations while disconnected; beyond that the
  oldest are dropped, with a warning, and the values they concerned are bounded by the maximum age
  again.
- **Operator action:** none. The first request for an account in each process now reads storage;
  the next ones use the cache.

#### Lower-severity fixes in 2.0.0-rc.86

- **A custom data store named after a built-in store came within reach of `*` permissions** (Low; a
  configuration error only; custom data stores are outside the scope of this review, section 2.3). A
  `custom.dataStores` entry whose id was that of a built-in store (`local`, `account`, `_audit`) did
  not replace the built-in store, but its id was added to the stores that a `*` permission covers,
  so with an entry named `account` or `_audit` an access holding `*` reached the built-in account
  or audit store. Such an entry is now not loaded, and a boot warning names it, unless it sets
  `override: true`; it then replaces the built-in store and, like the built-in, is not covered by
  `*`.
- **A full backup re-created the directory of an account erased while it ran** (Low; closes the
  backup residual noted under 2.0.0-rc.53): `bin/backup.js` runs in a process of its own, which does
  not hear of an erasure, so an account erased during a full backup was backed up empty and its
  directory and empty databases were created again on disk (no account data). Such an account is
  now left out of the run.
- **A large SQLite account could hold an API worker** (Low; availability, SQLite storage engine): a
  page of events over a stream filter that most rows of a large account meet (for example the audit
  trail of every access, `streams: [':_audit:accesses']`, over a million rows) read every matching
  row before applying the page size, about 10 s during which the worker answered no other call. Such
  a page is now read in time order and stops at its end (about 0.1 s), with the same results.
- **Backups:** two runs finishing together into the same directory no longer race on `chain.json`
  (the second is refused and left aside, as an overlapping run already was); new passphrase-encrypted
  backups use a stronger key derivation (scrypt N = 2^17).
- Not security fixes, listed for operators: on SQLite, a call that reached an account's database
  while the server was closing it could fail with `unexpected-error` (HTTP 500), and an event written
  into a stream whose id holds a space (created before 2.0.0-rc.85) answered HTTP 500 instead of
  `invalid-parameters-format`; a restore that failed while writing an account left it half-restored
  (what was written is now cleared and the account removed from the core's index); `--inspect`
  answers FAILED instead of UNKNOWN for a damaged manifest of a backup written before chains;
  `POST /reg/records` and `DELETE /reg/records/{subdomain}` answer a storage failure with
  `unexpected-error`.
- New in this release, not a finding: `audit.getSummary` (activity counts of the account's audit
  trail), for personal accesses only, with a bounded range, one summary at a time per account and a
  few at once per server (`too-many-requests` otherwise).
- **Operator action:** check the boot log for a warning naming a `custom.dataStores` entry; set
  `override: true` on it if it is meant to replace the built-in store, otherwise rename it.

### Fixed in 2.0.0-rc.87 (deployed)

2.0.0-rc.87 carries no new counted finding. It ships two items of the limits work planned in
section 5 since the first revision, and cuts the session of a composed OAuth2 re-consent to the
request; each was reviewed independently before merge.

#### Time limits on the PostgreSQL work of API requests

- **Planned in section 5** since the first revision ("database statements have no default
  timeout"); not a counted finding.
- **What could happen:** a statement issued while serving an API request ran for as long as it
  took, holding its database connection even after the client had gone away, so a few expensive
  reads made with a valid credential could occupy a worker's connections (availability).
- **What changed:** with the PostgreSQL engine, such a statement is stopped after
  `storages.engines.postgresql.statementTimeoutMs` (30000 ms by default) and a transaction left idle
  is closed after `idleInTransactionTimeoutMs` (60000 ms by default); the request answers
  `503 api-unavailable` and one warning line names the request and the statement (truncated, never
  its parameters). A streamed response is limited per batch of rows, so a long download is not
  stopped by the time its client takes to read it. Schema migrations, the command-line tools,
  account deletion, the background jobs and `system.checkPlatformIntegrity` are not limited; the
  limits apply to the API, HFS and previews workers of the clustered server.
- **Residual:** the limit bounds how long one request occupies a connection, not how many slow
  requests one account sends in a row (a per-account cap on requests in flight, planned in section 5
  at this release, ships in 2.0.0-rc.90). The single-process entry points and the SQLite engine have
  no statement time limit.
- **Operator action:** behind a connection pooler (for example PgBouncer), check before upgrading
  that it passes both connection parameters, or set both keys to `0` and set the limits on the
  database role instead. Leave room for 2 more connections per pool of each worker in
  `max_connections`. `0` switches either limit off.

#### Password checks: a bounded number at a time per API worker

- **Planned in section 5** since the first revision (resource quotas); not a counted finding.
- **What could happen:** password hashing and verification, and OAuth client-secret verification,
  ran on the worker's small thread pool with no bound on how many ran at once. The attempt limits of
  earlier releases count wrong guesses per account and per address; they did not bound the work of
  the checks themselves, so a flood of password checks on unauthenticated routes (sign-in, MFA
  recovery, the OAuth token endpoint) could occupy the whole pool and the CPU, stalling attachments,
  DNS lookups for webhooks and compression for every account served by that worker.
- **What changed:** at most `auth.passwordCheckConcurrency` checks (2 by default) run at once per
  API worker, with up to `auth.passwordCheckQueue` (50) waiting at most 10 s for a turn. Beyond that
  the call is refused without checking anything: `429 too-many-requests` on the API,
  `503 temporarily_unavailable` on the OAuth endpoints, each with `Retry-After: 5`. A refused check
  is not a failed attempt: it neither counts on the account's tally nor answers
  `invalid-credentials` or `invalid_client`. Registration hashes the password before its storage
  transaction opens, so a wait never holds a database connection.
- **Residual:** a flood of password checks from many addresses can still make other accounts'
  checks wait or be refused on that worker; it no longer stalls the worker's other work. Rate
  limiting at a reverse proxy (section 5) remains the answer to such a flood.
- **Operator action:** none beyond the upgrade. Clients of `auth.login`, `account.changePassword`,
  the password reset, `mfa.recover`, the MFA step-up, `auth.register` and the OAuth token,
  introspection and revocation endpoints must handle the new answers; an authorization code refused
  this way is spent, and the client starts a new authorization. Keep `passwordCheckConcurrency` below
  the thread pool size (`UV_THREADPOOL_SIZE`); the boot and `bin/check-config.js` warn otherwise.

#### Lower-severity fixes in 2.0.0-rc.87

- Reported through the public issue tracker, not counted: on a re-authorization of a registered
  OAuth2 client through the composed consent screen, the session (and its refresh chain, and the
  token `scope`) held every stream ticked on the screen, not only those the app requested, so an app
  asking for one stream over a grant of many received a session reaching all of them
  (open-pryv.io#170). The reach stayed within what the user had granted that client. The session
  now holds the requested streams only (through the stream tree, each at the lower of the ticked and
  the requested level); the grant itself is unchanged. A composed consent that keeps none of the
  requested streams is refused (`400 invalid_scope`, `request-no-reach`) before anything is written.
  Sessions minted earlier keep their reach until they end.
- Not a security fix, listed for operators: a zone served by the cores' embedded DNS servers must be
  delegated to at least two of them; with one nameserver, every restart of its core leaves the whole
  zone unresolvable until the core answers again (`INSTALL.md`, `SINGLE-TO-MULTIPLE.md`).
- **Operator action:** none beyond the upgrade. A consent page that shows the composed offer can
  list the streams already held outside the request apart (they carry no `requested` flag); a scope
  grammar extension's `echo` must name tokens of the session's permissions only.

### Fixed in 2.0.0-rc.90 (deployed)

2.0.0-rc.90 carries one counted finding, found by the independent review of the fix of a consent
issue reported through the public issue tracker (open-pryv.io#171, listed with the lower-severity
fixes). It also ships most of the limits and token work planned in section 5 since the first
revision, the write step of the at-rest envelope read since 2.0.0-rc.86, completion steps of
earlier findings and lower-severity fixes; two of these are rated Medium but are not counted, as
they were found outside the review. 2.0.0-rc.88 (a Node.js runtime update) and 2.0.0-rc.89 (the
erasure ledger) appear in the release table only.

#### A consent accept could take over another counterparty's relationship

- **Severity:** High (where the consent plugin is used; the caller needs a consent link of the same
  scope as an existing relationship). Affected: 2.0.0-rc.89 and earlier releases.
- **What could happen:** when an accept reached the requester's account for a counterparty and a
  scope that already had a relationship, the requester's core updated that relationship with the
  endpoint the accept carried, without checking that the accept came from the account the
  relationship was made with. A party holding a link of that scope could so point another
  counterparty's relationship at an endpoint of its choosing: the credential the requester hands
  its counterparty through the relationship went to that endpoint, and the requester's later reads
  through the relationship read from it instead of from the counterparty.
- **What changed:** an accept that resolves to an existing relationship (same counterparty, same
  scope) updates it only when its granted endpoint is the one recorded on the relationship (scheme,
  host and path; the token may differ); a relationship recorded without an endpoint is updated only
  through the capability it was made with. Otherwise the accept fails with
  `cmc-incoming-accept-counterparty-endpoint-mismatch`, is not retried, and the relationship is
  left as it was. The counterparty username of an accept is compared in lowercase.
- **Operator action:** none beyond the upgrade. Behaviour change for integrations: a counterparty
  whose account moved to another host or path can no longer re-accept onto the existing
  relationship; the relationship is revoked and made again.

#### A second accept on the same scope left the first consent working

- **Severity:** Medium (consent plugin; not counted: found outside the review). Affected:
  2.0.0-rc.89 and earlier releases.
- **What could happen:** when a person accepted a second invite from the same requester on the
  same scope stream, both grants stayed live. Withdrawing one consent left the other working, with
  the accesses made through it, and in group accounts a member access made through the earlier
  grant could outlive the membership or the consent it came from, while the offboarding record
  could report it gone.
- **What changed:** one relationship per counterparty and scope stream: the latest accept replaces
  the first. On the person's core the earlier grant is deleted, with the accesses made through it,
  once the requester's core has taken the new one (its accept records `withdrawal.by: 'replaced'`);
  on the requester's core the earlier invite reads `revoked` with `replacedBy`, and the member
  accesses made through the earlier grant are deleted. A retry never restores the older consent
  (`cmc-incoming-accept-superseded`, `cmc-accept-withdrawn`), and a retried accept delivery that
  the requester's core refuses for good no longer deletes a grant it already paired. A membership
  joined twice on the same team is handled the same way. The offboarding record
  (`consent/member-revoke-cmc`) reports a member access `residual`, with a reason, whenever the
  patient's core did not confirm it gone, instead of `absent`.
- **Residual:** a member access recorded before this release whose relationship the patient ended
  is reported `residual` until its expiry, which bounds it.
- **Operator action:** none beyond the upgrade. Integrations that read consent records handle
  `withdrawal.by: 'replaced'`, the invite's `replacedBy` and the two new refusal reasons; changing
  the terms of a relationship is one new invite on the same scope.

#### Multi-core: platform writes could be lost, and reads taken for absent, during a leader change

- **Severity:** Medium (multi-core platforms; not counted: found during the rqlite update below).
- **What could happen:** while the platform database's leader restarted, a follower could answer a
  forwarded write with a success status, an error and no result; the server took it for a success,
  so the write (a unique name, a routing row, a token, a revocation) was lost without any sign. A
  read that got no answer during a leader change was taken for "no row": a revoked OAuth client
  could read as not revoked, a held certificate as missing, a core as unknown, a valid invitation
  or code as invalid, a reserved name as taken.
- **What changed:** a write the cluster did not carry out fails (`503 api-unavailable`,
  `Retry-After: 2`) and is not sent again. A read without an answer, or a core that cannot reach
  its local `rqlited`, is retried every 100 ms for up to `storages.engines.rqlite.readWaitMs`
  (3000 ms by default), then fails the same way instead of acting on an absence: API methods, the
  routing of `/{username}/*` requests, the `/reg/*` routes and the adapter ingress alike; the OAuth
  endpoints answer `503 temporarily_unavailable`, and the embedded DNS answers SERVFAIL, never
  NXDOMAIN, and keeps the records it holds. A process that starts while the cluster elects its
  leader waits for it, up to 15 seconds, and does not start without one.
- **Residual:** after one read waited the full time in vain, the next reads of that process fail at
  once until one is answered again; requests already waiting when an outage starts each wait their
  full time.
- **Operator action:** none beyond the upgrade; clients retry a `503` after its `Retry-After`.

#### Bundled rqlite 10.7.5

- Dependency update, not an audit finding: the bundled rqlite is 10.7.5 (was 10.6.0; SQLite
  3.54.1, built with the patched Go toolchain and `x/net` 0.63.0). Its security fixes: a malformed
  inter-node request from a host that reaches the Raft port without the cluster's certificate could
  stop `rqlited` when Raft TLS is off (GHSA-f4f3-px5g-gm4x); a query could open another database
  file (GHSA-j62w-8865-2h7x). A core whose Raft port uses mutual TLS and whose HTTP API listens on
  loopback, the defaults of a multi-core platform, exposed neither to the network. The other rqlite
  advisories of these releases concern its authentication file, which a core does not use. A write
  a follower forwards to the leader is sent once (10.6.0 sent it again after a failure, so a write
  whose answer was lost could be applied twice). The `x/net` advisories accepted in the image scan
  until this release (section 5) are fixed; the scan reports none on `rqlited`.
- **Operator action:** no data-directory step; upgrade the followers first and the leader last (a
  node can go back to 10.5.1 or 10.6.0 on the same data directory). Native installs replace
  `bin-ext/rqlited` while the core is stopped (`INSTALL.md`, "Upgrading the bundled rqlite"): the
  setup script never replaces an existing binary. An external rqlited
  (`storages.engines.rqlite.external`) must support the `linearizable` read level.

#### Per-account, per-access and per-connection limits

- **Planned in section 5** since the first revision (resource quotas); not a counted finding.
- **What could happen:** with a valid credential, one token or one account could take a worker's
  whole capacity: any number of calls running at once, of socket.io connections, of calls in flight
  on one connection and of subscription scopes; parameters nested deep enough to reach recursive
  code and fail there; a stream tree of any depth or size; any number of stream ids per event, of
  webhooks and of webhook scopes (each webhook is an outbound call per change); a client that
  stopped reading a response held its database cursor for as long as it kept the connection open;
  and the mails a caller can trigger had per-address budgets only.
- **What changed:** each ceiling below applies per API worker process, is configurable, is on by
  default (`0` turns it off) and sits far above normal use:
  - calls in progress: 64 per account and 32 per access (`limits.requests.maxInflightPerUser`,
    `maxInflightPerAccess`), then `429 too-many-requests` with `Retry-After: 1`;
  - parameters: a nesting depth of 64 and 10000 keys per object (`limits.json.*`), then `400`;
  - socket.io: 20 connections per access and 100 per account, 16 calls in progress per connection,
    100 scoped subscriptions per connection (`socketIO.*`);
  - streams: 32 levels deep and 10000 per account in its own store (`limits.streams.*`), 100
    stream ids per event (`limits.events.maxStreamIds`);
  - webhooks: 10 per access, 100 per account and 20 scopes per webhook (`webhooks.maxPerAccess`,
    `maxPerUser`, `maxScopes`);
  - a connection with no traffic either way for 120 s is closed (`http.responseIdleTimeoutMs`),
    and one access runs one streamed audit read at a time, a second one waiting at most 30 s
    (`limits.audit.*`);
  - mail: 10 registration codes per client address an hour, verification mails to 10 distinct
    addresses per account a day, and a breaker of 500 caller-triggered mails an hour per core,
    counted apart for registration and account mails (`account.emailVerification.*`,
    `services.email.maxPerHour`); an account may ask `account.update` about 30 addresses an hour
    (whether another account holds them), then `429`.
- **Residual:** the ceilings are counted per API worker, so a core with several workers allows a
  multiple of them; the stream caps are soft (creates running at once can pass them by a few
  streams). What an account stores has no quota yet (section 5).
- **Operator action:** where clients fire many calls at once, hold many sockets on one token, or
  run accounts beyond the defaults (more than 10000 streams or 32 levels, more than 100 stream ids
  on an event, a call silent for more than 120 s), raise the matching key; keep
  `http.responseIdleTimeoutMs` above the slowest call. Behind a shared address (a clinic or campus
  NAT), or with `http.trustedProxies` not set behind a proxy, raise
  `account.emailVerification.registrationCodesPerIpPerHour`. Webhooks already stored keep working.

#### Multi-core: cached routing lookups and a DNS response rate limit

- **Planned in section 5** since the first revision (resource quotas); not a counted finding.
- **What could happen:** which core hosts a username was read from the platform database, at its
  most expensive consistency level, for every `/{username}/*` request and every embedded-DNS query,
  so a stream of requests, or of forged UDP queries for random names, needing no credential became
  a stream of cluster-wide reads (availability).
- **What changed:** each process caches the routing answer (a found account for 30 s, an unknown
  name for 5 s, `cluster.userCoreCache.*`; uniqueness checks never use the cache), read at
  `linearizable` rather than `strong`; the embedded DNS answers core information from the core list
  it refreshes every 30 s. UDP answers that need a platform lookup are limited to 20 a second per
  client network (`dns.responseRateLimit.perSecond`; past it they are dropped, every second one sent
  truncated so that a real resolver retries over TCP), UDP lookups of unknown names to 100 a second
  for the whole server (`missesPerSecond`), and an HTTP client whose lookups found no account more
  than 60 times in a minute gets `429` for names not already cached
  (`limits.routing.unknownNamesPerClientPerMinute`).
- **Residual:** an account moved to another core can still be routed to its former core for up to
  30 s, and a name just registered can be unknown for up to 5 s; during a flood of unknown names,
  an account the DNS has not resolved in the last 30 s gets the truncated answer and is resolved
  over TCP.
- **Operator action:** where the embedded DNS serves UDP, watch the warnings naming
  `dns.responseRateLimit` after the upgrade and raise `perSecond` if a resolver network reaches it.

#### Tokens, codes and store keys

- **Planned in section 5** since the first revision (token hardening); not a counted finding.
- **What changed:**
  - a token chosen for a new access (`accesses.create`, and an app's `token` in `POST /reg/access`)
    must be at least 16 characters after slugification; existing accesses keep their tokens;
  - the access, personal (session) and password-reset tokens the server generates are drawn from
    `node:crypto` directly, instead of an id library that would fall back to a non-cryptographic
    source where the platform lacks one (same shape as before);
  - the registration code mailed by `POST /reg/email-challenge` has 10 symbols (about 50 bits)
    instead of 8; the attempt budgets are unchanged;
  - every store key built from a client address or an email (the password, reset, access-request
    and email budgets, the registration challenges, the verification-mail slots) is an HMAC-SHA256
    under a key derived from `auth.adminAccessKey`, instead of a plain SHA-256 that a listing of the
    store reverses by enumerating addresses or running a mailing list through it;
  - node certificates issued when a core joins a multi-core platform state their purpose (an end
    entity, TLS server and client authentication), a newly created cluster CA may sign end-entity
    certificates only, and the names and address given for a node certificate are checked.
- **Residual:** tokens are still stored and looked up as they are (hashed token storage stays
  planned, section 5); existing CAs and node certificates are unchanged.
- **Operator action:** deploy an auth page that accepts 10-symbol codes before, or with, this
  release (app-web-user-account from its release that takes them, or a custom registration page).
  What is in flight at the upgrade is not found under the new store keys: the budgets start again,
  a pending registration code must be requested again, and during a rolling upgrade of a multi-core
  platform cores on different versions count an address separately. Integrations that choose short
  tokens omit `token` or choose a longer one.

#### Signed webhook calls

- **Planned in section 5** since the first revision (token hardening); not a counted finding.
- **What changed:** a receiver can check that a webhook call comes from the platform without a
  secret in the webhook URL. `webhooks.create` returns a `secret` once; each call of a webhook with
  a secret carries `Pryv-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 under the secret of
  `t`, a `.` and the exact bytes of the body, computed afresh for every call, retries included;
  `webhooks.rotateSecret` replaces the secret, under the access rules of `webhooks.update` (refused
  to a delegate that may not read the webhook URL in full). The messages that tell the server's
  processes about a webhook now carry its id only, no secret and no URL.
- **Residual:** webhooks created before this release send unsigned calls (`signed: false`) until
  their secret is rotated; the secret is stored with the webhook (the server reads it on every call)
  and travels in server backups.
- **Operator action:** with `migrations:autoRunOnStart: false`, run the migrations before serving
  (on PostgreSQL, webhook creation and deletion fail until the new column exists). Receivers verify
  the signature on the raw body with a constant-time comparison and refuse a `t` more than 300 s
  away from their clock.

#### Keys stored encrypted at rest: the authenticated envelope is written

- **Planned in section 5** (token hardening); completes the read step of 2.0.0-rc.86; not a counted
  finding.
- **What changed:** keys stored encrypted at rest (among them TLS and ACME account keys,
  authenticator secrets and observability credentials) are written in the envelope that
  2.0.0-rc.86 started reading: bound to the row that holds it, with the tag length pinned, and the
  TLS and ACME keys under a key derived for that purpose from `letsEncrypt.atRestKey` (the
  configured value is unchanged).
- **Residual:** rows written by earlier releases (envelope version 1) stay readable and are
  rewritten in the new envelope only when they are written again (the ACME account key at the next
  account check): version 1 is still read (section 5).
- **Operator action:** every core of a platform must run 2.0.0-rc.86 or later before this release
  is deployed on any of them. Going back to a release before 2.0.0-rc.86 once this one has run is
  not possible without restoring those rows; 2.0.0-rc.86 to 2.0.0-rc.89 read the new envelope.

#### Feature permission names are a closed set

- **Planned in section 5** since the first revision; not a counted finding.
- **What changed (BREAKING):** an unknown feature permission name is refused where permissions are
  submitted (`accesses.create`, `accesses.update`, `accesses.checkApp`, `POST /reg/access`, consent
  offers and the scope requests or updates written by the account's own accesses, and the
  permissions an OAuth scope grammar returns); the names are `selfRevoke`, `secretSharing`,
  `webhooks`, `accessCreation` and `selfAudit`. Until now a typo such as `webhook` was stored and
  restricted nothing. Stored data is not touched: an access or an offer that already holds an
  unknown name keeps working. With the same release, a personal token's `events.update` of a
  consent event is validated as its create would be, so an offer can no longer be changed to hold
  content its create refuses; and a permission that would create an ordinary stream named like an
  account field (for example `email` with a `defaultName`, which looked right on a consent screen
  and never held the account's address) is refused with `400 invalid-operation`, recognised by
  `data.accountStreamId`.
- **Operator action:** none beyond the upgrade; integrations that build permissions or consent
  offers check the feature names and stream ids they send.

#### Production refuses the published development secrets

- **Completes** the 2.0.0-rc.40 finding "Placeholder secrets passed boot validation" (High; not
  counted again).
- **What could happen:** a production core accepted `auth.adminAccessKey`
  `dev-only-admin-access-key` and `auth.filesReadTokenSecret` `dev-only-files-read-token-secret` or
  `libjs-test-files-secret`, values shipped in this repository's development and test
  configurations and as good as public; only the published `platform.piiHmacKey` was refused.
- **What changed (BREAKING):** a production core (`NODE_ENV=production`, the Docker image) refuses
  to boot with them; `bin/check-config.js` reports them.
- **Operator action:** before upgrading, run `bin/check-config.js` on every core's configuration,
  and set long random values of your own (`openssl rand -hex 32`). A new
  `auth.filesReadTokenSecret` invalidates the attachment read tokens already handed out.

#### Erased accounts: nothing re-created or stored by late work

- **Closes** the residue noted with the 2.0.0-rc.72 finding "An account erased during a consent
  operation kept a record holding a peer's capability token" (Low; not counted again).
- **What could happen:** work still running for an account while it was erased (a long request, a
  consent dispatch reading a peer) could re-open empty databases in the directory kept for the
  audit (SQLite with `audit.onUserDelete: keep`) or store rows for the erased account
  (PostgreSQL), and with the audit on PostgreSQL a call still running could leave one audit record
  under the erased id.
- **What changed:** on SQLite with `keep`, the erasure leaves a marker file in the kept directory
  (`erased.json`, no username), and no new file is created there while it is present (a restore of
  the account removes it); a late attachment no longer re-creates an erased account's directory in
  erase mode either. On PostgreSQL, the database refuses a new row in the account tables for a user
  id the users index does not hold (one trigger per table, installed at boot and by a migration),
  and the erasure removes the index entry before the data. With the audit on PostgreSQL and
  `erase` (the default), a record for an erased account is refused and the erasure removes audit
  records a second time once the account is gone. A request whose account is erased while it runs
  answers `404 unknown-resource`. `bin/reconcile-user-cores.js --cmc-retries` lists, and with
  `--apply` deletes, the consent retry records that earlier releases could leave under erased ids
  (PostgreSQL).
- **Residual:** on SQLite with `keep`, an open that passed the check just before the marker was
  written can still create one empty file (no row in it); on PostgreSQL, series points, attachment
  content stored in the database and the audit table under `keep` are not guarded; with the audit
  on PostgreSQL and the base storage on SQLite, a record written in the last moment before the
  erasure marks the account can stay (the server warns about this pairing at boot).
- **Operator action:** every process of a core must run this release: a process of an earlier
  release on the same database fails registrations, and a rollback needs the guard removed first
  (the SQL is in `CHANGELOG-v2.md`). A data-only `pg_restore` into an existing schema runs with
  `--disable-triggers`. On a core that never ran with `keep` and whose base and audit storage are
  both PostgreSQL, remove once the audit records left by earlier releases (query in
  `CHANGELOG-v2.md`). On PostgreSQL cores that erased accounts before 2.0.0-rc.72, run
  `bin/reconcile-user-cores.js --cmc-retries` (never as part of an upgrade), then `--apply` if the
  list holds erased ids only. Directories kept by earlier erasures carry no marker: empty databases
  next to their audit files hold no row and may be removed.

#### Lower-severity fixes in 2.0.0-rc.90

- Reported through the public issue tracker, not counted: an accept written to a consent
  capability's responses stream was tied to a capability by the `capabilityId` of its content,
  which the accepter writes. An accept leaving it out skipped the capability lookup, so a
  single-use link stayed open and could be used again, the invite was not stamped accepted, and an
  invite id chosen by the accepter was kept on the requester's inbox mirror; an accept could also
  have its anchor streams placed under another app scope of the account (open-pryv.io#171). The
  capability is now taken from the responses stream the accept was written to, an accept naming
  another capability is refused (`cmc-incoming-accept-capability-mismatch`; nothing is created and
  the link is not consumed), and the scope comes from this side's own copy of the offer.
- **An access reading itself got the credentials of the URLs in its `clientData`:**
  `GET /access-info`, and `GET /accesses/{id}` by a non-personal access on its own id, returned
  `clientData` as stored, and it can hold endpoints written there by another account (a consent
  counterparty's back-channel), whose tokens are not the holder's to read. The user part of every
  URL in it is now removed, as `accesses.get` does where it withholds an access's credentials; the
  access's own `token` and `apiEndpoint` are still returned.
- **Access requests:** `POST /reg/access` stored the `returnURL` as sent, and auth pages navigate to
  it once the user decides. It is now checked at creation (BREAKING): an absolute URL with no
  control character and no `user:password@` part, whose scheme is not `javascript:`, `data:`,
  `vbscript:` or `blob:`; anything else is refused with `400`. The new optional key
  `access.returnOrigins` binds app ids to the origins their requests may return to. This is
  redirect hygiene, not client authentication: whoever creates a request can still read its
  outcome by polling.
- **Sessions:** the periodic re-validation of open socket.io connections extended their personal
  session, so a socket left open without calls kept it alive; the session now expires after
  `auth.sessionMaxAge` like an idle browser tab, the socket is disconnected at the next
  re-validation, and an expired session is no longer extended by any request.
  `oauth.clientRevokeCheckSeconds` and `caching.accessMaxAgeSeconds` above 300 are used as 300:
  they bound how long a revoked or narrowed access keeps working where no invalidation arrives.
- **Auto-deletion:** a change of an account's deletion schedule made while the sweep checked that
  account (the holder moving the date later) could be ignored or written over, and the account
  erased. The sweep now never writes its schedule over a newer one, reads the setting and the
  schedule again right before an erasure and once the erasure is recorded as in progress, and a
  change made meanwhile stops that account's pass.
- **Audit completeness:** the API calls the server makes in-process for a flow (local deliveries,
  credential hand-offs, third-party sign-in, OAuth consent writes) and the access changes it makes
  outside an `accesses.*` call now leave audit records (`accesses.created`, `accesses.changed`,
  `accesses.deleted`); the creation of an account is the first record of its trail
  (`account.created`); lost audit records are counted (`GET /system/audit-status`, the telemetry
  counter `audit.records.lost`); in a batch, an audit write failure no longer changes a call's
  answer; two socket.io calls running at once on one connection could swap their method id in the
  audit trail; an audit filter group that is only the start of a name now refuses the boot.
- **Event types:** an answer of `service.eventTypes` without a `types` list (an error page in JSON)
  was taken for a loaded catalogue, and the core stopped refusing unknown event types; it is now a
  failed load (the core stays degraded and retries).
- **Registration:** on a multi-core platform, a registration naming a hosting that no available core
  serves created the account on the core that received it, whatever its hosting (cores of different
  hostings may fall under different rules); it is now refused with `400`.
- **Mail:** new key `services.email.mergeLanguage`; with `handlebars`, Mandrill HTML-escapes the
  variables of `{{VAR}}` templates (names, links, an administrator's reason). Unset, the Mandrill
  account default (Mailchimp tags, whose escaping Mandrill does not document) applies as before, and
  a core with `method: mandrill` logs a boot warning.
- **OAuth:** the session pre-minted for an authorization code that expired unexchanged is removed
  like any other: the breach-scope index (`GET /system/accesses/:accessId`) marks it deleted (it was
  left there as a live access), and its alias stops routing.
- Not security fixes, listed for operators: an operator who fronts a core with nginx keeps it
  patched against the flaws disclosed on 2026-11-18 (fixed in nginx 1.30.7 and 1.31.9;
  `docs/nginx-ingress-sample.conf` enables HTTP/2); a core serving TLS itself, the default, runs no
  nginx. An operation a data store does not support answers `unsupported-operation` (501) instead
  of `api-unavailable`.
- New in this release, not findings: `GET /system/admin/config/effective` (admin key) answers the
  configuration a core runs with, every secret redacted (with fingerprints keyed by
  `auth.filesReadTokenSecret`, none when that secret is a placeholder or a published value);
  `access.openedOnlyByAuthPage` (off by default) lets only the auth page open a pending access
  request.
- **Operator action:** audit filters that list methods one by one add `account.created`,
  `accesses.created`, `accesses.changed` and `accesses.deleted` (`accesses.all`, `account.all` and
  `all` include them); alert on `lost.total` above zero and on the `Failed to audit a batched call`
  log line; a `service.eventTypes` pointing at the hierarchical file must point at a flat list
  (`flat.json`); on Mandrill, convert the templates to `{{VAR}}` and set `handlebars`, or set
  `mailchimp`; set `access.returnOrigins` identically on every core where wanted, and turn
  `access.openedOnlyByAuthPage` on only once the auth page sends `?authPage=1`; a client that only
  listens on a socket with a personal token makes a call from time to time.

### Fixed in 2.0.0-rc.91 (deployed)

2.0.0-rc.91 carries no new counted finding. It adds an administration surface (platform setup,
administrator sessions and roles) and validation levels for OAuth2 clients, each reviewed
independently before merge with no finding in what was released; it keeps registration closed on a
fresh install until its setup is finished, checks MFA sessions by kind, and carries lower-severity
fixes.

#### Platform setup, administrator sessions and roles

- **New surface** (section 3.2); not a counted finding.
- **What changed:** a fresh platform waits for its first administrator. Its first core prints a
  one-time setup code at boot (in a marked block of its output and in `setup-code.txt` next to the
  configuration file, mode 0600); only the code's SHA-256 is stored, and past 10 tries in 15
  minutes on a core redeeming answers `429`. The code is redeemed on the setup page built into
  every core (`GET /system/setup/`: strict Content-Security-Policy, `cache-control: no-store`,
  `404` once setup is done), which signs in or creates the first administrator. Administrators then
  use administrator sessions (`Authorization: AdminSession <token>`), opened on the account's home
  core from a personal token, with the second factor of the sign-in when MFA is on, accepted by
  every core and checked against the account's role on every request; sensitive acts need a recent
  second factor (step-up). Every `/system` route names the permission it needs and accepts an
  administrator session holding it, beside the admin key. The `owner` role is given by a one-time
  claim code to an account signed in with a personal token (an app or shared token opens nothing);
  the last owner cannot be revoked, nor delete its account with its own token; deleting an account
  deletes its role.
- **Origin rule on `/system`:** a call carrying an `Origin` and not authenticated by the admin key
  is accepted only from the core's own origin, the portal's or `portal.cors.allowedOrigins`, with
  CORS for that origin only. Admin-key calls and calls without `Origin` are unchanged.
- **Break-glass admin key (opt-in):** `auth.adminAccessKeyScope: break-glass` limits the admin key
  to the `/system` routes that need it (calls between cores, setup code, claim codes, role listing
  and revocation, status): any other `/system` path refuses it, and outside `/system` it no longer
  deletes accounts nor reaches `/reg/records` and `/reg/admin/*`. The default, `full`, is unchanged.
- **Registration on a fresh install (BREAKING for fresh installs only):** while setup is pending,
  `POST /users` answers `403`, except for the first administrator's account created through the
  setup session (`setup.registrationWhilePending: closed`, the default). Until this release a new
  install accepted registrations from its first boot.
- **Residual:** unless `break-glass` is set, the admin key keeps its full reach, and it remains the
  credential of calls between cores (section 5).
- **Operator action:** none for an existing platform: it is recorded as set up at its first boot on
  this release (no code is printed, admin-key calls and registration are unchanged). A fresh install
  provisioned by automation finishes setup with the admin key (`POST /system/setup/finish` or
  `node bin/admin.js setup finish`), or sets `setup.registrationWhilePending: open`. Treat the boot
  output and `setup-code.txt` as secret until setup is done. List a portal served from another
  origin in `portal.cors.allowedOrigins`. Guide: `docs/setup-and-administrators.md`.

#### MFA: confirmation and sign-in sessions checked by kind

- **Hardening**; not a counted finding.
- **What changed:** `mfa.confirm` accepts an enrolment session only and `mfa.verify` a sign-in
  session only; a session without a kind is refused by both (`invalid-access-token`). Until now a
  session without a kind passed both checks; none could exist, as the server tags every session
  when it opens it and keeps it in memory only, and the check no longer depends on that.
- **Operator action:** none; nothing a client holds changes.

#### OAuth2 client registration modes and validation levels

- **New surface**; not a counted finding.
- **What changed:** `oauth.clientRegistration.mode` accepts `curated` (the default, unchanged) and
  `delegated`; any other value, `open` included, is refused at boot and by `bin/check-config.js`
  (anonymous client registration was never offered, but the value was not checked). Every registry
  client has a validation level decided by the server (`appValidated`, `publisherValidated` or
  `nonValidated`), returned by `POST /oauth2/authorize/offer` and stamped on grants and sessions.
  The operator sets, per level, whether consent is allowed, limited to testers or refused, a scope
  template, and a maximum number of grants; a level whose consent is refused also refuses the
  refresh of grants already given. While the mode is `curated`, a client registered by a developer
  is not served. Registration by developers comes with a later release.
- **Operator action:** none with an unchanged `curated` configuration. Scripts that parse
  `bin/oauth-client.js list` handle two more columns. Read `docs/oauth2.md` before setting
  `delegated`.

#### Lower-severity fixes in 2.0.0-rc.91

- **Reference nginx configuration:** `docs/nginx-ingress-sample.conf` matched the OAuth2 token and
  authorization routes with exact, case-sensitive locations, while the core accepts any letter case
  and a trailing slash, so `/OAuth2/token` or `/oauth2/token/` reached the core outside the OAuth2
  rate limits. The locations are now case-insensitive with an optional trailing slash, and the
  introspection and revocation routes, which check the client secret, share the token route's
  limit.
- **Audit trail kept after an erasure (`audit.onUserDelete: keep`):** the kept trail now ends with
  an `account.deleted` record (who erased the account, as ids and fixed words only), and a restore
  writes `account.restored`. The auto-deletion sweep's own erasure record no longer holds the
  username, which it kept after the account was gone. A restore over an existing account
  (`--overwrite`), its roll-back and the cleanup of a failed restore no longer remove the kept
  trail, and a restore under another user id onto the id of an erased account is refused without
  `--restore-erased`, so a backup is no longer merged into the kept trail of the erased account
  that held that id. With `erase` (the default) nothing changes.
- **Platform database engine switch:** `bin/migrate-platform.js` (between rqlite and PostgreSQL)
  copied only some platform rows: the OAuth2 clients, their revocation lists and grants, the
  erasure ledger (which a restore reads to refuse an account erased after its backup), the access
  index of `GET /system/accesses/:accessId`, the external ids and the send budgets were lost. It now
  copies every row, and without `--force` refuses a target that holds any platform row.
- **Mail switches (BREAKING):** `services.email.enabled` is a boolean and each mail has its own
  `services.email.send...` switch. A configuration that still holds the former object, in any
  source, environment variables included, stops the boot and is named key by key, rather than read,
  so that a mail switched off is never sent again because of the upgrade; a switch that is neither
  `true` nor `false` (an empty value, a quoted `'false'`), which counted as on, is refused as well.
- **Storage engines:** each storage type has an interface version, and the server refuses to start
  when a discovered engine declares another one, before loading its code. The platform storage
  interface moves to version 2 with this release.
- **Operator action:** before upgrading, run `bin/check-config.js` and replace a
  `services.email.enabled` object with the flat switches (`MIGRATION-services-email-enabled.md`);
  roll the configuration back together with the image. If you copied
  `docs/nginx-ingress-sample.conf`, update your copy. Update or remove engine folders under
  `storages/engines/` that this release does not ship; an engine maintained elsewhere implements the
  two new platform storage methods and declares version 2. Audit filters that list methods one by
  one add `account.deleted` and `account.restored` (`account.all` and `all` include them).

---

## 5. Known residual risks and planned work

**Rate limiting at the edge.** The server enforces in-code limits on several sensitive operations
(see the release notes), but connection-level and per-route rate limiting is best done by a
reverse proxy in front of every core. Deploy one, follow the operator rate-limiting guide, and list
it in `http.trustedProxies`.

**Resource quotas.** Since 2.0.0-rc.90, calls in progress, socket.io connections and calls,
parameter shapes, stream trees, webhooks, idle connections, streamed audit reads, caller-triggered
mails and routing lookups are bounded per account, per access, per connection or per client
(section 4); each bound is counted per API worker. What an account stores (events, attachments,
accesses) has no quota yet; this is planned with the rest of the limits-hardening work, and a
reverse proxy mitigates it meanwhile. Since 2.0.0-rc.87 a PostgreSQL statement issued while
serving an API request has a time limit and password checks run a bounded number at a time per API
worker (section 4). With the SQLite engine, statements have no time limit.

**Container image.** Since 2.0.0-rc.55 the image is based on Debian 13, and every release image is
scanned in CI before it is published: a critical advisory that has a fix stops the release. It
bundles rqlite 10.7.5 since 2.0.0-rc.90 (10.6.0 from 2.0.0-rc.55), which carries the fixed version
of the networking library whose HTTP/2 advisories were accepted until then. The image still carries
operating-system package advisories for which the distribution has published no fix; these are
accepted, each with its reason. `npm` / `npx` were removed from the image in rc.50. The rqlite
ports listen on loopback (HTTP) and behind mutual TLS (Raft).

**Backups.** A plaintext backup's file list detects corruption, not tampering; a backup read
without `--signing-pubkey` is authenticated against anyone without its data key only. A signed
chain is verified only when the restore is given the public key; the restore warns when a signed
chain is read without it. Dropping the last runs from `chain.json` is not detected, signed or not:
the restore then yields the earlier state (as `--through-run` does). Keep the run count from
`--inspect` with the restore secret if rollback matters. The chain lock relies on exclusive create
and on the destination's clock being within a minute of the host's.

**Planned for the next major version:**

- Cluster join: a certificate-signing-request flow (the joiner generates its key; short-lived node
  certificates), replacing bundles that carry the admin key.
- rqlite HTTP API authentication.
- A core-to-core credential distinct from the admin key. Since 2.0.0-rc.91,
  `auth.adminAccessKeyScope: break-glass` limits the admin key to the `/system` routes that need it,
  calls between cores among them.
- Use-time clipping of a child access to its managing access, which also narrows children created
  before rc.43 (today `bin/access-scope-audit.js` reports them).
- HF series keyed by account id instead of username. Until then, a username change moves the
  account's series under the new name (since 2.0.0-rc.66; `bin/gather-former-series.js` gathers
  those that changes made with earlier releases left under a former name).
- Access requests: a second secret held by the requester, so that the poll key alone no longer
  retrieves the delivered token.
- Delegation teardown across cores: a peer check of the delegate's identity.
- Token hardening: hashed token storage (the minimum length for caller-chosen access tokens and
  signed webhook calls ship in 2.0.0-rc.90). Keys stored at rest are written with authenticated
  data since 2.0.0-rc.90 (read since 2.0.0-rc.86); envelopes written by earlier releases (version 1)
  are still read, and a row moves to the new envelope only when it is written again. The new
  envelope binds an authenticator secret to its purpose, not to its account.

**Access deletion records.** A deleted access leaves a deletion record (its name, permissions and
timestamps) that is kept until the account is erased by default; API answers never return its
token, and since 2.0.0-rc.53 the stored record of a consent relationship holds none of its
credentials. Since 2.0.0-rc.53 every consent and delegation teardown leaves such a record too. Since
2.0.0-rc.56 an operator can set a retention period (`accesses.deletionRecords.retentionDays`, see
that release).

**Lower-severity defects.** The Low and Low-Medium defects that were still open at revision 2 are
fixed in 2.0.0-rc.56 (section 4); the residuals that remain are stated with their items.
Operators should keep daily log rotation on (the default); since 2.0.0-rc.52,
`logs.file.rotation.maxSize` also caps the size of each daily file. A log file without daily
rotation is one growing file, to be rotated outside the server.

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
| 3 | 2026-10-23 | 2.0.0-rc.40 to 2.0.0-rc.57 | Adds 2.0.0-rc.54 to rc.57 (rc.57: Node.js runtime update, release table only; follow-up review of how stream ids are compared by the access guards, and of the server's calls to consent counterparties): 2 High findings and lower-severity fixes in rc.55 and rc.56; the lower-severity defects open at revision 2 are fixed; section 5 updated for the container image and the deletion-record retention. rc.54 to rc.57 deployed on the maintainers' platforms (2026-10-16 to 2026-10-23). |
| 4 | 2026-10-26 | 2.0.0-rc.40 to 2.0.0-rc.58 | Adds 2.0.0-rc.58 to the release table: dependency security updates (`body-parser`, `multer`, `undici`, `fast-uri`), not audit findings; counts unchanged. Deployed on the maintainers' platforms (2026-10-26). |
| 5 | 2026-10-26 | 2.0.0-rc.40 to 2.0.0-rc.59 | Adds 2.0.0-rc.59 to the release table: `nodemailer` 10.2.1 (moderate dependency advisories), not an audit finding; counts unchanged. Deployed on the maintainers' platforms (2026-10-26). |
| 6 | 2026-10-28 | 2.0.0-rc.40 to 2.0.0-rc.63 | Adds 2.0.0-rc.63 to the release table: `node-forge` 1.4.2 (high dependency advisory) and `qs` 6.16.1 (moderate), not audit findings; counts unchanged. rc.60 to rc.62 carried no security fix. Deployed on the maintainers' platforms (2026-10-28). |
| 7 | 2026-10-29 | 2.0.0-rc.40 to 2.0.0-rc.64 | Adds 2.0.0-rc.64 (follow-up review of the OAuth2 consent and session lifecycle and of event history reads): 2 Medium findings. Deployed on the maintainers' platforms (2026-10-29). |
| 8 | 2026-10-29 | 2.0.0-rc.40 to 2.0.0-rc.65 | Adds 2.0.0-rc.65 (follow-up review of account-field permissions carried by consents and app accesses, of the consent retry path and of deletion listings): 3 Medium findings and lower-severity fixes; section 4.1 notes the deletion-record exception to the `*` scope. Deployed on the maintainers' platforms (2026-10-29). |
| 9 | 2026-10-30 | 2.0.0-rc.40 to 2.0.0-rc.66 | Adds 2.0.0-rc.66 (follow-up review of access aliases and username changes, and of how consent grants and refreshed OAuth2 sessions combine permissions): 3 Medium findings, lower-severity fixes and the completion step of the 2.0.0-rc.47 HF series item; section 4.1 adds the alias check, section 5 updates the HF series item. Deployed on the maintainers' platforms (2026-10-30). |
| 10 | 2026-10-30 | 2.0.0-rc.40 to 2.0.0-rc.68 | Adds 2.0.0-rc.67 (no security fix: the 2.0.0-rc.66 server with its Docker image) and 2.0.0-rc.68 (review of the OAuth2 consent flow alongside the OAuth2 clients registered by the operator): lower-severity fixes and the completion steps of the 2.0.0-rc.64 and rc.66 consent items; counts unchanged. Deployed on the maintainers' platforms (2026-10-30). |
| 11 | 2026-11-02 | 2.0.0-rc.40 to 2.0.0-rc.69 | Adds 2.0.0-rc.69 (review of the OAuth2 refresh chain and of pseudonymous access aliases alongside token introspection, revocation and pseudonymous OAuth2 subjects): 2 Medium findings and lower-severity fixes, plus the `follow-redirects` 1.16.2 dependency update (high advisory, not an audit finding); section 4.1 updates the alias check. Deployed on the maintainers' platforms (2026-11-02). |
| 12 | 2026-11-02 | 2.0.0-rc.40 to 2.0.0-rc.70 | Adds 2.0.0-rc.70 (review of OAuth2 client authentication, of what an OAuth2 session may create and of the authorization request's audience, alongside client key sets, grant state and resource indicators): 2 Medium findings, lower-severity fixes and the completion step of the 2.0.0-rc.69 state-key item (the admin-key fallback removed). Deployed on the maintainers' platforms (2026-11-02). |
| 13 | 2026-11-03 | 2.0.0-rc.40 to 2.0.0-rc.71 | Adds 2.0.0-rc.71 (review of the suspension and lifecycle of OAuth2 clients, alongside the vetting status of clients registered by the operator): 1 Low finding, lower-severity fixes and the completion step of the 2.0.0-rc.68 suspension (the data API refuses a suspended client's tokens). Deployed on the maintainers' platforms (2026-11-03). |
| 14 | 2026-11-04 | 2.0.0-rc.40 to 2.0.0-rc.72 | Adds 2.0.0-rc.72 (review of backup restore on multi-core platforms, of the mails sent to an account's stored address and of the background work of an account being erased): 2 Medium findings, 1 Low finding and lower-severity fixes, among them two completion steps of the 2.0.0-rc.71 client vetting (launch types, withdrawn refresh grant type). Deployed on the maintainers' platforms (2026-11-04). |
| 15 | 2026-11-05 | 2.0.0-rc.40 to 2.0.0-rc.73 | Adds 2.0.0-rc.73 (follow-up review of email uniqueness in cleartext PII mode and of backup restore): 1 Medium finding and lower-severity fixes; section 3.2 adds the adapter routes. Deployed on the maintainers' platforms (2026-11-05). |
| 16 | 2026-11-06 | 2.0.0-rc.40 to 2.0.0-rc.74 | Adds 2.0.0-rc.74 (review of the OAuth2 client revoke, alongside client metadata documents): 1 Low finding and lower-severity fixes; section 3.2 adds client metadata documents and their outbound fetches. Deployed on the maintainers' platforms (2026-11-06). |
| 17 | 2026-11-07 | 2.0.0-rc.40 to 2.0.0-rc.75 | Adds 2.0.0-rc.75 (review alongside per-user resource addresses and adapter routes on per-user hosts): lower-severity fixes, no counted finding; section 3.2 adds the addressed-account headers and the `421` of adapter routes on per-user hosts. Deployed on the maintainers' platforms (2026-11-07). |
| 18 | 2026-11-08 | 2.0.0-rc.40 to 2.0.0-rc.76 | Adds 2.0.0-rc.76 (review alongside address aliases): no finding, counts unchanged; the `html-to-text` 10 dependency update (low advisory, not an audit finding); section 3.2 adds address aliases. Deployed on the maintainers' platforms (2026-11-08). |
| 19 | 2026-11-09 | 2.0.0-rc.40 to 2.0.0-rc.77 | Adds 2.0.0-rc.77 (review alongside the per-user OAuth2 issuer): no finding, counts unchanged; one lower-severity fix (the audit outcome of a streamed call cut short); section 3.2 adds the per-user issuer. Deployed on the maintainers' platforms (2026-11-09). |
| 20 | 2026-11-11 | 2.0.0-rc.40 to 2.0.0-rc.79 | Adds 2.0.0-rc.78 (lower-severity fixes: public email lookups within a per-address budget, one accepter per single-use consent link) and 2.0.0-rc.79 (no finding, counts unchanged; the group-account member access budgets; one lower-severity fix, a failed member access request holding its patient's lock). Deployed on the maintainers' platforms (2026-11-11). |
| 21 | 2026-11-12 | 2.0.0-rc.40 to 2.0.0-rc.82 | Release table adds 2.0.0-rc.80 and rc.81 (not audit releases); section 4 adds 2.0.0-rc.82: the default of `oauth.audienceBoundSessions` is now `true`, closing by default the direct use at the data API of a token issued for a resource server (described with 2.0.0-rc.73); no finding, counts unchanged. Deployed on the maintainers' platforms (2026-11-12). |
| 22 | 2026-11-12 | 2.0.0-rc.40 to 2.0.0-rc.83 | Release table adds 2.0.0-rc.83 (not an audit release: `features.passwordResetByEmail` in service info, the admin route `GET /system/migrations-status`); counts unchanged. |
| 23 | 2026-11-13 | 2.0.0-rc.40 to 2.0.0-rc.84 | Release table adds 2.0.0-rc.84 (not an audit release; lower-severity fixes: access integrity verifiable after an update, history snapshots without internal call counters); counts unchanged. Deployed on the maintainers' platforms (2026-11-13). |
| 24 | 2026-11-17 | 2.0.0-rc.40 to 2.0.0-rc.85 | Adds 2.0.0-rc.85 (review of how the SQLite storage engine builds its queries and matches stream ids): 1 High and 2 Medium findings, all on the SQLite engine, and lower-severity fixes; the planned move of the SQLite engine to bound values ships (removed from section 5, section 4.1 updated). Deployed on the maintainers' platforms (2026-11-17). |
| 25 | 2026-11-17 | 2.0.0-rc.40 to 2.0.0-rc.86 | Adds 2.0.0-rc.86: no new finding, counts unchanged; the second step of the 2.0.0-rc.51 backup finding ships (every file of a backup run authenticated, signed runs; removed from section 5, which gains the backup residual risks; six findings keep a planned second step), the 2.0.0-rc.43 cache item is completed (cache invalidation between the processes of a core), and lower-severity fixes, among them a custom data store named after a built-in store that came within reach of `*` permissions (section 4.1 qualified). Deployed on the maintainers' platforms (2026-11-17). |
| 26 | 2026-11-18 | 2.0.0-rc.40 to 2.0.0-rc.87 | Adds 2.0.0-rc.87: no new finding, counts unchanged; two items of the limits work planned in section 5 ship (a time limit on the PostgreSQL work of API requests, a bound on the password checks running at once), and the resource-quotas paragraph of section 5 is updated (the per-account cap on requests in flight stays planned); one lower-severity fix reported through the public issue tracker (the session of a composed OAuth2 re-consent holds the request only). Deployed on the maintainers' platforms (2026-11-18). |
| 27 | 2026-11-26 | 2.0.0-rc.40 to 2.0.0-rc.90 | Release table adds 2.0.0-rc.88 (Node.js 24.22.3 runtime update, CI actions pinned) and 2.0.0-rc.89 (the erasure ledger, not an audit release); section 4 adds 2.0.0-rc.90: 1 High finding (a consent accept could take over another counterparty's relationship), counts 74 (24 High); two lower-severity fixes rated Medium and not counted (a second consent accept on the same scope left the first working; platform writes lost during a leader change); the limits and token work planned in section 5 ships (per-account, per-access and per-connection limits, cached routing lookups with a DNS response rate limit, a floor on chosen tokens, keyed store hashes, signed webhook calls, feature permission names a closed set), and the at-rest envelope is written; completion steps of the 2.0.0-rc.40 placeholder-secret and 2.0.0-rc.72 erasure items; rqlite 10.7.5 (dependency update); section 5 updated (resource quotas, container image, token hardening; the feature-name item removed). Deployed on the maintainers' platforms (2.0.0-rc.88 on 2026-11-25, 2.0.0-rc.90 with 2.0.0-rc.89 on 2026-11-26). |
| 28 | 2026-11-27 | 2.0.0-rc.40 to 2.0.0-rc.91 | Adds 2.0.0-rc.91: no new finding, counts unchanged (74, 24 High); new administration surface reviewed before merge (platform setup with a one-time code, administrator sessions with step-up and roles, an origin rule on `/system`, an opt-in break-glass scope for the admin key) and OAuth2 client validation levels; hardening (registration closed on a fresh install until setup, MFA sessions checked by kind, storage engine interface versions checked at boot); lower-severity fixes (reference nginx OAuth2 locations, the audit trail kept under `keep`, `bin/migrate-platform.js` copying every platform row, mail switches that are not booleans refused); sections 3.1, 3.2, 3.3 and 4.1 add the administration surface; section 5 notes the break-glass scope under the core-to-core credential item. Deployed on the maintainers' platforms (2026-11-27). |
