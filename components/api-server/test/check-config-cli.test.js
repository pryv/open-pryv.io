/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
/* global assert */

const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('child_process');
const cuid = require('cuid');

const CLI = path.resolve(__dirname, '../../../bin/check-config.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

// No NODE_ENV by default: boot (and check-config) would otherwise merge the
// matching config/<NODE_ENV>-config.yml (test-config.yml under mocha) under
// the checked file.
function runCheck (yamlBody, nodeEnv = null, extraEnv = {}) {
  const file = path.join(os.tmpdir(), 'check-config-' + cuid.slug() + '.yml');
  fs.writeFileSync(file, yamlBody);
  // The test runner itself sets `a__b` config variables: keep only the ones a test passes.
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^[^_].*__/.test(k)) delete env[k];
  Object.assign(env, extraEnv);
  if (nodeEnv == null) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
  try {
    const res = spawnSync('node', [CLI, file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      timeout: 30000
    });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  } finally {
    fs.unlinkSync(file);
  }
}

// Everything the other checks demand, so the only variable under test is the
// email-verification block.
const BASE_WITHOUT_PII_KEY = `
service:
  name: Test
  serial: "2026091501"
  home: https://example.com
  support: https://example.com/
  terms: https://example.com/terms
  eventTypes: https://example.com/event-types.json
auth:
  adminAccessKey: an-admin-key
  filesReadTokenSecret: a-files-secret
  passwordResetPageURL: https://app.example.com/reset-password
  trustedApps: '*@https://app.example.com'
storages:
  base:
    engine: sqlite
  series:
    engine: sqlite
dnsLess:
  isActive: true
  publicUrl: https://core.example.com/
access:
  defaultAuthUrl: https://app.example.com/auth
`;
// PII is hashed by default, so a complete config carries the pepper.
const PII_KEY = `
platform:
  piiHmacKey: WLthDQK7GoYZINg7uIeWN9eANnj2BSh4zEZmRPyR5y0=
`;
const BASE = BASE_WITHOUT_PII_KEY + PII_KEY;

describe('[CKCF] bin/check-config.js email verification', function () {
  this.timeout(60000);

  it('[CKCF1] a config that never mentions verifyEmail passes with a warning about the page URL', () => {
    const res = runCheck(BASE);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout,
      /emailVerificationPageURL missing or unset: email verification is on by default/);
  });

  it('[CKCF2] a config that turns verifyEmail on without a page URL is a problem', () => {
    const res = runCheck(BASE + `
services:
  email:
    enabled:
      verifyEmail: true
`);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr,
      /required when services\.email\.enabled\.verifyEmail is true/);
  });

  it('[CKCF3] a config that supplies the page URL is clean', () => {
    const res = runCheck(BASE.replace(
      '  passwordResetPageURL: https://app.example.com/reset-password',
      '  passwordResetPageURL: https://app.example.com/reset-password\n' +
      '  emailVerificationPageURL: https://app.example.com/verify-email'));
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok(!/emailVerificationPageURL/.test(res.stdout),
      'no email-verification warning is expected: ' + res.stdout);
  });

  it('[CKCF4] an auth UI without service.account gets a warning; setting it clears it', () => {
    const without = runCheck(BASE);
    assert.strictEqual(without.status, 0, without.stdout + without.stderr);
    assert.match(without.stdout, /service\.account is not set/);
    const withAccount = runCheck(BASE.replace('  terms: https://example.com/terms',
      '  terms: https://example.com/terms\n  account: https://app.example.com'));
    assert.ok(!/service\.account/.test(withAccount.stdout), withAccount.stdout);
  });

  it('[CKCF5] services.mfa gets the boot check, merged over the shipped defaults', () => {
    const bad = runCheck(BASE + `
services:
  mfa:
    defaultMethod: push
`);
    assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /services\.mfa\.defaultMethod: defaultMethod "push" is not an active MFA method/);
    // A partial block is judged with the defaults filled in: no false problem.
    const legacyKey = runCheck(BASE + `
services:
  mfa:
    attempts:
      lockoutSeconds: 900
`);
    assert.strictEqual(legacyKey.status, 0, legacyKey.stdout + legacyKey.stderr);
    assert.match(legacyKey.stdout, /lockoutSeconds is no longer read/);
  });

  it('[CKCF7] a plain services.email.enabled: true inherits verifyEmail: a missing page URL is a warning, as at boot', () => {
    const res = runCheck(BASE + `
services:
  email:
    enabled: true
`);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /emailVerificationPageURL missing or unset: email verification is on by default/);
    assert.doesNotMatch(res.stdout + res.stderr, /required when services\.email\.enabled\.verifyEmail is true/);
  });

  it('[CKCF6] letsEncrypt.email is optional, but a placeholder in it is a problem', () => {
    const le = `
letsEncrypt:
  enabled: true
  atRestKey: c2VjcmV0LWtleS1mb3ItdGVzdHMtMzItYnl0ZXMtbG9uZw==
`;
    const noEmail = runCheck(BASE + le);
    assert.strictEqual(noEmail.status, 0, noEmail.stdout + noEmail.stderr);
    assert.doesNotMatch(noEmail.stdout + noEmail.stderr, /letsEncrypt\.email/);
    const placeholder = runCheck(BASE + le + "  email: 'REPLACE ME'\n");
    assert.strictEqual(placeholder.status, 1, placeholder.stdout + placeholder.stderr);
    assert.match(placeholder.stdout + placeholder.stderr, /letsEncrypt\.email holds a placeholder/);
  });
});

describe('[CKBL] bin/check-config.js base layer and trusted apps', function () {
  this.timeout(60000);

  it('[CKBL1] says which base layer boot adds under the file', () => {
    const prod = runCheck(BASE, 'production');
    assert.strictEqual(prod.status, 0, prod.stdout + prod.stderr);
    assert.match(prod.stdout, /Base layer: NODE_ENV=production, so boot without --config adds config\/production-config\.yml/);
    const none = runCheck(BASE, null);
    assert.strictEqual(none.status, 0, none.stdout + none.stderr);
    assert.match(none.stdout, /Base layer: none/);
  });

  it('[CKBL2] in production a missing auth.trustedApps is a problem: the base layer no longer supplies it', () => {
    const res = runCheck(BASE.replace("  trustedApps: '*@https://app.example.com'\n", ''), 'production');
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /auth\.trustedApps missing or empty/);
    assert.match(res.stderr, /Base layer: NODE_ENV=production/);
  });

  it('[CKBL3] an auth.trustedApps entry with a misplaced wildcard is a problem', () => {
    const res = runCheck(BASE.replace("'*@https://app.example.com'", "'*@https://app.*.example.com'"), 'production');
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /auth\.trustedApps: .*only allowed as the whole first label/);
  });
});

describe('[CKSE] bin/check-config.js series engine with a SQLite base', function () {
  this.timeout(60000);

  const PROBLEM = /storages\.series\.engine=postgresql requires storages\.base\.engine: postgresql/;
  const withoutSeries = BASE.replace('  series:\n    engine: sqlite\n', '');

  it('[CKSE1] PostgreSQL series on a SQLite base is a problem, also when the series engine is left to its default', () => {
    for (const body of [BASE.replace('  series:\n    engine: sqlite\n', '  series:\n    engine: postgresql\n'), withoutSeries]) {
      const res = runCheck(body);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, PROBLEM);
    }
  });

  it('[CKSE2] SQLite or InfluxDB series on a SQLite base, and PostgreSQL series on a PostgreSQL base, pass', () => {
    for (const engine of ['sqlite', 'influxdb']) {
      const res = runCheck(BASE.replace('  series:\n    engine: sqlite\n', `  series:\n    engine: ${engine}\n`));
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    }
    const pg = runCheck(withoutSeries.replace('    engine: sqlite\n', '    engine: postgresql\n  engines:\n    postgresql:\n' +
      '      host: localhost\n      port: 5432\n      database: pryv\n      user: pryv\n      password: a-db-password\n'));
    assert.strictEqual(pg.status, 0, pg.stdout + pg.stderr);
    assert.doesNotMatch(pg.stdout + pg.stderr, /storages\.series\.engine/);
  });
});

describe('[CKPK] bin/check-config.js platform.piiHmacKey', function () {
  this.timeout(60000);

  it('[CKPK1] hashed PII (the default) without a key is a problem', () => {
    for (const body of [
      BASE_WITHOUT_PII_KEY,
      BASE_WITHOUT_PII_KEY + "\nplatform:\n  piiMode: hashed\n  piiHmacKey: 'REPLACE ME'\n"
    ]) {
      const res = runCheck(body, null);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout + res.stderr, /platform\.piiHmacKey missing or unset/);
    }
  });

  it('[CKPK2] cleartext PII needs no key', () => {
    const res = runCheck(BASE_WITHOUT_PII_KEY + '\nplatform:\n  piiMode: cleartext\n', null);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout + res.stderr, /piiHmacKey/);
  });

  it('[CKPK4] the public development/test pepper is flagged: a production core refuses it', () => {
    const res = runCheck(BASE, null);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr,
      /platform\.piiHmacKey is the public development\/test value: a production core refuses to boot with it/);
    const own = runCheck(BASE_WITHOUT_PII_KEY + '\nplatform:\n  piiHmacKey: ' +
      require('node:crypto').randomBytes(32).toString('base64') + '\n', null);
    assert.strictEqual(own.status, 0, own.stdout + own.stderr);
    assert.doesNotMatch(own.stdout + own.stderr, /piiHmacKey/);
  });

  it('[CKPK3] the development base layer supplies the key', () => {
    const res = runCheck(BASE_WITHOUT_PII_KEY, 'development');
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout + res.stderr, /platform\.piiHmacKey missing/);
  });
});

describe('[CKRQ] bin/check-config.js rqlite url', function () {
  this.timeout(60000);

  function withRqlite (block) {
    return BASE.replace('    engine: sqlite\n', '    engine: sqlite\n  engines:\n    rqlite:\n' + block);
  }
  const WARNING = /storages\.engines\.rqlite\.url="http:\/\/10\.0\.0\.5:4101" is not a loopback address.*Use http:\/\/127\.0\.0\.1:4101/;

  it('[CKRQ1] a non-loopback url warns and recommends 127.0.0.1 with the same port', () => {
    const res = runCheck(withRqlite('      url: http://10.0.0.5:4101\n'));
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, WARNING);
  });

  it('[CKRQ2] a loopback url, an explicit httpBindAddr or an external rqlite does not warn', () => {
    for (const block of [
      '      url: http://127.0.0.1:4101\n',
      '      url: http://localhost:4101\n',
      '      url: http://10.0.0.5:4101\n      httpBindAddr: 10.0.0.5\n',
      '      url: http://10.0.0.5:4101\n      external: true\n'
    ]) {
      const res = runCheck(withRqlite(block));
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
      assert.doesNotMatch(res.stdout, /rqlite\.url=/, block);
    }
  });
});

describe('[CKRF] bin/check-config.js Raft TLS on a multi-core node', function () {
  this.timeout(60000);

  const MULTI_CORE = BASE + 'core:\n  ip: 203.0.113.7\n';
  function withRqlite (yamlBody, block) {
    return yamlBody.replace('    engine: sqlite\n', '    engine: sqlite\n  engines:\n    rqlite:\n' + block);
  }
  const REFUSAL = /multi-core node \(core\.ip is set\) without Raft TLS.*refuses to start.*init-ca-holder/;

  it('[CKRF1] core.ip without storages.engines.rqlite.tls is a problem (exit 1)', () => {
    const res = runCheck(MULTI_CORE);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /problem\(s\):/);
    assert.match(res.stderr, REFUSAL);
  });

  it('[CKRF2] single-core, tls set, an external rqlite or the PostgreSQL platform engine pass', () => {
    const tlsBlock = '      tls:\n        caFile: /tls/ca.crt\n        certFile: /tls/node.crt\n        keyFile: /tls/node.key\n';
    for (const body of [
      BASE,
      withRqlite(MULTI_CORE, tlsBlock),
      withRqlite(MULTI_CORE, '      external: true\n')
    ]) {
      const res = runCheck(body);
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
      assert.doesNotMatch(res.stdout + res.stderr, /Raft TLS/);
    }
    // The PostgreSQL platform engine runs no rqlited (it has other requirements: full PG mode).
    const pgPlatform = MULTI_CORE.replace('  base:\n    engine: sqlite\n  series:\n    engine: sqlite\n',
      '  base:\n    engine: postgresql\n  series:\n    engine: postgresql\n  platform:\n    engine: postgresql\n');
    assert.notStrictEqual(pgPlatform, MULTI_CORE);
    const res = runCheck(pgPlatform);
    assert.doesNotMatch(res.stdout + res.stderr, /Raft TLS/);
  });
});

describe('[CCIA] bin/check-config.js integrity.algorithm', function () {
  this.timeout(60000);

  it('[CCIA1] md5 and sha1 are problems; sha512 and the default pass', () => {
    for (const algorithm of ['md5', 'sha1']) {
      const res = runCheck(BASE + `
integrity:
  algorithm: ${algorithm}
`);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, new RegExp('integrity\\.algorithm \'' + algorithm + '\' is not supported'));
    }
    const strong = runCheck(BASE + '\nintegrity:\n  algorithm: sha512\n');
    assert.strictEqual(strong.status, 0, strong.stdout + strong.stderr);
    const absent = runCheck(BASE);
    assert.strictEqual(absent.status, 0, absent.stdout + absent.stderr);
  });
});

describe('[CKSS] bin/check-config.js custom system streams', function () {
  this.timeout(60000);

  it('[ESOT3] an "other" custom system stream is a problem; account streams and an empty "other" list pass', () => {
    const other = runCheck(BASE + `
custom:
  systemStreams:
    other:
      - id: my-stream
        type: string/pryv
`);
    assert.strictEqual(other.status, 1, other.stdout + other.stderr);
    assert.match(other.stderr, /custom\.systemStreams\.other is not supported/);
    const account = runCheck(BASE + `
custom:
  systemStreams:
    account:
      - id: phone
        type: string/pryv
    other: []
`);
    assert.strictEqual(account.status, 0, account.stdout + account.stderr);
    const invalid = runCheck(BASE + `
custom:
  systemStreams:
    account:
      - id: bad-type
        type: hellow
`);
    assert.strictEqual(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /invalid custom system stream/);
  });
});

describe('[CKEV] bin/check-config.js keys supplied by environment variables', function () {
  this.timeout(60000);
  const OWN_KEY = 'k3J9vQx2Lm8Pz4Rt6Wy1Ab5Cd7Ef0Gh2Ij4Kl6Mn8=';

  it('[CKEV1] a required key set as `a__b` in the environment is not reported missing', () => {
    const fileOnly = runCheck(BASE_WITHOUT_PII_KEY, null);
    assert.strictEqual(fileOnly.status, 1, fileOnly.stdout + fileOnly.stderr);
    assert.match(fileOnly.stderr, /platform\.piiHmacKey missing or unset/);

    const res = runCheck(BASE_WITHOUT_PII_KEY.replace('  base:\n    engine: sqlite\n', ''), null,
      { platform__piiHmacKey: OWN_KEY, storages__base__engine: 'sqlite' });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Environment: 2 variable\(s\) merged under this file/);
    assert.match(res.stdout, /platform__piiHmacKey, storages__base__engine/);
    assert.doesNotMatch(res.stdout, new RegExp(OWN_KEY), 'values are never printed');
  });

  it('[CKEV2] the file wins over the environment, as at boot; parsed values (booleans) apply', () => {
    const res = runCheck(BASE, null, { platform__piiHmacKey: 'REPLACE ME' });
    assert.doesNotMatch(res.stdout + res.stderr, /piiHmacKey missing or unset/);

    const dnsOff = runCheck(BASE, null, { dnsLess__isActive: 'false' });
    assert.strictEqual(dnsOff.status, 0, 'the file sets dnsLess.isActive: true: ' + dnsOff.stdout + dnsOff.stderr);
    const noDns = runCheck(BASE.replace('  isActive: true\n', ''), null, { dnsLess__isActive: 'false' });
    assert.strictEqual(noDns.status, 1, noDns.stdout + noDns.stderr);
    assert.match(noDns.stderr, /Neither dnsLess\.isActive nor dns\.active is true/);
  });
});

describe('[CKBS] bin/check-config.js on a core joined with --bootstrap', function () {
  this.timeout(60000);

  it('[CKBS1] keys in bootstrap-config.yml next to the file count, as at boot; the file still wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-config-bs-'));
    try {
      const file = path.join(dir, 'override-config.yml');
      fs.writeFileSync(file, BASE_WITHOUT_PII_KEY);
      const run = () => {
        const env = Object.assign({}, process.env);
        for (const k of Object.keys(env)) if (/^[^_].*__/.test(k)) delete env[k];
        delete env.NODE_ENV;
        return spawnSync('node', [CLI, file], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 30000 });
      };
      assert.strictEqual(run().status, 1, 'no key anywhere');
      fs.writeFileSync(path.join(dir, 'bootstrap-config.yml'), 'platform:\n  piiHmacKey: k3J9vQx2Lm8Pz4Rt6Wy1Ab5Cd7Ef0Gh2Ij4Kl6Mn8=\n');
      const res = run();
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /Bootstrap layer: .*bootstrap-config\.yml/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('[CKOC] bin/check-config.js oauth.consentUrl', function () {
  this.timeout(60000);

  it('[CKOC1] a config without oauth.consentUrl passes with a warning; setting it clears the warning', () => {
    const without = runCheck(BASE);
    assert.strictEqual(without.status, 0, without.stdout + without.stderr);
    assert.match(without.stdout, /oauth\.consentUrl is not set: GET \/oauth2\/authorize answers 500/);
    const empty = runCheck(BASE + `
oauth:
  consentUrl: ''
`);
    assert.strictEqual(empty.status, 0, empty.stdout + empty.stderr);
    assert.match(empty.stdout, /oauth\.consentUrl is not set/);
    const withUrl = runCheck(BASE + `
oauth:
  consentUrl: https://app.example.com/oauth2-authorize
`);
    assert.strictEqual(withUrl.status, 0, withUrl.stdout + withUrl.stderr);
    assert.ok(!/oauth\.consentUrl/.test(withUrl.stdout), withUrl.stdout);
  });
});

describe('[CCDL] bin/check-config.js reads the shipped defaults under the file', function () {
  this.timeout(60000);

  const PG_DEFAULTS = BASE.replace('storages:\n  base:\n    engine: sqlite\n  series:\n    engine: sqlite\n', '');

  it('[CCDL1] storages left to the defaults (local PostgreSQL) are not reported missing; an empty password is a warning', () => {
    assert.notStrictEqual(PG_DEFAULTS, BASE);
    const res = runCheck(PG_DEFAULTS);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /storages\.base\.engine/);
    assert.match(res.stdout, /storages\.engines\.postgresql\.password is empty/);
    const withPassword = runCheck(PG_DEFAULTS + 'storages:\n  engines:\n    postgresql:\n      password: a-db-password\n');
    assert.strictEqual(withPassword.status, 0, withPassword.stdout + withPassword.stderr);
    assert.doesNotMatch(withPassword.stdout, /postgresql\.password/);
    const placeholder = runCheck(PG_DEFAULTS + "storages:\n  engines:\n    postgresql:\n      password: 'REPLACE ME'\n");
    assert.strictEqual(placeholder.status, 1, placeholder.stdout + placeholder.stderr);
    assert.match(placeholder.stderr, /storages\.engines\.postgresql\.password holds a placeholder/);
  });

  it('[CCDL2] the PostgreSQL platform engine accepts dnsLess.isActive left to its default (true)', () => {
    const res = runCheck(PG_DEFAULTS.replace('  isActive: true\n', '') +
      'storages:\n  platform:\n    engine: postgresql\n  engines:\n    postgresql:\n      password: a-db-password\n');
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /requires dnsLess\.isActive/);
  });

  it('[CCDL3] the registration email gate judges the default mail method (in-process) when the file names none', () => {
    const res = runCheck(BASE + 'account:\n  emailVerification:\n    requireAtRegistration: true\n');
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /services\.email\.smtp\.host missing or unset \(required by the registration email gate with method in-process\)/);
  });
});

describe('[CCMC] bin/check-config.js on a multi-core member without a DNS of its own', function () {
  this.timeout(60000);

  const NEITHER = /Neither dnsLess\.isActive nor dns\.active is true/;
  const withTopology = (block) => BASE.replace('dnsLess:\n  isActive: true\n  publicUrl: https://core.example.com/\n', block);

  it('[CCMC1] a member served by a peer core\'s DNS passes with a warning (classified multi-core as at boot)', () => {
    for (const block of [
      // dns.domain set, dnsLess off: the core URL is derived from core.id
      'dnsLess:\n  isActive: false\ndns:\n  active: false\n  domain: example.org\ncore:\n  id: core-b\n',
      // an explicit core.url, dnsLess off
      'dnsLess:\n  isActive: false\ncore:\n  url: https://core-b.example.org\n'
    ]) {
      const body = withTopology(block);
      assert.notStrictEqual(body, BASE);
      const res = runCheck(body);
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, NEITHER);
      assert.match(res.stdout, /multi-core member runs no DNS of its own.*peer core's embedded DNS/);
    }
  });

  it('[CCMC3] a DNSless member (core.url, no dnsLess key, as written by bootstrap) is classified on the operator\'s layers', () => {
    // dnsLess.isActive is left out, so boot's core identity (which runs before
    // the defaults load) makes this core a multi-core member: no public URL is needed.
    const https = runCheck(withTopology('core:\n  id: core-b\n  url: https://core-b.example.org\n'));
    assert.strictEqual(https.status, 0, https.stdout + https.stderr);
    assert.doesNotMatch(https.stdout, /dnsLess\.publicUrl/);
    // As a member its URL is a peer URL, refused over http: the classification
    // did not read the merged dnsLess.isActive (true by default).
    const http = runCheck(withTopology('core:\n  id: core-b\n  url: http://core-b.example.org\n'));
    assert.strictEqual(http.status, 1, http.stdout + http.stderr);
    assert.match(http.stderr, /uses http: \(core-to-core calls carry the admin key\)/);
  });

  it('[CCMC2] a single core with neither dnsLess nor the embedded DNS is still a problem', () => {
    const res = runCheck(withTopology('dnsLess:\n  isActive: false\n'));
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /Neither dnsLess\.isActive nor dns\.active is true — server cannot resolve user → core/);
  });
});

describe('[CCDU] bin/check-config.js on dns.domain with dnsLess.isActive left unset', function () {
  this.timeout(60000);

  const PROBLEM = /'dns\.domain' is set \(example\.org\) but 'dnsLess\.isActive' is not: set it explicitly/;
  const withTopology = (block) => BASE.replace('dnsLess:\n  isActive: true\n  publicUrl: https://core.example.com/\n', block);

  it('[CCDU1] dns.domain without core.url and without dnsLess.isActive is a problem, as at boot', () => {
    for (const block of [
      'dns:\n  domain: example.org\n',
      'dns:\n  domain: example.org\ndnsLess:\n  publicUrl: https://core.example.com/\n'
    ]) {
      const body = withTopology(block);
      assert.notStrictEqual(body, BASE);
      const res = runCheck(body);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, PROBLEM);
    }
  });

  it('[CCDU2] dnsLess.isActive set in the file or the environment, or a core.url, is not that problem', () => {
    for (const [block, env] of [
      ['dns:\n  domain: example.org\ndnsLess:\n  isActive: true\n  publicUrl: https://core.example.com/\n', {}],
      ['dns:\n  domain: example.org\ndnsLess:\n  isActive: false\n', {}],
      ['dns:\n  domain: example.org\n', { dnsLess__isActive: 'false' }],
      ['dns:\n  domain: example.org\ncore:\n  url: https://core-b.example.org\n', {}]
    ]) {
      const res = runCheck(withTopology(block), null, env);
      assert.doesNotMatch(res.stdout + res.stderr, /dnsLess\.isActive' is not/, block);
      assert.strictEqual(res.status, 0, block + res.stdout + res.stderr);
    }
  });
});
