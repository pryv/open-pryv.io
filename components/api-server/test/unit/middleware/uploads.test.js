/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('test-helpers/src/api-server-tests-config.ts');
const express = require('express');
const assert = require('node:assert');
const { listeningAgent } = require('test-helpers/src/listeningAgent.ts');
const { fixturePath, fixtureFile } = require('../test-helper');
const uploads = require('../../../src/middleware/uploads.ts');

describe('[UPLD] uploads middleware', function () {
  function app () {
    const app = express();
    const verifyAssumptions = (req, res) => {
      res.status(200).json({ files: req.files });
    };
    app.post('/path', express.json(), uploads.hasFileUpload, verifyAssumptions);
    return app;
  }
  // Not a bare app: see listeningAgent.ts on why supertest(app) flakes on macOS.
  let request;
  before(async function () {
    request = await listeningAgent(app());
  });
  describe('[UP01] hasFileUpload', function () {
    it('[GY5H] should parse file uploads', function () {
      const rq = request
        .post('/path')
        .attach('file', fixturePath('somefile'), fixtureFile('somefile'));
      return rq.then((res) => {
        assert.strictEqual(res.statusCode, 200);
        const files = res.body.files;
        assert.ok(Array.isArray(files), 'must be an array');
        const file = files[0];
        assert.ok(file != null && file.originalname != null, 'should not be null');
        assert.strictEqual(file.originalname, 'somefile');
      });
    });
  });
  describe('[UP02] buildUploadLimits', function () {
    it('[UP02A] must apply the configured size and file count', function () {
      const { limits } = uploads.buildUploadLimits(2, 4);
      assert.deepStrictEqual(limits, {
        fileSize: 2 * 1024 * 1024,
        fieldSize: 2 * 1024 * 1024,
        fields: 1,
        files: 4,
        parts: 5
      });
    });
    it('[UP02B] must apply defaults when the settings are absent or invalid', function () {
      for (const [size, files] of [[undefined, undefined], [null, null], ['abc', 'abc'], [0, 0], [-1, 2.5]]) {
        const { maxSizeMb, maxFiles, limits } = uploads.buildUploadLimits(size, files);
        assert.strictEqual(maxSizeMb, 50);
        assert.strictEqual(maxFiles, 10);
        assert.strictEqual(limits.fileSize, 50 * 1024 * 1024);
        assert.strictEqual(limits.fields, 1);
        assert.strictEqual(limits.files, 10);
        assert.strictEqual(limits.parts, 11);
      }
    });
  });
});
