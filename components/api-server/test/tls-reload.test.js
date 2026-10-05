/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, assert */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Server.reloadTls() keeps the previous TLS context when the certificate on
 * disk is outside the local clock's validity window. The time-boundary cases
 * are covered by the certUtils checkValidityWindow() tests; here the
 * unparseable case proves the guard sits before setSecureContext().
 */
describe('[CKRT] Server.reloadTls() validity guard', function () {
  let Server, tmp, keyFile, certFile;

  before(async function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      this.skip();
    }
    await initTests();
    ({ Server } = require('../src/server.ts'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-tls-reload-'));
    keyFile = path.join(tmp, 'privkey.pem');
    certFile = path.join(tmp, 'fullchain.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-noenc', '-keyout', keyFile, '-out', certFile,
      '-days', '30', '-subj', '/CN=tls-reload.test'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  function fakeServer (settings) {
    const calls = [];
    const logs = [];
    const values = { 'http:ssl:keyFile': keyFile, 'http:ssl:certFile': certFile, ...settings };
    return {
      calls,
      logs,
      httpsServer: { setSecureContext: (opts) => calls.push(opts) },
      config: { get: (key) => values[key] },
      logger: {
        info: (msg) => logs.push(['info', msg]),
        error: (msg) => logs.push(['error', msg]),
        debug: () => {}
      }
    };
  }

  it('[CKR1] swaps the context for a valid certificate', () => {
    const fake = fakeServer({ 'cluster:clockSkewSeconds': 30 });
    const result = Server.prototype.reloadTls.call(fake);
    assert.deepEqual(result, { reloaded: true });
    assert.equal(fake.calls.length, 1);
  });

  it('[CKR2] refuses a certificate outside the validity check and keeps the previous context', () => {
    const badCert = path.join(tmp, 'garbage.pem');
    fs.writeFileSync(badCert, 'not a cert');
    const fake = fakeServer({ 'cluster:clockSkewSeconds': 30, 'http:ssl:certFile': badCert });
    const result = Server.prototype.reloadTls.call(fake);
    assert.deepEqual(result, { reloaded: false, reason: 'validity-unparseable' });
    assert.equal(fake.calls.length, 0);
    assert.ok(fake.logs.some(([level, msg]) => level === 'error' && msg.startsWith('reloadTls refused: ')));
  });

  it('[CKR3] skips the check when cluster.clockSkewSeconds is 0', () => {
    const badCert = path.join(tmp, 'garbage.pem');
    fs.writeFileSync(badCert, 'not a cert');
    const fake = fakeServer({ 'cluster:clockSkewSeconds': 0, 'http:ssl:certFile': badCert });
    const result = Server.prototype.reloadTls.call(fake);
    // setSecureContext is the fake here, so the unchecked garbage goes through
    assert.deepEqual(result, { reloaded: true });
    assert.equal(fake.calls.length, 1);
  });
});
