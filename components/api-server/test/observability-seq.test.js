/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Observability tests.
 *
 * Covers:
 *   [OB01] Platform.getObservabilityConfig encrypts/decrypts license key round-trip
 *   [OB02] local `observability.enabled: false` overrides PlatformDB true
 *   [OB03] appName falls back to `open-pryv.io (<dns.domain>)` when unset
 *   [OB04] hostname derived from `new URL(core.url).hostname`
 *   [OB05] façade is no-op when no provider attached
 *   [OB06] shim bypasses in NODE_ENV=test
 *   [OB07] shim no-ops when PRYV_OBSERVABILITY_PROVIDER unset
 *   [OB08] logForwarder forwards ONLY errors at default log level
 *   [OB09] logForwarder forwards warns when log level is raised to 'warn'
 *
 * Sequential because it mutates PlatformDB + process.env + global façade state.
 */

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cuid = require('cuid');

const { getConfig } = require('@pryv/boiler');
const { platform } = require('platform');
const observability = require('business/src/observability');
const logForwarder = require('business/src/observability/logForwarder');
const { buildObservabilityEnv } = require('business/src/observability/envBuilder');

function getPlatformDB () {
  return require('storages').platformDB;
}

describe('[OBS] observability', function () {
  this.timeout(10000);

  let config;

  before(async function () {
    config = await getConfig();
    await platform.init();
  });

  afterEach(function () {
    observability._reset();
    logForwarder.setLogLevel('error');
  });

  describe('[OB-PF] Platform.getObservabilityConfig', function () {
    beforeEach(async function () {
      const values = await getPlatformDB().getAllObservabilityValues();
      for (const { key } of values) {
        await getPlatformDB().deleteObservabilityValue(key);
      }
    });

    it('[OB01] encrypts and decrypts the newrelic license key round-trip', async function () {
      const licenseKey = 'test-license-' + cuid();
      await platform.setObservabilityValue('enabled', true);
      await platform.setObservabilityValue('provider', 'newrelic');
      await platform.setObservabilityValue('newrelic-license-key', licenseKey);

      // Raw storage MUST be encrypted envelope — not plaintext.
      const rawStored = await getPlatformDB().getObservabilityValue('newrelic-license-key');
      assert.notStrictEqual(rawStored, licenseKey, 'raw PlatformDB value must not be plaintext');
      assert.ok(rawStored.length > licenseKey.length, 'envelope should be larger than plaintext');

      // getObservabilityConfig must decrypt correctly.
      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.enabled, true);
      assert.strictEqual(obs.provider, 'newrelic');
      assert.strictEqual(obs.newrelic.licenseKey, licenseKey);
    });

    it('[OB02] local observability.enabled:false overrides PlatformDB true', async function () {
      await platform.setObservabilityValue('enabled', true);
      config.injectTestConfig({ observability: { enabled: false } });

      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.enabled, false, 'local false must win');

      config.injectTestConfig({ observability: {} });
    });

    it('[OB03] appName falls back to open-pryv.io (<dns.domain>) when unset', async function () {
      const domain = 'ob03-' + cuid() + '.test';
      config.injectTestConfig({ dns: { domain }, observability: {} });

      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.appName, 'open-pryv.io (' + domain + ')');
    });

    it('[OB04] hostname derived from new URL(core.url).hostname', async function () {
      const coreUrl = 'https://core-ob04.example.com';
      config.injectTestConfig({ core: { url: coreUrl }, observability: {} });

      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.hostname, 'core-ob04.example.com');
    });
  });

  describe('[OB-FC] façade behaviour', function () {
    it('[OB05] façade is no-op when no provider attached', function () {
      observability._reset();
      assert.strictEqual(observability.isActive(), false);
      // All methods must be safe to call without a provider.
      observability.setTransactionName('x');
      observability.recordError(new Error('y'), { z: 1 });
      observability.recordCustomEvent('PryvLog', { level: 'error', msg: 'z' });
    });
  });

  describe('[OB-SH] bin/_observability-boot shim', function () {
    const shimPath = path.resolve(__dirname, '../../../bin/_observability-boot.js');

    it('[OB06] returns `{activated:false, reason:"NODE_ENV=test"}` in test mode', function () {
      const result = spawnSync('node', ['-e',
        'process.env.NODE_ENV = "test"; console.log(JSON.stringify(require("' + shimPath + '")));'
      ], { encoding: 'utf8' });
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.activated, false);
      assert.match(parsed.reason, /NODE_ENV=test/);
    });

    it('[OB07] no-ops when PRYV_OBSERVABILITY_PROVIDER unset', function () {
      const result = spawnSync('node', ['-e',
        'delete process.env.NODE_ENV; delete process.env.PRYV_OBSERVABILITY_PROVIDER; ' +
        'console.log(JSON.stringify(require("' + shimPath + '")));'
      ], { encoding: 'utf8' });
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.activated, false);
      assert.match(parsed.reason, /PRYV_OBSERVABILITY_PROVIDER unset/);
    });

    it('[OB06B] env-set + missing provider module records boot-failure without crashing', function () {
      // Simulate the master having populated env but the provider boot
      // file being absent (future-proofing or a mistyped provider id).
      const result = spawnSync('node', ['-e',
        'delete process.env.NODE_ENV; ' +
        'process.env.PRYV_OBSERVABILITY_PROVIDER = "nonexistent-xyz"; ' +
        'console.log(JSON.stringify(require("' + shimPath + '")));'
      ], { encoding: 'utf8' });
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.activated, false);
      assert.match(parsed.reason, /boot-failure/);
      // Expected: non-fatal. Process must have exited 0 (shim must never
      // crash the host process).
      assert.strictEqual(result.status, 0, 'shim must not crash the host process on boot-failure');
      assert.match(result.stderr, /failed to activate provider "nonexistent-xyz"/);
    });
  });

  describe('[OB-EP] env propagation from Platform.getObservabilityConfig', function () {
    beforeEach(async function () {
      const values = await getPlatformDB().getAllObservabilityValues();
      for (const { key } of values) {
        await getPlatformDB().deleteObservabilityValue(key);
      }
    });

    it('[OB08B] master env object is empty when no provider is enabled', async function () {
      // Reproduce master's check: the config must be "enabled && provider && licenseKey"
      // to emit env for cluster.fork(). Anything else yields an empty env.
      const obs = await platform.getObservabilityConfig();
      const env = buildObservabilityEnv(obs);
      assert.deepStrictEqual(env, {}, 'no provider should yield empty env: ' + JSON.stringify(env));
    });

    it('[OB09B] env has the full shape when enabled + provider + license are set', async function () {
      const coreUrl = 'https://core-ob09b.example.com';
      config.injectTestConfig({ core: { url: coreUrl }, dns: { domain: 'example.com' }, observability: {} });
      await platform.setObservabilityValue('enabled', true);
      await platform.setObservabilityValue('provider', 'newrelic');
      await platform.setObservabilityValue('newrelic-license-key', 'test-license-xyz-01234567890123456789');
      await platform.setObservabilityValue('log-level', 'warn');
      await platform.setObservabilityValue('app-name', 'test-cluster-app');

      const obs = await platform.getObservabilityConfig();
      const env = buildObservabilityEnv(obs);

      assert.strictEqual(env.PRYV_OBSERVABILITY_PROVIDER, 'newrelic');
      assert.strictEqual(env.NEW_RELIC_LICENSE_KEY, 'test-license-xyz-01234567890123456789');
      assert.strictEqual(env.NEW_RELIC_APP_NAME, 'test-cluster-app');
      assert.strictEqual(env.NEW_RELIC_PROCESS_HOST_DISPLAY_NAME, 'core-ob09b.example.com');
      assert.strictEqual(env.NEW_RELIC_LOG_LEVEL, 'warn');
      assert.strictEqual(env.NEW_RELIC_HIGH_SECURITY, 'true');
      assert.ok(env.NEW_RELIC_HOME, 'NEW_RELIC_HOME must point at the provider config dir');
    });
  });

  describe('[OB-LF] logForwarder', function () {
    let calls;
    let mockAdapter;

    beforeEach(function () {
      observability._reset();
      calls = [];
      mockAdapter = {
        id: 'mock',
        setTransactionName () { /* noop */ },
        recordError (err, attrs) { calls.push({ kind: 'error', msg: err.message, attrs }); },
        recordCustomEvent (type, attrs) { calls.push({ kind: 'event', type, attrs }); },
        async startBackgroundTransaction (name, fn) { return fn(); }
      };
      observability.init(mockAdapter);
    });

    it('[OB08] default log level forwards only errors', function () {
      logForwarder.setLogLevel('error');
      const base = {
        error (msg) { /* base logger */ },
        warn (msg) { /* base logger */ },
        info (msg) { /* base logger */ },
        debug (msg) { /* base logger */ }
      };
      const wrapped = logForwarder.wrap(base, 'test-logger');
      wrapped.error('boom');
      wrapped.warn('soft');
      wrapped.info('chatter');
      wrapped.debug('noise');

      assert.strictEqual(calls.length, 1, 'only the error call should forward');
      assert.strictEqual(calls[0].kind, 'error');
      assert.strictEqual(calls[0].msg, 'boom');
    });

    it('[OB09] log level "warn" forwards errors + warns, not info/debug', function () {
      logForwarder.setLogLevel('warn');
      const base = {
        error (msg) { /* base logger */ },
        warn (msg) { /* base logger */ },
        info (msg) { /* base logger */ },
        debug (msg) { /* base logger */ }
      };
      const wrapped = logForwarder.wrap(base, 'test-logger');
      wrapped.error('boom');
      wrapped.warn('soft');
      wrapped.info('chatter');
      wrapped.debug('noise');

      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0].kind, 'error');
      assert.strictEqual(calls[1].kind, 'event');
      assert.strictEqual(calls[1].type, 'PryvLog');
      assert.strictEqual(calls[1].attrs.level, 'warn');
    });
  });
});
