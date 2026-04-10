/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const supertest = require('supertest');
const express = require('express');
const assert = require('node:assert');
const subdomainToPath = require('middleware/src/subdomainToPath')([]);

describe('[SDTP] subdomainToPath middleware', function () {
  describe('[SD01] using a minimal application', function () {
    const app = express();
    const request = supertest(app);
    app.use(subdomainToPath);
    app.get('*', (req, res) => {
      res.json({ path: req.path });
    });
    function ok (host, path) {
      return request
        .get('/path')
        .set('Host', host)
        .expect(200)
        .then((res) => {
          assert.strictEqual(res.body.path, path + '/path');
        });
    }
    it('[V0R9] should not transform illegal usernames', function () {
      return ok('user/name.pryv.li', '');
    });
    it('[Q5A5] should transform username into a path segment', function () {
      return ok('username.pryv.li', '/username');
    });
    it('[IDDE] should accept dashes', function () {
      return ok('a---0.pryv.li', '/a---0');
    });
  });
});
