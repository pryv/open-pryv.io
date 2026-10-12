/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const queryParser = require('../../src/queryParser.ts').default;

describe('[QPRS] query string parser', function () {
  it('[QPR1] keeps the extended bracket syntax and repeated keys', function () {
    assert.deepStrictEqual(queryParser('streams[]=a&streams[]=b&x[y]=1&t=2&t=3'),
      { streams: ['a', 'b'], x: { y: '1' }, t: ['2', '3'] });
  });

  it('[QPR2] drops keys that would shadow Object.prototype properties', function () {
    const q = queryParser('hasOwnProperty=x&toString=y&a[constructor]=z&ok=1');
    assert.deepStrictEqual(Object.keys(q), ['ok']);
    assert.strictEqual(typeof q.hasOwnProperty, 'function');
    assert.strictEqual(typeof q.toString, 'function');
  });

  it('[QPR3] installed on an express app, req.query uses it', async function () {
    const app = express();
    app.set('query parser', queryParser);
    app.get('/', (req, res) => res.json({ keys: Object.keys(req.query) }));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/?hasOwnProperty=1&s[]=a`);
      assert.deepStrictEqual(await res.json(), { keys: ['s'] });
    } finally {
      server.close();
    }
  });
});
