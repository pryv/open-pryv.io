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
 *   [OBSC] agent config pins the scrub constants (exclusions, URL
 *          obfuscation, no SQL capture, log forwarding off by default)
 *   [OBHS] high-security opt-in round-trips PlatformDB -> config -> worker env
 *
 * Sequential because it mutates PlatformDB + process.env + global façade state.
 */

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cuid = require('cuid');

const { getConfig } = require('@pryv/boiler');
const { withInjectedConfig } = require('test-helpers');
const { platform } = require('platform');
const observability = require('business/src/observability/index.ts');
const logForwarder = require('business/src/observability/logForwarder.ts');
const { buildObservabilityEnv } = require('business/src/observability/envBuilder.ts');

function getPlatformDB () {
  return require('storages').platformDB;
}

describe('[OBS] observability', function () {
  this.timeout(10000);

  before(async function () {
    await getConfig();
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
      await withInjectedConfig({ observability: { enabled: false } }, async () => {
        const obs = await platform.getObservabilityConfig();
        assert.strictEqual(obs.enabled, false, 'local false must win');
      });
    });

    it('[OB03] appName falls back to open-pryv.io (<dns.domain>) when unset', async function () {
      const domain = 'ob03-' + cuid() + '.test';
      await withInjectedConfig({ dns: { domain } }, async () => {
        const obs = await platform.getObservabilityConfig();
        assert.strictEqual(obs.appName, 'open-pryv.io (' + domain + ')');
      });
    });

    it('[OB04] hostname derived from new URL(core.url).hostname', async function () {
      const coreUrl = 'https://core-ob04.example.com';
      await withInjectedConfig({ core: { url: coreUrl } }, async () => {
        const obs = await platform.getObservabilityConfig();
        assert.strictEqual(obs.hostname, 'core-ob04.example.com');
      });
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
      await withInjectedConfig({ core: { url: coreUrl }, dns: { domain: 'example.com' } }, async () => {
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
        // HSM defaults to 'false' (must match account-side or connect returns 409).
        assert.strictEqual(env.NEW_RELIC_HIGH_SECURITY, 'false');
        assert.ok(env.NEW_RELIC_HOME, 'NEW_RELIC_HOME must point at the provider config dir');
      });
    });

    it('[OB09C] NEW_RELIC_HIGH_SECURITY flips to "true" only when obs.newrelic.highSecurity=true', async function () {
      const obs = {
        enabled: true,
        provider: 'newrelic',
        appName: 'x',
        logLevel: 'error',
        hostname: 'core.x',
        newrelic: { licenseKey: 'k'.repeat(40), highSecurity: true }
      };
      const env = buildObservabilityEnv(obs);
      assert.strictEqual(env.NEW_RELIC_HIGH_SECURITY, 'true');
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

  describe('[OB-SC] agent config scrub constants', function () {
    // These values are quoted verbatim in the customer-facing data-flow
    // documentation, which answers "what does our APM vendor receive?".
    // Pin them here so a well-meaning edit cannot loosen the posture
    // silently: if this test changes, that documentation must change too.
    const NR_CONFIG_MODULE = 'business/src/observability/providers/newrelic/newrelic.ts';

    it('[OBSC] excludes credentials, request bodies, URLs and identifying attributes', function () {
      const { config } = require(NR_CONFIG_MODULE);

      assert.strictEqual(config.allow_all_headers, false,
        'header capture must stay on the agent default allowlist');

      const mustExclude = [
        // credentials and payloads
        'request.headers.authorization',
        'request.headers.cookie',
        'request.headers.proxy-authorization',
        'request.headers.set-cookie*',
        'request.headers.x-*',
        'request.body',
        // subject-linking attributes: URLs carry usernames and record ids,
        // the parameter wildcard also catches route params such as
        // request.parameters.route.username, and Host carries the username
        // as a subdomain in DNS-ful topologies
        'request.uri',
        'request.parameters.*',
        'http.url',
        'request.headers.host',
        'request.headers.referer'
      ];
      for (const key of mustExclude) {
        assert.ok(config.attributes.exclude.includes(key),
          'attributes.exclude must contain ' + key);
      }

      // Retained on purpose: operationally useful, not subject-linking.
      assert.ok(!config.attributes.exclude.includes('request.headers.user-agent'),
        'user-agent is deliberately retained');

      assert.strictEqual(config.transaction_tracer.record_sql, 'off',
        'SQL text must never be captured');
    });

    it('[OBSC2] enables URL obfuscation, the only cover for segment and span names', function () {
      const { config } = require(NR_CONFIG_MODULE);
      // Attribute exclusion cannot reach a segment or span NAME, and those
      // embed the outbound path on cross-core forwards.
      assert.strictEqual(config.url_obfuscation.enabled, true);
      assert.strictEqual(config.url_obfuscation.regex.pattern,
        '(^/[^/?]+)|(c[a-z0-9]{20,})|(\\?.*$)');
      assert.strictEqual(config.url_obfuscation.regex.flags, 'g');
      assert.strictEqual(config.url_obfuscation.regex.replacement, '*');
    });

    it('[OBSC3] ships application log forwarding OFF by default', function () {
      // The agent auto-instruments the logging stack and would forward log
      // records including message bodies. Attribute exclusion does not apply
      // to a message, and nothing here scrubs identifiers out of one.
      assert.strictEqual(
        process.env.NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED,
        undefined,
        'this assertion is only meaningful with the opt-in env var unset');
      const { config } = require(NR_CONFIG_MODULE);
      assert.strictEqual(config.application_logging.forwarding.enabled, false,
        'log forwarding must be off unless an operator opts in');
      assert.strictEqual(config.application_logging.enabled, true);
      assert.strictEqual(config.application_logging.metrics.enabled, true,
        'log-to-metric counts carry no message content and stay on');
      assert.strictEqual(config.application_logging.local_decorating.enabled, false);
    });

    it('[OBSC5] the AGENT actually discovers this config, not just our importers', function () {
      // The regression this guards is not hypothetical: the config used to live
      // in a .ts file, which the agent cannot discover. It scans NEW_RELIC_HOME
      // for exactly newrelic.js / newrelic.cjs / newrelic.mjs (or
      // NEW_RELIC_CONFIG_FILENAME) and otherwise silently runs on env vars and
      // built-in defaults: no exclusions, SQL recorded as obfuscated rather
      // than off, and log forwarding ON. Every assertion above passed happily
      // through all of that, because they read the object we export rather than
      // the config the agent resolves. So ask the agent.
      const providerDir = path.resolve(
        __dirname, '../../business/src/observability/providers/newrelic');
      const result = spawnSync('node', ['-e',
        'const c = require("newrelic/lib/config").initialize();' +
        'console.log(JSON.stringify({' +
        '  exclude: c.attributes.exclude,' +
        '  recordSql: c.transaction_tracer.record_sql,' +
        '  logForwarding: c.application_logging.forwarding.enabled,' +
        '  obfuscation: c.url_obfuscation && c.url_obfuscation.enabled' +
        '}));'
      ], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          ...process.env,
          NEW_RELIC_HOME: providerDir,
          NEW_RELIC_LICENSE_KEY: 'd'.repeat(40),
          NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED: undefined
        }
      });
      assert.strictEqual(result.status, 0, 'child failed: ' + result.stderr);
      const resolved = JSON.parse(result.stdout.trim());

      assert.ok(resolved.exclude.includes('request.uri'),
        'the agent resolved no URL exclusion, so it did not load our config file: ' +
        JSON.stringify(resolved.exclude));
      assert.ok(resolved.exclude.includes('request.parameters.*'));
      assert.ok(resolved.exclude.includes('request.headers.host'));
      assert.strictEqual(resolved.recordSql, 'off');
      assert.strictEqual(resolved.logForwarding, false);
      assert.strictEqual(resolved.obfuscation, true);
    });

    it('[OBSC4] the log-forwarding opt-in env var is honoured at module load', function () {
      // `forwarding.enabled` is evaluated when the module is first imported,
      // and these modules load through ESM interop, so clearing require.cache
      // does NOT re-evaluate them. Load in a child process instead, which is
      // also closer to reality: the setting is decided when a worker boots.
      const modulePath = path.resolve(
        __dirname,
        '../../business/src/observability/providers/newrelic/newrelic.ts');
      const read = (env) => {
        const result = spawnSync('node', ['--input-type=module', '-e',
          'const m = await import("file://' + modulePath + '");' +
          'console.log(m.config.application_logging.forwarding.enabled);'
        ], { encoding: 'utf8', env: { ...process.env, ...env } });
        assert.strictEqual(result.status, 0,
          'child failed: ' + result.stderr);
        return result.stdout.trim();
      };

      assert.strictEqual(
        read({ NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED: 'true' }),
        'true',
        'an explicit opt-in must be honoured');
      assert.strictEqual(
        read({ NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED: undefined }),
        'false',
        'and the shipped default with no env set must stay off');
    });
  });

  describe('[OB-HS] high-security opt-in', function () {
    beforeEach(async function () {
      const values = await getPlatformDB().getAllObservabilityValues();
      for (const { key } of values) {
        await getPlatformDB().deleteObservabilityValue(key);
      }
    });

    it('[OBHS] defaults to false with no PlatformDB row', async function () {
      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.newrelic.highSecurity, false);
    });

    it('[OBHS2] round-trips PlatformDB -> config -> worker env', async function () {
      await platform.setObservabilityValue('enabled', true);
      await platform.setObservabilityValue('provider', 'newrelic');
      await platform.setObservabilityValue('newrelic-license-key', 'k'.repeat(40));
      await platform.setObservabilityValue('newrelic-high-security', true);

      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.newrelic.highSecurity, true,
        'the opt-in row must reach the resolved config');

      const env = buildObservabilityEnv(obs);
      assert.strictEqual(env.NEW_RELIC_HIGH_SECURITY, 'true',
        'and must reach the worker env, or the opt-in is dead code');
    });

    it('[OBHS3] is stored in the clear, unlike the license key', async function () {
      // Not a secret: an operator comparing cores should be able to read it.
      await platform.setObservabilityValue('newrelic-high-security', true);
      const raw = await getPlatformDB().getObservabilityValue('newrelic-high-security');
      assert.ok(/true/.test(String(raw)),
        'expected a readable boolean, got: ' + String(raw));
    });

    it('[OBHS4] local YAML wins over the PlatformDB row, as for `enabled`', async function () {
      await platform.setObservabilityValue('newrelic-high-security', true);
      await withInjectedConfig({ observability: { newrelic: { highSecurity: false } } }, async () => {
        const obs = await platform.getObservabilityConfig();
        assert.strictEqual(obs.newrelic.highSecurity, false,
          'the local override is the operator kill-switch and must win');
      });
    });
  });
});
