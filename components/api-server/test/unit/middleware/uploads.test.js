/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

require('test-helpers/src/api-server-tests-config');
const express = require('express');
const bodyParser = require('body-parser');
const supertest = require('supertest');
const assert = require('node:assert');
const { fixturePath, fixtureFile } = require('../test-helper');
const uploads = require('../../../src/middleware/uploads');

describe('[UPLD] uploads middleware', function () {
  function app () {
    const app = express();
    const verifyAssumptions = (req, res) => {
      res.status(200).json({ files: req.files });
    };
    app.post('/path', bodyParser.json(), uploads.hasFileUpload, verifyAssumptions);
    return app;
  }
  const request = supertest(app());
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
});
