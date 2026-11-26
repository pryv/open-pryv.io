# Setup and administrators

A platform is administered by **administrators**: Pryv accounts of the platform that hold a **role**. This page
covers how a new platform gets its first administrator (the setup code and the built-in setup page), how
administrators authenticate (administrator sessions), how more administrators get a role (claim codes), what the
admin key still does, and the command-line tool `bin/admin.js`.

Today there is one role, `owner` (every administration permission), at one scope, `platform`. The permission names
the server checks are in `components/business/src/admin/permissions.ts`; every `/system` route and the
permission it needs are in `components/api-server/src/routes/system-permissions.ts`.

## Setup state

The platform store holds `setup/state`: `pending` (the platform waits for its first administrator) or `ready`.

- **Fresh platform** (no account, no other core): the first core that boots writes `pending` (first writer wins,
  so one core of a platform does it) and mints the setup code.
- **Existing platform** upgraded to this release (it has accounts, or other cores): the first boot writes `ready`
  directly. No code is printed and every admin-key call behaves as before. Its first administrator comes from a
  claim code (below).
- A core that joins a platform later (`bin/master.js --bootstrap`) never mints a code: it reads the state.

While `pending`, registration is closed (`setup.registrationWhilePending: closed`, the default) except for the
first administrator's account, created through the setup session.

## The setup code

- 130 random bits shown as 26 characters of Crockford base32 in groups (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`). Typing
  is lenient: case, dashes and spaces are ignored, `O` reads as `0`, `I` and `L` as `1`.
- Printed **once**, in one marked block of the boot log (stdout), with the addresses of the setup page; also written
  to `setup-code.txt` next to the configuration file (mode 0600, deleted once setup is done). `setup.printCode:
  false` leaves the block out (the file is still written when possible). The code is never logged otherwise.
- Only its SHA-256 is kept, in the platform store: a restart keeps a pending code valid but cannot show it again
  (the log says when it was issued and how to replace it).
- Valid `setup.codeTtlHours` (24). Redeeming it is limited to 10 tries per 15 minutes per core; past that the code
  is withdrawn and a new one must be minted.
- **Replace it**: `node bin/admin.js setup-code --new` on a core (shell access is the proof of being the operator;
  in a container `docker exec <container> node bin/admin.js setup-code --new`), or `POST /system/admin/setup/code`
  with the admin key. The previous code stops working.
- **Choose it yourself** (images, CI, marketplace): `node bin/admin.js setup-code --hash` prints a new code and
  its SHA-256; put only the hash in `setup.codeHash` (env `pryv_setup__codeHash`, or `init --setup-code-hash=`).
  The first boot then accepts that code and prints none. A hash of your own code is the SHA-256 (hex) of its
  canonical form: the 26 characters, uppercase, no separator (`setup-code --hash <code>` computes it).

## The built-in setup page

`/system/setup/` on any core, on any host name and on the bare IP (`http://<ip>:3000/system/setup/`, or
`https://<ip>/system/setup/` with TLS), in both topologies. It needs no hosted site, no DNS, no certificate and no
outbound access: it is the way in when the portal cannot be reached yet (DNS or certificate not working, no access
to the portal's host). It answers 404 once setup is done.

Steps: enter the setup code; read the checks (configuration, public address, DNS delegation, certificates and
how they are issued, migrations, second factor, portal, admin key scope); sign in with an account of the platform
or create one; enable a TOTP second factor when administrators need one (`services.mfa` on and
`admin.session.requireMfa: true`), then sign in again with it; finish.

The page is three static files of the release (HTML, one script, one style sheet), no build, no external
resource. Every answer carries `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` and `cache-control: no-store`.
The setup session and the account's token live in the page's memory only: reloading the page ends the session
(a new code is then needed).

Signing in from the page uses the app id `pryv-setup-page`, which `auth.trustedApps` does not need to list: a
sign-in with that app id is accepted when it comes from the core's own origin (the request's own host, `core.url`
or `dnsLess.publicUrl`) and carries a valid setup session while setup is pending. Anywhere else the app id is
checked against `auth.trustedApps` as any other.

## Routes

| Route | Credential |
|---|---|
| `GET /system/setup/` (page, `setup.js`, `setup.css`) | none, while pending |
| `GET /system/setup/status` | none |
| `GET /system/setup/checks` | setup session or admin key |
| `POST /system/setup/session { code }` | none (rate limited); answers the setup session (2 h) |
| `POST /system/setup/first-admin { username, personalToken }` | setup session; the account gets `owner` |
| `POST /system/setup/finish` | setup session or admin key; needs an owner |
| `POST /system/admin/setup/code` | admin key or setup session |
| `POST /system/admin/session { username }` | the account's personal token (`Authorization`), on its home core |
| `GET`, `DELETE /system/admin/session` | administrator session |
| `POST /system/admin/session/renew { personalToken }`, `.../step-up` | administrator session, on its home core |
| `POST /system/admin/claim-codes { role, scope, ttlMinutes }` | admin key, setup session, or `claimCodes:mint` (step-up) |
| `POST /system/admin/roles/claim { username, code }` | the account's personal token, on its home core |
| `GET /system/admin/roles` | `roles:read` or admin key |
| `DELETE /system/admin/roles/:userId[?role=&scope=]` | `roles:grant` (step-up) or admin key |
| `GET /system/admin/portal/context` | any administrator subject |

A refused credential answers 404, as an unknown route does. A personal token is valid on its account's home core
only: elsewhere these routes answer an error naming the home core's URL.

## Administrator sessions

1. The administrator signs in on the account's home core as in any Pryv app (password, then the second factor).
2. `POST /system/admin/session` with that personal token opens an **administrator session** (256 random bits,
   `admin.session.ttlMinutes`, 60). Only its SHA-256 is stored, in the platform store, so every core accepts it.
3. Calls carry `Authorization: AdminSession <token>`. Each core reads the account's role row locally and computes
   the permissions; deleting the role row, or `bin/admin.js sessions revoke`, stops the sessions at their next
   request on every core.
4. **Step-up**: granting or revoking roles, minting claim codes and deleting accounts need a second factor younger
   than `admin.session.stepUpMinutes` (5): `POST /system/admin/session/step-up` with the token of a fresh sign-in.

With `services.mfa` on and `admin.session.requireMfa: true` (the default), the sign-in behind the personal token
must have passed its second factor (recorded by the home core at `mfa.verify`).

**Origin rule.** A call to `/system/*` that carries an `Origin` and is not authenticated by the admin key is
accepted only from the core's own origin, the portal's origin (from `portal.site` and the topology) or one listed
in `portal.cors.allowedOrigins`, and gets CORS headers for that origin only. Admin-key calls and calls without
`Origin` keep the API-wide behaviour.

## Claim codes and roles

A claim code gives a role to whoever holds it and signs in: same format as the setup code, role and scope fixed
when it is minted, valid 15 minutes by default (24 hours at most), single use (of two concurrent claims exactly
one wins). Mint one with `node bin/admin.js claim-code --role owner`, `POST /system/admin/claim-codes` (admin key),
or as an owner in the portal; the person claims it with `POST /system/admin/roles/claim` while signed in on the
account's home core. The grant records `via: claim-code` and who minted it.

Roles are stored in the platform store under `admin-role/<userId>` (the account id, never a username or an email;
no credential in it). **The last lasting owner grant** (`owner` at scope `platform`, without expiry) cannot be
revoked nor replaced by an expiring one: the route answers 400 `invalid-operation` with `data.id: last-owner`;
`bin/admin.js roles revoke --force` does it anyway, after which the platform is administered with the admin key and
a claim code.

## The admin key: `auth.adminAccessKeyScope`

- `full` (default, unchanged behaviour): the admin key authenticates every `/system` route.
- `break-glass`: the admin key reaches only the routes marked so in the route table (calls between cores, the setup
  code, claim codes, role listing and revocation, status routes); everything else needs an administrator session.
  A refused admin-key call answers 404.

The key cannot be retired (other secrets are derived from it); keep it for recovery.

## `bin/admin.js`

Runs on a core's shell and talks to the platform store directly, so it works while the API is down.

```
node bin/admin.js setup-code                  setup state and the pending code's times
node bin/admin.js setup-code --new            replace the setup code (printed once)
node bin/admin.js setup-code --hash [<code>]  a code and its SHA-256 for setup.codeHash (no store access)
node bin/admin.js claim-code [--role owner] [--scope platform] [--ttl 15m]
node bin/admin.js roles list
node bin/admin.js roles revoke <userId|username> [--role <r>] [--scope <s>] [--force]
node bin/admin.js sessions revoke <userId|username>
```

`--config <file>` layers a host-config file as for `bin/master.js`. A username is looked up on the core the tool
runs on; give the user id for an account of another core.

## Configuration

| Key | Category | Default | Meaning |
|---|---|---|---|
| `portal.site` | platform-wide | `null` | the hosted site that is the portal (the wizard writes `admin`) |
| `portal.cors.allowedOrigins` | platform-wide | `[]` | origins of a portal hosted outside the platform |
| `setup.codeTtlHours` | platform-wide | `24` | lifetime of a setup code |
| `setup.codeHash` | bootstrap | `null` | SHA-256 of a setup code chosen by the deployer |
| `setup.printCode` | per-core | `true` | print the setup code block at boot |
| `setup.registrationWhilePending` | platform-wide | `closed` | `closed` or `open` |
| `auth.adminAccessKeyScope` | platform-wide | `full` | `full` or `break-glass` |
| `admin.session.ttlMinutes` | platform-wide | `60` | administrator session lifetime |
| `admin.session.stepUpMinutes` | platform-wide | `5` | how recent the second factor must be for a sensitive act |
| `admin.session.requireMfa` | platform-wide | `true` | administrators need MFA whenever `services.mfa` is on |

`bin/check-config.js` and the boot check these keys (`portal.site` must name a configured hosted site).

## Audit

Each act (setup session, first administrator, finish, code replacement, session start, renewal, step-up and end,
claim code minted, role claimed or revoked) is recorded with the audit's "without a user" path (the kind of
subject, the administrator's id and a short session id; never a code or a token), and in the acting
administrator's own trail when the account is on the core. Reads are not audited. `bin/admin.js` acts are not
recorded in the audit (they are a shell act on the core).
