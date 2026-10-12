/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const http = require('node:http');
const { guardIngress } = require('../../src/ingressGuard.ts');

// The raw ingress runs before express: a throw there would end the worker.
describe('[INGG] raw ingress guard', function () {
  let server, port, handler;
  const errors = [];
  const logger = { error: (msg) => errors.push(msg) };

  before(async function () {
    server = http.createServer(guardIngress((req, res) => handler(req, res), logger));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(function () { server.close(); });
  beforeEach(function () { errors.length = 0; });

  async function get () {
    const res = await fetch(`http://127.0.0.1:${port}/x?auth=secret`);
    return { status: res.status, body: await res.text() };
  }

  it('[ING1] a synchronous throw (a refused header value) is answered 500 and logged', async function () {
    handler = (req, res) => {
      res.setHeader('x-site', 'ok');
      res.setHeader('x-bad', 'snow ☃');
    };
    const res = await get();
    assert.strictEqual(res.status, 500);
    assert.strictEqual(JSON.parse(res.body).error.id, 'unexpected-error');
    assert.strictEqual(errors.length, 1);
    assert.doesNotMatch(errors[0], /secret/);
  });

  it('[ING2] a rejection of an async branch is answered 500', async function () {
    handler = async () => { throw new Error('boom'); };
    const res = await get();
    assert.strictEqual(res.status, 500);
    assert.match(errors[0], /boom/);
  });

  it('[ING3] after the answer started, the connection is closed; the server keeps serving', async function () {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      throw new Error('late');
    };
    await assert.rejects(get());
    handler = (req, res) => res.end('fine');
    assert.deepStrictEqual(await get(), { status: 200, body: 'fine' });
  });
});
