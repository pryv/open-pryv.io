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
const commonHeaders = require('../../src/commonHeaders.ts').default;

// JSON answers carry `Cache-Control: no-store`, whichever way the handler
// sends its headers: set beforehand, or passed to writeHead directly.
describe('[NSWH] no-store on JSON answers sent through writeHead', function () {
  let server, port, handler;

  before(async function () {
    const middleware = await commonHeaders();
    server = http.createServer((req, res) => {
      // the express helpers the middleware uses
      res.header = (name, value) => res.setHeader(name, value);
      res.vary = () => {};
      middleware(req, res, () => handler(req, res));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async function () {
    await new Promise((resolve) => server.close(resolve));
  });

  function get () {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }).on('error', reject);
    });
  }

  it('[NSWH1] headers given to writeHead (with or without a status message) are taken into account', async function () {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };
    let res = await get();
    assert.strictEqual(res.headers['cache-control'], 'no-store');

    handler = (req, res) => {
      res.writeHead(200, 'OK', { 'content-type': 'application/json; charset=utf-8' });
      res.end('{}');
    };
    res = await get();
    assert.strictEqual(res.headers['cache-control'], 'no-store');

    handler = (req, res) => {
      res.writeHead(200, ['Content-Type', 'application/json']);
      res.end('{}');
    };
    res = await get();
    assert.strictEqual(res.headers['cache-control'], 'no-store');

    // a Cache-Control passed alongside wins; a non-JSON type gets none
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' });
      res.end('{}');
    };
    res = await get();
    assert.strictEqual(res.headers['cache-control'], 'max-age=60');

    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end('');
    };
    res = await get();
    assert.strictEqual(res.headers['cache-control'], undefined);

    // the type set beforehand keeps working
    handler = (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end('{}');
    };
    res = await get();
    assert.strictEqual(res.headers['cache-control'], 'no-store');
  });
});

// A route that answers CORS with its own policy (`ownCors`) gets no CORS
// header from the middleware and its preflight reaches the route; every other
// route keeps the echoed CORS and the middleware's own preflight answer.
describe('[CHOC] CORS left to the routes that own it', function () {
  const servers = [];

  after(async function () {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  async function serve (options) {
    const middleware = await commonHeaders(options);
    const server = http.createServer((req, res) => {
      res.header = (name, value) => res.setHeader(name, value);
      res.vary = () => {};
      res.sendStatus = (status) => { res.statusCode = status; res.end(); };
      middleware(req, res, () => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(req.method === 'OPTIONS' ? 299 : 200);
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return server.address().port;
  }

  function request (port, method) {
    return new Promise((resolve, reject) => {
      http.request({
        host: '127.0.0.1',
        port,
        path: '/oauth2/token',
        method,
        headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }).on('error', reject).end();
    });
  }

  const corsHeaders = (res) => Object.keys(res.headers).filter((name) => name.startsWith('access-control-'));

  it('[CHOC1] ownCors: no CORS header, the preflight reaches the route; API-Version and no-store stay', async function () {
    const port = await serve({ ownCors: (req) => req.url.startsWith('/oauth2/') });
    const get = await request(port, 'GET');
    assert.deepStrictEqual(corsHeaders(get), []);
    assert.ok(get.headers['api-version'] != null);
    assert.strictEqual(get.headers['cache-control'], 'no-store');
    const preflight = await request(port, 'OPTIONS');
    assert.strictEqual(preflight.statusCode, 299, 'answered by the route');
    assert.deepStrictEqual(corsHeaders(preflight), []);
    assert.ok(preflight.headers['api-version'] != null);
  });

  it('[CHOC2] default: the origin echoed with credentials, the preflight answered 200 by the middleware', async function () {
    for (const options of [undefined, { ownCors: () => false }]) {
      const port = await serve(options);
      const get = await request(port, 'GET');
      assert.strictEqual(get.headers['access-control-allow-origin'], 'https://app.example');
      assert.strictEqual(get.headers['access-control-allow-credentials'], 'true');
      assert.strictEqual(get.headers['access-control-expose-headers'], 'API-Version');
      const preflight = await request(port, 'OPTIONS');
      assert.strictEqual(preflight.statusCode, 200);
      assert.strictEqual(preflight.headers['access-control-allow-origin'], 'https://app.example');
      assert.strictEqual(preflight.headers['access-control-allow-methods'], 'POST');
      assert.strictEqual(preflight.headers['access-control-allow-headers'], 'content-type');
      assert.strictEqual(preflight.headers['access-control-allow-credentials'], 'true');
    }
  });
});
