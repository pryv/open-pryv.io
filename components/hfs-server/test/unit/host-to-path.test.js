/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { hostToPath } = require('../../src/hostToPath.ts');

// The HFS worker receives series requests with the client's Host header. It
// must decide whether that host carries a username the same way the API
// server does, or a dnsLess core whose public name looks like a username
// (`api-core1.example.com`) answers 404 to every series request.
describe('[HTP1] HFS host-to-path rewriting', function () {
  function config (values) {
    return { get: (key) => values[key] };
  }

  function rewrite (cfg, host, url) {
    const req = { headers: { host }, url };
    let called = false;
    hostToPath(cfg)(req, {}, (err) => { assert.ifError(err); called = true; });
    assert.ok(called, 'the middleware must call next()');
    return req.url;
  }

  it('[HTP2] dnsLess: a username-looking host label is not inserted into the path', function () {
    const cfg = config({ 'dnsLess:isActive': true });
    assert.strictEqual(rewrite(cfg, 'api-core1.example.com', '/alice/events/ev1/series'), '/alice/events/ev1/series');
    assert.strictEqual(rewrite(cfg, 'api-core1.example.com', '/alice/series/batch'), '/alice/series/batch');
  });

  it('[HTP3] username in host: the subdomain becomes the path root', function () {
    const cfg = config({ 'dnsLess:isActive': false });
    assert.strictEqual(rewrite(cfg, 'alice.pryv.me', '/events/ev1/series'), '/alice/events/ev1/series');
    assert.strictEqual(rewrite(cfg, 'alice.pryv.me', '/alice/events/ev1/series'), '/alice/events/ev1/series',
      'no second prefix when the username is already the path root');
  });

  it('[HTP4] username in host: the core\'s own subdomain and reserved names are left alone', function () {
    const cfg = config({ 'dnsLess:isActive': false, 'core:id': 'core-use1' });
    assert.strictEqual(rewrite(cfg, 'core-use1.pryv.me', '/alice/events/ev1/series'), '/alice/events/ev1/series');
    assert.strictEqual(rewrite(cfg, 'access.pryv.me', '/alice/events/ev1/series'), '/alice/events/ev1/series');
  });

  it('[HTP5] username in host: the worker\'s own /system routes are not prefixed', function () {
    const cfg = config({ 'dnsLess:isActive': false });
    assert.strictEqual(rewrite(cfg, 'alice.pryv.me', '/system/status'), '/system/status');
  });
});
