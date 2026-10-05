/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { externalRequestUri } = require('../src/externalUri.ts');
const { configureTrustedProxies, currentTrustedProxies } = require('middleware/src/clientIp.ts');

// The URI a DPoP proof must name. Forwarding headers pick the host and scheme
// only when they come from a trusted proxy; otherwise a client reaching the
// core directly could make a proof minted for another host pass.
describe('[EXUR] client-facing request URI for DPoP', function () {
  const saved = currentTrustedProxies();
  afterEach(function () { configureTrustedProxies(saved); });

  function req (peer, headers, extra = {}) {
    return Object.assign({ originalUrl: '/alice/events?limit=1', headers, socket: { remoteAddress: peer } }, extra);
  }
  const fwd = { host: '127.0.0.1:3000', 'x-forwarded-host': 'api.example.com', 'x-forwarded-proto': 'https' };

  it('[EXU1] from a trusted proxy: the forwarded host and scheme, path without query', function () {
    assert.equal(externalRequestUri(req('127.0.0.1', fwd)), 'https://api.example.com/alice/events');
  });

  it('[EXU2] from an untrusted peer: Host and the transport scheme, forwarding headers ignored', function () {
    assert.equal(externalRequestUri(req('203.0.113.7', fwd, { protocol: 'http' })), 'http://127.0.0.1:3000/alice/events');
    assert.equal(externalRequestUri(req('203.0.113.7', fwd, { socket: { remoteAddress: '203.0.113.7', encrypted: true } })),
      'https://127.0.0.1:3000/alice/events', 'without express, an encrypted socket means https');
  });

  it('[EXU3] trusting nobody: even a loopback peer\'s forwarding headers are ignored', function () {
    configureTrustedProxies([]);
    assert.equal(externalRequestUri(req('127.0.0.1', fwd, { protocol: 'http' })), 'http://127.0.0.1:3000/alice/events');
  });

  it('[EXU4] a forwarded chain names the client-facing edge first', function () {
    const chained = { host: 'h', 'x-forwarded-host': 'api.example.com, inner.local', 'x-forwarded-proto': 'https, http' };
    assert.equal(externalRequestUri(req('127.0.0.1', chained)), 'https://api.example.com/alice/events');
  });
});
