/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Default `service.assets.definitions`: the core serves no UI assets itself,
 * so without an operator setting the service info must point at a set that
 * answers (the public Pryv assets), on both topologies; an operator's own
 * setting is kept.
 */

const assert = require('node:assert/strict');
const publicUrl = require('../../../config/plugins/public-url');

function fakeConfig (values) {
  const store = { ...values };
  return {
    get: (key) => store[key],
    set: (key, value) => { store[key] = value; }
  };
}

describe('[PUAS] public-url plugin: default UI assets', () => {
  it('[PUAS-01] dnsLess: defaults to the public Pryv assets, not a path on the core', async () => {
    const config = fakeConfig({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'https://api.example.com/' });
    await publicUrl.load(config);
    const service = config.get('service');
    assert.strictEqual(service.assets.definitions, publicUrl.DEFAULT_ASSETS_DEFINITIONS);
    assert.strictEqual(service.assets.definitions, 'https://pryv.github.io/assets-pryv.me/index.json');
    assert.strictEqual(service.register, 'https://api.example.com/reg/');
  });

  it('[PUAS-02] dns-active: same default', async () => {
    const config = fakeConfig({ 'dnsLess:isActive': false, 'core:url': 'https://core-a.example.com', 'dns:domain': 'example.com' });
    await publicUrl.load(config);
    assert.strictEqual(config.get('service').assets.definitions, publicUrl.DEFAULT_ASSETS_DEFINITIONS);
  });

  it('[PUAS-03] an operator setting is kept', async () => {
    const own = { definitions: 'https://assets.example.com/index.json' };
    for (const values of [
      { 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'https://api.example.com/' },
      { 'dnsLess:isActive': false, 'core:url': 'https://core-a.example.com', 'dns:domain': 'example.com' }
    ]) {
      const config = fakeConfig({ ...values, service: { assets: own } });
      await publicUrl.load(config);
      assert.deepStrictEqual(config.get('service').assets, own);
    }
  });
});
