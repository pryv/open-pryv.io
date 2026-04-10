/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

require('date-utils');

describe('[PSLF] permissions selfRevoke', function () {
  let mongoFixtures;
  before(async function () {
    await initTests();
    await initCore();
    mongoFixtures = getNewFixture();
  });

  describe('[PS01] POST /accesses', function () {
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
        name: `test-app-${username}`, // Unique name per user
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
      const res = await coreRequest.post(basePathAccess).set('Authorization', personalToken).send({
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

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.access);

      // --- check that permissions are visible with a .get()

      const res3 = await coreRequest.get(basePathAccess).set('Authorization', personalToken);
      assert.strictEqual(res3.status, 200);
      assert.ok(res3.body.accesses);
      let found;
      for (let i = 0; i < res3.body.accesses.length && found == null; i++) {
        if (res3.body.accesses[i].id === res.body.access.id) found = res3.body.accesses[i];
      }
      assert.ok(found != null);
      assert.ok(found.permissions);
      let featureFound = false;
      for (let i = 0; i < found.permissions.length; i++) {
        if (found.permissions[i].feature === 'selfRevoke') {
          assert.strictEqual(found.permissions[i].setting, 'forbidden');
          featureFound = true;
        }
      }
      assert.strictEqual(featureFound, true);
    });

    it('[JYU5] must forbid creating accesses with selfRevoke different than forbidden ', async () => {
      const res = await coreRequest.post(basePathAccess).set('Authorization', personalToken).send({
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
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error);
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    });

    it('[UZRA] an appToken with managed rights should allow to create an access with selfRevoke forbidden', async function () {
      const res = await coreRequest
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
      assert.strictEqual(res.status, 201);
      const access = res.body.access;
      assert.ok(access);
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
          name: `test-access-${i}-${username}`, // Unique name per user
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
        const res = await coreRequest.delete(basePathAccess + access.id).set('Authorization', access.token);

        if (access.selfRevoke) {
          assert.strictEqual(res.status, 200);
          assert.ok(res.body.accessDeletion);
          assert.strictEqual(res.body.accessDeletion.id, access.id);
        } else {
          assert.strictEqual(res.status, 403);
        }
      });
    }
  });
});
