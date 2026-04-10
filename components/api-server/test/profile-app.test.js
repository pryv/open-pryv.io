/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, _ */

const ErrorIds = require('errors').ErrorIds;
const validation = require('./helpers/validation');
const methodsSchema = require('../src/schema/profileMethods');

describe('[PRFA] profile (app)', function () {
  let username;
  let basePath;
  let appToken;
  let appName;
  let sharedToken;
  let personalToken;
  let profileData;

  before(async function () {
    await initTests();
    await initCore();

    // Create fixture data
    const fixtures = getNewFixture();
    username = cuid();
    appName = 'test-3rd-party-app-id';
    appToken = cuid();
    sharedToken = cuid();
    personalToken = cuid();
    basePath = '/' + username;

    profileData = {
      keyOne: 'value One',
      keyTwo: 2,
      keyThree: true,
      keyFour: [1, 2, 3, 4],
      keyFive: { giveMe: 5 }
    };

    const user = await fixtures.user(username);

    // Create app access
    await user.access({
      type: 'app',
      name: appName,
      token: appToken,
      permissions: [{ streamId: '*', level: 'contribute' }]
    });

    // Create shared access
    await user.access({
      type: 'shared',
      name: 'shared-access',
      token: sharedToken,
      permissions: [{ streamId: '*', level: 'read' }]
    });

    // Create personal access
    await user.access({
      type: 'personal',
      token: personalToken
    });
    await user.session(personalToken);

    // Create public profile
    await fixtures.context.profile(username, {
      id: 'public',
      data: profileData
    });

    // Create app profile
    await fixtures.context.profile(username, {
      id: appName,
      data: profileData
    });
  });

  describe('[PA01] GET /public', function () {
    it('[FWG1] must return publicly shared key-value profile info', async function () {
      const res = await coreRequest
        .get(basePath + '/profile/public')
        .set('Authorization', appToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result,
        body: { profile: profileData }
      });
    });
  });

  describe('[PA02] GET /app', function () {
    it('[13DL] must return key-value settings for the current app', async function () {
      const res = await coreRequest
        .get(basePath + '/profile/app')
        .set('Authorization', appToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result,
        body: { profile: profileData }
      });
    });

    it('[J37U] must refuse requests with a shared access token', async function () {
      const res = await coreRequest
        .get(basePath + '/profile/app')
        .set('Authorization', sharedToken);

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidOperation
      });
    });

    it('[GYBN] must refuse requests with a personal access token', async function () {
      const res = await coreRequest
        .get(basePath + '/profile/app')
        .set('Authorization', personalToken);

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidOperation
      });
    });
  });

  describe('[PA03] PUT /app', function () {
    beforeEach(async function () {
      // Reset app profile
      const fixtures = getNewFixture();
      await fixtures.context.profile(username, {
        id: appName,
        data: structuredClone(profileData)
      });
    });

    it('[1QFB] must add/update/remove the specified keys without touching the others', async function () {
      const data = {
        newKey: 'New Value', // add
        keyOne: 'No One', // update
        keyTwo: null // delete
      };

      const res = await coreRequest
        .put(basePath + '/profile/app')
        .set('Authorization', appToken)
        .send(data);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.update.result
      });

      const expectedData = _.extend(structuredClone(profileData), data);
      delete expectedData.keyTwo;
      assert.deepStrictEqual(res.body.profile, expectedData);
    });

    it('[0H9A] must refuse requests with a shared access token', async function () {
      const res = await coreRequest
        .put(basePath + '/profile/app')
        .set('Authorization', sharedToken)
        .send({ any: 'thing' });

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidOperation
      });
    });

    it('[JC5F] must refuse requests with a personal access token', async function () {
      const res = await coreRequest
        .put(basePath + '/profile/app')
        .set('Authorization', personalToken)
        .send({ any: 'thing' });

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidOperation
      });
    });
  });
});
