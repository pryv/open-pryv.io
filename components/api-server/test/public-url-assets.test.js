/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The public-url plugin on a real configuration, in both production shapes
 * (dnsLess with a public URL; multi-core with `core.url` and `dns.domain`):
 * it derives `service.api`, `service.register` and `service.access` only;
 * the default `service.assets.definitions` (the public Pryv assets: the core
 * serves none itself) sits below every other scope; an operator setting is
 * kept; and no key the platform store may hold resolves from the memory
 * scope, so a store row replaces the local value.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const publicUrl = require('../../../config/plugins/public-url');
const { Config, PLATFORM_STORE_SCOPE } = require('@pryv/boiler/src/config.ts');
const { SCHEMA, configPath } = require('business/src/platformConfig/index.ts');

const SHAPES = {
  dnsLess: { dnsLess: { isActive: true, publicUrl: 'https://api.example.com/' } },
  multiCore: { dnsLess: { isActive: false }, core: { url: 'https://core-a.example.com' }, dns: { domain: 'example.com' } }
};
const LOCAL_SERVICE = {
  name: 'Local name',
  serial: '2026112701',
  home: 'https://home.example.com',
  support: 'https://support.example.com',
  terms: 'https://terms.example.com',
  eventTypes: 'https://types.example.com/flat.json'
};
const noop = () => {};
const logging = { getLogger: () => ({ debug: noop, warn: noop, info: noop, error: noop }), initLoggerWithConfig: noop };

describe('[PUAS] public-url plugin: derived service URLs and default UI assets', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puas-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** A configuration whose override-config.yml holds `override`, the plugin run as at boot. */
  function boot (override) {
    fs.writeFileSync(path.join(dir, 'default-config.yml'), 'http:\n  port: 3000\n');
    fs.writeFileSync(path.join(dir, 'override-config.yml'), JSON.stringify(override));
    return new Config().initSync({ baseConfigDir: dir, extras: [{ plugin: publicUrl }] }, logging);
  }

  it('[PUAS-01] dnsLess: URLs derived on the public URL, the default assets are the public Pryv set', () => {
    const config = boot({ ...SHAPES.dnsLess, service: LOCAL_SERVICE });
    const service = config.get('service');
    assert.strictEqual(service.register, 'https://api.example.com/reg/');
    assert.strictEqual(service.api, 'https://api.example.com/{username}/');
    assert.strictEqual(service.assets.definitions, publicUrl.DEFAULT_ASSETS_DEFINITIONS);
    assert.strictEqual(service.assets.definitions, 'https://pryv.github.io/assets-pryv.me/index.json');
    assert.strictEqual(config.getScopeAndValue('service:assets:definitions').scope, publicUrl.DEFAULTS_SCOPE);
    assert.strictEqual(service.name, 'Local name');
  });

  it('[PUAS-02] multi-core: same default; register and access on the reserved names', () => {
    const config = boot({ ...SHAPES.multiCore, service: LOCAL_SERVICE });
    assert.strictEqual(config.get('service:register'), 'https://reg.example.com/');
    assert.strictEqual(config.get('service:access'), 'https://access.example.com/access/');
    assert.strictEqual(config.get('service:assets:definitions'), publicUrl.DEFAULT_ASSETS_DEFINITIONS);
  });

  it('[PUAS-03] an operator setting is kept', () => {
    const own = { definitions: 'https://assets.example.com/index.json' };
    for (const shape of Object.values(SHAPES)) {
      const config = boot({ ...shape, service: { ...LOCAL_SERVICE, assets: own } });
      assert.deepStrictEqual(config.get('service:assets'), own);
    }
  });

  it('[PUAS-04] no key the platform store may hold resolves from the memory scope; a store row replaces the local value', () => {
    for (const [name, shape] of Object.entries(SHAPES)) {
      for (const service of [LOCAL_SERVICE, { ...LOCAL_SERVICE, assets: { definitions: 'https://assets.example.com/index.json' } }]) {
        const config = boot({ ...shape, service });
        const stored = {};
        for (const key of Object.keys(SCHEMA)) {
          const found = config.getScopeAndValue(configPath(key));
          assert.notStrictEqual(found?.scope, 'memory', name + ': ' + key + ' resolves from memory');
          let node = stored;
          const segments = key.split('.');
          for (const seg of segments.slice(0, -1)) node = node[seg] = node[seg] ?? {};
          node[segments[segments.length - 1]] = 'https://store.example.com/' + key;
        }
        config.replaceScopeConfig(PLATFORM_STORE_SCOPE, stored);
        for (const key of Object.keys(SCHEMA)) {
          assert.strictEqual(config.get(configPath(key)), 'https://store.example.com/' + key, name + ': ' + key);
        }
        // The derived URLs and the values the store does not hold are unchanged.
        assert.strictEqual(config.get('service:serial'), '2026112701');
        assert.ok(String(config.get('service:register')).includes('example.com'), name);
      }
    }
  });
});
