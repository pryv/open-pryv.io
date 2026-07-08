/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const getAuthMiddleware = require('../../src/getAuth.ts').default;
const assert = require('node:assert');

describe('[GAUTH] getAuth middleware', function () {
  // Run the middleware over a mock request and return the normalized
  // `req.headers.authorization` it produces.
  function run (headerValue, query = {}) {
    const req = {
      header: (name) => (name.toLowerCase() === 'authorization' ? headerValue : undefined),
      headers: {},
      query
    };
    getAuthMiddleware(req, {}, () => {});
    return req.headers.authorization;
  }

  it('[GA-BEARER] strips the RFC 6750 "Bearer " scheme', function () {
    assert.strictEqual(run('Bearer abc123'), 'abc123');
  });

  it('[GA-BEARER-CASE] is case-insensitive on the scheme', function () {
    assert.strictEqual(run('bearer abc123'), 'abc123');
  });

  it('[GA-BEARER-CALLER] keeps a trailing " CALLERID" for parseAuth', function () {
    assert.strictEqual(run('Bearer abc123 mycaller'), 'abc123 mycaller');
  });

  it('[GA-BARE] passes a bare token through unchanged', function () {
    assert.strictEqual(run('abc123'), 'abc123');
  });

  it('[GA-BASIC] decodes Basic auth to the username part', function () {
    const b64 = Buffer.from('tok123:ignored').toString('base64');
    assert.strictEqual(run('Basic ' + b64), 'tok123');
  });

  it('[GA-QUERY] falls back to the ?auth= query param when no header', function () {
    assert.strictEqual(run(undefined, { auth: 'qtoken' }), 'qtoken');
  });

  it('[GA-NONE] yields null when neither header nor query is present', function () {
    assert.strictEqual(run(undefined, {}), null);
  });
});
