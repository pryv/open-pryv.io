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

const CLI = path.resolve(__dirname, '../../../bin/integrity-check.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[ICKC] bin/integrity-check.js arguments', function () {
  this.timeout(60000);

  let tmpDir, hostConfig;
  before(() => {
    // Own sqlite dir, so the child never touches the suite's var-pryv/users.
    // Nothing listens on port 9 (discard); the URL can only come from this file.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-check-'));
    hostConfig = path.join(tmpDir, 'host-config-' + cuid.slug() + '.yml');
    fs.writeFileSync(hostConfig, `
storages:
  base:
    engine: sqlite
  engines:
    sqlite:
      path: ${path.join(tmpDir, 'users')}
    rqlite:
      url: http://127.0.0.1:9
`);
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[ICKC1] --help prints the tool usage, including --config', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Usage: node bin\/integrity-check\.js/);
    assert.match(res.stdout, /--config <file>/);
  });

  it('[ICKC2] an unknown argument is a usage error', () => {
    const res = runCli(['--bogus']);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /Unknown argument: --bogus/);
  });

  it('[ICKC3] --config <file> is accepted and applied; an unreachable platform DB is named, exit 1', () => {
    const res = runCli(['--platform', '--config', hostConfig]);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.doesNotMatch(res.stderr, /Unknown argument/);
    assert.match(res.stderr,
      /Platform DB unreachable at http:\/\/127\.0\.0\.1:9( \([A-Z_]+\))?: is rqlited running for this core\?/);
  });

  it('[ICKC4] a --config file that does not exist is refused, exit 1', () => {
    const res = runCli(['--platform', '--config', path.join(tmpDir, 'no-such-file.yml')]);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /--config: file not found/);
  });
});
