/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan */

const { ErrorIds } = require('errors');
const validation = require('./helpers/validation');
const methodsSchema = require('../src/schema/accessesMethods');
const { getMall } = require('mall');
const storage = require('storage');

describe('[ACSF] accesses (personal)', function () {
  let username;
  let basePath;
  let personalToken;
  let sessionAccessId;
  let appToken;
  let sharedToken;
  let mall = null;
  let accessStorage;
  let sessionStorage;
  let user;
  let fixtures;
  let fixtureUser;
  // eslint-disable-next-line no-unused-vars
  let stream0, stream1, stream2, stream3;
  let personalAccess, appAccess, sharedAccess;

  function path (id) {
    return basePath + '/' + id;
  }

  before(async function () {
    await initTests();
    await initCore();

    mall = await getMall();

    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    appToken = cuid();
    sharedToken = cuid();
    basePath = '/' + username + '/accesses';
    user = { id: username };

    const storageLayer = await storage.getStorageLayer();
    accessStorage = storageLayer.accesses;
    sessionStorage = storageLayer.sessions;

    // Create user with streams
    fixtureUser = await fixtures.user(username);

    // Create streams
    stream0 = await fixtureUser.stream({ id: `stream0_${username}`, name: 'Stream 0' });
    await stream0.stream({ id: `stream0_0_${username}`, name: 'Stream 0.0' });
    stream1 = await fixtureUser.stream({ id: `stream1_${username}`, name: 'Stream 1' });
    stream2 = await fixtureUser.stream({ id: `stream2_${username}`, name: 'Stream 2' });
    stream3 = await fixtureUser.stream({ id: `stream3_${username}`, name: 'Stream 3' });
  });

  // Create all test accesses using fixtures
  async function createTestAccesses () {
    // Create personal access
    personalAccess = await fixtureUser.access({
      type: 'personal',
      token: personalToken
    });
    await fixtureUser.session(personalToken);
    sessionAccessId = personalAccess.attrs.id;

    // Create app access
    appAccess = await fixtureUser.access({
      id: `app_${username}`,
      type: 'app',
      name: 'test-3rd-party-app-id',
      token: appToken,
      deviceName: "Calvin's Amazing Transmogrifier",
      permissions: [{ streamId: stream0.attrs.id, level: 'contribute' }]
    });

    // Create shared access
    sharedAccess = await fixtureUser.access({
      id: `shared_${username}`,
      type: 'shared',
      name: 'read all',
      token: sharedToken,
      permissions: [{ streamId: '*', level: 'read' }]
    });
  }

  // Clean and recreate accesses for tests that modify data
  async function resetAccesses () {
    // Remove all accesses for this user (uses deleteMany with userId filter - parallel safe)
    await new Promise((resolve) => {
      accessStorage.removeAll(user, () => resolve());
    });
    // Also remove session for this user (session _id is the personalToken)
    await new Promise((resolve) => {
      sessionStorage.destroy(personalToken, () => resolve());
    });
    // Recreate test accesses using fixtures
    await createTestAccesses();
  }

  describe('[AS01] GET /', function () {
    before(resetAccesses);

    it('[K5BF] must return all accesses (including personal ones)', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', personalToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result
      });

      assert.ok(res.body.accesses.length >= 3, 'should have at least 3 accesses');
    });
  });

  describe('[AS02] POST /', function () {
    beforeEach(resetAccesses);

    it('[BU9U] must create a new shared access with the sent data, returning it', async function () {
      const data = {
        name: 'New Access',
        permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
      };

      const originalCount = await new Promise((resolve, reject) => {
        accessStorage.countAll(user, (err, count) => {
          if (err) reject(err);
          else resolve(count);
        });
      });

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 201,
        schema: methodsSchema.create.result
      });

      const accesses = await new Promise((resolve, reject) => {
        accessStorage.findAll(user, null, (err, acc) => {
          if (err) reject(err);
          else resolve(acc);
        });
      });

      assert.strictEqual(accesses.length, originalCount + 1, 'accesses');
    });

    it('[FPUE] must create a new app access with the sent data, creating/restoring requested streams', async function () {
      const data = {
        name: 'my-sweet-app',
        type: 'app',
        deviceName: 'My Sweet Device',
        permissions: [
          { streamId: stream0.attrs.id, level: 'contribute', name: 'This should be ignored' },
          { streamId: 'new-stream', level: 'manage', defaultName: 'The New Stream, Sir.' },
          { streamId: '*', level: 'read', defaultName: 'Ignored, must be cleaned up' }
        ]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 201,
        schema: methodsSchema.create.result
      });

      // Verify new stream was created
      const newStream = await mall.streams.getOneWithNoChildren(user.id, 'new-stream');
      assert.ok(newStream);
      assert.strictEqual(newStream.name, 'The New Stream, Sir.');
    });

    it('[865I] must accept two app accesses with the same name (app ids) but different device names', async function () {
      const data = {
        name: appAccess.attrs.name,
        type: 'app',
        deviceName: "Calvin's Fantastic Cerebral Enhance-o-tron",
        permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 201,
        schema: methodsSchema.create.result
      });
    });

    it('[4Y3Y] must ignore erroneous requests to create new streams', async function () {
      const data = {
        name: 'my-sweet-app-id',
        type: 'app',
        permissions: [
          { streamId: stream0.attrs.id, level: 'read', defaultName: 'This property should be ignored as the stream already exists' }
        ]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 201,
        schema: methodsSchema.create.result
      });
    });

    it('[WSG8] must fail if a stream similar to that requested for creation already exists', async function () {
      const data = {
        name: 'my-sweet-app-id',
        type: 'app',
        permissions: [
          { streamId: 'bad-new-stream', level: 'contribute', defaultName: stream0.attrs.name }
        ]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 409,
        id: ErrorIds.ItemAlreadyExists,
        data: { name: stream0.attrs.name }
      });
    });

    it('[GVC7] must refuse to create new personal accesses (obtained via login only)', async function () {
      const data = {
        token: 'client-defined-token',
        name: 'New Personal Access',
        type: 'personal'
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkErrorForbidden(res);
    });

    it("[YRNE] must slugify the new access' predefined token", async function () {
      const data = {
        token: 'pas encodé de bleu!',
        name: 'Genevois, cette fois',
        permissions: []
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, {
        status: 201,
        schema: methodsSchema.create.result
      });
      assert.strictEqual(res.body.access.token, 'pas-encode-de-bleu');
    });

    it("[00Y3] must return an error if a permission's streamId has an invalid format", async function () {
      const data = {
        name: 'Access with slugified streamId permission',
        permissions: [{ streamId: ':az&', level: 'read', defaultName: 'whatever' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidRequestStructure
      });
    });

    it('[V3AV] must return an error if the sent data is badly formatted', async function () {
      const data = {
        name: 'New Access',
        permissions: [{ streamId: stream0.attrs.id, level: 'bad-level' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkErrorInvalidParams(res);
    });

    it('[HETK] must refuse empty `defaultName` values for streams', async function () {
      const data = {
        name: 'New Access',
        permissions: [{ streamId: stream0.attrs.id, level: 'read', defaultName: '   ' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkErrorInvalidParams(res);
    });

    it('[YG81] must return an error if an access with the same token already exists', async function () {
      const data = {
        token: sharedToken,
        name: 'Duplicate',
        permissions: []
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 409,
        id: ErrorIds.ItemAlreadyExists
      });
    });

    it('[GZTH] must return an error if an shared access with the same name already exists', async function () {
      const data = {
        name: sharedAccess.attrs.name,
        permissions: []
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 409,
        id: ErrorIds.ItemAlreadyExists,
        data: { type: 'shared', name: sharedAccess.attrs.name, deviceName: null }
      });
    });

    it('[4HO6] must return an error if an "app" access with the same name (app id) and device name already exists', async function () {
      const data = {
        type: appAccess.attrs.type,
        name: appAccess.attrs.name,
        deviceName: appAccess.attrs.deviceName,
        permissions: []
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 409,
        id: ErrorIds.ItemAlreadyExists,
        data: {
          type: appAccess.attrs.type,
          name: appAccess.attrs.name,
          deviceName: appAccess.attrs.deviceName
        }
      });
    });

    it('[PO0R] must return an error if the device name is set for a non-app access', async function () {
      const data = {
        name: 'Yikki-yikki',
        deviceName: 'Impossible Device'
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidParametersFormat
      });
    });

    it("[RWGG] must return an error if the given predefined access's token is a reserved word", async function () {
      const data = {
        token: 'null',
        name: 'Badly Named Access',
        permissions: []
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidItemId
      });
    });

    it('[08SK] must return an error if the permission streamId has invalid characters', async function () {
      const data = {
        name: charlatan.Lorem.word(),
        permissions: [{ streamId: 'whdaup "" /', level: 'read' }]
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', personalToken)
        .send(data);

      validation.checkError(res, {
        status: 400,
        id: ErrorIds.InvalidRequestStructure
      });
    });
  });

  describe('[AS03] PUT /<token>', function () {
    beforeEach(resetAccesses);

    it('[U04A] must return a 410 (Gone)', async function () {
      const res = await coreRequest
        .put(path('unknown-id'))
        .set('Authorization', personalToken)
        .send({ name: '?' });

      validation.checkError(res, {
        status: 410,
        id: ErrorIds.Gone
      });
    });
  });

  describe('[AS04] DELETE /<id>', function () {
    beforeEach(resetAccesses);

    it('[S8EK] must delete the shared access', async function () {
      const res = await coreRequest
        .delete(path(`shared_${username}`))
        .set('Authorization', personalToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.del.result,
        body: { accessDeletion: { id: `shared_${username}` } }
      });
    });

    it('[5GBI] must delete the personal access', async function () {
      const res = await coreRequest
        .delete(path(sessionAccessId))
        .set('Authorization', personalToken);

      validation.check(res, {
        status: 200,
        schema: methodsSchema.del.result
      });
    });

    it('[NN11] must return an error if the access does not exist', async function () {
      const res = await coreRequest
        .delete(path('unknown-id'))
        .set('Authorization', personalToken);

      validation.checkError(res, {
        status: 404,
        id: ErrorIds.UnknownResource
      });
    });
  });

  describe('[AS05] POST /check-app', function () {
    beforeEach(resetAccesses);

    function getCheckAppPath () {
      return basePath + '/check-app';
    }

    it('[VCH9] must return the adjusted permissions structure if no access exists', async function () {
      const data = {
        requestingAppId: 'the-love-generator',
        deviceName: "It's a washing machine that sends tender e-mails to your grandmother!",
        requestedPermissions: [
          { name: 'myaccess', streamId: stream0.attrs.id, level: 'contribute', defaultName: 'A different name' },
          { streamId: 'new-stream-check', level: 'manage', defaultName: 'The New Stream, Sir.' }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, { status: 200, schema: methodsSchema.checkApp.result });
      assert.ok(res.body.checkedPermissions);
    });

    it('[R8H5] must accept requested permissions with store ":dummy:" and adapt to correct name', async function () {
      const data = {
        requestingAppId: 'mall-dummy',
        deviceName: 'For sure',
        requestedPermissions: [
          { streamId: ':dummy:', level: 'read', defaultName: 'Ignored, must be cleaned up' }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, { status: 200, schema: methodsSchema.checkApp.result });
      assert.ok(res.body.checkedPermissions);
      assert.strictEqual(res.body.checkedPermissions[0].name, 'Dummy Store');
    });

    it('[R8H4] must accept requested permissions with "*" for "all streams"', async function () {
      const data = {
        requestingAppId: 'lobabble-dabidabble',
        deviceName: "It's a matchbox that sings the entire repertoire of Maria Callas!",
        requestedPermissions: [
          { name: 'myaccess', streamId: stream0.attrs.id, level: 'manage', defaultName: 'A different name' },
          { streamId: '*', level: 'read', defaultName: 'Ignored, must be cleaned up' }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, { status: 200, schema: methodsSchema.checkApp.result });
      assert.ok(res.body.checkedPermissions);
    });

    it('[9QNK] must return the existing app access if matching', async function () {
      const data = {
        requestingAppId: appAccess.attrs.name,
        deviceName: appAccess.attrs.deviceName,
        requestedPermissions: [
          { streamId: stream0.attrs.id, level: 'contribute', defaultName: "This permission is the same as the existing access's" }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, { status: 200, schema: methodsSchema.checkApp.result });
      assert.ok(res.body.matchingAccess);
      assert.strictEqual(res.body.matchingAccess.token, appToken);
    });

    it('[IF33] must also return the token of the existing mismatching access if any', async function () {
      const data = {
        requestingAppId: appAccess.attrs.name,
        deviceName: appAccess.attrs.deviceName,
        requestedPermissions: [
          { name: 'foobar', streamId: stream0.attrs.id, level: 'manage', defaultName: "This permission differs from the existing access' permissions" }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, { status: 200, schema: methodsSchema.checkApp.result });
      assert.ok(res.body.checkedPermissions);
      assert.ok(res.body.mismatchingAccess);
      assert.strictEqual(res.body.mismatchingAccess.id, `app_${username}`);
    });

    it('[G5T2] must propose fixes to duplicate ids of streams and signal an error when appropriate', async function () {
      const data = {
        requestingAppId: 'the-love-generator-2',
        requestedPermissions: [
          { streamId: 'bad-new-stream-2', level: 'contribute', defaultName: stream3.attrs.name }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.check(res, { status: 200, schema: methodsSchema.checkApp.result });
      assert.ok(res.body.checkedPermissions);
      assert.ok(res.body.error);
      assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
    });

    it('[MTY1] must return an error if the sent data is badly formatted', async function () {
      const data = {
        requestingAppId: appAccess.attrs.name,
        requestedPermissions: [
          { streamId: stream0.attrs.id, level: 'manage', RATATA: 'But-but-but this property has nothing to do here!!!' }
        ]
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', personalToken)
        .send(data);

      validation.checkErrorInvalidParams(res);
    });

    it('[U5KD] must be forbidden to non-personal accesses', async function () {
      const data = {
        requestingAppId: appAccess.attrs.name,
        requestedPermissions: []
      };

      const res = await coreRequest
        .post(getCheckAppPath())
        .set('Authorization', appToken)
        .send(data);

      validation.checkErrorForbidden(res);
    });
  });
});
