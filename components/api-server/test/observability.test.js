/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Observability configuration + worker-startup tests.
 *
 * The choke point itself (what may be emitted, and what is refused) is
 * covered by the business component's unit suite; this file covers the
 * layer around it: how the posture is resolved from PlatformDB and local
 * YAML, how it reaches workers, and how a worker decides to start.
 *
 *   [OB01] OTLP headers round-trip PlatformDB encrypted at rest
 *   [OB02] local `observability.enabled: false` overrides PlatformDB true
 *   [OB03] appName falls back to `open-pryv.io (<dns.domain>)` when unset
 *   [OB04] hostname is the MACHINE hostname, never derived from the URL layer
 *   [OB05] malformed stored headers degrade to none rather than throwing
 *   [OB06] worker env is empty when telemetry is off or has no endpoint
 *   [OB07] worker env has the full shape when enabled with an endpoint
 *   [OB08] startup refuses to activate in NODE_ENV=test
 *   [OB09] startup refuses to activate without an endpoint
 *   [OB10] startup activates and registers the method vocabulary
 *
 * Sequential because it mutates PlatformDB + global façade state.
 */

const assert = require('node:assert');
const cuid = require('cuid');

const { getConfig } = require('@pryv/boiler');
const { withInjectedConfig } = require('test-helpers');
const { platform } = require('platform');
const observability = require('business/src/observability/index.ts');
const { buildObservabilityEnv } = require('business/src/observability/envBuilder.ts');
const { startFromEnv } = require('business/src/observability/startup.ts');

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
  });

  describe('[OB-PF] Platform.getObservabilityConfig', function () {
    beforeEach(async function () {
      const values = await getPlatformDB().getAllObservabilityValues();
      for (const { key } of values) {
        await getPlatformDB().deleteObservabilityValue(key);
      }
    });

    it('[OB01] encrypts and decrypts the OTLP headers round-trip', async function () {
      const apiKey = 'test-key-' + cuid();
      await platform.setObservabilityValue('enabled', true);
      await platform.setObservabilityValue('otlp-endpoint', 'https://otlp.example.test');
      await platform.setObservabilityValue('otlp-headers', JSON.stringify({ 'api-key': apiKey }));

      // Raw storage MUST be an encrypted envelope — the header carries the
      // backend credential.
      const rawStored = await getPlatformDB().getObservabilityValue('otlp-headers');
      assert.ok(!rawStored.includes(apiKey), 'raw PlatformDB value must not hold the key in clear');

      const obs = await platform.getObservabilityConfig();
      assert.strictEqual(obs.enabled, true);
      assert.strictEqual(obs.otlp.endpoint, 'https://otlp.example.test');
      assert.strictEqual(obs.otlp.headers['api-key'], apiKey);
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

    it('[OB04] hostname is the MACHINE hostname, never derived from the URL layer', async function () {
      // In DNS-ful deployments user-facing hosts are <username>.<domain>,
      // so a hostname taken from core.url / dns.domain is one config
      // change away from carrying a username — and it would ride on every
      // metric and every error report as a direct identifier.
      const machine = require('os').hostname();
      await withInjectedConfig({
        core: { url: 'https://alice.example.com' },
        dns: { domain: 'example.com' }
      }, async () => {
        const obs = await platform.getObservabilityConfig();
        assert.strictEqual(obs.hostname, machine);
        assert.ok(!obs.hostname.includes('alice'),
          'no URL-layer name may reach the telemetry instance id');
      });
    });

    it('[OB05] malformed stored headers yield none rather than throwing', async function () {
      // Write a non-JSON payload through the encrypting setter, so the
      // decrypt succeeds and the parse is what fails.
      await platform.setObservabilityValue('otlp-headers', 'not json at all');
      const obs = await platform.getObservabilityConfig();
      assert.deepStrictEqual(obs.otlp.headers, {}, 'a broken credential must not stop a boot');
    });
  });

  describe('[OB-EP] env propagation to workers', function () {
    beforeEach(async function () {
      const values = await getPlatformDB().getAllObservabilityValues();
      for (const { key } of values) {
        await getPlatformDB().deleteObservabilityValue(key);
      }
    });

    it('[OB06] env is empty when disabled, and when enabled without an endpoint', async function () {
      const disabled = await platform.getObservabilityConfig();
      assert.deepStrictEqual(buildObservabilityEnv(disabled), {});

      await platform.setObservabilityValue('enabled', true);
      const noEndpoint = await platform.getObservabilityConfig();
      assert.deepStrictEqual(buildObservabilityEnv(noEndpoint), {},
        'enabled without a destination must not start workers emitting');
    });

    it('[OB07] env has the full shape when enabled with an endpoint', async function () {
      const coreUrl = 'https://core-ob07.example.com';
      await withInjectedConfig({ core: { url: coreUrl }, dns: { domain: 'example.com' } }, async () => {
        await platform.setObservabilityValue('enabled', true);
        await platform.setObservabilityValue('otlp-endpoint', 'https://otlp.example.test');
        await platform.setObservabilityValue('otlp-headers', JSON.stringify({ 'api-key': 'k'.repeat(40) }));
        await platform.setObservabilityValue('app-name', 'test-cluster-app');

        const obs = await platform.getObservabilityConfig();
        const env = buildObservabilityEnv(obs);

        assert.strictEqual(env.PRYV_OBS_ENABLED, 'true');
        assert.strictEqual(env.PRYV_OBS_ENDPOINT, 'https://otlp.example.test');
        assert.strictEqual(JSON.parse(env.PRYV_OBS_HEADERS)['api-key'], 'k'.repeat(40));
        assert.strictEqual(env.PRYV_OBS_SERVICE_NAME, 'test-cluster-app');
        assert.strictEqual(env.PRYV_OBS_INSTANCE_ID, require('os').hostname(),
          'instance id is the machine, not anything from the URL layer');
        // Unset means the emitter's privacy-biased default.
        assert.strictEqual(env.PRYV_OBS_FLUSH_SECONDS, undefined);

        await platform.setObservabilityValue('otlp-flush-interval', '900');
        const widened = buildObservabilityEnv(await platform.getObservabilityConfig());
        assert.strictEqual(widened.PRYV_OBS_FLUSH_SECONDS, '900',
          'the operator can widen the reporting interval, as the docs promise');
      });
    });
  });

  describe('[OB-ST] worker startup', function () {
    const baseEnv = {
      PRYV_OBS_ENABLED: 'true',
      PRYV_OBS_ENDPOINT: 'https://otlp.example.test',
      PRYV_OBS_HEADERS: '{"api-key":"k"}',
      PRYV_OBS_SERVICE_NAME: 'open-pryv.io (test)',
      PRYV_OBS_INSTANCE_ID: 'core-test.example.com'
    };

    it('[OB08] refuses to activate in NODE_ENV=test', function () {
      const result = startFromEnv({
        methodIds: ['events.get'],
        serviceVersion: '2.0.0',
        env: Object.assign({}, baseEnv, { NODE_ENV: 'test' })
      });
      assert.strictEqual(result.activated, false);
      assert.match(result.reason, /NODE_ENV=test/);
      assert.strictEqual(observability.isActive(), false);
    });

    it('[OB09] refuses to activate without an endpoint', function () {
      const env = Object.assign({}, baseEnv);
      delete env.PRYV_OBS_ENDPOINT;
      const result = startFromEnv({ methodIds: ['events.get'], serviceVersion: '2.0.0', env });
      assert.strictEqual(result.activated, false);
      assert.match(result.reason, /endpoint/);
      assert.strictEqual(observability.isActive(), false);
    });

    it('[OB11] refuses an empty method vocabulary rather than going inert', function () {
      // Regression: startup used to run before the API method modules
      // registered, so the emitter attached knowing zero methods and
      // silently refused every datapoint. Caught only by reading a
      // deployed log line, which is exactly the failure mode this layer
      // is supposed to have retired — so it now fails loudly.
      const result = startFromEnv({ methodIds: [], serviceVersion: '2.0.0', env: baseEnv });
      assert.strictEqual(result.activated, false);
      assert.match(result.reason, /no API methods registered/);
      assert.strictEqual(observability.isActive(), false,
        'an emitter that knows no method must not attach at all');
    });

    it('[OB10] activates and registers the method vocabulary', function () {
      const result = startFromEnv({
        methodIds: ['events.get', 'events.create'],
        serviceVersion: '2.0.0',
        env: baseEnv
      });
      assert.strictEqual(result.activated, true, result.reason);
      assert.strictEqual(observability.isActive(), true);

      const schema = require('business/src/observability/schema.ts');
      assert.ok(schema.knownMethodIds().has('events.get'));
      assert.ok(!schema.knownMethodIds().has('events.delete'),
        'only the ids handed over may be emitted');
      assert.ok(schema.knownErrorCodes().has('invalid-access-token'),
        'the error registry is registered alongside');
    });
  });
});
