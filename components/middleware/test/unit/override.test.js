/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const override = require('../../src/override.ts').default;
const assert = require('node:assert');

// The urlencoded `_method` / `_auth` / `_json` fields stand in for the HTTP
// method, the Authorization header and a JSON body; each must yield what the
// real thing could carry, or be refused.
describe('[OVRD] urlencoded override fields', function () {
  /** Run the middleware on a form request; resolves { req, err }. */
  function run (body, headers = {}) {
    const req = {
      method: 'POST',
      headers: Object.assign({}, headers),
      body,
      is: (type) => type === 'application/x-www-form-urlencoded'
    };
    let err = null;
    override(req, {}, (e) => { err = e ?? null; });
    return { req, err };
  }

  it('[OVR1] `_method` takes a known HTTP verb, any case; anything else is refused', function () {
    for (const verb of ['GET', 'put', 'Delete', 'POST']) {
      const { req, err } = run({ _method: verb });
      assert.strictEqual(err, null, verb);
      assert.strictEqual(req.method, verb.toUpperCase());
      assert.strictEqual(req.originalMethod, 'POST');
    }
    for (const verb of ['TRACE', 'CONNECT', 'OPTIONS', 'G ET', '']) {
      const { req, err } = run({ _method: verb });
      assert.ok(err != null, verb);
      assert.strictEqual(err.id, 'invalid-request-structure', verb);
      assert.strictEqual(req.method, 'POST', verb);
    }
  });

  it('[OVR2] `_json` must parse to an object or an array', function () {
    const ok = run({ _json: '{"name":"a"}' });
    assert.strictEqual(ok.err, null);
    assert.deepStrictEqual(ok.req.body, { name: 'a' });
    const arr = run({ _json: '[{"method":"events.get","params":{}}]' });
    assert.strictEqual(arr.err, null);
    assert.ok(Array.isArray(arr.req.body));
    for (const json of ['null', '12', '"text"', 'true']) {
      const { err } = run({ _json: json });
      assert.ok(err != null, json);
      assert.strictEqual(err.id, 'invalid-request-structure', json);
    }
  });

  it('[OVR3] a repeated `_auth` or `_method` field is refused', function () {
    const auth = run({ _auth: ['tok-a', 'tok-b'] });
    assert.ok(auth.err != null);
    assert.strictEqual(auth.err.id, 'invalid-request-structure');
    assert.strictEqual(auth.req.headers.authorization, undefined);
    const method = run({ _method: ['PUT', 'DELETE'] });
    assert.ok(method.err != null);
    assert.strictEqual(method.req.method, 'POST');
  });

  it('[OVR4] a single `_auth` string replaces the Authorization header', function () {
    const { req, err } = run({ _auth: 'tok-a' }, { authorization: 'tok-b' });
    assert.strictEqual(err, null);
    assert.strictEqual(req.headers.authorization, 'tok-a');
    assert.strictEqual(req.headers['original-authorization'], 'tok-b');
  });
});
