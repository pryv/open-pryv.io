/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cuid = require('cuid');
const path = require('path');
const { promisify } = require('util');
const nock = require('nock');
const { useNock } = require('test-helpers/src/nockScope.ts');
const assert = require('node:assert');
const { listeningAgent } = require('test-helpers');
const charlatan = require('charlatan');

const ErrorIds = require('errors').ErrorIds;
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');
const { getApplication } = require('api-server/src/application.ts');

const { pubsub } = require('messages');
const AccessLogic = require('business/src/accesses/AccessLogic.ts').default;
const { addPrivatePrefixToStreamId, addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters.ts');
const accountStreams = require('business/src/system-streams/index.ts');

const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');

const { getConfig } = require('@pryv/boiler');

describe('[AD01] Accesses with account streams', function () {
  useNock();

  let config;
  let app;
  let request;
  let res;
  let createAccessResponse;
  let accountAccessData;
  let fixtures;
  let basePath;
  let eventsBasePath;
  let access;
  let user;
  let validation;

  async function createUser () {
    // Use cuid for unique username to avoid parallel test conflicts
    user = await fixtures.user('acsds' + cuid.slug().toLowerCase(), {
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

  // ⚑ Query by `id`, not `_id`. The PostgreSQL storage maps both to its id
  // column (`BaseStoragePG.toCol`), so an `_id` query works there and silently
  // matches nothing on SQLite, whose user storage has no such mapping. That
  // made every assertion below read `null` and fail on the SQLite engine while
  // passing on PostgreSQL, so these checks had no coverage on the default
  // audit engine at all. `id` is understood by both.
  async function getAccessInDb (id) {
    const findOneAsync = promisify((userId, query, opts, cb) =>
      user.storage.accesses.findOne(userId, query, opts, cb));
    return await findOneAsync({ id: user.attrs.id }, { id }, null);
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
    fixtures = databaseFixture(await produceStorageConnection());

    app = getApplication(true);
    await app.initiate();

    // Initialize notifyTests dependency
    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    pubsub.setTestNotifier(testNotifier);
    pubsub.status.emit(pubsub.SERVER_READY);
    await require('api-server/src/methods/accesses.ts').default(app.api);

    await require('api-server/src/methods/events.ts').default(app.api);
    request = await listeningAgent(app.expressApp);
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users/index.ts');
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
            // phoneNumber (visible, editable, not platform-coordinated): the
            // email account field is no longer writable through the events API,
            // so this "contribute lets you write the event" coverage uses a
            // non-coordinated visible field.
            streamId = addCustomerPrefixToStreamId('phoneNumber');
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
      describe('[AD15] to create an access for an unknown account stream', () => {
        let streamId;
        before(async function () {
          streamId = ':system:' + charlatan.Lorem.characters(10);
          await createUserAndAccess('read', streamId);
        });
        it('[R7WQ] should return 400', async () => {
          assert.strictEqual(createAccessResponse.status, 400);
        });
        it('[V3HD] should return the correct error', async () => {
          assert.deepStrictEqual(createAccessResponse.body.error, {
            id: ErrorIds.InvalidOperation,
            message: ErrorMessages[ErrorIds.UnknownAccountStream],
            data: { param: streamId }
          });
        });
      });
      describe('[AD16] to create an access for a known account field under the wrong prefix', () => {
        let streamId;
        before(async function () {
          // The email is a platform-defined field, so it carries the customer
          // prefix; the private prefix names nothing. Assert the premise first:
          // without a declared email field this case would silently degrade
          // into a duplicate of the unknown-stream one above and still pass.
          assert.ok(
            accountStreams.accountMap[addCustomerPrefixToStreamId('email')] != null,
            'premise: this deployment must declare an email account field'
          );
          streamId = addPrivatePrefixToStreamId('email');
          await createUserAndAccess('read', streamId);
        });
        it('[N8KC] should return 400', async () => {
          assert.strictEqual(createAccessResponse.status, 400);
        });
        it('[T2PX] should return an error naming the stream and the prefix rule', async () => {
          assert.deepStrictEqual(createAccessResponse.body.error, {
            id: ErrorIds.InvalidOperation,
            message: ErrorMessages[ErrorIds.UnknownAccountStream],
            data: { param: streamId }
          });
        });
      });
    });
  });

  describe('[ASUP] PUT /accesses applies the same account-stream validation as create', () => {
    const emailStreamId = () => addCustomerPrefixToStreamId('email');

    async function putPermissions (accessId, permissions) {
      return await request.put(basePath + '/' + accessId)
        .send({ permissions })
        .set('authorization', access.token);
    }

    describe('[ASU1] rejects an unknown system stream added via update', () => {
      let unknownStreamId, originalAccess, putRes;
      before(async function () {
        await createUserAndAccess('read', emailStreamId());
        originalAccess = accountAccessData;
        unknownStreamId = ':system:' + charlatan.Lorem.characters(10);
        putRes = await putPermissions(originalAccess.id, [{ streamId: unknownStreamId, level: 'read' }]);
      });
      it('[AV1E] returns 400 with the UnknownAccountStream error', () => {
        assert.strictEqual(putRes.status, 400);
        assert.deepStrictEqual(putRes.body.error, {
          id: ErrorIds.InvalidOperation,
          message: ErrorMessages[ErrorIds.UnknownAccountStream],
          data: { param: unknownStreamId }
        });
      });
      it('[AV1D] leaves the stored permissions unchanged', async () => {
        const dbAccess = await getAccessInDb(originalAccess.id);
        assert.deepStrictEqual(dbAccess.permissions, originalAccess.permissions);
      });
    });

    describe('[ASU2] rejects a not-visible account stream added via update', () => {
      let hiddenStreamId, originalAccess, putRes;
      before(async function () {
        await createUserAndAccess('read', emailStreamId());
        originalAccess = accountAccessData;
        hiddenStreamId = addPrivatePrefixToStreamId('invitationToken');
        putRes = await putPermissions(originalAccess.id, [{ streamId: hiddenStreamId, level: 'read' }]);
      });
      it('[AV2E] returns 400 with the DeniedStreamAccess error', () => {
        assert.strictEqual(putRes.status, 400);
        assert.deepStrictEqual(putRes.body.error, {
          id: ErrorIds.InvalidOperation,
          message: ErrorMessages[ErrorIds.DeniedStreamAccess],
          data: { param: hiddenStreamId }
        });
      });
      it('[AV2D] leaves the stored permissions unchanged', async () => {
        const dbAccess = await getAccessInDb(originalAccess.id);
        assert.deepStrictEqual(dbAccess.permissions, originalAccess.permissions);
      });
    });

    describe('[ASU3] rejects an over-cap level on a visible account stream added via update', () => {
      let originalAccess, putRes;
      before(async function () {
        await createUserAndAccess('read', emailStreamId());
        originalAccess = accountAccessData;
        putRes = await putPermissions(originalAccess.id, [{ streamId: emailStreamId(), level: AccessLogic.PERMISSION_LEVEL_MANAGE }]);
      });
      it('[AV3E] returns 400 with the TooHighAccessForSystemStreams error', () => {
        assert.strictEqual(putRes.status, 400);
        assert.deepStrictEqual(putRes.body.error, {
          id: ErrorIds.InvalidOperation,
          message: ErrorMessages[ErrorIds.TooHighAccessForSystemStreams],
          data: { param: emailStreamId() }
        });
      });
      it('[AV3D] leaves the stored permissions unchanged', async () => {
        const dbAccess = await getAccessInDb(originalAccess.id);
        assert.deepStrictEqual(dbAccess.permissions, originalAccess.permissions);
      });
    });

    describe('[ASU4] accepts a within-cap account-stream permission via update', () => {
      let accessId, putRes;
      before(async function () {
        await createUserAndAccess('read', emailStreamId());
        accessId = accountAccessData.id;
        putRes = await putPermissions(accessId, [{ streamId: emailStreamId(), level: 'contribute' }]);
      });
      it('[AV4S] returns 200', () => {
        assert.strictEqual(putRes.status, 200);
      });
      it('[AV4D] stores the updated permission', async () => {
        const dbAccess = await getAccessInDb(accessId);
        assert.deepStrictEqual(dbAccess.permissions, [{ streamId: emailStreamId(), level: 'contribute' }]);
      });
    });

    describe('[ASU5] leaves account-stream permissions untouched when update omits permissions', () => {
      let accessId, putRes;
      before(async function () {
        await createUserAndAccess('contribute', emailStreamId());
        accessId = accountAccessData.id;
        putRes = await request.put(basePath + '/' + accessId)
          .send({ name: charlatan.Lorem.characters(8) })
          .set('authorization', access.token);
      });
      it('[AV5S] returns 200', () => {
        assert.strictEqual(putRes.status, 200);
      });
      it('[AV5D] keeps the pre-existing account-stream permission', async () => {
        const dbAccess = await getAccessInDb(accessId);
        assert.deepStrictEqual(dbAccess.permissions, [{ streamId: emailStreamId(), level: 'contribute' }]);
      });
    });

    describe('[ASU6] validates every element of the submitted set, not just the first', () => {
      let unknownStreamId, originalAccess, putRes;
      before(async function () {
        await createUserAndAccess('read', emailStreamId());
        originalAccess = accountAccessData;
        unknownStreamId = ':system:' + charlatan.Lorem.characters(10);
        putRes = await putPermissions(originalAccess.id, [
          { streamId: emailStreamId(), level: 'read' },
          { streamId: unknownStreamId, level: 'read' }
        ]);
      });
      it('[AV6E] returns 400 naming the second (invalid) permission', () => {
        assert.strictEqual(putRes.status, 400);
        assert.deepStrictEqual(putRes.body.error, {
          id: ErrorIds.InvalidOperation,
          message: ErrorMessages[ErrorIds.UnknownAccountStream],
          data: { param: unknownStreamId }
        });
      });
      it('[AV6D] leaves the stored permissions unchanged', async () => {
        const dbAccess = await getAccessInDb(originalAccess.id);
        assert.deepStrictEqual(dbAccess.permissions, originalAccess.permissions);
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
