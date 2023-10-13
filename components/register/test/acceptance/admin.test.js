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

require('test-helpers/src/api-server-tests-config');
const { databaseFixture } = require('test-helpers');
const {
  produceMongoConnection,
  context
} = require('api-server/test/test-helpers');
const regPath = require('api-server/src/routes/Paths').Register;

const { getConfig } = require('@pryv/boiler');

const cuid = require('cuid');

const chai = require('chai');
const assert = chai.assert;

describe('register /admin', function () {
  let server, email, adminKey;
  this.timeout(10000);

  let mongoFixtures;
  before(async function () {
    const config = await getConfig();
    adminKey = config.get('auth:adminAccessKey');
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
      email,
      created: Date.now() / 1000
    });
  });

  it('[6TZE] /admin/users ', async function () {
    const res = await server
      .request()
      .get(regPath + '/admin/users')
      .set('Authorization', adminKey)
      .set('Accept', 'application/json');
    assert.equal(res.status, 200);
    assert.exists(res.body.users);
    assert.isAbove(res.body.users.length, 1);
    for (const user of res.body.users) {
      assert.exists(user.username);
      assert.exists(user.email);
    }
  });
});
