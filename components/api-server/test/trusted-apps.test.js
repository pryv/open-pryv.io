/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../');

describe('[TRUST] auth.trustedApps origin matching', () => {
  const { parseTrustedApps, isTrustedApp } = require('business/src/auth/trustedApps.ts');
  const { getTrustedAppCheck } = require('api-server/src/methods/helpers/commonFunctions.ts');

  function trusted (setting, appId, origin) {
    const { apps, errors } = parseTrustedApps(setting);
    assert.deepStrictEqual(errors, [], 'setting parses');
    return isTrustedApp(apps, appId, origin);
  }

  // Runs the real method-chain step and reports whether it let the call through.
  function checkPasses (authSettings, params) {
    let passed = null;
    getTrustedAppCheck(() => authSettings)({}, params, {}, (err) => { passed = err == null; });
    return passed;
  }

  const LOOK_ALIKES = [
    'https://x.pryv.me.attacker.example',
    'https://a.pryv.messages.example',
    'https://attacker.example/x.pryv.me', // a Referer naming the host in its path
    'https://x.pryv.me@attacker.example/',
    'https://pryv.me.attacker.example'
  ];

  it('[TRUST1] a leading *. label matches real subdomains only, never a look-alike host', () => {
    const setting = '*@https://*.pryv.me';
    for (const origin of LOOK_ALIKES) {
      assert.strictEqual(trusted(setting, 'any-app', origin), false, origin);
    }
    assert.strictEqual(trusted(setting, 'any-app', 'https://x.pryv.me'), true);
    assert.strictEqual(trusted(setting, 'any-app', 'https://a.b.pryv.me'), true);
    assert.strictEqual(trusted(setting, 'any-app', 'https://pryv.me'), false, 'the parent domain is not a subdomain');
    assert.strictEqual(trusted(setting, 'any-app', 'http://x.pryv.me'), false, 'scheme must match');
    assert.strictEqual(trusted(setting, 'any-app', 'https://x.pryv.me:8443'), false, 'port must match');
  });

  it('[TRUST2] a legacy trailing * still accepts the real subdomain (any port) and still refuses look-alikes', () => {
    const setting = '*@https://*.pryv.me*';
    for (const origin of LOOK_ALIKES) {
      assert.strictEqual(trusted(setting, 'any-app', origin), false, origin);
    }
    assert.strictEqual(trusted(setting, 'any-app', 'https://x.pryv.me'), true);
    assert.strictEqual(trusted(setting, 'any-app', 'https://x.pryv.me:8443'), true);
    assert.strictEqual(trusted('*@https://app.example.com:8443*', 'a', 'https://app.example.com:8443'), true);
    assert.strictEqual(trusted('*@https://app.example.com:8443*', 'a', 'https://app.example.com:84431'), false);
  });

  it('[TRUST3] a Referer is reduced to its origin: a path or query does not matter', () => {
    const setting = 'my-app@https://app.example.com';
    assert.strictEqual(trusted(setting, 'my-app', 'https://app.example.com/some/page?x=1#y'), true);
    assert.strictEqual(trusted(setting, 'my-app', 'https://app.example.com'), true);
    assert.strictEqual(trusted('my-app@https://app.example.com/only/here', 'my-app', 'https://app.example.com/elsewhere'), true);
  });

  it('[TRUST4] app id semantics: exact id, * for any id, a missing id is never trusted', () => {
    const setting = 'my-app@https://app.example.com, *@https://other.example.com';
    assert.strictEqual(trusted(setting, 'my-app', 'https://app.example.com'), true);
    assert.strictEqual(trusted(setting, 'other-app', 'https://app.example.com'), false);
    assert.strictEqual(trusted(setting, 'other-app', 'https://other.example.com'), true);
    assert.strictEqual(trusted(setting, undefined, 'https://other.example.com'), false);
    assert.strictEqual(trusted(setting, '', 'https://other.example.com'), false);
    // `*` as the origin accepts any origin, including none (non-browser clients).
    assert.strictEqual(trusted('no-cors@*', 'no-cors', undefined), true);
    assert.strictEqual(trusted('no-cors@*', 'no-cors', 'https://anything.example'), true);
    assert.strictEqual(trusted(setting, 'my-app', undefined), false);
    assert.strictEqual(trusted(setting, 'my-app', 'not a url'), false);
  });

  it('[TRUST5] exact origins compare scheme, host and port; :* accepts any port', () => {
    assert.strictEqual(trusted('*@http://127.0.0.1:3000', 'a', 'http://127.0.0.1:3000'), true);
    assert.strictEqual(trusted('*@http://127.0.0.1:3000', 'a', 'http://127.0.0.1:3001'), false);
    assert.strictEqual(trusted('*@https://app.example.com:443', 'a', 'https://app.example.com'), true);
    assert.strictEqual(trusted('*@http://127.0.0.1:*', 'a', 'http://127.0.0.1:4321'), true);
    assert.strictEqual(trusted('*@http://127.0.0.1:*', 'a', 'http://127.0.0.10:4321'), false);
  });

  it('[TRUST6] malformed entries are reported, the valid ones kept', () => {
    const { apps, errors } = parseTrustedApps(
      '*@https://pryv.*.me, *@https://*pryv.me, *@localhost, broken, *@https://u:p@x.example.com, *@https://*., ok@https://ok.example.com,');
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].appId, 'ok');
    assert.strictEqual(errors.length, 6, JSON.stringify(errors));
    assert.ok(errors.some((e) => /pryv\.\*\.me.*only allowed as the whole first label/.test(e)));
    assert.ok(errors.some((e) => /localhost.*not a URL/.test(e)));
    assert.ok(errors.some((e) => /broken.*<appId>@<origin>/.test(e)));
    // The app id runs to the last '@', so credentials leave a host-less origin.
    assert.ok(errors.some((e) => /u:p@x\.example\.com.*not a URL/.test(e)));
  });

  it('[TRUST7] the method step refuses look-alikes, accepts the real subdomain, and refuses (without throwing) when the setting is absent', () => {
    const auth = { trustedApps: '*@https://*.pryv.me*' };
    assert.strictEqual(checkPasses(auth, { appId: 'a', origin: 'https://x.pryv.me.attacker.example' }), false);
    assert.strictEqual(checkPasses(auth, { appId: 'a', origin: 'https://x.pryv.me/login' }), true);
    assert.strictEqual(checkPasses({}, { appId: 'a', origin: 'https://x.pryv.me' }), false);
    assert.strictEqual(checkPasses(undefined, { appId: 'a', origin: 'https://x.pryv.me' }), false);
  });
});

describe('[CVTA] config-validation auth.trustedApps', () => {
  const { checkTrustedApps } = require('../../../config/plugins/config-validation.js');
  function problemsFor (value) {
    const problems = [];
    checkTrustedApps({ get: (key) => (key === 'auth:trustedApps' ? value : undefined) }, problems);
    return problems;
  }

  it('[CVTA1] a missing or empty auth.trustedApps refuses the boot', () => {
    for (const value of [undefined, null, '', '   ']) {
      const problems = problemsFor(value);
      assert.strictEqual(problems.length, 1, JSON.stringify(value));
      assert.deepStrictEqual(problems[0].path, ['auth', 'trustedApps']);
      assert.match(problems[0].message, /missing or empty/);
    }
  });

  it('[CVTA2] every entry must parse', () => {
    const problems = problemsFor('*@https://ok.example.com, *@https://pryv.*.me');
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /only allowed as the whole first label/);
  });

  it('[CVTA3] valid settings, including the legacy trailing * form, pass', () => {
    assert.deepStrictEqual(problemsFor('*@https://*.example.com*, app@https://app.example.com, x@*'), []);
    for (const file of ['test-config.yml', 'development-config.yml']) {
      const yaml = require('js-yaml');
      const doc = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', file), 'utf8'));
      assert.deepStrictEqual(problemsFor(doc.auth.trustedApps), [], file);
    }
  });
});

describe('[CVLY] production base layer is deployment-neutral', function () {
  this.timeout(60000);

  // Boots the real config chain (boiler) in a child process: NODE_ENV=production,
  // no --config, so `production-config.yml` is layered between an override that
  // only carries `service.*` and `default-config.yml`, as in the Docker image.
  function loadProductionChain () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-layer-'));
    try {
      for (const file of ['default-config.yml', 'production-config.yml']) {
        fs.copyFileSync(path.join(REPO_ROOT, 'config', file), path.join(dir, file));
      }
      fs.writeFileSync(path.join(dir, 'override-config.yml'), [
        'service:',
        '  name: Layer Test',
        '  serial: "2026100701"',
        '  home: https://example.com',
        '  support: https://example.com/support',
        '  terms: https://example.com/terms',
        '  eventTypes: https://example.com/event-types.json',
        ''
      ].join('\n'));
      const probe = `
        const path = require('node:path');
        const [boilerPath, validationPath, pathsPlugin, configDir] = process.argv.slice(1);
        const boiler = require(boilerPath);
        boiler.init({
          appName: 'layer-probe',
          baseConfigDir: configDir,
          baseFilesDir: configDir,
          extraConfigs: [{ scope: 'default-paths', file: pathsPlugin }]
        });
        (async () => {
          const config = await boiler.getConfig();
          const { validate, collectWarnings } = require(validationPath);
          const problems = await validate(config);
          process.stdout.write(JSON.stringify({
            problems: problems.map((p) => (p.path || []).join(':') + ' ' + p.message),
            warnings: collectWarnings(config),
            values: {
              trustedApps: config.get('auth:trustedApps') ?? null,
              passwordResetPageURL: config.get('auth:passwordResetPageURL') ?? null,
              emailVerificationPageURL: config.get('auth:emailVerificationPageURL') ?? null,
              emailMethod: config.get('services:email:method') ?? null,
              adminAccessKey: config.get('auth:adminAccessKey') ?? null,
              sessionMaxAge: config.get('auth:sessionMaxAge') ?? null
            }
          }));
          process.exit(0);
        })().catch((err) => { process.stderr.write(String(err && err.stack)); process.exit(2); });
      `;
      const res = spawnSync(process.execPath, ['-e', probe,
        require.resolve('@pryv/boiler'),
        path.join(REPO_ROOT, 'config/plugins/config-validation.js'),
        path.join(REPO_ROOT, 'config/plugins/paths-config.js'),
        dir
      ], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 45000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' }
      });
      assert.strictEqual(res.status, 0, res.stderr + res.stdout);
      return JSON.parse(res.stdout.slice(res.stdout.indexOf('{"problems"')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('[CVLY1] an override with only service.* boots with nothing inherited: secrets, page URLs and trustedApps are reported', () => {
    const { problems, warnings, values } = loadProductionChain();
    const has = (re) => problems.some((p) => re.test(p));
    assert.ok(has(/^auth:adminAccessKey /), JSON.stringify(problems, null, 2));
    assert.ok(has(/^auth:filesReadTokenSecret /), JSON.stringify(problems, null, 2));
    assert.ok(has(/^auth:passwordResetPageURL /), JSON.stringify(problems, null, 2));
    assert.ok(has(/^auth:trustedApps .*missing or empty/), JSON.stringify(problems, null, 2));
    // PII is hashed by default, so the shipped chain requires the pepper.
    assert.ok(has(/^platform:piiHmacKey .*missing or unset/), JSON.stringify(problems, null, 2));
    // Verification mail is on by default: its missing page URL is reported at boot.
    assert.ok(warnings.some((w) => /auth\.emailVerificationPageURL' is not set/.test(w)), JSON.stringify(warnings, null, 2));
    assert.deepStrictEqual(values, {
      trustedApps: null,
      passwordResetPageURL: null,
      emailVerificationPageURL: null,
      emailMethod: 'in-process',
      adminAccessKey: null,
      sessionMaxAge: 1209600000
    });
  });

  it('[CVLY2] production-config.yml carries no secret, origin, page URL, mail or registry setting', () => {
    const yaml = require('js-yaml');
    const doc = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config/production-config.yml'), 'utf8'));
    assert.deepStrictEqual(Object.keys(doc).sort(), ['auth', 'env', 'http', 'logs']);
    assert.deepStrictEqual(Object.keys(doc.auth).sort(), ['passwordResetRequestMaxAge', 'sessionMaxAge']);
  });
});
