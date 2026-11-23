/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { stableStringify, FORMAT } from 'business/src/effectiveConfig/index.ts';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert */

const ROUTE = '/system/admin/config/effective';

describe('[CFGE] GET /system/admin/config/effective', () => {
  let config;
  let adminKey;
  let platform;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.getEffectiveConfig')) {
      await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    }
    const { getConfig } = require('@pryv/boiler');
    config = await getConfig();
    adminKey = config.get('auth:adminAccessKey');
    platform = require('platform').platform;
  });

  function get (query = '') {
    return coreRequest.get(ROUTE + query).set({ authorization: adminKey });
  }

  it('[CFE1] answers the document with the admin key', async () => {
    const res = await get();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const meta = res.body.configMeta;
    assert.strictEqual(meta.format, FORMAT);
    assert.strictEqual(meta.coreId, config.get('core:id'));
    assert.strictEqual(typeof meta.apiVersion, 'string');
    assert.match(meta.digests.full, /^[0-9a-f]{64}$/);
    assert.match(meta.digests.platform, /^[0-9a-f]{64}$/);
    const keys = Object.keys(res.body.keys);
    assert.deepStrictEqual(keys, keys.slice().sort());
    assert.strictEqual(res.body.keys['http.port'].value, config.get('http:port'));
    assert.strictEqual(res.body.keys['auth.adminAccessKey'].redacted, true);
    assert.strictEqual(res.body.keys['auth.adminAccessKey'].class, 'secret');
    assert.strictEqual(res.body.keys.PATH, undefined);
    assert.strictEqual(res.body.keys['service.api'].value, config.get('service:api'));
    assert.strictEqual(res.body.keys['auth.trustedApps'].value, config.get('auth:trustedApps'));
    assert.ok(res.body.meta, 'the usual API envelope meta is kept');
    for (const [k, entry] of Object.entries(res.body.keys)) {
      assert.ok(!entry.source.startsWith('scope:'), k + ' has an unlabelled source ' + entry.source);
    }
  });

  it('[CFE2] refuses a missing or wrong admin key with 404', async () => {
    const none = await coreRequest.get(ROUTE);
    assert.strictEqual(none.status, 404);
    const wrong = await coreRequest.get(ROUTE).set({ authorization: 'not-the-key' });
    assert.strictEqual(wrong.status, 404);
  });

  it('[CFE3] `digest=true` answers the digests only, equal to the full answer\'s', async () => {
    const full = await get();
    const digest = await get('?digest=true');
    assert.strictEqual(digest.status, 200);
    assert.strictEqual(digest.body.keys, undefined);
    assert.deepStrictEqual(digest.body.configMeta.digests, full.body.configMeta.digests);
    const explicitFull = await get('?digest=false');
    assert.ok(explicitFull.body.keys);
  });

  it('[CFE4] refuses another `digest` value or any other parameter with 400', async () => {
    for (const q of ['?digest=maybe', '?raw=true', '?digest=true&includeSecrets=true', '?digest=true&digest=false']) {
      const res = await get(q);
      assert.strictEqual(res.status, 400, q + ' ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format', q);
    }
  });

  it('[CFE5] carries none of the configured secret values', async () => {
    const res = await get();
    const text = res.text;
    const secrets = [adminKey, config.get('auth:filesReadTokenSecret'), config.get('storages:engines:postgresql:password'), config.get('platform:piiHmacKey')];
    for (const s of secrets) {
      if (typeof s !== 'string' || s.length < 4) continue;
      assert.strictEqual(text.includes(s), false, 'a configured secret appears in the answer');
    }
  });

  it('[CFE6] both digests recompute from the returned keys', async () => {
    const res = await get();
    const full = {};
    const plat = {};
    for (const [k, entry] of Object.entries(res.body.keys)) {
      const { source, scope, ...rest } = entry;
      full[k] = rest;
      if (scope === 'platform') plat[k] = rest;
    }
    const sha = (o) => createHash('sha256').update(stableStringify({ format: FORMAT, keys: o })).digest('hex');
    assert.strictEqual(res.body.configMeta.digests.full, sha(full));
    assert.strictEqual(res.body.configMeta.digests.platform, sha(plat));
  });

  it('[CFE7] observability values resolved from platform storage read as `platform-db`', async () => {
    await platform.setObservabilityValue('provider', 'otlp-test');
    await platform.setObservabilityValue('otlp-headers', JSON.stringify({ 'api-key': 'header-secret-value-123' }));
    try {
      const res = await get();
      const k = res.body.keys;
      assert.deepStrictEqual({ value: k['observability.provider'].value, source: k['observability.provider'].source }, { value: 'otlp-test', source: 'platform-db' });
      assert.strictEqual(k['observability.otlp.headers'].class, 'opaque');
      assert.strictEqual(k['observability.otlp.headers'].source, 'platform-db');
      assert.strictEqual(res.text.includes('header-secret-value-123'), false);
    } finally {
      await platform.deleteObservabilityValue('provider');
      await platform.deleteObservabilityValue('otlp-headers');
    }
  });

  it('[CFE8] is audited without a user and never cached', async () => {
    const { AUDITED_METHODS, WITHOUT_USER_METHODS } = require('audit/src/ApiMethods.ts');
    assert.ok(AUDITED_METHODS.includes('system.getEffectiveConfig'));
    assert.ok(WITHOUT_USER_METHODS.includes('system.getEffectiveConfig'));
    const res = await get('?digest=true');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
  });
});
