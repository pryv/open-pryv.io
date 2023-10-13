/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const supertest = require('supertest');
const should = require('should');
const { fixturePath, fixtureFile } = require('../test-helper');
const uploads = require('../../../src/middleware/uploads');

describe('uploads middleware', function () {
  function app () {
    const app = express();
    const verifyAssumptions = (req, res) => {
      res.status(200).json({ files: req.files });
    };
    app.post('/path', bodyParser.json(), uploads.hasFileUpload, verifyAssumptions);
    return app;
  }
  const request = supertest(app());
  describe('hasFileUpload', function () {
    it('[GY5H] should parse file uploads', function () {
      const rq = request
        .post('/path')
        .attach('file', fixturePath('somefile'), fixtureFile('somefile'));
      return rq.then((res) => {
        should(res.statusCode).be.eql(200);
        const files = res.body.files;
        if (!Array.isArray(files)) { throw new Error('AF: must be an array'); }
        const file = files[0];
        if (file == null || file.originalname == null) { throw new Error('AF: should not be null'); }
        should(file.originalname).be.eql('somefile');
      });
    });
  });
});
