/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, _ */

const timestamp = require('unix-timestamp');
const { ErrorIds } = require('errors');
const methodsSchema = require('../src/schema/accessesMethods');
const { ApiEndpoint } = require('utils');
const { getConfig } = require('@pryv/boiler');
const { integrity } = require('business');
const storage = require('storage');

describe('[ACCP] accesses (app)', function () {
  let validation;
  let username;
  let fixtureUser;
  let stream0, stream1, stream0Child;
  let appAccessAToken, appAccessAId;
  let appAccessB, appAccessBToken;
  let sharedAccess, sharedAccessToken;
  let sharedAccessAToken, sharedAccessAId;
  let sharedAccessBToken;
  let rootAccessToken;
  let basePath;
  let fixtures;
  let accessStorage;
  let user;

  function buildApiEndpoint (uname, token) {
    return ApiEndpoint.build(uname, token);
  }

  before(async function () {
    await initTests();
    await initCore();
    await getConfig();

    validation = require('./helpers/validation');

    fixtures = getNewFixture();
    username = cuid();
    basePath = '/' + username + '/accesses';

    const storageLayer = await storage.getStorageLayer();
    accessStorage = storageLayer.accesses;
    user = { id: username };

    // Create user with streams using fixtures
    fixtureUser = await fixtures.user(username);

    // Create streams using fixtures
    stream0 = await fixtureUser.stream({ id: `stream0_${username}`, name: 'Stream 0' });
    stream0Child = await stream0.stream({ id: `stream0child_${username}`, name: 'Stream 0 Child' });
    stream1 = await fixtureUser.stream({ id: `stream1_${username}`, name: 'Stream 1' });

    // Create unique tokens and IDs
    appAccessAToken = cuid();
    appAccessBToken = cuid();
    sharedAccessAToken = cuid();
    rootAccessToken = cuid();
    sharedAccessBToken = cuid();
    sharedAccessToken = cuid();

    appAccessAId = `app_A_${username}`;
    sharedAccessAId = `shared_A_${username}`;
  });

  // Create all test accesses using fixtures
  async function createTestAccesses () {
    // App access A (main access for tests)
    await fixtureUser.access({
      id: appAccessAId,
      token: appAccessAToken,
      name: 'App access A',
      type: 'app',
      permissions: [
        { streamId: stream0.attrs.id, level: 'manage' },
        { streamId: stream1.attrs.id, level: 'contribute' }
      ]
    });

    // App access B (subset of A)
    appAccessB = await fixtureUser.access({
      id: `app_B_${username}`,
      token: appAccessBToken,
      name: 'App access B (subset of A)',
      type: 'app',
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });

    // Shared access A (created by app_A - important for delete tests)
    await fixtureUser.access({
      id: sharedAccessAId,
      token: sharedAccessAToken,
      name: 'Shared access A (subset of app access A)',
      type: 'shared',
      permissions: [{ streamId: stream0Child.attrs.id, level: 'read' }],
      createdBy: appAccessAId,
      modifiedBy: appAccessAId
    });

    // Root access (manage all streams)
    await fixtureUser.access({
      id: `root_A_${username}`,
      token: rootAccessToken,
      name: 'Root token',
      type: 'app',
      permissions: [{ streamId: '*', level: 'manage' }]
    });

    // Shared access B (with permission on non-existing stream)
    await fixtureUser.access({
      id: `shared_B_${username}`,
      token: sharedAccessBToken,
      name: 'Shared access B (with permission on unexisting stream)',
      type: 'shared',
      permissions: [{ streamId: 'idonotexist', level: 'read' }]
    });

    // Regular shared access for forbidden tests
    sharedAccess = await fixtureUser.access({
      id: `shared_regular_${username}`,
      token: sharedAccessToken,
      name: 'Regular shared access',
      type: 'shared',
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });
  }

  // Clean and recreate accesses for tests that modify data
  async function resetAccesses () {
    // Remove all accesses for this user (uses deleteMany with userId filter - parallel safe)
    await new Promise((resolve) => {
      accessStorage.removeAll(user, () => resolve());
    });
    // Recreate test accesses
    await createTestAccesses();
  }

  function path (id) {
    return basePath + '/' + id;
  }

  describe('[AA01] GET /', function () {
    before(resetAccesses);

    it("[YEHW] must return shared accesses whose permissions are a subset of the current one's", async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', appAccessAToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result
      });

      // Check that sharedAccessA is returned (created by appAccessA)
      assert.ok(res.body.accesses.length >= 1, 'should have at least 1 access');
      const found = res.body.accesses.find(a => a.id === sharedAccessAId);
      assert.ok(found, 'should return sharedAccessA');
    });

    it('[GLHP] must be forbidden to requests with a shared access token', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', sharedAccessToken);

      validation.checkErrorForbidden(res);
    });
  });

  describe('[AA02] POST /', function () {
    beforeEach(resetAccesses);

    it('[QVHS] must create a new shared access with the sent data and return it', async function () {
      const data = {
        name: 'New Access',
        permissions: [
          {
            streamId: stream0.attrs.id,
            level: 'read',
            defaultName: 'Should be ignored',
            name: 'Should be ignored'
          }
        ]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', appAccessAToken)
        .send(data);

      validation.check(res, {
        status: 201,
        schema: methodsSchema.create.result
      });

      const expected = structuredClone(data);
      expected.id = res.body.access.id;
      expected.token = res.body.access.token;
      expected.apiEndpoint = buildApiEndpoint(username, expected.token);
      expected.type = 'shared';
      delete expected.permissions[0].defaultName;
      delete expected.permissions[0].name;
      expected.created = res.body.access.created;
      expected.createdBy = res.body.access.createdBy;
      expected.modified = res.body.access.modified;
      expected.modifiedBy = res.body.access.modifiedBy;
      expected.deviceName = null;
      integrity.accesses.set(expected);
      validation.checkObjectEquality(res.body.access, expected);
    });

    it('[6GR1] must forbid trying to create a non-shared access', async function () {
      const data = {
        name: 'New Access',
        type: 'app',
        permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', appAccessAToken)
        .send(data);

      validation.checkErrorForbidden(res);
    });

    it('[A4MC] must forbid trying to create an access with greater permissions', async function () {
      const data = {
        name: 'New Access',
        permissions: [{ streamId: stream1.attrs.id, level: 'manage' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', appAccessAToken)
        .send(data);

      validation.checkErrorForbidden(res);
    });

    it('[QN6D] must return a correct error if the sent data is badly formatted', async function () {
      const data = {
        name: 'New Access',
        permissions: [{ streamId: stream0.attrs.id, level: 'bad-level' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', appAccessAToken)
        .send(data);

      validation.checkErrorInvalidParams(res);
    });

    it('[4HAE] must allow creation of shared accesses with an access that has superior permission on root stream (*)', async function () {
      const data = {
        name: 'New Access',
        permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', rootAccessToken)
        .send(data);

      assert.ok(res.body);
      assert.ok(res.body.error == null);
      assert.strictEqual(res.statusCode, 201);
    });
  });

  describe('[AA03] PUT /<token>', function () {
    beforeEach(resetAccesses);

    it('[11UZ]  must return a 410 (Gone)', async function () {
      const res = await coreRequest
        .put(path(appAccessB.attrs.id))
        .set('Authorization', appAccessAToken)
        .send({ name: 'Updated App Access' });

      validation.check(res, { status: 410 });
    });
  });

  describe('[AA04] DELETE /<id>', function () {
    beforeEach(resetAccesses);

    it('[5BOO] must delete the shared access', async function () {
      const deletionTime = timestamp.now();

      const res = await coreRequest
        .delete(path(sharedAccessAId))
        .set('Authorization', appAccessAToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.del.result,
        body: { accessDeletion: { id: sharedAccessAId } }
      });

      // Verify data in storage
      const accesses = await new Promise((resolve, reject) => {
        accessStorage.findAll(user, null, (err, acc) => {
          if (err) reject(err);
          else resolve(acc);
        });
      });

      const actual = _.find(accesses, { id: sharedAccessAId });
      assert.ok(actual.deleted >= deletionTime - 1, 'access should be marked deleted');
    });

    it('[ZTSX] forbid deletion of already deleted for AppTokens', async function () {
      // First deletion
      const res1 = await coreRequest
        .delete(path(appAccessAId))
        .set('Authorization', appAccessAToken);

      validation.check(res1, {
        status: 200,
        schema: methodsSchema.del.result,
        body: {
          accessDeletion: { id: appAccessAId },
          relatedDeletions: [{ id: sharedAccessAId }]
        }
      });

      // Second deletion should be forbidden
      const res2 = await coreRequest
        .delete(path(appAccessAId))
        .set('Authorization', appAccessAToken);

      validation.check(res2, { status: 403 });
    });

    it('[VGQS] must forbid trying to delete a non-shared access', async function () {
      const res = await coreRequest
        .delete(path(appAccessB.attrs.id))
        .set('Authorization', appAccessAToken);

      validation.checkErrorForbidden(res);
    });

    it('[ZTSY] must forbid trying to delete an access that was not created by itself', async function () {
      const res = await coreRequest
        .delete(path(sharedAccess.attrs.id))
        .set('Authorization', appAccessAToken);

      validation.checkErrorForbidden(res);
    });

    it('[J32P] must return a correct error if the access does not exist', async function () {
      const res = await coreRequest
        .delete(path('unknown-id'))
        .set('Authorization', appAccessAToken);

      validation.checkError(res, {
        status: 404,
        id: ErrorIds.UnknownResource
      });
    });
  });
});
