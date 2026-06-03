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
//   docker run -it -v /host/config:/app/config -v /host/data:/app/data \
//     pryvio/open-pryv.io init /app/config/override-config.yml
//
// Or locally during development:
//   node bin/init.js /tmp/test-override.yml
//
// Refuses to overwrite an existing file. After collecting answers the wizard
// validates the host environment (writable paths, plausible values) and only
// writes the YAML if no fatal problems are found.

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
    // inside an askNonEmpty retry loop.
    process.stdout.write('\n');
    throw new Error('init: input stream closed before all prompts were answered (EOF on stdin)');
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

function dirWritable (dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function bar (n = 50) { return '─'.repeat(n); }

async function main () {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: init <config-path>');
    console.error('Example: init /app/config/override-config.yml');
    process.exit(1);
  }
  const absConfigPath = path.resolve(configPath);
  if (fs.existsSync(absConfigPath)) {
    console.error(`init: ${absConfigPath} already exists.`);
    console.error('  Move it aside or pick a different path. (init never overwrites.)');
    process.exit(1);
  }

  console.log();
  console.log('open-pryv.io configuration wizard');
  console.log(bar());
  console.log('Producing a single-core override-config.yml at:');
  console.log(`  ${absConfigPath}`);
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
  }
  console.log();

  // 3. DB engine
  console.log('▸ User-data storage engine');
  console.log('  postgresql → shared tables keyed by user_id (cheap cross-user queries; one pg_dump)');
  console.log('  sqlite     → one file per user (per-user backups; cleaner GDPR Art.17 deletion)');
  const dbEngine = await askChoice('Choose:', ['postgresql', 'sqlite'], 0);
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

  // 5. Data folder
  console.log('▸ User-data folder (must be mounted in the container)');
  const dataFolder = await ask('  User data folder', '/app/data');
  console.log();

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
      keyFile: await ask('  Path to TLS key file (inside container)', '/app/config/tls/key.pem'),
      certFile: await ask('  Path to TLS cert file (inside container)', '/app/config/tls/cert.pem')
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

  if (problems.length > 0) {
    console.log();
    console.log('Refusing to write — fix the problems above and re-run init.');
    rl.close();
    process.exit(1);
  }

  console.log();
  const confirm = await askYesNo(`Write config to ${absConfigPath}?`, true);
  if (!confirm) {
    console.log('Aborted. No file written.');
    rl.close();
    process.exit(0);
  }

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
      port: 3000
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
    config.dns = { active: true, domain: dnsDomain, port: 53 };
  }

  if (tlsStrategy === 'letsEncrypt') {
    config.letsEncrypt = leConfig;
  } else if (tlsStrategy === 'custom') {
    config.http.ssl = customSsl;
  }

  if (emailConfig) {
    config.services = { email: emailConfig };
  }

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(absConfigPath, yaml.dump(config, { lineWidth: 100, noRefs: true }));

  console.log();
  console.log(`✓ Wrote ${absConfigPath}`);

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
  console.log('Verify the config with check-config:');
  console.log(`  docker run --rm -v ${configDir}:/app/config \\`);
  console.log(`    pryvio/open-pryv.io check-config ${absConfigPath}`);
  console.log();
  console.log('Start the server:');
  const ports = [];
  if (tlsStrategy === 'letsEncrypt' || tlsStrategy === 'custom') {
    ports.push('-p 80:80', '-p 443:443');
  }
  ports.push('-p 3000:3000', '-p 3001:3001');
  if (hfsWorkers > 0) ports.push('-p 4000:4000');
  if (!dnsLess) ports.push('-p 53:53/udp');
  console.log(`  docker run -d --name pryvio \\`);
  console.log(`    -v ${configDir}:/app/config \\`);
  console.log(`    -v ${dataFolder}:/app/data \\`);
  console.log(`    ${ports.join(' ')} \\`);
  console.log(`    -e PRYV_DATADIR=/app/data \\`);
  console.log(`    pryvio/open-pryv.io \\`);
  console.log(`    node bin/master.js --config ${absConfigPath}`);
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
