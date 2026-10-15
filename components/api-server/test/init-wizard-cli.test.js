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
import { createRequire } from 'node:module';
/* global assert */
const yaml = createRequire(import.meta.url)('js-yaml');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLI = path.resolve(__dirname, '../../../bin/init.js');
const CHECK_CLI = path.resolve(__dirname, '../../../bin/check-config.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');
const BOILER_SRC = path.resolve(REPO_ROOT, 'components/boiler/src/index.ts');

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

  it('[INWZ6] UI assets are written explicitly, the public Pryv set by default', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const config = yaml.load(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'));
    assert.strictEqual(config.service.assets.definitions, 'https://pryv.github.io/assets-pryv.me/index.json');
    // dnsLess: the trusted origins stay the public URL and the auth UI, nothing more.
    assert.deepStrictEqual(config.auth.trustedApps.split(',').map((s) => s.trim()).sort(),
      ['*@https://account.example.com', '*@https://core.example.com']);
  });

  it('[INWZ7] dns-active: the default trustedApps include the register and access hosts', () => {
    const answers = ANSWERS.replace(/^dnsless:.*\n/m, 'dnsless: false\n')
      .replace(/^publicurl:.*\n/m, 'dnsdomain: example.invalid\npublicip: 192.0.2.10\n');
    const res = runWizard(configDir, [], answers);
    assert.strictEqual(res.status, 0, res.output);
    const config = yaml.load(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'));
    const trustedApps = config.auth.trustedApps.split(',').map((s) => s.trim());
    for (const origin of ['https://core.example.invalid', 'https://reg.example.invalid', 'https://access.example.invalid']) {
      assert.ok(trustedApps.includes('*@' + origin), origin + ' in ' + trustedApps.join(', '));
    }
  });

  it('[INWZ8] the generated config sets log targets: console at info, errors in a file on the data volume', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const config = yaml.load(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'));
    assert.deepStrictEqual(config.logs.console, { active: true, level: 'info', format: { color: false } });
    assert.strictEqual(config.logs.file.active, true);
    assert.strictEqual(config.logs.file.level, 'error');
    assert.strictEqual(config.logs.file.path, path.join(configDir, 'data', 'logs', 'api-server.errors.log'));
    const check = spawnSync('node', [CHECK_CLI, path.join(configDir, 'pryv-config.yml')], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000
    });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
  });

  it('[INWZ9] a core booted on the generated config writes console logs without ANSI colour codes', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const script = path.join(configDir, 'boot.mjs');
    fs.writeFileSync(script, [
      `const { init, getLogger } = await import(${JSON.stringify(BOILER_SRC)});`,
      `init({ appName: 'inwz', baseConfigDir: ${JSON.stringify(path.join(REPO_ROOT, 'config'))}, skipOverrideConfig: true });`,
      "const l = getLogger('wizard');",
      "l.info('inwz-info', { nested: { list: [1, 'two'] } }); l.error('inwz-error', { code: 'E1' });",
      'setTimeout(() => process.exit(0), 1500);'
    ].join('\n'));
    const env = { ...process.env };
    for (const k of ['LOGS', 'LOG_FORMAT', 'DEBUG', 'NODE_ENV']) delete env[k];
    const boot = spawnSync(process.execPath, [script, '--config', path.join(configDir, 'pryv-config.yml')], {
      cwd: configDir, env, encoding: 'utf8', timeout: 30000
    });
    assert.strictEqual(boot.status, 0, boot.stdout + boot.stderr);
    const out = boot.stdout + boot.stderr;
    assert.match(out, /inwz-info/);
    assert.match(out, /inwz-error/);
    assert.ok(!out.includes('\u001b['), JSON.stringify(out));
    // and the error reached the (daily) error file on the data volume
    const logDir = path.join(configDir, 'data', 'logs');
    const errorFile = fs.readdirSync(logDir).find((n) => n.startsWith('api-server.errors.log.'));
    assert.ok(errorFile, 'error log file in ' + logDir);
    assert.match(fs.readFileSync(path.join(logDir, errorFile), 'utf8'), /inwz-error/);
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
