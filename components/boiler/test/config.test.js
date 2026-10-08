/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.ts';

const DEFAULT_CONFIG = `
services:
  mfa:
    active: false
    sessions:
      ttlSeconds: 1800
      maxPending: 10000
    methods:
      sms:
        endpoints:
          verify:
            url: ''
list:
  - name: a
`;

// Loaded as the 'base' scope (NODE_ENV-config.yml), between 'test' and the defaults.
const BASE_CONFIG = `
services:
  mfa:
    active: true
`;

describe('[BCFG] boiler config: values read are copies', function () {
  let dir;
  let config;

  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boiler-config-'));
    fs.writeFileSync(path.join(dir, 'default-config.yml'), DEFAULT_CONFIG);
    fs.writeFileSync(path.join(dir, 'base-config.yml'), BASE_CONFIG);
  });
  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(function () {
    const noop = () => {};
    const logging = {
      getLogger: () => ({ debug: noop, warn: noop, info: noop, error: noop }),
      initLoggerWithConfig: noop
    };
    config = new Config().initSync({
      baseConfigDir: dir,
      skipOverrideConfig: true,
      extras: [{ scope: 'base-file', file: path.join(dir, 'base-config.yml') }]
    }, logging);
  });

  it('[BCFG1] a nested value of a removed scope does not survive in the lower scopes', function () {
    config.injectTestConfig({
      services: { mfa: { sessions: { maxPending: 2 }, methods: { sms: { endpoints: { verify: { success: { equals: 'ok' } } } } } } }
    });
    // Reading the parent keys merges the scopes.
    assert.strictEqual(config.get('services:mfa').sessions.maxPending, 2);
    assert.deepStrictEqual(config.get('services').mfa.methods.sms.endpoints.verify.success, { equals: 'ok' });
    assert.strictEqual(config.get().services.mfa.sessions.maxPending, 2);

    config.injectTestConfig({});

    const mfa = config.get('services:mfa');
    assert.strictEqual(mfa.sessions.maxPending, 10000);
    assert.strictEqual(mfa.sessions.ttlSeconds, 1800);
    assert.strictEqual(mfa.active, true);
    assert.deepStrictEqual(mfa.methods.sms.endpoints.verify, { url: '' });
    assert.strictEqual(config.get('services:mfa:methods:sms:endpoints:verify:success'), undefined);
    assert.strictEqual(config.has('services:mfa:methods:sms:endpoints:verify:success'), false);
    assert.strictEqual(config.getScopeAndValue('services:mfa:sessions:maxPending').scope, 'default-file');
  });

  it('[BCFG2] mutating a returned value does not change the config', function () {
    const mfa = config.get('services:mfa');
    mfa.sessions.maxPending = 1;
    mfa.active = 'changed';
    delete mfa.methods;
    config.get('list')[0].name = 'changed';
    config.get('list').push({ name: 'b' });
    config.get().services.mfa.sessions.ttlSeconds = 1;
    config.getScopeAndValue('services:mfa:sessions').value.ttlSeconds = 2;

    assert.deepStrictEqual(config.get('services:mfa'), {
      active: true,
      sessions: { ttlSeconds: 1800, maxPending: 10000 },
      methods: { sms: { endpoints: { verify: { url: '' } } } }
    });
    assert.deepStrictEqual(config.get('list'), [{ name: 'a' }]);
  });

  it('[BCFG3] scopes resolve as before: higher over lower, a non-object value stops the lookup', function () {
    config.injectTestConfig({ services: { mfa: { sessions: { ttlSeconds: 5 } } }, list: [{ name: 'test' }] });
    assert.deepStrictEqual(config.get('services:mfa:sessions'), { ttlSeconds: 5, maxPending: 10000 });
    assert.deepStrictEqual(config.get('list'), [{ name: 'test' }]);
    config.set('services:mfa:sessions', null);
    assert.strictEqual(config.get('services:mfa:sessions'), null);
    assert.strictEqual(config.has('services:mfa:sessions'), true);
    assert.strictEqual(config.get('services:mfa').sessions, null);
    assert.strictEqual(config.has('services:none'), false);
    assert.strictEqual(config.get('services:none'), undefined);
  });
});
