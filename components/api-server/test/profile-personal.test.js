/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, _ */

const validation = require('./helpers/validation');
const methodsSchema = require('../src/schema/profileMethods');

describe('[PRFP] profile (personal)', function () {
  let username;
  let basePath;
  let personalToken;
  let appToken;
  let publicProfile;
  let privateProfile;
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();

    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    appToken = cuid();
    basePath = '/' + username + '/profile';

    publicProfile = {
      id: 'public',
      data: {
        keyOne: 'value One',
        keyTwo: 2,
        keyThree: true,
        keyFour: [1, 2, 3, 4],
        keyFive: { giveMe: 5 }
      }
    };

    privateProfile = {
      id: 'private',
      data: {
        keyOne: 'value One',
        keyTwo: 2,
        keyThree: true,
        keyFour: [1, 2, 3, 4],
        keyFive: { giveMe: 5 }
      }
    };

    const user = await fixtures.user(username);

    // Create personal access and session for personal requests
    await user.access({
      type: 'personal',
      token: personalToken
    });
    await user.session(personalToken);

    // Create app access for forbidden tests
    await user.access({
      type: 'app',
      name: 'test-app',
      token: appToken,
      permissions: [{ streamId: '*', level: 'contribute' }]
    });

    // Create initial profiles
    await fixtures.context.profile(username, publicProfile);
    await fixtures.context.profile(username, privateProfile);
  });

  describe('[PP01] GET', function () {
    it('[J61R] /public must return publicly shared key-value profile info', async function () {
      const res = await coreRequest
        .get(basePath + '/public')
        .set('Authorization', personalToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result,
        body: { profile: publicProfile.data }
      });
    });

    it('[HIMS] /private must return private key-value profile info', async function () {
      const res = await coreRequest
        .get(basePath + '/private')
        .set('Authorization', personalToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result,
        body: { profile: privateProfile.data }
      });
    });

    it('[36B1] must return an appropriate error for other paths', async function () {
      const res = await coreRequest
        .get(basePath + '/unknown-profile')
        .set('Authorization', personalToken);

      assert.strictEqual(res.statusCode, 404);
    });

    it('[FUJA] "private" must be forbidden to non-personal accesses', async function () {
      const res = await coreRequest
        .get(basePath + '/private')
        .set('Authorization', appToken);

      validation.checkErrorForbidden(res);
    });
  });

  describe('[PP02] PUT', function () {
    beforeEach(async function () {
      // Reset profiles
      await fixtures.context.profile(username, publicProfile);
      await fixtures.context.profile(username, privateProfile);
    });

    it('[M28R] /public must add/update/remove the specified keys without touching the others', async function () {
      const data = {
        newKey: 'New Value', // add
        keyOne: 'No One', // update
        keyTwo: null // delete
      };

      const res = await coreRequest
        .put(basePath + '/public')
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.update.result
      });

      const expectedData = _.extend(structuredClone(publicProfile.data), data);
      delete expectedData.keyTwo;
      assert.deepStrictEqual(res.body.profile, expectedData);
    });

    it('[WU9C] /private must add/update/remove the specified keys without touching the others', async function () {
      const data = {
        newKey: 'New Value', // add
        keyOne: 'No One', // update
        keyTwo: null // delete
      };

      const res = await coreRequest
        .put(basePath + '/private')
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.update.result
      });

      const expectedData = _.extend(structuredClone(privateProfile.data), data);
      delete expectedData.keyTwo;
      assert.deepStrictEqual(res.body.profile, expectedData);
    });

    it('[2AS6] must create the profile if not existing', async function () {
      // Remove all profiles for the user
      const storage = require('storage');
      const storageLayer = await storage.getStorageLayer();
      const profileStorage = storageLayer.profile;
      const user = { id: username };
      await new Promise((resolve) => {
        profileStorage.removeAll(user, () => resolve());
      });

      // Now test PUT creates the profile
      const data = {
        newKey: 'New Value'
      };

      const res = await coreRequest
        .put(basePath + '/public')
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.update.result
      });

      assert.deepStrictEqual(res.body.profile, data);
    });

    it('[Q99E] must return an appropriate error for other paths', async function () {
      const res = await coreRequest
        .put(basePath + '/unknown-profile')
        .set('Authorization', personalToken)
        .send({ an: 'update' });

      assert.strictEqual(res.statusCode, 404);
    });

    it('[T565] must be forbidden to non-personal accesses', async function () {
      const res = await coreRequest
        .put(basePath + '/public')
        .set('Authorization', appToken)
        .send({ an: 'update' });

      validation.checkErrorForbidden(res);
    });
  });
});
