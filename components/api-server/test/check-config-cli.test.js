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

function runCheck (yamlBody) {
  const file = path.join(os.tmpdir(), 'check-config-' + cuid.slug() + '.yml');
  fs.writeFileSync(file, yamlBody);
  try {
    const res = spawnSync('node', [CLI, file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000
    });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  } finally {
    fs.unlinkSync(file);
  }
}

// Everything the other checks demand, so the only variable under test is the
// email-verification block.
const BASE = `
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
storages:
  base:
    engine: sqlite
dnsLess:
  isActive: true
  publicUrl: https://core.example.com/
access:
  defaultAuthUrl: https://app.example.com/auth
`;

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
});
