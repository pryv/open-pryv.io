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
const { createTokenProtection } = require('business/src/accesses/tokenProtection.ts');

const CLI = path.resolve(__dirname, '../../../bin/access-tokens.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[ATCL] bin/access-tokens.js arguments', function () {
  this.timeout(60000);

  let tmpDir, hostConfig, adminKey;
  before(() => {
    // Own SQLite users directory and key: the child never touches the suite's storage.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-tokens-cli-'));
    hostConfig = path.join(tmpDir, 'host-config-' + cuid.slug() + '.yml');
    adminKey = 'access-tokens-cli-key-' + cuid();
    fs.writeFileSync(hostConfig, `
auth:
  adminAccessKey: ${adminKey}
storages:
  base:
    engine: sqlite
  series:
    engine: sqlite
  engines:
    sqlite:
      path: ${path.join(tmpDir, 'users')}
    filesystem:
      previewsDirPath: ${path.join(tmpDir, 'previews')}
`);
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[ATCL1] --help lists --config', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /--config <file>/);
  });

  it('[ATCL2] status --config <file> reads that file: the key id is the one of its admin key, its storage path is used', () => {
    const res = runCli(['status', '--config', hostConfig]);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stderr, /Unknown argument/);
    assert.match(res.stdout, new RegExp('^kid: ' + createTokenProtection(adminKey).kid + '$', 'm'), res.stdout);
    assert.ok(fs.existsSync(path.join(tmpDir, 'users')), 'the users directory of the file was used');
  });

  it('[ATCL3] a --config file that does not exist, or a --config without a file, is refused, exit 1', () => {
    const missing = runCli(['status', '--config', path.join(tmpDir, 'no-such-file.yml')]);
    assert.strictEqual(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /--config: file not found/);
    const bare = runCli(['status', '--config']);
    assert.strictEqual(bare.status, 1, bare.stdout + bare.stderr);
    assert.match(bare.stderr, /--config: file not found: \(missing <file>\)/);
  });

  it('[ATCL4] an unknown argument is still refused', () => {
    const res = runCli(['status', '--bogus']);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /Unknown argument: --bogus/);
  });
});
