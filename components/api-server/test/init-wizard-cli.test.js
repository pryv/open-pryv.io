/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
/* global assert */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLI = path.resolve(__dirname, '../../../bin/init.js');
const CHECK_CLI = path.resolve(__dirname, '../../../bin/check-config.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

const ANSWERS = `
dnsless: true
publicurl: https://core.example.com
db.engine: sqlite
service.name: Test
secrets.autogenerate: true
authui.url: https://account.example.com
tls.strategy: letsEncrypt
le.email: ops@example.com
le.staging: false
hfs.enabled: false
email.enabled: false
`;

/** Runs the wizard unattended into a fresh directory (local mode, no docker). */
function runWizard (configDir, extraArgs = [], answers = ANSWERS) {
  const answersFile = path.join(configDir, 'answers.yml');
  fs.writeFileSync(answersFile, answers);
  const env = { ...process.env, PRYV_CONFIG_DIR: configDir };
  delete env.PRYV_IMAGE_TAG;
  const res = spawnSync('node', [CLI, '--non-interactive', '--config-from=' + answersFile, ...extraArgs], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

describe('[INWZ] bin/init.js generated files', function () {
  this.timeout(60000);
  let configDir;

  before(function () {
    // The mode assertions rely on POSIX file modes
    if (process.platform === 'win32') this.skip();
  });

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-wizard-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('[INWZ1] run-pryv.sh restarts the container after a reboot and gives it 30 s to stop', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const runScript = fs.readFileSync(path.join(configDir, 'run-pryv.sh'), 'utf8');
    assert.match(runScript, /docker run -d --name "\$NAME" --restart unless-stopped --stop-timeout 30 /);
  });

  it('[INWZ2] pryv-config.yml, which holds the secrets, is readable by its owner only', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const mode = fs.statSync(path.join(configDir, 'pryv-config.yml')).mode & 0o777;
    assert.strictEqual(mode.toString(8), '600');
  });

  it('[INWZ4] the Let\'s Encrypt contact email is optional', () => {
    const res = runWizard(configDir, [], ANSWERS.replace(/^le\.email:.*\n/m, ''));
    assert.strictEqual(res.status, 0, res.output);
    const config = fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8');
    assert.match(config, /^letsEncrypt:\n {2}enabled: true$/m);
    assert.doesNotMatch(config, /^ {2}email:/m);
    const check = spawnSync('node', [CHECK_CLI, path.join(configDir, 'pryv-config.yml')], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000
    });
    assert.doesNotMatch(check.stdout + check.stderr, /letsEncrypt\.email/);
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
  });

  it('[INWZ5] a Let\'s Encrypt contact that is not an email address is refused', () => {
    const res = runWizard(configDir, [], ANSWERS.replace(/^le\.email:.*$/m, 'le.email: ops'));
    assert.notStrictEqual(res.status, 0);
    assert.match(res.output, /le\.email/);
    assert.ok(!fs.existsSync(path.join(configDir, 'pryv-config.yml')), 'no config written');
  });

  it('[INWZ3] an existing world-readable config overwritten with --force ends up 0600', () => {
    const configFile = path.join(configDir, 'pryv-config.yml');
    fs.writeFileSync(configFile, 'previous: true\n', { mode: 0o644 });
    fs.chmodSync(configFile, 0o644);
    const res = runWizard(configDir, ['--force']);
    assert.strictEqual(res.status, 0, res.output);
    assert.doesNotMatch(fs.readFileSync(configFile, 'utf8'), /previous: true/);
    const mode = fs.statSync(configFile).mode & 0o777;
    assert.strictEqual(mode.toString(8), '600');
  });
});
