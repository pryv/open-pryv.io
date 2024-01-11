/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

const cuid = require('cuid');
const { assert } = require('chai');

require('./test-helpers');

const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');

require('date-utils');

describe('permissions selfRevoke', function () {
  let server;
  before(async () => {
    server = await context.spawn();
  });
  after(() => {
    server.stop();
  });

  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture((await produceMongoConnection()));
  });

  describe('POST /accesses', function () {
    let username,
      personalToken,
      appToken,
      streamId,
      basePathAccess;

    beforeEach(async function () {
      username = cuid();
      personalToken = cuid();
      appToken = cuid();
      streamId = cuid();
      basePathAccess = `/${username}/accesses/`;
      const user = await mongoFixtures.user(username, {});
      await user.access({
        type: 'personal',
        token: personalToken
      });
      await user.session(personalToken);
      await user.stream({
        id: streamId,
        name: 'Does not matter either'
      });
      await user.access({
        type: 'app',
        token: appToken,
        permissions: [
          {
            streamId,
            level: 'manage'
          }
        ]
      });
    });

    afterEach(async () => {
      await mongoFixtures.clean();
    });

    it('[JYL5] must list accesses with forbidden selfRevoke by GET /accesses', async () => {
      const res = await server.request().post(basePathAccess).set('Authorization', personalToken).send({
        type: 'app',
        name: 'toto',
        permissions: [{
          streamId: '*',
          level: 'contribute'
        }, {
          feature: 'selfRevoke',
          setting: 'forbidden'
        }]
      });

      assert.equal(res.status, 201);
      assert.exists(res.body.access);

      // --- check that permissions are visible with a .get()

      const res3 = await server.request().get(basePathAccess).set('Authorization', personalToken);
      assert.equal(res3.status, 200);
      assert.exists(res3.body.accesses);
      let found;
      for (let i = 0; i < res3.body.accesses.length && found == null; i++) {
        if (res3.body.accesses[i].id === res.body.access.id) found = res3.body.accesses[i];
      }
      assert.isNotNull(found);
      assert.exists(found.permissions);
      let featureFound = false;
      for (let i = 0; i < found.permissions.length; i++) {
        if (found.permissions[i].feature === 'selfRevoke') {
          assert.equal(found.permissions[i].setting, 'forbidden');
          featureFound = true;
        }
      }
      assert.isTrue(featureFound);
    });

    it('[JYU5] must forbid creating accesses with selfRevoke different than forbidden ', async () => {
      const res = await server.request().post(basePathAccess).set('Authorization', personalToken).send({
        type: 'app',
        name: 'toto',
        permissions: [{
          streamId: '*',
          level: 'contribute'
        }, {
          feature: 'selfRevoke',
          setting: 'bob'
        }]
      });
      assert.equal(res.status, 400);
      assert.exists(res.body.error);
      assert.equal(res.body.error.id, 'invalid-parameters-format');
    });

    it('[UZR] an appToken with managed rights should allow to create an access with selfRevoke forbidden', async function () {
      const res = await server.request()
        .post(basePathAccess)
        .set('Authorization', appToken)
        .send({
          type: 'shared',
          name: 'whatever',
          permissions: [{
            streamId,
            level: 'manage'
          }, {
            feature: 'selfRevoke',
            setting: 'forbidden'
          }]
        });
      assert.equal(res.status, 201);
      const access = res.body.access;
      assert.exists(access);
    });
  });

  describe('[DACC] DELETE /accesses', function () {
    let username,
      accesses,
      basePathAccess;

    const accessDefs = {};
    accessDefs['must allow app accesses to self revoke by default'] = { testCode: 'AHS6', selfRevoke: true };
    accessDefs['must forbid app accesses to self revoke when set'] = { testCode: 'H6DU', selfRevoke: false };
    accessDefs['must allow shared accesses to self revoke by default'] = { testCode: '3DR7', type: 'shared', selfRevoke: true };
    accessDefs['must forbid shared accesses to self revoke when set'] = { testCode: 'F62D', type: 'shared', selfRevoke: false };

    const accessKeys = Object.keys(accessDefs);

    beforeEach(async function () {
      username = cuid();
      basePathAccess = `/${username}/accesses/`;
      accesses = structuredClone(accessDefs);
      const user = await mongoFixtures.user(username, {});

      for (let i = 0; i < accessKeys.length; i++) {
        const access = accesses[accessKeys[i]];
        access.token = cuid();
        const data = {
          type: access.type || 'app',
          token: access.token,
          permissions: [{
            streamId: '*',
            level: 'contribute'
          }]
        };
        if (!access.selfRevoke) {
          data.permissions.push({
            feature: 'selfRevoke',
            setting: 'forbidden'
          });
        }
        access.id = (await user.access(data)).attrs.id;
      }
    });
    afterEach(async () => {
      await mongoFixtures.clean();
    });

    for (let i = 0; i < accessKeys.length; i++) {
      const testKey = accessKeys[i];
      const accessDef = accessDefs[testKey];
      it(`[${accessDef.testCode}] ` + testKey, async function () {
        const access = accesses[testKey];
        const res = await server.request().delete(basePathAccess + access.id).set('Authorization', access.token);

        if (access.selfRevoke) {
          assert.equal(res.status, 200);
          assert.exists(res.body.accessDeletion);
          assert.equal(res.body.accessDeletion.id, access.id);
        } else {
          assert.equal(res.status, 403);
        }
      });
    }
  });
});
