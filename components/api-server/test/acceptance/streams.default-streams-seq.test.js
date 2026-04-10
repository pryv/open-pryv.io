/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const cuid = require('cuid');
const path = require('path');
const assert = require('node:assert');
const supertest = require('supertest');
const charlatan = require('charlatan');
const ErrorIds = require('errors').ErrorIds;
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const { databaseFixture } = require('test-helpers');
const validation = require('api-server/test/helpers').validation;
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { addPrivatePrefixToStreamId, addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters');
const { defaults: dataStoreDefaults } = require('@pryv/datastore');
const treeUtils = require('utils/src/treeUtils');

describe('[SYSS] System streams', function () {
  let app;
  let request;
  let res;
  let mongoFixtures;
  let basePath;
  let access;
  let user;
  let savedIntegrityCheck;

  async function createUser () {
    // Use cuid for unique username to avoid parallel test conflicts
    user = await mongoFixtures.user('strds' + cuid.slug().toLowerCase(), {
      insurancenumber: charlatan.Number.number(4),
      phoneNumber: charlatan.Lorem.characters(3)
    });
    basePath = '/' + user.attrs.username + '/streams';
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);
    return user;
  }

  before(async function () {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    mongoFixtures = databaseFixture(await produceStorageConnection());

    app = getApplication(true);
    await app.initiate();

    // Initialize notifications dependency
    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    pubsub.setTestNotifier(testNotifier);

    pubsub.status.emit(pubsub.SERVER_READY);
    require('api-server/src/methods/streams')(app.api);

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

  describe('[SS01] GET /streams', () => {
    describe('[SS02] When using a personal access', () => {
      it('[9CGO] Should return all streams - including system ones', async () => {
        const expectedRes = [];
        validation.addStoreStreams(expectedRes);
        let readableStreams = [
          {
            name: 'Account',
            id: addPrivatePrefixToStreamId('account'),
            parentId: null,
            children: [
              {
                name: 'Language',
                id: addPrivatePrefixToStreamId('language'),
                parentId: addPrivatePrefixToStreamId('account'),
                children: []
              },
              {
                name: 'Storage used',
                id: addPrivatePrefixToStreamId('storageUsed'),
                parentId: addPrivatePrefixToStreamId('account'),
                children: [
                  {
                    name: 'Db Documents',
                    id: addPrivatePrefixToStreamId('dbDocuments'),
                    parentId: addPrivatePrefixToStreamId('storageUsed'),
                    children: []
                  },
                  {
                    name: 'Attached files',
                    id: addPrivatePrefixToStreamId('attachedFiles'),
                    parentId: addPrivatePrefixToStreamId('storageUsed'),
                    children: []
                  }
                ]
              },
              {
                name: 'insurancenumber',
                id: addCustomerPrefixToStreamId('insurancenumber'),
                parentId: addPrivatePrefixToStreamId('account'),
                children: []
              },
              {
                name: 'phoneNumber',
                id: addCustomerPrefixToStreamId('phoneNumber'),
                parentId: addPrivatePrefixToStreamId('account'),
                children: []
              },
              {
                name: 'Email',
                id: addCustomerPrefixToStreamId('email'),
                parentId: addPrivatePrefixToStreamId('account'),
                children: []
              }
            ]
          }
        ];

        readableStreams = treeUtils.cloneAndApply(readableStreams, (s) => {
          s.createdBy = dataStoreDefaults.SystemAccessId;
          s.modifiedBy = dataStoreDefaults.SystemAccessId;
          return s;
        });

        dataStoreDefaults.applyOnStreams(readableStreams);

        expectedRes.push(...readableStreams);

        await createUser();
        res = await request.get(basePath).set('authorization', access.token);

        assert.deepStrictEqual(res.body.streams, expectedRes);
      });
    });
  });

  describe('[SS03] POST /streams', () => {
    describe('[SS04] When using a personal access', () => {
      describe('[SS05] to create a child to a system stream', () => {
        before(async function () {
          await createUser();
          res = await request.post(basePath)
            .send({
              name: charlatan.Lorem.characters(7),
              parentId: addPrivatePrefixToStreamId('language')
            })
            .set('authorization', access.token);
        });
        it('[GRI4] should return status 400', async () => {
          assert.strictEqual(res.status, 400);
        });
        it('[XP07] should return the correct error', async () => {
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
        });
      });
    });
  });

  describe('[SS06] PUT /streams/<id>', () => {
    describe('[SS07] When using a personal access', () => {
      let streamData;
      describe('[SS08] to update a system stream', () => {
        before(async function () {
          await createUser();
          streamData = {
            name: 'lanugage2'
          };
          res = await request.put(path.join(basePath, addPrivatePrefixToStreamId('language')))
            .send(streamData)
            .set('authorization', access.token);
        });
        it('[SLIR] should return status 400', async () => {
          assert.strictEqual(res.status, 400);
        });
        it('[V6HC] should return the correct error', async () => {
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
        });
      });
    });
  });

  describe('[SS09] DELETE /streams/<id>', () => {
    describe('[SS10] When using a personal access', () => {
      describe('[SS11] to delete a system stream', () => {
        before(async function () {
          await createUser();
          res = await request.delete(path.join(basePath, addPrivatePrefixToStreamId('language')))
            .set('authorization', access.token);
        });
        it('[1R35] should return status 400', async () => {
          assert.strictEqual(res.status, 400);
        });
        it('[4939] should return the correct error', async () => {
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
        });
      });
    });
  });
});
