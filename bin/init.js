#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Interactive single-core install wizard.
//
// Usage:
//   docker run -it -v /host/pryv:/app/pryv \
//     pryvio/open-pryv.io init
//
// No argument. The wizard hardcodes `/app/pryv` as the in-container
// config directory and discovers the host path from
// /proc/self/mountinfo, so the generated `run-pryv.sh` carries the
// operator's REAL on-disk host path — no env-var override needed for
// the common case.
//
// `/app/pryv` is deliberate: mounting over /app/config would mask the
// image's bundled config plugins (systemStreams, paths-config, …) and
// master.js would die at boot with "Cannot find module
// '../config/plugins/…'". /app/pryv is the conventional, safe target.
//
// The wizard writes `pryv-config.yml` inside it, plus a sibling
// `run-pryv.sh` launcher. The user-data folder is auto-derived to
// `<host-dir>/data` — both ride a single host -v mount.
//
// Or locally during development (no docker):
//   PRYV_CONFIG_DIR=/tmp/test1 node bin/init.js
//
// Refuses to overwrite an existing pryv-config.yml.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

let yaml;
try {
  yaml = require('js-yaml');
} catch (err) {
  console.error('init: js-yaml is required but not installed.');
  console.error('Inside the docker image this should never happen — please file a bug.');
  process.exit(1);
}

// `readline.Interface#question` callback-style API misbehaves under piped
// stdin (callbacks after the first one never fire — observed on Node 22+).
// The async-iterator pattern is robust to both TTY and pipe inputs, so we
// drive prompts manually: write the prompt, await the next line.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lineIter = rl[Symbol.asyncIterator]();

async function ask (question, defaultValue) {
  const prompt = defaultValue !== undefined && defaultValue !== ''
    ? `${question} [${defaultValue}]: `
    : `${question}: `;
  process.stdout.write(prompt);
  const next = await lineIter.next();
  if (next.done) {
    // Stdin closed mid-wizard. Don't loop silently — surface a clean error
    // so piped tests with too-few answers fail fast instead of OOM-ing
    // inside an askNonEmpty retry loop. Most common cause in practice:
    // `docker run` invoked without `-it` (no TTY → stdin closes on the
    // first read). The startup TTY check covers that case, so by the
    // time this fires we are either in piped-input testing or stdin
    // was closed by something else mid-run.
    process.stdout.write('\n');
    throw new Error('init: input stream closed before all prompts were answered (EOF on stdin). If you piped answers in, you ran out of lines; if you launched with docker, ensure `-it` is set.');
  }
  const v = (next.value || '').trim();
  return v === '' && defaultValue !== undefined ? defaultValue : v;
}

async function askNonEmpty (question, defaultValue) {
  while (true) {
    const v = await ask(question, defaultValue);
    if (v !== '' && v != null) return v;
    console.log('  (required — please enter a value)');
  }
}

async function askYesNo (question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const raw = (await ask(`${question} [${hint}]`)).toLowerCase();
  if (raw === '') return defaultYes;
  return raw.startsWith('y');
}

async function askChoice (question, choices, defaultIdx = 0) {
  console.log(question);
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
  const raw = await ask(`Choice [1-${choices.length}]`, String(defaultIdx + 1));
  const idx = parseInt(raw, 10) - 1;
  return choices[Number.isFinite(idx) && idx >= 0 && idx < choices.length ? idx : defaultIdx];
}

function genSecret (bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64').replace(/=+$/, '');
}

/**
 * Best-effort detection of the host's public IPv4 via checkip.amazonaws.com.
 * Returns the trimmed string on success, null on timeout/error. Tight 2.5s
 * AbortSignal so a wizard run on a machine without public egress doesn't
 * hang — the operator can always type the IP in manually.
 */
async function detectPublicIp () {
  try {
    const res = await fetch('https://checkip.amazonaws.com/', {
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return null;
    const txt = (await res.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(txt)) return txt;
    return null;
  } catch (_) {
    return null;
  }
}

function dirWritable (dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// ── dns-active DNS-chain preflight helpers (best-effort, warnings only) ──
//
// We query a PUBLIC recursor (not the system resolver) so the checks reflect
// what Let's Encrypt's distributed validators will see, and shell nothing out
// to `dig` (not guaranteed present in the slim image) — Node's dns module is
// enough. Every probe is time-boxed so a wizard run never hangs on them.

function publicResolver () {
  const dns = require('dns');
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(['8.8.8.8', '1.1.1.1']);
  return resolver;
}

/**
 * NS hostnames the public recursor sees for <domain> (i.e. whether the parent
 * zone delegates it), or null on NXDOMAIN / no-delegation / timeout.
 */
async function lookupNs (domain) {
  try {
    const ns = await publicResolver().resolveNs(domain);
    return Array.isArray(ns) && ns.length ? ns : null;
  } catch (_) {
    return null;
  }
}

/** A records for <hostname> via the public recursor; [] on any failure. */
async function lookupA (hostname) {
  try {
    const a = await publicResolver().resolve4(hostname.replace(/\.$/, ''));
    return Array.isArray(a) ? a : [];
  } catch (_) {
    return [];
  }
}

/**
 * Send a minimal DNS SOA query over UDP/53 to <ip> and resolve true if ANY
 * datagram comes back within timeoutMs — the content is irrelevant, even a
 * SERVFAIL/REFUSED proves a listener is reachable at that address. Resolves
 * false on timeout or socket error.
 */
function probeUdp53 (ip, domain, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('message', () => finish(true));
    sock.on('error', () => finish(false));

    // Header (12 bytes): ID, flags=RD, QDCOUNT=1, rest 0. Question: QNAME +
    // QTYPE=SOA(6) + QCLASS=IN(1).
    const labels = domain.split('.').filter(Boolean);
    const qnameLen = labels.reduce((n, l) => n + 1 + Buffer.byteLength(l), 0) + 1;
    const buf = Buffer.alloc(12 + qnameLen + 4);
    buf.writeUInt16BE(0x1234, 0);
    buf.writeUInt16BE(0x0100, 2);
    buf.writeUInt16BE(1, 4);
    let off = 12;
    for (const l of labels) {
      buf.writeUInt8(Buffer.byteLength(l), off++);
      off += buf.write(l, off);
    }
    buf.writeUInt8(0, off++);
    buf.writeUInt16BE(6, off); off += 2;
    buf.writeUInt16BE(1, off);

    sock.send(buf, 53, ip, (err) => { if (err) finish(false); });
  });
}

function bar (n = 50) { return '─'.repeat(n); }

/**
 * Default `pryvio/open-pryv.io:<tag>` image string used in the generated
 * run-pryv.sh + check-config.sh launchers. The Dockerfile bakes
 * `PRYV_IMAGE_TAG` from a build arg (CI sets it to the git ref name on
 * tag pushes) so a wizard run from inside the container always emits a
 * default that matches the running image — operators don't get pinned
 * to a stale literal across RC bumps. Local `docker build .` without
 * `--build-arg IMAGE_TAG=...` falls back to `dev`.
 */
function defaultImageRef () {
  const tag = process.env.PRYV_IMAGE_TAG || 'dev';
  return 'pryvio/open-pryv.io:' + tag;
}

/**
 * Emit a YAML section: header banner + per-line doc-comments + yaml.dump
 * of the data subtree. The header banner is sized to a stable width so
 * the file scans well in a text editor.
 *
 * Generated output:
 *   ── Section title ─────────────────────────────────
 *   # one or more docstring lines
 *   key: value
 *   ...
 */
function section (yaml, title, doc, obj) {
  const HEADER_WIDTH = 60;
  const headerPad = Math.max(3, HEADER_WIDTH - title.length - 4);
  const header = '# ── ' + title + ' ' + '─'.repeat(headerPad);
  const docBlock = (Array.isArray(doc) ? doc : [doc]).map(l => '# ' + l).join('\n');
  const body = yaml.dump(obj, { lineWidth: 100, noRefs: true });
  return '\n' + header + '\n' + docBlock + '\n' + body;
}

/**
 * Returns a commented-out YAML appendix appended to every generated
 * pryv-config.yml. Surfaces the most-commonly-needed optional config
 * sections the wizard does NOT prompt for, so operators can uncomment
 * + tweak in place rather than hunting through default-config.yml.
 *
 * MAINTENANCE: keep in sync with `config/default-config.yml` and
 * `config/production-config.yml`. New top-level config sections that an
 * operator typically tunes (email, MFA, hostings, observability, custom
 * extensions, multi-core CLI paths, …) should land here as commented-out
 * blocks. Field-level changes to existing sections (added keys,
 * renamed keys, default-value flips) need a mirror edit here. Unit
 * coverage for the appendix is at `bin/test/init-appendix.test.js` (TODO
 * — currently exercised only by manual smoke tests).
 */
function buildOptionalAppendix ({ dnsLess, dataFolder }) {
  const HOSTINGS_BLOCK = dnsLess
    ? `# # hostings — single-core dnsLess deployments don't need this; the
# # auto-generated hostings hierarchy in /reg/hostings is sufficient.
# # For multi-core or multi-region setups, declare explicit hostings:
# # hostings:
# #   regions:
# #     europe:
# #       name: Europe
# #       zones:
# #         eu-west:
# #           name: Western Europe
# #           hostings:
# #             aws-eu-west-1:
# #               name: AWS Frankfurt
# #               url: ${dnsLess ? 'https://eu.example.com' : 'https://core.eu.example.com'}
# #               available: true`
    : `# # hostings — declares regions/zones surfaced via /reg/hostings so the SDK
# # picks the closest core per user. Auto-generated when unset; for multi-
# # region deployments, declare explicitly:
# # hostings:
# #   regions:
# #     america:
# #       name: America
# #       zones:
# #         usa-east:
# #           name: USA East
# #           hostings:
# #             aws-us-east-1:
# #               name: AWS Virginia
# #               url: https://core-use1.example.com
# #               available: true
# #     europe:
# #       name: Europe
# #       zones:
# #         eu-central:
# #           name: Germany Stuttgart
# #           hostings:
# #             aws-eu-central-1:
# #               name: AWS Frankfurt
# #               url: https://core-euc1.example.com
# #               available: true`;

  return `
# ─────────────────────────────────────────────────────────────────────
# Optional sections — wizard did NOT prompt for these. Uncomment + edit
# the blocks you want to enable. See config/default-config.yml in the
# image for the complete field surface + defaults.
# ─────────────────────────────────────────────────────────────────────

# # services.email — password-reset + welcome emails over in-process SMTP.
# # Skip the wizard's microservice path unless you run a separate service-mail
# # container. The 'in-process' method renders + sends from the api-server.
# services:
#   email:
#     enabled:
#       welcome: true
#       resetPassword: true
#     method: in-process
#     fromName: 'My Pryv'
#     fromEmail: 'no-reply@example.com'
#     smtp:
#       host: smtp.example.com
#       port: 587
#       secure: false
#       auth:
#         user: smtp-user
#         pass: smtp-password

# # services.mfa — SMS-based two-factor for app + personal accesses.
# # mode: disabled | single (combined challenge+verify) | challenge-verify (two endpoints).
# # services:
# #   mfa:
# #     mode: single
# #     sms:
# #       endpoints:
# #         single:
# #           url: https://sms-gateway.example.com/send
# #           method: POST
# #           headers: { Authorization: 'Bearer <api-token>' }
# #           bodyTemplate: '{"to": "{{phoneNumber}}", "text": "{{message}}"}'

${HOSTINGS_BLOCK}

# # custom.systemStreams — extend the account schema (e.g. add 'phone',
# # 'address', 'organization' alongside the built-in 'username' / 'email').
# # custom:
# #   systemStreams:
# #     account:
# #       - id: phone
# #         type: phone/number
# #         isIndexed: true
# #         isUnique: true
# #         isShown: true
# #         isEditable: true
# #       - id: organization
# #         type: string/string
# #         isIndexed: false
# #         isShown: true
# #         isEditable: true

# # observability — opt-in APM (New Relic today; framework supports more).
# # The license key is stored encrypted in PlatformDB via bin/observability.js;
# # set 'enabled: true' here to flip the feature on without re-deploying.
# # observability:
# #   enabled: false
# #   provider: newrelic
# #   appName: 'open-pryv.io'
# #   logLevel: error
# #   newrelic:
# #     licenseKey: ''   # leave blank; set via 'bin/observability.js newrelic set-license-key'

# # eventFiles — attachments + previews size limits.
# # eventFiles:
# #   attachmentSizeMaxKB: 10240   # 10 MiB per attachment
# #   previewsCacheMaxAgeMs: 86400000

# # webhooks — global delivery tuning. Default cooldownMs is generous.
# # webhooks:
# #   cooldownMs: 5000
# #   maxRetries: 5

# # cluster.discoveryEnabled — set true on multi-core deployments using
# # DNS-based rqlite joiners (-disco-mode dns). Leave OFF on single-core.
# # cluster:
# #   discoveryEnabled: false

# # core.url — pin this core's externally-reachable URL when 'dns.active'
# # is false but you still want a stable identity (DNSless multi-core).
# # core:
# #   id: core-use1
# #   url: https://core-use1.example.com
`;
}

// Fixed in-container filename. The wizard ALWAYS writes
// `<configDir>/pryv-config.yml`; operators don't pick the name. This keeps
// the generated `run-pryv.sh` self-locating + the docker mount semantics
// trivially predictable.
const CONFIG_FILENAME = 'pryv-config.yml';
// Fixed in-container target the operator MUST mount to. Hardcoded so the
// wizard takes no argument: `docker run -v /host/dir:/app/pryv pryvio init`.
// /app/pryv avoids the /app/config collision (which would mask the image's
// bundled config plugins and crash master.js at boot).
const CONTAINER_CONFIG_DIR = '/app/pryv';

/**
 * Discover the host-side path bind-mounted at the given in-container
 * path by parsing /proc/self/mountinfo. Returns null when no matching
 * mount is found (e.g. running locally without docker, or the mount
 * target doesn't exist).
 *
 * mountinfo per-line format (kernel ABI):
 *   mountID parentID major:minor ROOT MOUNT_POINT mount_opts - fs source super_opts
 * For bind mounts of a regular host directory, ROOT carries the host
 * absolute path on the underlying device (modulo any sub-volume
 * rewriting on btrfs/zfs, which we don't try to invert).
 */
function discoverHostPath (containerPath) {
  let mi;
  try {
    mi = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch (_) {
    return null;
  }
  // Walk in reverse so the most recent (= operator-supplied) mount wins
  // over earlier overlay/system mounts at the same point.
  const lines = mi.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    const parts = line.split(' ');
    // ROOT is field 4 (1-indexed). MOUNT_POINT is field 5.
    const root = parts[3];
    const mountPoint = parts[4];
    if (mountPoint === containerPath) {
      // Unescape kernel-encoded space/tab/newline/backslash in the path.
      return root.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    }
  }
  return null;
}

async function main () {
  // Local-dev escape hatch: skip /app/pryv when PRYV_CONFIG_DIR is set so
  // contributors can run the wizard outside docker without juggling mounts.
  // Inside the image the env var is never set; operators get the
  // hardcoded path + auto-discovery flow.
  const localDevDir = process.env.PRYV_CONFIG_DIR;
  const absConfigDir = localDevDir ? path.resolve(localDevDir) : CONTAINER_CONFIG_DIR;
  const hostConfigDir = localDevDir ? absConfigDir : discoverHostPath(CONTAINER_CONFIG_DIR);

  // Refuse to run without an interactive TTY. Without `-it` on docker run,
  // stdin is closed and the very first prompt EOFs — surface that here
  // with the actual fix (`docker run -it …`) rather than a stack trace.
  if (!process.stdin.isTTY) {
    console.error('init: no interactive TTY attached to stdin.');
    console.error('  The wizard needs to prompt you — re-run docker with `-it`:');
    console.error('');
    console.error('    docker run -it --rm \\');
    console.error(`      -v /host/path:${CONTAINER_CONFIG_DIR} \\`);
    console.error('      pryvio/open-pryv.io init');
    console.error('');
    console.error('  (Substitute /host/path with the host directory where you want');
    console.error(`   ${CONFIG_FILENAME} + run-pryv.sh to land.)`);
    process.exit(2);
  }

  if (!fs.existsSync(absConfigDir)) {
    console.error(`init: ${absConfigDir} does not exist inside the container.`);
    console.error(`  Mount a writable host directory at ${absConfigDir}:`);
    console.error('');
    console.error('    docker run -it --rm \\');
    console.error(`      -v /host/path:${CONTAINER_CONFIG_DIR} \\`);
    console.error('      pryvio/open-pryv.io init');
    process.exit(2);
  }
  if (!dirWritable(absConfigDir)) {
    console.error(`init: ${absConfigDir} exists but is NOT writable.`);
    console.error('  Most likely the host directory you mounted is not writable by the');
    console.error('  container user. On the host:');
    console.error('');
    console.error('      sudo chown -R $(id -u):$(id -g) /host/path');
    console.error('      chmod 755 /host/path');
    process.exit(2);
  }
  // hostConfigDir is informational. The generated run-pryv.sh always
  // self-locates via `cd "$(dirname "$0")" && pwd`, so even if we can't
  // discover the host path here (unusual filesystem, non-docker run, etc.)
  // the launcher still works — operators just run it from its own dir.
  const absConfigPath = path.join(absConfigDir, CONFIG_FILENAME);
  if (fs.existsSync(absConfigPath)) {
    console.error(`init: ${absConfigPath} already exists.`);
    if (hostConfigDir) console.error(`  On the host: ${hostConfigDir}/${CONFIG_FILENAME}`);
    console.error('  Move it aside or pick a different mount. (init never overwrites.)');
    process.exit(1);
  }

  // Data folder lives under the same operator-mounted tree, sibling to
  // the config file. Container-side: `<configDir>/data`. The run-pryv.sh
  // launcher mounts the host's `<host-config-dir>/data` to the same
  // in-container path, so config + data ride a single -v host mount and
  // every TLS / rqlite / sqlite / attachment path the operator sees in
  // the YAML is also a real on-disk host path.
  const dataFolder = path.join(absConfigDir, 'data');
  const hostDataFolder = hostConfigDir ? path.join(hostConfigDir, 'data') : null;

  console.log();
  console.log('open-pryv.io configuration wizard');
  console.log(bar());
  console.log('Producing a single-core install:');
  if (hostConfigDir) {
    console.log(`  host:      ${hostConfigDir}/${CONFIG_FILENAME}  ← config`);
    console.log(`             ${hostDataFolder}/  ← user data (auto)`);
    console.log(`  container: ${absConfigPath}`);
    console.log(`             ${dataFolder}/`);
  } else {
    console.log(`  container: ${absConfigPath}  ← config`);
    console.log(`             ${dataFolder}/  ← user data (auto)`);
  }
  console.log();

  // 1. dnsLess mode — default OFF (matches canonical Pryv URL shape +
  // multi-core deployments). dnsLess ON is the lighter single-host mode.
  console.log('▸ DNS topology');
  console.log('  dnsLess OFF → each user gets a subdomain: https://alice.example.com/events');
  console.log('                (canonical Pryv shape; needs embedded DNS + delegated zone +');
  console.log('                 port 53/udp on the host + LE wildcard cert via DNS-01)');
  console.log('  dnsLess ON  → users share one FQDN: https://example.com/<username>/events');
  console.log('                (simpler single-host setup; no DNS server, HTTP-01 LE works)');
  const dnsLess = await askYesNo('Enable dnsLess mode?', false);
  console.log();

  // 2. Hostname / domain
  let publicUrl;
  let dnsDomain;
  let dnsPublicIp;
  if (dnsLess) {
    publicUrl = await askNonEmpty('Public URL (e.g. https://pryv.example.com)');
    if (!/^https?:\/\//.test(publicUrl)) {
      console.log('  (prepending https://)');
      publicUrl = 'https://' + publicUrl;
    }
    publicUrl = publicUrl.replace(/\/+$/, '');
  } else {
    dnsDomain = await askNonEmpty('Root domain to serve (e.g. example.com — will serve *.example.com)');
    publicUrl = `https://core.${dnsDomain}`;

    // Public IPv4 address — fed into `dns.publicIp` so master.js can seed
    // the apex SOA/NS records + the `core.<domain>` A record on first boot.
    // Without this, the embedded DNS server has no authoritative answer
    // for the zone and ACME DNS-01 errors with
    // "No TXT records found for name: _acme-challenge.<domain>" before
    // the LE round-trip starts. Auto-detect via checkip.amazonaws.com
    // with a tight timeout so wizard runs on machines without public
    // egress don't hang.
    const detectedIp = await detectPublicIp();
    if (detectedIp) {
      console.log(`  (detected public IPv4: ${detectedIp})`);
    } else {
      console.log('  (public IPv4 auto-detect failed — please enter manually)');
    }
    dnsPublicIp = await askNonEmpty(
      'Public IPv4 address of this host (NS delegation for ' + dnsDomain + ' should resolve here)',
      detectedIp || undefined
    );
  }
  console.log();

  // 3. DB engine — SQLite default: lighter footprint, no extra service to
  // run, cleaner GDPR Art.17 erasure semantics (per-user file unlink).
  // PostgreSQL is the choice when you want a single DB to back up + one
  // schema to manage across many users.
  console.log('▸ User-data storage engine');
  console.log('  sqlite     → one file per user; no extra service; cleaner GDPR Art.17 erasure');
  console.log('  postgresql → shared tables keyed by user_id; one DB to back up + administer');
  const dbEngine = await askChoice('Choose:', ['sqlite', 'postgresql'], 0);
  console.log();

  let pgConfig = null;
  if (dbEngine === 'postgresql') {
    console.log('▸ PostgreSQL connection');
    pgConfig = {
      host: await ask('  Host', 'localhost'),
      port: parseInt(await ask('  Port', '5432'), 10),
      database: await ask('  Database name', 'pryv_db'),
      user: await ask('  User', 'pryv'),
      password: await askNonEmpty('  Password'),
      max: 20
    };
    console.log();
  }

  // 4. Service name
  console.log('▸ Service identity');
  const serviceName = await askNonEmpty('  Service display name', 'My Pryv Instance');
  console.log();

  // (data folder is no longer prompted — derived above as sibling to the
  // config file. Both ride a single -v mount in run-pryv.sh.)

  // 6. Secrets
  console.log('▸ Secrets');
  const genSecrets = await askYesNo('Generate random secrets automatically?', true);
  let adminAccessKey;
  let filesReadTokenSecret;
  if (genSecrets) {
    adminAccessKey = genSecret(32);
    filesReadTokenSecret = genSecret(32);
  } else {
    adminAccessKey = await askNonEmpty('  auth.adminAccessKey (32+ chars)');
    filesReadTokenSecret = await askNonEmpty('  auth.filesReadTokenSecret (32+ chars)');
  }
  console.log();

  // 7. app-web-auth3 deployment URL.
  //
  // open-pryv.io does NOT embed the auth UI. `app-web-auth3` is a separate
  // Vue.js bundle (forked/rebranded per platform) that hosts the access /
  // sign-in / reset-password popup pages. The public Pryv-hosted build at
  // sw.pryv.me works out of the box; operators can fork + self-host.
  //
  // The reset-password page URL is derived from this base
  // (auth.passwordResetPageURL = `${authUiUrl}/reset-password.html`), so
  // there is no separate prompt for it.
  console.log('▸ app-web-auth3 (auth UI) deployment');
  console.log('  open-pryv.io does not embed the auth UI — it is a separate Vue.js bundle');
  console.log('  (popup pages for /access flow, password-reset, etc.). The default below is');
  console.log('  the canonical Pryv-hosted public build; fork app-web-auth3 to rebrand.');
  console.log('  Sets `access.defaultAuthUrl` (auth URL emitted by /reg/access) +');
  console.log('  `auth.passwordResetPageURL` + adds the host to `auth.trustedApps`.');
  const authUiUrl = (await ask('  app-web-auth3 base URL', 'https://pryv.github.io/app-web-auth3/access')).replace(/\/+$/, '');
  console.log();

  // 8. TLS strategy
  console.log('▸ TLS strategy');
  console.log('  letsEncrypt → master serves HTTPS via embedded ACME (auto-renew, DNS-01 default)');
  console.log('  custom      → bring your own cert files (mount them into the container)');
  console.log('  none        → plain HTTP on :3000 (auth flows expect HTTPS — testing only)');
  const tlsStrategy = await askChoice('Choose:', ['letsEncrypt', 'custom', 'none'], 0);
  console.log();

  let leConfig = null;
  let customSsl = null;
  if (tlsStrategy === 'letsEncrypt') {
    console.log('▸ Let\'s Encrypt');
    leConfig = {
      enabled: true,
      email: await askNonEmpty('  Contact email (for ACME registration)'),
      atRestKey: genSecrets ? genSecret(32) : await askNonEmpty('  letsEncrypt.atRestKey (32 bytes b64 — encrypts cert at rest)'),
      certRenewer: true,
      staging: await askYesNo('  Use STAGING (recommended for first boot — avoids prod rate limits)?', true)
    };
    console.log();
  } else if (tlsStrategy === 'custom') {
    console.log('▸ Custom TLS cert');
    customSsl = {
      keyFile: await ask('  Path to TLS key file (inside container)', `${absConfigDir}/tls/key.pem`),
      certFile: await ask('  Path to TLS cert file (inside container)', `${absConfigDir}/tls/cert.pem`)
    };
    console.log();
  }

  // 9-13. Defaulted fields with confirmation
  console.log('▸ Defaulted fields (press enter to accept)');

  // passwordResetPageURL: derived from authUiUrl (the auth UI hosts the page).
  const defaultPasswordResetPageURL = `${authUiUrl}/reset-password.html`;
  const passwordResetPageURL = await ask('  auth.passwordResetPageURL (derived from auth UI)', defaultPasswordResetPageURL);

  // trustedApps: must whitelist BOTH the operator's own publicUrl AND the
  // auth UI origin (otherwise the /reg/access flow loaded from sw.pryv.me
  // — or whichever app-web-auth3 host is configured — returns 403 because
  // its origin isn't trusted). Compose `*@<origin>*` entries deduplicated.
  function originOf (u) {
    try { return new URL(u).origin; } catch (_) { return u; }
  }
  const trustedOrigins = new Set();
  trustedOrigins.add(originOf(publicUrl));
  trustedOrigins.add(originOf(authUiUrl));
  const defaultTrustedApps = [...trustedOrigins].map(o => `*@${o}*`).join(', ');
  const trustedApps = await ask('  auth.trustedApps (auth UI + publicUrl wildcard)', defaultTrustedApps);

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const serviceSerial = await ask('  service.serial (build tag)', today);
  const serviceHome = await ask('  service.home URL', publicUrl);
  const serviceSupport = await ask('  service.support URL', publicUrl);
  const serviceTerms = await ask('  service.terms URL', publicUrl);
  const serviceEventTypes = await ask('  service.eventTypes URL', 'https://pryv.github.io/event-types/flat.json');
  console.log();

  // 13. HFS workers
  console.log('▸ High-frequency series (HFS)');
  console.log('  Disable if you don\'t use series:* event types — saves ~250MB RAM per box.');
  const hfsEnabled = await askYesNo('Enable HFS (1 worker on :4000)?', true);
  const hfsWorkers = hfsEnabled ? 1 : 0;
  console.log();

  // 14. Email service
  console.log('▸ Email service');
  console.log('  Required for password-reset + welcome emails. Skip now → configure later.');
  const emailEnabled = await askYesNo('Configure email service now?', false);
  let emailConfig = null;
  if (emailEnabled) {
    emailConfig = {
      enabled: { resetPassword: true, welcome: true },
      method: 'microservice',
      url: await ask('  service-mail URL', 'http://service-mail:9000/sendmail/'),
      key: await askNonEmpty('  Shared secret with service-mail')
    };
    console.log();
  }

  // ── VALIDATION ────────────────────────────────────────────────
  console.log();
  console.log('Validating host environment');
  console.log(bar());

  const problems = [];
  const warnings = [];

  const configDir = path.dirname(absConfigPath);
  if (dirWritable(configDir)) {
    console.log(`  ✓ Config directory writable: ${configDir}`);
  } else {
    problems.push(`Config directory not writable: ${configDir}`);
  }

  if (fs.existsSync(dataFolder)) {
    if (dirWritable(dataFolder)) {
      console.log(`  ✓ Data folder writable: ${dataFolder}`);
    } else {
      problems.push(`Data folder exists but not writable: ${dataFolder}`);
    }
  } else {
    warnings.push(`Data folder does not exist yet: ${dataFolder} — create it (or mount it) before starting master.js`);
  }

  if (pgConfig && (!pgConfig.host || !pgConfig.user || !pgConfig.database || !pgConfig.password)) {
    problems.push('PostgreSQL credentials incomplete');
  }

  if (!publicUrl.startsWith('http')) {
    problems.push(`Public URL does not start with http: ${publicUrl}`);
  }

  if (tlsStrategy === 'none') {
    warnings.push('TLS disabled — auth flows expect HTTPS. Use this only for internal LAN / load-balancer-terminated deployments.');
  }
  if (!dnsLess) {
    warnings.push('dns-active mode requires port 53/udp published + (for non-docker hosts) `setcap cap_net_bind_service=+ep $(which node)`.');

    // ── Phase C: dns-active DNS-chain preflight (best-effort, never blocks) ──
    // Catches the three most common reasons LE DNS-01 issuance fails on first
    // boot: (1) parent zone never delegated the domain, (2) the delegation
    // points at an IP other than this host, (3) UDP/53 isn't reachable. All
    // results are warnings/notes only — the wizard always continues.
    console.log();
    console.log('  Checking dns-active DNS chain (best-effort, a few seconds)…');

    const nsHosts = await lookupNs(dnsDomain);
    if (!nsHosts) {
      warnings.push(`No NS delegation found for ${dnsDomain} via a public recursor. The parent zone ` +
        `must delegate ${dnsDomain} to a nameserver that resolves to ${dnsPublicIp} before Let's Encrypt ` +
        'DNS-01 issuance can succeed. (If you just set the delegation up, this may be propagation lag.)');
    } else {
      console.log(`    ✓ NS delegation for ${dnsDomain}: ${nsHosts.join(', ')}`);
      const nsIps = new Set();
      for (const h of nsHosts) (await lookupA(h)).forEach(ip => nsIps.add(ip));
      if (nsIps.size && !nsIps.has(dnsPublicIp)) {
        warnings.push(`NS delegation for ${dnsDomain} resolves to ${[...nsIps].join(', ')}, but you declared ` +
          `the public IP as ${dnsPublicIp} — ACME challenge lookups will reach the wrong server.`);
      } else if (nsIps.has(dnsPublicIp)) {
        console.log(`    ✓ NS delegation resolves to the declared public IP (${dnsPublicIp})`);
      }
    }

    // UDP/53 reachability is informational, not a warning: at init time
    // master.js isn't running yet, so "no answer" is the expected/normal
    // case pre-boot. An answer here means a DNS listener is already bound at
    // that address (your embedded server on a re-run, or — worth knowing — a
    // host systemd-resolved that would conflict with the container's :53).
    if (await probeUdp53(dnsPublicIp, dnsDomain)) {
      console.log(`    ✓ A DNS listener already answers on ${dnsPublicIp}:53/udp.`);
      console.log('      If that is the host\'s systemd-resolved, free :53 so the container can bind it.');
    } else {
      console.log(`    ℹ No answer yet on ${dnsPublicIp}:53/udp (normal before first boot). After starting`);
      console.log(`      master.js, verify externally:  dig @${dnsPublicIp} SOA ${dnsDomain}`);
      console.log('      If still silent, check the host firewall / AWS Security Group (53/udp) +');
      console.log('      the docker `-p 53:53/udp` mapping.');
    }
  }
  if (leConfig && leConfig.staging) {
    warnings.push('letsEncrypt.staging is ON — issued certs will NOT be trusted by browsers. Flip to false for production.');
  }

  console.log();
  if (warnings.length) {
    console.log(`  ⚠ ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`    - ${w}`));
  }
  if (problems.length) {
    console.log(`  ✗ ${problems.length} problem(s):`);
    problems.forEach(p => console.log(`    - ${p}`));
  }
  if (warnings.length === 0 && problems.length === 0) {
    console.log('  All checks passed.');
  }

  // Host pre-flight notes for dns-active mode. The wizard runs inside the
  // container so it can't truly probe the host, but for dnsLess=false the
  // operator MUST free UDP/53 on the host before `-p 53:53/udp` can bind.
  // Ubuntu 24+ / Fedora / most modern Linux distros ship systemd-resolved
  // listening on 127.0.0.53:53 by default — it doesn't conflict with
  // Docker's 0.0.0.0:53 directly but breaks recursive resolution on the
  // host once Docker takes 53. Same fix on every modern distro.
  if (!dnsLess) {
    console.log();
    console.log('  ── Host pre-flight (Linux) ────────────────────────────');
    console.log('  dns-active mode publishes UDP/53 to the host. Modern Linux distros');
    console.log('  (Ubuntu 24/26, Fedora 40+, recent Debian) ship systemd-resolved');
    console.log('  listening on 127.0.0.53:53. Before `docker run … -p 53:53/udp`, disable');
    console.log('  the stub resolver and point /etc/resolv.conf at a public resolver:');
    console.log();
    console.log('      sudo systemctl disable --now systemd-resolved');
    console.log('      sudo rm /etc/resolv.conf');
    console.log('      echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf');
    console.log();
    console.log('  Verify nothing else binds UDP/53 on the host:');
    console.log('      sudo ss -ulnp | grep \':53 \'   # expect: no rows after the disable above');
    console.log();
  }

  // We surface problems but never refuse to write. An operator who hand-
  // edits the generated YAML afterwards can re-validate it with
  // `check-config <path>` — that's exactly what that subcommand is for.
  // Refusing the write would force the operator to restart the wizard
  // from scratch just to fix a typo in a single field.
  if (problems.length > 0) {
    console.log();
    console.log('Config will be written despite the problems above — edit the YAML to fix');
    console.log('them, then re-validate with `check-config`:');
    console.log(`    docker run --rm -v ${configDir}:${configDir} \\`);
    console.log(`      pryvio/open-pryv.io check-config ${absConfigPath}`);
  }

  // No "write the config?" prompt — that's the wizard's whole purpose.
  // Problems above are surfaced; operator can hand-edit afterwards or
  // re-run with the config moved aside.

  // ── BUILD YAML ────────────────────────────────────────────────
  const config = {
    auth: {
      adminAccessKey,
      filesReadTokenSecret,
      passwordResetPageURL,
      trustedApps
    },
    access: {
      // The full auth-UI landing URL (open-pryv.io appends ?key=…&poll=… etc.)
      // The reset-password page is a sibling file under the same base.
      defaultAuthUrl: `${authUiUrl}/access.html`
    },
    cluster: {
      apiWorkers: 2,
      hfsWorkers,
      previewsWorker: true
    },
    http: {
      ip: '0.0.0.0',
      // When TLS is on, workers bind HTTPS on this port. With LE / custom
      // certs the public API + HFS + previews all route through the same
      // TLS port (in-process dispatchers per INSTALL.md Option C). With
      // tls=none we stay on the legacy :3000 plain-HTTP convention.
      port: tlsStrategy === 'none' ? 3000 : 443
    },
    service: {
      name: serviceName,
      serial: serviceSerial,
      eventTypes: serviceEventTypes,
      home: serviceHome,
      support: serviceSupport,
      terms: serviceTerms
    },
    storages: {
      base: { engine: dbEngine },
      platform: { engine: 'rqlite' },
      file: { engine: 'filesystem' },
      series: { engine: dbEngine === 'postgresql' ? 'postgresql' : 'sqlite' },
      audit: { engine: 'sqlite' },
      engines: {
        ...(pgConfig ? { postgresql: pgConfig } : {}),
        filesystem: {
          attachmentsDirPath: `${dataFolder}/users`,
          previewsDirPath: `${dataFolder}/previews`
        },
        sqlite: { path: `${dataFolder}/users` },
        rqlite: {
          url: 'http://localhost:4001',
          raftPort: 4002,
          dataDir: `${dataFolder}/rqlite-data`
        }
      }
    }
  };

  if (dnsLess) {
    config.dnsLess = { isActive: true, publicUrl };
  } else {
    // `publicIp` feeds master.js's first-boot bootstrap of the apex
    // SOA + NS records + the A record for `core.<domain>` — without it
    // the embedded DNS server can't answer authoritatively for the zone
    // and DNS-01 issuance fails before contacting Let's Encrypt.
    config.dns = { active: true, domain: dnsDomain, port: 53, publicIp: dnsPublicIp };
  }

  if (tlsStrategy === 'letsEncrypt') {
    // master.js's selfSignedPlaceholder + ACME orchestrator both need
    // `http.ssl.keyFile` + `http.ssl.certFile` set so they know where to
    // write the first-boot placeholder cert + where ACME materialises the
    // real cert later (workers read these paths at boot). Without this,
    // master.js silently skips placeholder generation, workers never bind
    // :443, ACME's HTTP-01 server never starts, and the public URL stays
    // dark. Default to under the data folder so it persists across container
    // restarts.
    config.http.ssl = {
      keyFile: `${dataFolder}/tls/key.pem`,
      certFile: `${dataFolder}/tls/cert.pem`
    };
    // Pin tlsDir to a path on the same operator-mounted volume as
    // http.ssl.{keyFile,certFile}. The FileMaterializer writes the real
    // LE cert to `<tlsDir>/<hostnameDir>/{fullchain,privkey}.pem`; on
    // the next container restart, selfSignedPlaceholder.ensure() reads
    // those files and copies them over http.ssl.{certFile,keyFile} so
    // workers fork up serving the real LE cert immediately (no
    // self-signed placeholder window between restart and rotation IPC).
    // Without this override the materializer defaults to relative
    // `var-pryv/tls` which resolves inside container-ephemeral storage.
    config.letsEncrypt = {
      ...leConfig,
      tlsDir: `${dataFolder}/tls`
    };
  } else if (tlsStrategy === 'custom') {
    config.http.ssl = customSsl;
  }

  if (emailConfig) {
    config.services = { email: emailConfig };
  }

  fs.mkdirSync(configDir, { recursive: true });
  // Emit YAML in logical sections with header dividers + per-section
  // docstrings instead of a flat alphabetised dump. The order below is
  // tuned for a top-down read: identity → topology → network/TLS →
  // secrets → auth-UI integration → cluster → storage → (optional
  // services). The same `config` object also serves as the structural
  // truth for `check-config`; we're only reshaping the serialisation.
  let yamlBody = '# Pryv.io configuration — generated by `pryvio/open-pryv.io init`\n';
  yamlBody += '# ' + new Date().toISOString().slice(0, 10) + '\n';
  yamlBody += '#\n# Edit freely. Re-validate any time with `./check-config.sh`.\n';

  yamlBody += section(yaml, 'Service identity',
    'What the SDK + /reg/service/info expose to clients.',
    { service: config.service });

  if (config.dnsLess) {
    yamlBody += section(yaml, 'DNS topology — dnsLess (single FQDN)',
      ['All users share one host: https://<publicUrl>/<username>/<path>.',
        'HTTP-01 LE challenge works on this single host (no DNS server needed).'],
      { dnsLess: config.dnsLess });
  } else {
    yamlBody += section(yaml, 'DNS topology — dns.active (subdomain per user)',
      ['Each user gets a subdomain: https://<user>.<domain>/events.',
        'Requires embedded DNS server + delegated zone + port 53/udp on the host',
        'and DNS-01 (wildcard) LE challenge.',
        'publicIp seeds the apex SOA + NS records + A core.<domain> on first boot.',
        'Operator-edited records under dns.records.root or via bin/dns-records.js win;',
        'the bootstrap only fills what is empty.'],
      { dns: config.dns });
  }

  const httpDoc = ['Workers bind on `port`.'];
  if (config.http.ssl) {
    httpDoc.push('http.ssl.{keyFile,certFile} are populated at first boot by master.js',
      '(selfSignedPlaceholder seeds them; ACME rotates them on issuance).');
  }
  yamlBody += section(yaml, 'HTTP + TLS', httpDoc, { http: config.http });

  if (config.letsEncrypt) {
    yamlBody += section(yaml, "Let's Encrypt",
      ['Embedded ACME client. tlsDir lives on the operator-mounted volume so',
        'materialised certs survive container restarts.',
        '`staging: true` issues from the LE staging CA (untrusted by browsers) — flip to false for production.'],
      { letsEncrypt: config.letsEncrypt });
  }

  yamlBody += section(yaml, 'Auth secrets + trusted apps',
    ['adminAccessKey + filesReadTokenSecret MUST be backed up — losing them locks',
      'you out of audit + cert decryption. trustedApps controls which origins',
      'can use /reg/access (the app-web-auth3 popup-frame flow).'],
    { auth: config.auth });

  yamlBody += section(yaml, 'app-web-auth3 integration',
    ['URL of the Vue.js popup-frame that hosts /access + password-reset pages.',
      'Defaults to the canonical Pryv-hosted public build; fork to rebrand.'],
    { access: config.access });

  yamlBody += section(yaml, 'Cluster sizing',
    ['apiWorkers + hfsWorkers + previewsWorker each fork a worker process.',
      'Tune for your CPU count; defaults are conservative.'],
    { cluster: config.cluster });

  yamlBody += section(yaml, 'Storage engines',
    ['Per-area engine selection + per-engine connection params.',
      'Wizard picked: base + series = ' + dbEngine + '; platform = rqlite; audit = sqlite.'],
    { storages: config.storages });

  if (config.services) {
    yamlBody += section(yaml, 'External services',
      'Email / MFA gateway configuration. Wizard wrote the bits you opted into.',
      { services: config.services });
  }

  const appendix = buildOptionalAppendix({ dnsLess, dataFolder });
  fs.writeFileSync(absConfigPath, yamlBody + appendix);

  console.log();
  console.log(`✓ Wrote ${absConfigPath}`);

  // ── OPTIONAL: run-pryv.sh launcher sibling to the config ──────
  // The launcher self-locates from $0 so operators can run it from
  // anywhere. CONFIG_DIR is the script's own dir; DATA_DIR defaults
  // to a sibling `data` dir but is overridable via $PRYV_DATA_DIR.
  // Image tag is overridable via $PRYV_IMAGE.
  // Public-port surface: clients only hit the api port (HFS + previews are
  // dispatched in-process per INSTALL.md Option C). Publish 80 only when
  // ACME needs HTTP-01. Publish 53/udp only when the embedded DNS is on.
  const dockerPorts = [];
  if (tlsStrategy === 'letsEncrypt' || tlsStrategy === 'custom') {
    dockerPorts.push('-p 443:443');
    if (tlsStrategy === 'letsEncrypt') dockerPorts.push('-p 80:80');
  } else {
    dockerPorts.push('-p 3000:3000');
  }
  if (!dnsLess) dockerPorts.push('-p 53:53/udp');

  const configFileName = path.basename(absConfigPath);
  const runScriptPath = path.join(configDir, 'run-pryv.sh');
  let wroteRunScript = false;

  console.log();
  let shouldWriteRunScript = true;
  if (fs.existsSync(runScriptPath)) {
    // run-pryv.sh exists — only ASK in this case; default no so the
    // operator can keep their customised launcher. The fresh-install
    // path (no existing launcher) is unconditional.
    shouldWriteRunScript = await askYesNo(`${runScriptPath} already exists — overwrite it?`, false);
    if (!shouldWriteRunScript) {
      console.log(`  ✓ Kept existing ${runScriptPath}`);
    }
  }
  if (shouldWriteRunScript) {
    // The image bundles its own config tree at /app/config/ (including
    // config/plugins/systemStreams etc.) so mounting the operator's
    // config dir to /app/config would mask it and master.js dies with
    // "Cannot find module '../config/plugins/systemStreams'". Mount to
    // the in-container path the operator picked at init time instead;
    // master.js's `--config` is absolute so anywhere outside /app/config
    // is fine.
    const containerConfigDir = configDir; // === absConfigDir
    const containerDataDir = dataFolder; // === absConfigDir + '/data'
    const runScript = [
      '#!/bin/sh',
      '# Auto-generated by `pryvio/open-pryv.io init`.',
      '# Lives sibling to override-config.yml. Run it from anywhere.',
      '#',
      '# Overrides:',
      `#   PRYV_DATA_DIR  host path mounted at ${dataFolder} (default: $CONFIG_DIR/data — sibling to ${configFileName})`,
      `#   PRYV_IMAGE     docker image tag (default: ${defaultImageRef()})`,
      '#   PRYV_NAME      container name (default: pryvio)',
      'set -e',
      '',
      'CONFIG_DIR="$(cd "$(dirname "$0")" && pwd)"',
      `CONFIG_FILE="$CONFIG_DIR/${configFileName}"`,
      // eslint-disable-next-line no-template-curly-in-string -- shell-variable expansions in the emitted script body
      'DATA_DIR="${PRYV_DATA_DIR:-$CONFIG_DIR/data}"',
      `IMAGE="\${PRYV_IMAGE:-${defaultImageRef()}}"`,
      // eslint-disable-next-line no-template-curly-in-string
      'NAME="${PRYV_NAME:-pryvio}"',
      '',
      'mkdir -p "$DATA_DIR"',
      '',
      '# Remove any prior container with the same name so the script is',
      '# idempotent. The data lives in the mounted $DATA_DIR; the container',
      '# is just a process wrapper, safe to drop and re-create.',
      // eslint-disable-next-line no-template-curly-in-string -- `${NAME}` is a shell expansion in the emitted script
      'if docker ps -a --format "{{.Names}}" | grep -q "^${NAME}$"; then',
      '  echo "Removing existing container $NAME …"',
      '  docker rm -f "$NAME" >/dev/null',
      'fi',
      '',
      'exec docker run -d --name "$NAME" \\',
      `  -v "$CONFIG_DIR":${containerConfigDir} \\`,
      // Data dir is always mounted at the in-container path the YAML
      // refers to (sibling to the config). In the default case
      // ($DATA_DIR == $CONFIG_DIR/data) this overlaps the config mount;
      // Docker handles the nested mount fine. In the override case
      // (PRYV_DATA_DIR=/some/other/host/path) the in-container view
      // still resolves to the YAML's data paths.
      `  -v "$DATA_DIR":${containerDataDir} \\`,
      `  ${dockerPorts.join(' ')} \\`,
      '  "$IMAGE" \\',
      `  node bin/master.js --config ${absConfigPath}`,
      ''
    ].join('\n');
    fs.writeFileSync(runScriptPath, runScript, { mode: 0o755 });
    wroteRunScript = true;
    console.log(`✓ Wrote ${runScriptPath}`);
  }

  // ── check-config.sh launcher ─────────────────────────────────
  // Same overwrite policy as run-pryv.sh: unconditional create on a
  // fresh install, asks before overwriting an existing one.
  const checkScriptPath = path.join(configDir, 'check-config.sh');
  let wroteCheckScript = false;
  let shouldWriteCheckScript = true;
  if (fs.existsSync(checkScriptPath)) {
    shouldWriteCheckScript = await askYesNo(`${checkScriptPath} already exists — overwrite it?`, false);
    if (!shouldWriteCheckScript) {
      console.log(`  ✓ Kept existing ${checkScriptPath}`);
    }
  }
  if (shouldWriteCheckScript) {
    const checkScript = [
      '#!/bin/sh',
      '# Auto-generated by `pryvio/open-pryv.io init`.',
      '# Validates the sibling pryv-config.yml without booting the server.',
      '# Exit 0 = required-at-boot checks passed. Exit 1 = at least one',
      '# problem (printed).',
      '#',
      '# Overrides:',

      `#   PRYV_IMAGE     docker image tag (default: ${defaultImageRef()})`,
      'set -e',
      '',
      'CONFIG_DIR="$(cd "$(dirname "$0")" && pwd)"',
      `CONFIG_FILE="$CONFIG_DIR/${configFileName}"`,
      `IMAGE="\${PRYV_IMAGE:-${defaultImageRef()}}"`,
      '',
      'exec docker run --rm \\',
      `  -v "$CONFIG_DIR":${configDir} \\`,
      '  "$IMAGE" \\',
      `  check-config ${absConfigPath}`,
      ''
    ].join('\n');
    fs.writeFileSync(checkScriptPath, checkScript, { mode: 0o755 });
    wroteCheckScript = true;
    console.log(`✓ Wrote ${checkScriptPath}`);
  }

  // ── NEXT STEPS ────────────────────────────────────────────────
  console.log();
  console.log('Next steps');
  console.log(bar());
  if (genSecrets) {
    console.log('Generated secrets (BACK THESE UP — losing them locks you out of audit + cert decryption):');
    console.log(`  auth.adminAccessKey       = ${adminAccessKey}`);
    console.log(`  auth.filesReadTokenSecret = ${filesReadTokenSecret}`);
    if (leConfig) {
      console.log(`  letsEncrypt.atRestKey     = ${leConfig.atRestKey}`);
    }
    console.log();
  }
  // The hint paths below quote the launcher RELATIVELY (./foo.sh) — the
  // operator runs the wizard from inside the install dir (the same dir
  // they bind-mounted to /app/pryv), so `./` resolves on their host the
  // same way `<configDir>/` resolves in-container.
  console.log('Verify the config with check-config:');
  if (wroteCheckScript) {
    console.log('  ./check-config.sh');
  } else {
    // Fallback when the operator declined to overwrite. Use `$(pwd)` on
    // the LHS so the snippet works as-pasted from any cwd on the host
    // (assuming they're in the install dir).
    console.log('  docker run --rm \\');
    console.log(`    -v "$(pwd)":${configDir} \\`);
    console.log('    pryvio/open-pryv.io \\');
    console.log(`    check-config ${absConfigPath}`);
  }
  console.log();
  console.log('Start the server:');
  if (wroteRunScript) {
    console.log('  ./run-pryv.sh');
    console.log('    (override host data dir with: PRYV_DATA_DIR=/host/path ./run-pryv.sh)');
  } else {
    console.log('  docker run -d --name pryvio \\');
    console.log(`    -v "$(pwd)":${configDir} \\`);
    console.log(`    -v "$(pwd)/data":${dataFolder} \\`);
    console.log(`    ${dockerPorts.join(' ')} \\`);
    console.log(`    ${defaultImageRef()} \\`);
    console.log(`    node bin/master.js --config ${absConfigPath}`);
  }
  console.log();
  console.log('Smoke test:');
  console.log(`  curl ${publicUrl}/reg/service/info`);
  console.log();

  rl.close();
}

main().catch((err) => {
  console.error();
  console.error('init: fatal error');
  console.error(err && err.stack ? err.stack : err);
  rl.close();
  process.exit(1);
});
