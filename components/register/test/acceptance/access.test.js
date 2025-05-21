/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
const { context } = require('api-server/test/test-helpers');
const regPath = require('api-server/src/routes/Paths').Register;

const cuid = require('cuid');

const chai = require('chai');
const assert = chai.assert;

let server;

describe('access', function () {
  this.timeout(10000);
  before(async () => {
    server = await context.spawn();
  });
  after(() => {
    server.stop();
  });

  it('[RE5T] POST /access', async () => {
    const res = await requestAccess();
    assert.equal(res.status, 'NEED_SIGNIN');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  it('[RE6T] POST /access/invitationtoken/check', async () => {
    const res = await server
      .request()
      .post(regPath + '/access/invitationtoken/check')
      .send({ invitationToken: cuid() });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'true');
  });

  describe(' GET / POST access/:key', () => {
    let key = null;
    before(async () => {
      key = (await requestAccess()).key;
    });

    it('[RE8T] GET /access/:key', async () => {
      const res = await server
        .request()
        .get(regPath + '/access/' + key)
        .set('Accept', 'application/json');

      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'NEED_SIGNIN');
    });

    it('[RE9T] POST /access/:key', async () => {
      const accessACCEPTED = {
        status: 'ACCEPTED',
        apiEndPoint: 'http://dummy/dummy',
        username: 'dummy',
        token: cuid()
      };
      const res = await server
        .request()
        .post(regPath + '/access/' + key)
        .send(accessACCEPTED)
        .set('Accept', 'application/json');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ACCEPTED');
    });
  });
});

async function requestAccess () {
  const accessRequestData = {
    requestingAppId: 'test-app-id',
    requestedPermissions: [
      {
        streamId: 'diary',
        level: 'read',
        defaultName: 'Journal'
      }
    ],
    languageCode: 'fr'
  };
  const res = await server
    .request()
    .post(regPath + '/access/')
    .send(accessRequestData)
    .set('Accept', 'application/json');
  assert.equal(res.status, 201);
  return res.body;
}
