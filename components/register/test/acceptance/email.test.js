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
/* global describe, it, before, after */

const { databaseFixture } = require('test-helpers');
const {
  produceMongoConnection,
  context
} = require('api-server/test/test-helpers');
const regPath = require('api-server/src/routes/Paths').Register;

const cuid = require('cuid');

const chai = require('chai');
const assert = chai.assert;

describe('register /email', function () {
  let server, email;

  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
  });
  after(() => {
    mongoFixtures.clean();
  });

  let username;
  before(() => {
    username = cuid().substr(5);
    email = username + '@pryv.io';
  });

  before(async () => {
    server = await context.spawn();
  });
  after(() => {
    server.stop();
  });

  before(async function () {
    await mongoFixtures.user(username, {
      email
    });
  });

  describe('GET /:email/check_email', function () {
    it('[RET1] should return item-already-exists if email exists ', async function () {
      const res = await server
        .request()
        .get(regPath + '/' + email + '/check_email')
        .set('Accept', 'application/json');
      assert.equal(res.status, 409);
      const body = res.body;
      assert.exists(body.error);
      assert.equal(body.error.id, 'item-already-exists');
      assert.isTrue(body.error.message.includes(username));
    });

    it('[RER1] should return false if email does not exists ', async function () {
      const wrongEmail = cuid().substr(5) + '@toto.com';
      const res = await server
        .request()
        .get(regPath + '/' + wrongEmail + '/check_email')
        .set('Accept', 'application/json');
      assert.equal(res.status, 200);
      assert.equal(res.body.reserved, false);
    });
  });

  describe('POST /email/check', function () {
    const callPath = regPath + '/email/check';
    it('[REZ7] should return 410 gone resource', async function () {
      const res = await server.request().post(callPath).send({ email });
      assert.equal(res.status, 410);
    });
  });

  const calls = ['uid', 'username'];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    describe('GET /:email/' + call, function () {
      it(
        '[RET' + (i + 1) * 2 + '] should return uid from email if it exists',
        async function () {
          const res = await server
            .request()
            .get(regPath + '/' + email + '/' + call)
            .set('Accept', 'application/json');
          assert.equal(res.status, 200);
          assert.equal(res.body[call], username);
        }
      );

      it(
        '[RET' +
          (i + 1) * 2 +
          1 +
          '] should not return uid from email if it exists',
        async function () {
          const wrongEmail = cuid() + '@toto.com';
          const res = await server
            .request()
            .get(regPath + '/' + wrongEmail + '/' + call)
            .set('Accept', 'application/json');
          assert.equal(res.status, 404);
          assert.equal(res.body.id, 'UNKNOWN_EMAIL');
        }
      );
    });
  }
});
