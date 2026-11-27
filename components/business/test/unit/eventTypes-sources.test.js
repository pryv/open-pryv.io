/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ETSR] where the event types catalogue is loaded from: the platform store's
 * value first (guarded: https, public hosts, no redirect), then the core's
 * local value when it differs; a failing store value falls back to the local
 * one; the load state shows an upstream failure by its status class only.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Config, PLATFORM_STORE_SCOPE } = require('@pryv/boiler/src/config.ts');
const { eventTypesSources } = require('business/src/platformConfig/index.ts');
const { TypeRepository, _resetEventTypesLoadStateForTests, getEventTypesLoadState } = require('business/src/types.ts');

const noop = () => {};
const logging = { getLogger: () => ({ debug: noop, warn: noop, info: noop, error: noop }), initLoggerWithConfig: noop };

describe('[ETSR] event types sources', function () {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsr-')); });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetEventTypesLoadStateForTests();
  });

  function config (local) {
    fs.writeFileSync(path.join(dir, 'default-config.yml'), 'http:\n  port: 3000\n');
    fs.writeFileSync(path.join(dir, 'override-config.yml'), JSON.stringify(local == null ? {} : { service: { eventTypes: local } }));
    return new Config().initSync({ baseConfigDir: dir }, logging);
  }

  it('[ETSR1] no row: the local value; a row: the row (guarded) then the local value; a row equal to the local value: not guarded', () => {
    const c = config('https://local.example.com/types.json');
    assert.deepEqual(eventTypesSources(c), [{ url: 'https://local.example.com/types.json', guarded: false }]);
    c.replaceScopeConfig(PLATFORM_STORE_SCOPE, { service: { eventTypes: 'https://store.example.com/types.json' } });
    assert.deepEqual(eventTypesSources(c), [
      { url: 'https://store.example.com/types.json', guarded: true },
      { url: 'https://local.example.com/types.json', guarded: false }
    ]);
    c.replaceScopeConfig(PLATFORM_STORE_SCOPE, { service: { eventTypes: 'https://local.example.com/types.json' } });
    assert.deepEqual(eventTypesSources(c), [{ url: 'https://local.example.com/types.json', guarded: false }]);
    assert.deepEqual(eventTypesSources(config(null)), []);
  });

  it('[ETSR2] a guarded URL is refused before any connection: http, credentials, loopback, private and link-local hosts', async () => {
    const repo = new TypeRepository();
    for (const url of ['http://example.com/types.json', 'https://u:p@example.com/types.json', 'https://127.0.0.1/types.json',
      'https://localhost/types.json', 'https://10.1.2.3/types.json', 'https://169.254.169.254/latest', 'https://[::1]/types.json']) {
      await assert.rejects(repo.tryUpdate(url, '0', { guarded: true }), /refused: /, url);
    }
  });

  it('[ETSR3] the sources are tried in order: a failing store value falls back to the next one, reported', async () => {
    const repo = new TypeRepository();
    const fallbacks = [];
    const missing = 'file://' + path.join(dir, 'missing.json');
    await assert.rejects(
      repo.tryUpdateFrom([{ url: 'https://127.0.0.1/types.json', guarded: true }, { url: missing, guarded: false }], '0',
        (failed, next, err) => fallbacks.push({ failed, next, message: err.message })),
      /missing\.json/, 'the last failure is the one thrown');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].failed, 'https://127.0.0.1/types.json');
    assert.equal(fallbacks[0].next, missing);
    assert.match(fallbacks[0].message, /private, loopback or link-local/);
  });

  it('[ETSR4] an upstream failure is shown by its status class only', async () => {
    const server = http.createServer((req, res) => { res.statusMessage = 'Internal Detail 42'; res.statusCode = 404; res.end('<html>secret page</html>'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/types.json';
      await assert.rejects(new TypeRepository().tryUpdate(url, '0'), /HTTP 4xx/);
      const state = getEventTypesLoadState();
      assert.match(state.lastError, /HTTP 4xx/);
      assert.ok(!/Internal Detail|\b404\b|secret/.test(state.lastError), state.lastError);
    } finally {
      server.close();
    }
  });
});
