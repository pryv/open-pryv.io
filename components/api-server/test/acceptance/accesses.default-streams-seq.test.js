/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const cuid = require('cuid');
const path = require('path');
const { promisify } = require('util');
const nock = require('nock');
const assert = require('node:assert');
const supertest = require('supertest');
const charlatan = require('charlatan');

const ErrorIds = require('errors').ErrorIds;
const { ErrorMessages } = require('errors/src/ErrorMessages');
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const AccessLogic = require('business/src/accesses/AccessLogic');
const { addPrivatePrefixToStreamId, addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters');

const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');

const { getConfig } = require('@pryv/boiler');

describe('[AD01] Accesses with account streams', function () {
  let config;
  let app;
  let request;
  let res;
  let createAccessResponse;
  let accountAccessData;
  let mongoFixtures;
  let basePath;
  let eventsBasePath;
  let access;
  let user;
  let validation;

  async function createUser () {
    // Use cuid for unique username to avoid parallel test conflicts
    user = await mongoFixtures.user('acsds' + cuid.slug().toLowerCase(), {
      insurancenumber: charlatan.Number.number(4),
      phoneNumber: charlatan.Lorem.characters(3)
    });
    basePath = '/' + user.attrs.username + '/accesses';
    eventsBasePath = '/' + user.attrs.username + '/events';
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);
    return user;
  }

  async function createUserAndAccess (permissionLevel, streamId) {
    await createUser();
    createAccessResponse = await request.post(basePath)
      .send({
        name: charlatan.Lorem.characters(7),
        permissions: [
          {
            streamId,
            level: permissionLevel
          }
        ]
      })
      .set('authorization', access.token);
    accountAccessData = createAccessResponse.body.access;
  }

  async function getAccessInDb (id) {
    const findOneAsync = promisify((userId, query, opts, cb) =>
      user.storage.accesses.findOne(userId, query, opts, cb));
    return await findOneAsync({ id: user.attrs.id }, { _id: id }, null);
  }

  let savedIntegrityCheck;
  before(async function () {
    // Disable per-test integrity checks — this file creates multiple users
    // across nested describe blocks; checked at cleanup in after().
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    const helpers = require('api-server/test/helpers');
    config = await getConfig();
    validation = helpers.validation;
    mongoFixtures = databaseFixture(await produceStorageConnection());

    app = getApplication(true);
    await app.initiate();

    // Initialize notifyTests dependency
    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    pubsub.setTestNotifier(testNotifier);
    pubsub.status.emit(pubsub.SERVER_READY);
    await require('api-server/src/methods/accesses')(app.api);

    await require('api-server/src/methods/events')(app.api);
    request = supertest(app.expressApp);
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  describe('[AD02] POST /accesses', () => {
    describe('[AD03] When using a personal access', () => {
      describe('[AD07] to create an access for visible account streams', () => {
        describe('[AD08] with a read-level permission', () => {
          let systemEmailStreamId;
          const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
          before(async function () {
            systemEmailStreamId = addCustomerPrefixToStreamId('email');
            await createUserAndAccess(permissionLevel, systemEmailStreamId);
          });
          it('[UE9G] should return 201', async () => {
            assert.strictEqual(createAccessResponse.status, 201);
          });
          it('[BUYP] should create access in the database', async () => {
            assert.deepStrictEqual(accountAccessData.permissions, [{ streamId: systemEmailStreamId, level: permissionLevel }]);
          });
          it('[S3IQ] should enable user to read visible stream event with this access', async () => {
            res = await request.get(eventsBasePath).set('authorization', accountAccessData.token);
            assert.strictEqual(res.body.events.length, 1);
            assert.strictEqual(res.body.events[0].streamIds[0], systemEmailStreamId);
          });

          describe('[AD09] for the "account" stream', () => {
            let streamId;
            const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
            before(async function () {
              streamId = addPrivatePrefixToStreamId('account');
              await createUserAndAccess(permissionLevel, streamId);
            });
            it('[XEAK] should return 201', async () => {
              assert.strictEqual(createAccessResponse.status, 201);
            });
            it('[65I4] should create access in the database', async () => {
              assert.deepStrictEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
            });
            it('[L99L] should allow to access visible events in storageUsed', async () => {
              res = await request.get(eventsBasePath).set('authorization', accountAccessData.token);
              assert.strictEqual(res.body.events.length, 6);
              validation.validateAccountEvents(res.body.events);
            });
          });
          describe('[AD10] for the "storageUsed" stream', () => {
            let streamId;
            const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
            before(async function () {
              streamId = addPrivatePrefixToStreamId('storageUsed');
              await createUserAndAccess(permissionLevel, streamId);
            });
            it('[EPEP] should return 201', async () => {
              assert.strictEqual(createAccessResponse.status, 201);
            });
            it('[U3UM] should create access in the database', async () => {
              assert.deepStrictEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
            });
            it('[A4UP] should allow to access visible events in storageUsed', async () => {
              res = await request.get(eventsBasePath).set('authorization', accountAccessData.token);
              assert.strictEqual(res.body.events.length, 2);
              assert.strictEqual([
                addPrivatePrefixToStreamId('attachedFiles'),
                addPrivatePrefixToStreamId('dbDocuments')
              ].includes(res.body.events[0].streamIds[0]), true);
              assert.strictEqual([
                addPrivatePrefixToStreamId('attachedFiles'),
                addPrivatePrefixToStreamId('dbDocuments')
              ].includes(res.body.events[1].streamIds[0]), true);
            });
          });
        });
        describe('[AD11] with a create-only-level permission', () => {
          let streamId;
          const permissionLevel = AccessLogic.PERMISSION_LEVEL_CREATE_ONLY;
          before(async function () {
            streamId = addCustomerPrefixToStreamId('email');
            await createUserAndAccess(permissionLevel, streamId);
          });
          it('[IWMQ] should return 201', async () => {
            assert.strictEqual(createAccessResponse.status, 201);
          });
          it('[APYN] should create access in the database', async () => {
            assert.deepStrictEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
          });
        });
        describe('[AD12] with a contribute-level permission', () => {
          let streamId;
          const permissionLevel = AccessLogic.PERMISSION_LEVEL_CONTRIBUTE;
          before(async function () {
            streamId = addCustomerPrefixToStreamId('email');
            await createUserAndAccess(permissionLevel, streamId);
          });
          it('[R0M1] should return 201', async () => {
            assert.strictEqual(createAccessResponse.status, 201);
          });
          it('[Q8R8] should create access in the database', async () => {
            assert.deepStrictEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
          });
          it('[TI1X] should allow to create visible stream events', async () => {
            const scope = nock(config.get('services:register:url'));
            scope.put('/users',
              (body) => {
                return true;
              }).reply(200, { errors: [] });

            const response = await request.post(eventsBasePath)
              .send({
                streamIds: [streamId],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              })
              .set('authorization', accountAccessData.token);

            assert.strictEqual(response.status, 201);
            assert.ok(response.body.event);
            assert.strictEqual(response.body.event.streamIds[0], streamId);
          });
        });

        describe('[AD13] with a manage-level permission', () => {
          let streamId;
          before(async function () {
            streamId = addCustomerPrefixToStreamId('email');
            await createUserAndAccess(AccessLogic.PERMISSION_LEVEL_MANAGE, streamId);
          });
          it('[93HO] should return 400', async () => {
            assert.strictEqual(createAccessResponse.status, 400);
          });
          it('[YPHX] should return the correct error', async () => {
            assert.deepStrictEqual(createAccessResponse.body.error, {
              id: ErrorIds.InvalidOperation,
              message: ErrorMessages[ErrorIds.TooHighAccessForSystemStreams],
              data: { param: streamId }
            });
          });
        });
      });
      describe('[AD14] to create an access for not visible account streams', () => {
        let streamId;
        before(async function () {
          streamId = addPrivatePrefixToStreamId('invitationToken');
          await createUserAndAccess('read', streamId);
        });
        it('[ATGU] should return 400', async () => {
          assert.strictEqual(createAccessResponse.status, 400);
        });
        it('[Q2KZ] should return the correct error', async () => {
          assert.deepStrictEqual(createAccessResponse.body.error, {
            id: ErrorIds.InvalidOperation,
            message: ErrorMessages[ErrorIds.DeniedStreamAccess],
            data: { param: streamId }
          });
        });
      });
      describe('[AD15] to create an access for unexisting system streams', () => {
        before(async function () {
          const streamId = ':system:' + charlatan.Lorem.characters(10);
          await createUserAndAccess('read', streamId);
        });
        it('[KKKS] should return 403 forbidden', async () => {
          assert.strictEqual(createAccessResponse.status, 403);
          assert.strictEqual(createAccessResponse.body.error.id, ErrorIds.Forbidden);
        });
      });
    });
  });

  describe('[AD04] DELETE /accesses', () => {
    describe('[AD05] When using a personal access', () => {
      describe('[AD06] to delete an account stream access', () => {
        let streamId;
        const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
        before(async function () {
          streamId = addPrivatePrefixToStreamId('storageUsed');
          await createUserAndAccess(permissionLevel, streamId);
          res = await request.delete(path.join(basePath, createAccessResponse.body.access.id))
            .set('authorization', access.token);
        });
        it('[Z40J] should return 200', async () => {
          assert.strictEqual(res.status, 200);
        });
        it('[MP9T] should delete the access in the database', async () => {
          const deletedAccess = await getAccessInDb(createAccessResponse.body.access.id);
          assert.strictEqual(deletedAccess, null);
        });
      });
    });
  });
});
