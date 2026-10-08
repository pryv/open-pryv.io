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

function runCheck (yamlBody, nodeEnv = process.env.NODE_ENV) {
  const file = path.join(os.tmpdir(), 'check-config-' + cuid.slug() + '.yml');
  fs.writeFileSync(file, yamlBody);
  const env = Object.assign({}, process.env);
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
