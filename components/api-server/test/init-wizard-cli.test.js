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
import crypto from 'node:crypto';
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
function runWizard (configDir, extraArgs = [], answers = ANSWERS, extraEnv = {}) {
  const args = ['--non-interactive', ...extraArgs];
  if (answers != null) {
    const answersFile = path.join(configDir, 'answers.yml');
    fs.writeFileSync(answersFile, answers);
    args.push('--config-from=' + answersFile);
  }
  return runCli(configDir, args, extraEnv);
}

/** Runs bin/init.js with exactly these arguments, PRYV_INIT_* variables cleared. */
function runCli (configDir, args, extraEnv = {}) {
  const env = { ...process.env, PRYV_CONFIG_DIR: configDir };
  for (const k of Object.keys(env)) if (k.startsWith('PRYV_INIT_')) delete env[k];
  delete env.PRYV_IMAGE_TAG;
  delete env.DATABASE_URL;
  Object.assign(env, extraEnv);
  const res = spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000
  });
  return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

function readConfig (configDir) {
  return yaml.load(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'));
}

function checkConfig (configDir) {
  const check = spawnSync('node', [CHECK_CLI, path.join(configDir, 'pryv-config.yml')], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000
  });
  return { status: check.status, output: check.stdout + check.stderr };
}

/** Every file and directory under `dir`, relative, sorted. */
function listTree (dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const r = rel ? rel + '/' + name : name;
      out.push(r);
      if (fs.statSync(path.join(d, name)).isDirectory()) walk(path.join(d, name), r);
    }
  };
  walk(dir, '');
  return out;
}

// Snapshots of what the wizard writes: the config structure (comments left
// out, so appendix wording can change) and the launcher scripts, with the
// install directory, generated secrets and the date masked.
// UPDATE_INIT_SNAPSHOTS=1 rewrites them.
const SNAPSHOT_DIR = path.resolve(__dirname, 'fixtures/init-wizard');
const SECRET_KEYS = new Set(['adminAccessKey', 'filesReadTokenSecret', 'stateKey', 'piiHmacKey', 'atRestKey']);

function snapshotOf (configDir) {
  const mask = (v, key) => {
    if (SECRET_KEYS.has(key)) return '<secret>';
    if (key === 'serial') return '<date>';
    if (typeof v === 'string') return v.split(configDir).join('<DIR>');
    if (Array.isArray(v)) return v.map((x) => mask(x, null));
    if (v != null && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = mask(x, k);
      return o;
    }
    return v;
  };
  // `ca.srl` (the CA's serial file) is written by some OpenSSL versions only.
  const files = listTree(configDir).filter((f) => f !== 'answers.yml' && !f.endsWith('/ca.srl'));
  const launchers = {};
  for (const f of ['run-pryv.sh', 'check-config.sh', 'config-to-env.sh']) {
    if (fs.existsSync(path.join(configDir, f))) launchers[f] = fs.readFileSync(path.join(configDir, f), 'utf8').split(configDir).join('<DIR>');
  }
  return { files, config: mask(readConfig(configDir), null), launchers };
}

function assertSnapshot (name, configDir) {
  const actual = snapshotOf(configDir);
  const file = path.join(SNAPSHOT_DIR, name + '.json');
  if (process.env.UPDATE_INIT_SNAPSHOTS === '1') {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  assert.ok(fs.existsSync(file), `snapshot ${file} missing (run with UPDATE_INIT_SNAPSHOTS=1)`);
  assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')));
}

const DNS_ACTIVE_ANSWERS = ANSWERS.replace(/^dnsless:.*\n/m, 'dnsless: false\n')
  .replace(/^publicurl:.*\n/m, 'dnsdomain: example.invalid\npublicip: 192.0.2.10\n');

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

  it('[INWZA] the OAuth consent page defaults to the auth UI\'s /oauth2-authorize route, a key default-config.yml also carries; a consent-state key of its own is generated', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const config = yaml.load(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'));
    assert.strictEqual(config.oauth.consentUrl, 'https://account.example.com/oauth2-authorize');
    const defaults = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config/default-config.yml'), 'utf8'));
    assert.ok(Object.hasOwn(defaults.oauth, 'consentUrl'), 'default-config.yml declares oauth.consentUrl');
    // The consent-state key is generated, of its own (not the admin key).
    assert.ok(typeof config.oauth.stateKey === 'string' && config.oauth.stateKey.length >= 32, 'oauth.stateKey generated');
    assert.notStrictEqual(config.oauth.stateKey, config.auth.adminAccessKey);
    assert.ok(Object.hasOwn(defaults.oauth, 'stateKey'), 'default-config.yml declares oauth.stateKey');
  });

  it('[INWZB] a sign-in state key of its own is generated, distinct from the admin and consent-state keys', () => {
    const res = runWizard(configDir);
    assert.strictEqual(res.status, 0, res.output);
    const config = yaml.load(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'));
    assert.ok(typeof config.sso.stateKey === 'string' && config.sso.stateKey.length >= 32, 'sso.stateKey generated');
    assert.notStrictEqual(config.sso.stateKey, config.auth.adminAccessKey);
    assert.notStrictEqual(config.sso.stateKey, config.oauth.stateKey);
    // Sign-in stays off until the operator turns it on.
    assert.notStrictEqual(config.sso.enabled, true);
    const defaults = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config/default-config.yml'), 'utf8'));
    assert.ok(Object.hasOwn(defaults.sso, 'stateKey'), 'default-config.yml declares sso.stateKey');
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

describe('[INWP] bin/init.js profiles, diagnostics, cluster gating, PaaS mode and portal entry', function () {
  this.timeout(120000);
  let configDir;

  before(function () {
    if (process.platform === 'win32') this.skip();
  });

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-wizard-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  describe('--profile', () => {
    it('[INWP1] --profile=dev --non-interactive writes a working config with no prompt', () => {
      const res = runCli(configDir, ['--profile=dev', '--non-interactive']);
      assert.strictEqual(res.status, 0, res.output);
      const config = readConfig(configDir);
      assert.strictEqual(config.dnsLess.isActive, true);
      assert.strictEqual(config.dnsLess.publicUrl, 'http://127.0.0.1:3000');
      assert.strictEqual(config.http.port, 3000);
      assert.strictEqual(config.storages.base.engine, 'sqlite');
      const check = checkConfig(configDir);
      assert.strictEqual(check.status, 0, check.output);
    });

    it('[INWP2] a --config-from answer wins over the env, which wins over the profile', () => {
      let res = runCli(configDir, ['--profile=ci', '--non-interactive']);
      assert.strictEqual(res.status, 0, res.output);
      assert.strictEqual(readConfig(configDir).service.name, 'Pryv CI');

      res = runCli(configDir, ['--profile=ci', '--non-interactive', '--force'], { PRYV_INIT_SERVICE_NAME: 'From env' });
      assert.strictEqual(res.status, 0, res.output);
      assert.strictEqual(readConfig(configDir).service.name, 'From env');

      const answersFile = path.join(configDir, 'answers.yml');
      fs.writeFileSync(answersFile, 'service.name: From file\n');
      res = runCli(configDir, ['--profile=ci', '--non-interactive', '--force', '--config-from=' + answersFile], { PRYV_INIT_SERVICE_NAME: 'From env' });
      assert.strictEqual(res.status, 0, res.output);
      assert.strictEqual(readConfig(configDir).service.name, 'From file');
    });

    it('[INWP3] an unknown profile is refused and nothing is written', () => {
      const res = runCli(configDir, ['--profile=nope', '--non-interactive']);
      assert.strictEqual(res.status, 2, res.output);
      assert.match(res.output, /unknown profile "nope"/);
      assert.match(res.output, /dev/);
      assert.deepStrictEqual(fs.readdirSync(configDir), []);
    });

    it('[INWP4] a profile that leaves a required answer out fails under --non-interactive, naming it', () => {
      const res = runCli(configDir, ['--profile=production-dnsless', '--non-interactive']);
      assert.strictEqual(res.status, 2, res.output);
      assert.match(res.output, /PRYV_INIT_PUBLICURL/);
      assert.ok(!fs.existsSync(path.join(configDir, 'pryv-config.yml')));
    });

    it('[INWP5] every shipped profile matches its snapshot', () => {
      const cases = [
        ['dev', {}],
        ['ci', {}],
        ['production-dnsless', { PRYV_INIT_PUBLICURL: 'https://pryv.example.com' }],
        ['production-subdomains', { PRYV_INIT_DNSDOMAIN: 'example.invalid', PRYV_INIT_PUBLICIP: '192.0.2.10' }]
      ];
      for (const [profile, env] of cases) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-wizard-'));
        try {
          const res = runCli(dir, ['--profile=' + profile, '--non-interactive'], env);
          assert.strictEqual(res.status, 0, profile + ': ' + res.output);
          assertSnapshot('profile-' + profile, dir);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('[INWP6] with no portal, the default answers give the same files as before the portal step', () => {
      // The snapshot was recorded with the wizard as it was before the portal,
      // cluster and profile steps existed, from these same answers.
      const res = runWizard(configDir, [], ANSWERS + 'portal.mode: none\n');
      assert.strictEqual(res.status, 0, res.output);
      assertSnapshot('default-dnsless-before-portal', configDir);
    });
  });

  describe('--diagnose', () => {
    it('[INWP7] reports a taken DNS port, exits 1 and writes nothing', async () => {
      const holder = (await import('node:dgram')).createSocket('udp4');
      await new Promise((resolve) => holder.bind(0, '0.0.0.0', resolve));
      const takenPort = holder.address().port;
      const freeHttp = await freeTcpPort();
      try {
        fs.writeFileSync(path.join(configDir, 'pryv-config.yml'), yaml.dump({
          dnsLess: { isActive: false },
          dns: { active: true, domain: 'example.invalid', port: takenPort },
          http: { port: freeHttp }
        }));
        const before = listTree(configDir);
        const res = runCli(configDir, ['--diagnose']);
        assert.strictEqual(res.status, 1, res.output);
        assert.match(res.output, new RegExp(`Port ${takenPort}/udp is already in use`));
        assert.match(res.output, /systemd-resolved/);
        assert.deepStrictEqual(listTree(configDir), before);
      } finally {
        holder.close();
      }
    });

    it('[INWP8] exits 0 on a dnsLess config whose port is free, without a TTY or a prompt', async () => {
      const freeHttp = await freeTcpPort();
      fs.writeFileSync(path.join(configDir, 'pryv-config.yml'), yaml.dump({
        dnsLess: { isActive: true, publicUrl: 'https://pryv.example.com' },
        http: { port: freeHttp }
      }));
      const before = listTree(configDir);
      const res = runCli(configDir, ['--diagnose']);
      assert.strictEqual(res.status, 0, res.output);
      assert.match(res.output, new RegExp(`${freeHttp}/tcp is free`));
      assert.match(res.output, /No problem found/);
      assert.deepStrictEqual(listTree(configDir), before);
    });
  });

  describe('cluster gating', () => {
    it('[INWP9] dnsLess asks no cluster question (a cluster answer is reported unused)', () => {
      const res = runWizard(configDir, [], ANSWERS + 'cluster.mode: join\n');
      assert.strictEqual(res.status, 0, res.output);
      assert.match(res.output, /keys no prompt asked for[^\n]*cluster\.mode/);
      assert.ok(fs.existsSync(path.join(configDir, 'pryv-config.yml')));
      assert.strictEqual(readConfig(configDir).storages.engines.rqlite.tls, undefined);
    });

    it('[INWPA] joining an existing cluster prints the bootstrap procedure and writes nothing', () => {
      const res = runWizard(configDir, [], DNS_ACTIVE_ANSWERS + 'cluster.mode: join\n');
      assert.strictEqual(res.status, 0, res.output);
      assert.match(res.output, /bin\/bootstrap\.js new-core --id/);
      assert.match(res.output, /bin\/master\.js --bootstrap/);
      assert.deepStrictEqual(fs.readdirSync(configDir), ['answers.yml']);
    });

    it('[INWPB] starting a new platform leaves this core initialised as the cluster CA holder', () => {
      const res = runWizard(configDir, [], DNS_ACTIVE_ANSWERS + 'cluster.mode: new\n');
      assert.strictEqual(res.status, 0, res.output);
      const config = readConfig(configDir);
      const clusterDir = path.join(configDir, 'data', 'cluster');
      assert.strictEqual(config.cluster.ca.path, path.join(clusterDir, 'ca'));
      assert.strictEqual(config.cluster.tokens.path, path.join(clusterDir, 'bootstrap-tokens.json'));
      const tls = config.storages.engines.rqlite.tls;
      assert.deepStrictEqual(tls, {
        caFile: path.join(clusterDir, 'tls', 'ca.crt'),
        certFile: path.join(clusterDir, 'tls', 'node.crt'),
        keyFile: path.join(clusterDir, 'tls', 'node.key'),
        verifyClient: true
      });
      for (const f of [path.join(clusterDir, 'ca', 'ca.crt'), path.join(clusterDir, 'ca', 'ca.key'), tls.caFile, tls.certFile, tls.keyFile]) {
        assert.ok(fs.existsSync(f), f + ' exists');
      }
      assert.strictEqual((fs.statSync(tls.keyFile).mode & 0o777).toString(8), '600');
      // the node certificate is signed by the cluster CA and names this host
      const ca = new crypto.X509Certificate(fs.readFileSync(path.join(clusterDir, 'ca', 'ca.crt')));
      const node = new crypto.X509Certificate(fs.readFileSync(tls.certFile));
      assert.ok(node.verify(ca.publicKey), 'node certificate signed by the cluster CA');
      assert.match(node.subjectAltName, /DNS:core\.example\.invalid/);
      assert.match(node.subjectAltName, /192\.0\.2\.10/);
      assert.match(res.output, /BACK UP .*cluster\/ca/);
      const check = checkConfig(configDir);
      assert.strictEqual(check.status, 0, check.output);
    });

    it('[INWPK] with subdomains, the URL the core derives for itself is the host the wizard announces and the first boot publishes', () => {
      const res = runWizard(configDir, [], DNS_ACTIVE_ANSWERS + 'cluster.mode: new\n');
      assert.strictEqual(res.status, 0, res.output);
      const config = readConfig(configDir);
      // What boot derives (the plugin reads the operator's layers: this file).
      const get = (key) => key.split(':').reduce((o, k) => (o == null ? undefined : o[k]), config);
      const { deriveCoreIdentity } = createRequire(import.meta.url)(path.join(REPO_ROOT, 'config/plugins/core-identity.js'));
      const { coreUrl } = deriveCoreIdentity(get);
      // master.js publishes `A core.<domain>` (and NS core.<domain>) on first boot.
      assert.strictEqual(coreUrl, 'https://core.example.invalid');
      assert.match(res.output, /curl https:\/\/core\.example\.invalid\/reg\/service\/info/);
      assert.strictEqual(checkConfig(configDir).status, 0);
    });

    it('[INWPC] --dry-run on a new platform creates no CA', () => {
      const res = runWizard(configDir, ['--dry-run'], DNS_ACTIVE_ANSWERS + 'cluster.mode: new\n');
      assert.strictEqual(res.status, 0, res.output);
      assert.match(res.output, /DRY-RUN would initialise the cluster CA/);
      assert.deepStrictEqual(fs.readdirSync(configDir), ['answers.yml']);
    });
  });

  describe('--inside-paas', () => {
    const PAAS_ANSWERS = 'publicurl: https://pryv.example.com\nportal.mode: none\n';

    it('[INWPD] forces dnsLess and TLS none, and leaves the PostgreSQL connection to DATABASE_URL', () => {
      const res = runWizard(configDir, ['--inside-paas'], PAAS_ANSWERS, { DATABASE_URL: 'postgres://u:p4ss-word@db.internal:5432/pryv' });
      assert.strictEqual(res.status, 0, res.output);
      const raw = fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8');
      const config = yaml.load(raw);
      assert.strictEqual(config.dnsLess.isActive, true);
      assert.strictEqual(config.http.port, 3000);
      assert.strictEqual(config.http.ssl, undefined);
      assert.strictEqual(config.letsEncrypt, undefined);
      assert.strictEqual(config.storages.base.engine, 'postgresql');
      assert.strictEqual(config.storages.engines.postgresql, undefined, 'no connection written');
      assert.ok(!raw.includes('p4ss-word') && !res.output.includes('p4ss-word'), 'the DATABASE_URL password is neither written nor printed');
      assert.match(res.output, /DATABASE_URL/);
    });

    it('[INWPE] an answer that contradicts --inside-paas is refused', () => {
      const res = runWizard(configDir, ['--inside-paas'], PAAS_ANSWERS + 'tls.strategy: letsEncrypt\n');
      assert.strictEqual(res.status, 2, res.output);
      assert.match(res.output, /--inside-paas forces TLS "none"/);
      assert.ok(!fs.existsSync(path.join(configDir, 'pryv-config.yml')));
    });

    it('[INWPF] an invalid DATABASE_URL is refused without printing it', () => {
      const res = runWizard(configDir, ['--inside-paas'], PAAS_ANSWERS, { DATABASE_URL: 'mysql://u:s3cret@h/d' });
      assert.strictEqual(res.status, 2, res.output);
      assert.match(res.output, /DATABASE_URL/);
      assert.ok(!res.output.includes('s3cret'));
    });
  });

  describe('administration portal entry', () => {
    it('[INWPG] dnsLess default: the published prefixed build proxied under /admin/, with the core\'s CSP', () => {
      const res = runWizard(configDir);
      assert.strictEqual(res.status, 0, res.output);
      const config = readConfig(configDir);
      assert.deepStrictEqual(config.portal, { site: 'admin' });
      assert.match(config.hostedSites.admin.proxy, /^https:\/\/pryv\.github\.io\/app-web-platform-portal\/\d+\.\d+\.\d+\/prefixed\/$/);
      const csp = config.hostedSites.admin.headers['content-security-policy'];
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /connect-src 'self';/);
      assert.match(res.output, /https:\/\/core\.example\.com\/admin\//);
      const check = checkConfig(configDir);
      assert.strictEqual(check.status, 0, check.output);
    });

    it('[INWPH] DNS topology: the root build on admin.<domain>, API calls allowed to the platform hosts', () => {
      const res = runWizard(configDir, [], DNS_ACTIVE_ANSWERS);
      assert.strictEqual(res.status, 0, res.output);
      const config = readConfig(configDir);
      assert.match(config.hostedSites.admin.proxy, /\/root\/$/);
      assert.match(config.hostedSites.admin.headers['content-security-policy'], /connect-src 'self' https:\/\/\*\.example\.invalid;/);
      assert.match(res.output, /https:\/\/admin\.example\.invalid\//);
    });

    it('[INWPI] static mode serves a folder, under a name the operator chooses', () => {
      const res = runWizard(configDir, [], ANSWERS + 'portal.mode: static\nportal.site: console\n');
      assert.strictEqual(res.status, 0, res.output);
      const config = readConfig(configDir);
      assert.deepStrictEqual(config.portal, { site: 'console' });
      assert.strictEqual(config.hostedSites.console.static, path.join(configDir, 'sites', 'console'));
      assert.strictEqual(config.hostedSites.admin, undefined);
      assert.match(res.output, /No index\.html in/);
    });

    it('[INWPJ] none writes no hosted site; a name reserved for an API route is refused', () => {
      let res = runWizard(configDir, [], ANSWERS + 'portal.mode: none\n');
      assert.strictEqual(res.status, 0, res.output);
      assert.strictEqual(readConfig(configDir).hostedSites, undefined);
      assert.strictEqual(readConfig(configDir).portal, undefined);

      res = runWizard(configDir, ['--force'], ANSWERS + 'portal.site: system\n');
      assert.match(res.output, /Administration portal: hostedSites\.system/);
    });
  });

  describe('setup-code handoff', () => {
    it('[INWPL] Next steps name the setup page and where the code appears; no setup block is written by default', () => {
      const res = runWizard(configDir);
      assert.strictEqual(res.status, 0, res.output);
      assert.match(res.output, /Platform setup \(first administrator\)/);
      assert.match(res.output, /https:\/\/<this host's IP>\/system\/setup\//);
      assert.match(res.output, /https:\/\/core\.example\.com\/system\/setup\//);
      assert.match(res.output, /setup-code\.txt/);
      assert.match(res.output, /bin\/admin\.js setup-code --new/);
      assert.strictEqual(readConfig(configDir).setup, undefined);
      assert.match(fs.readFileSync(path.join(configDir, 'pryv-config.yml'), 'utf8'), /# # setup:\n# # {3}codeTtlHours: 24/, 'the appendix mirrors the setup keys');
    });

    it('[INWPM] --setup-code-hash (or setup.codeHash) is written as setup.codeHash; a malformed one is refused', () => {
      const { generateCode, hashCode } = createRequire(import.meta.url)('business/src/admin/codes.ts');
      const hash = hashCode(generateCode());
      let res = runWizard(configDir, ['--setup-code-hash=' + hash.toUpperCase()]);
      assert.strictEqual(res.status, 0, res.output);
      assert.deepStrictEqual(readConfig(configDir).setup, { codeHash: hash });
      assert.match(res.output, /prints none/);
      const check = checkConfig(configDir);
      assert.strictEqual(check.status, 0, check.output);
      res = runWizard(configDir, ['--force'], ANSWERS + 'setup.codeHash: ' + hash + '\n');
      assert.strictEqual(res.status, 0, res.output);
      assert.deepStrictEqual(readConfig(configDir).setup, { codeHash: hash });
      res = runWizard(configDir, ['--force', '--setup-code-hash=abc']);
      assert.strictEqual(res.status, 2, res.output);
      assert.match(res.output, /setup\.codeHash/);
    });
  });
});

/** A TCP port free at the time of the call. */
async function freeTcpPort () {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '0.0.0.0', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
