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
