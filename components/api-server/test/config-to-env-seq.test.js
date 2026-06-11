/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * [CENV] — bin/config-to-env.js round-trip fidelity.
 *
 * The converter flattens a YAML config into KEY=VALUE lines (paths joined
 * with '__') for pure-ENV deployments. The server's env loader JSON-parses
 * each value twice (env reader + underlying store), so the converter
 * double-encodes everything that two parses would otherwise mangle —
 * numeric-looking strings ('20260611' must stay a string: a numeric DB
 * password coerced to a number breaks the PG driver), arrays ([1] must
 * stay an array), objects. These tests load the generated env file into
 * the same nconf configuration the server uses and assert type-exact
 * round-trips.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('[CENV] config-to-env round-trip', () => {
  let tmpDir, envPath;

  const fixture = [
    'service:',
    '  name: Env Test',
    "  serial: '20260611'",
    'http:',
    '  port: 3000',
    'dnsLess:',
    '  isActive: true',
    'auth:',
    "  passwordLikeNumber: '00012345'",
    'invitationTokens:',
    '  - 123',
    'singleNumericArray:',
    '  - 1',
    'someNull: null',
    'emptyString: \'\'',
    'nested:',
    '  emptyObject: {}',
    '  list: [a, b]'
  ].join('\n');

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cenv-'));
    const yamlPath = path.join(tmpDir, 'fixture-config.yml');
    fs.writeFileSync(yamlPath, fixture);
    execFileSync('node', [path.join(ROOT, 'bin/config-to-env.js'), yamlPath]);
    envPath = path.join(tmpDir, 'fixture-config.env');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadThroughNconf () {
    // Mirror the server's env configuration (double parseValues path).
    const nconf = require('nconf');
    const saved = {};
    const injected = [];
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx);
      saved[key] = process.env[key];
      process.env[key] = line.slice(idx + 1);
      injected.push(key);
    }
    const store = new nconf.Provider();
    store.env({ parseValues: true, separator: '__' });
    for (const key of injected) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    return store;
  }

  it('[CEN1] env file exists and is line-based KEY=VALUE', () => {
    const body = fs.readFileSync(envPath, 'utf8');
    assert.match(body, /^service__name=/m);
    assert.match(body, /^http__port=3000$/m);
  });

  it('[CEN2] numeric-looking strings stay strings', () => {
    const store = loadThroughNconf();
    assert.strictEqual(store.get('service:serial'), '20260611');
    assert.strictEqual(store.get('auth:passwordLikeNumber'), '00012345');
  });

  it('[CEN3] numbers and booleans stay typed', () => {
    const store = loadThroughNconf();
    assert.strictEqual(store.get('http:port'), 3000);
    assert.strictEqual(store.get('dnsLess:isActive'), true);
  });

  it('[CEN4] arrays survive — including the single-numeric-element trap', () => {
    const store = loadThroughNconf();
    assert.deepStrictEqual(store.get('invitationTokens'), [123]);
    assert.deepStrictEqual(store.get('singleNumericArray'), [1]);
    assert.deepStrictEqual(store.get('nested:list'), ['a', 'b']);
  });

  it('[CEN5] null, empty string and empty object round-trip', () => {
    const store = loadThroughNconf();
    assert.strictEqual(store.get('someNull'), null);
    assert.strictEqual(store.get('emptyString'), '');
    assert.deepStrictEqual(store.get('nested:emptyObject'), {});
  });
});
