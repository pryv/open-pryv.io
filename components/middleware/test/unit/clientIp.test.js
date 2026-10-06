/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { clientIp, configureTrustedProxies, currentTrustedProxies, trustedProxiesSummary } = require('../../src/clientIp.ts');

// The audit log's source.ip comes from here: X-Forwarded-For must only be
// believed from a trusted proxy, or any client chooses its recorded address.
describe('[CLIP] client address behind trusted proxies', function () {
  const saved = currentTrustedProxies();
  function req (peer, xff) {
    const headers = xff == null ? {} : { 'x-forwarded-for': xff };
    return { headers, socket: { remoteAddress: peer } };
  }

  afterEach(function () {
    configureTrustedProxies(saved);
  });

  it('[CLI1] no header: the TCP peer', function () {
    assert.strictEqual(clientIp(req('203.0.113.7')), '203.0.113.7');
  });

  it('[CLI2] default trust: a loopback proxy\'s header is read', function () {
    assert.strictEqual(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
    assert.strictEqual(clientIp(req('::1', '203.0.113.7')), '203.0.113.7');
  });

  it('[CLI3] an untrusted peer\'s header is ignored (the spoof)', function () {
    assert.strictEqual(clientIp(req('198.51.100.9', '1.2.3.4')), '198.51.100.9');
    assert.strictEqual(clientIp(req('10.0.0.1', '1.2.3.4')), '10.0.0.1',
      'private ranges are not trusted by default');
  });

  it('[CLI4] the chain is read from the right: the first untrusted entry is the client', function () {
    // A client-sent value on the left must not win over the address the proxy saw.
    assert.strictEqual(clientIp(req('127.0.0.1', '1.2.3.4, 203.0.113.7')), '203.0.113.7');
    configureTrustedProxies(['loopback', '203.0.113.0/24']);
    assert.strictEqual(clientIp(req('127.0.0.1', '198.51.100.9, 203.0.113.7')), '198.51.100.9');
  });

  it('[CLI5] an empty list trusts nobody: the header is never read', function () {
    configureTrustedProxies([]);
    assert.strictEqual(clientIp(req('127.0.0.1', '203.0.113.7')), '127.0.0.1');
    assert.match(trustedProxiesSummary(), /never read/);
  });

  it('[CLI6] a comma-joined chain (how Node joins repeated headers) is read as one chain', function () {
    const r = { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.strictEqual(clientIp(r), '203.0.113.7');
  });

  it('[CLI7] IPv4-mapped addresses are recorded in IPv4 form', function () {
    assert.strictEqual(clientIp(req('::ffff:203.0.113.7')), '203.0.113.7');
    assert.strictEqual(clientIp(req('::ffff:127.0.0.1', '203.0.113.8')), '203.0.113.8',
      'a mapped loopback peer is trusted like 127.0.0.1');
  });

  it('[CLI8] junk from a trusted proxy falls back to the peer', function () {
    assert.strictEqual(clientIp(req('127.0.0.1', 'not-an-address')), '127.0.0.1');
  });

  it('[CLI9] no peer address: null; the peer may come from `connection`', function () {
    assert.strictEqual(clientIp({ headers: {}, socket: {} }), null);
    assert.strictEqual(clientIp({ headers: {}, connection: { remoteAddress: '203.0.113.9' } }), '203.0.113.9');
  });

  it('[CLIA] an entry proxy-addr cannot compile is refused', function () {
    assert.throws(() => configureTrustedProxies(['not-a-cidr/99']));
  });

  it('[CLIB] a list that trusts every client, or an entry that matches nobody, is refused at runtime too', function () {
    configureTrustedProxies(['loopback', '10.0.0.0/8']);
    for (const list of [['::/1'], ['::ffff:0.0.0.0/96'], ['loopback', '::ffff:10.0.0.0/8']]) {
      assert.throws(() => configureTrustedProxies(list), /trusts every client|matches no client/, JSON.stringify(list));
      assert.deepStrictEqual(currentTrustedProxies(), ['loopback', '10.0.0.0/8'], 'previous list kept');
    }
    // the spoof still fails after a refused update
    assert.strictEqual(clientIp(req('198.51.100.9', '1.2.3.4')), '198.51.100.9');
    configureTrustedProxies(['::ffff:10.0.0.0/104']);
    assert.strictEqual(clientIp(req('::ffff:10.1.2.3', '198.51.100.20')), '198.51.100.20');
  });
});
