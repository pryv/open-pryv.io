/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const assert = require('node:assert');
const { listeningAgent } = require('test-helpers/src/listeningAgent.ts');
const subdomainToPath = require('middleware/src/subdomainToPath.ts').default([]);

describe('[SDTP] subdomainToPath middleware', function () {
  describe('[SD46] using a minimal application', function () {
    const app = express();
    // Not a bare app: see listeningAgent.ts on why supertest(app) flakes on macOS.
    let request;
    before(async function () {
      request = await listeningAgent(app);
    });
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
    it('[SDAL] should route an access alias (r- + 8 letters or digits) like a username', async function () {
      for (const alias of ['r-abcdefgh', 'r-23456789', 'r-zz2y3x4w']) {
        await ok(alias + '.pryv.li', '/' + alias);
      }
    });
  });

  describe('[SDPR] ignored subdomains given as a predicate', function () {
    const route = (ignoredSubdomains, host, url = '/events') => {
      const req = { url, headers: { host } };
      require('middleware/src/subdomainToPath.ts').default([], ignoredSubdomains)(req, {}, () => {});
      return req.url;
    };

    it('[SDPF] a label the predicate accepts is not rewritten, others are; the predicate sees the lowercased label', function () {
      const seen = [];
      let names = new Set(['records']);
      const predicate = (label) => { seen.push(label); return names.has(label); };
      assert.strictEqual(route(predicate, 'records.pryv.li'), '/events');
      assert.strictEqual(route(predicate, 'Records.pryv.li'), '/events');
      assert.strictEqual(route(predicate, 'alice.pryv.li'), '/alice/events');
      assert.deepStrictEqual(seen, ['records', 'records', 'alice']);
      // read on every request: a name the predicate learns later is skipped from then on
      names = new Set(['records', 'alice']);
      assert.strictEqual(route(predicate, 'alice.pryv.li'), '/events');
    });

    it('[SDPA] a list keeps its behaviour', function () {
      assert.strictEqual(route(['records'], 'records.pryv.li'), '/events');
      assert.strictEqual(route(['records'], 'alice.pryv.li'), '/alice/events');
      assert.strictEqual(route(undefined, 'alice.pryv.li'), '/alice/events');
    });

    it('[SDPC] a list compares labels without case, as the predicate does', function () {
      assert.strictEqual(route(['records'], 'Records.pryv.li'), '/events');
      assert.strictEqual(route(['Records'], 'records.pryv.li'), '/events');
    });
  });
});
