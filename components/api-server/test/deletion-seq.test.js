/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const cuid = require('cuid');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const supertest = require('supertest');
const charlatan = require('charlatan');
const { getApplication } = require('api-server/src/application');
const SeriesRepository = require('business/src/series/repository');
const DataMatrix = require('business/src/series/data_matrix');
const { getConfig } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users');
const { databaseFixture } = require('test-helpers');
const { produceStorageConnection, produceSeriesConnection } = require('api-server/test/test-helpers');
const { removeSystemStreams } = require('test-helpers/src/systemStreamFilters');
const { pubsub } = require('messages');
const { promisify } = require('util');
const { getMall } = require('mall');
const cache = require('cache');
const { MESSAGES } = require('cache/src/synchro');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

let app;
let authKey;
let username1; // fixtures reuse the username for userId
let user1;
let username2;
let request;
let res;
let mongoFixtures;
let usersRepository;
let seriesConn;
let seriesRepository;
let config;
let isAuditActive = false;
let mall;
describe('[PGTD] DELETE /users/:username', () => {
  before(async function () {
    config = await getConfig();
    isAuditActive = config.get('audit:active');
    app = getApplication();
    await app.initiate();
    await require('api-server/src/methods/auth/delete')(app.api);
    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    // needed even if not used
    pubsub.setTestNotifier(testNotifier);
    await require('api-server/src/methods/events')(app.api);
    await require('api-server/src/methods/streams')(app.api);
    await require('api-server/src/methods/auth/login')(app.api);
    await require('api-server/src/methods/utility')(app.api);
    await require('api-server/src/methods/auth/register')(app.api);
    request = supertest(app.expressApp);
    mongoFixtures = databaseFixture(await produceStorageConnection());
    await mongoFixtures.context.cleanEverything();
    seriesConn = await produceSeriesConnection(app.config);
    seriesRepository = new SeriesRepository(seriesConn);
    usersRepository = await getUsersRepository();
    // Use cuid() for unique usernames to avoid parallel test conflicts
    username1 = 'testdel1_' + cuid.slug();
    username2 = 'testdel2_' + cuid.slug();
    authKey = config.get('auth:adminAccessKey');
    mall = await getMall();
  });
  after(async function () {
    config.injectTestConfig({});
    await mongoFixtures.context.cleanEverything();
  });
  describe('[USAD] depending on "user-account:delete"  config parameter', function () {
    let personalAccessToken;
    beforeEach(async function () {
      personalAccessToken = cuid();
      user1 = await initiateUserWithData(username1);
      await user1.access({
        type: 'personal',
        token: personalAccessToken
      });
      await user1.session(personalAccessToken);
    });
    it('[8UT7] Should accept when "personalToken" is active and a valid personal token is provided', async function () {
      config.injectTestConfig({
        'user-account': { delete: ['personalToken'] }
      });
      res = await request
        .delete(`/users/${username1}`)
        .set('Authorization', personalAccessToken);
      assert.strictEqual(res.status, 200);
    });
    it('[IJ5F] Should reject when "personalToken" is active and an invalid token is provided', async function () {
      config.injectTestConfig({
        'user-account': { delete: ['personalToken'] }
      });
      res = await request
        .delete(`/users/${username1}`)
        .set('Authorization', 'bogus');
      assert.strictEqual(res.status, 403); // not 404 as when option is not activated
    });
    it('[NZ6G] Should reject when only "personalToken" is active and a valid admin token is provided', async function () {
      config.injectTestConfig({
        'user-account': { delete: ['personalToken'] }
      });
      res = await request
        .delete(`/users/${username1}`)
        .set('Authorization', authKey);
      assert.strictEqual(res.status, 403); // not 404 as when option is not activated
    });
    it('[UK8H] Should accept when "personalToken" and "adminToken" are active and a valid admin token is provided', async function () {
      config.injectTestConfig({
        'user-account': { delete: ['personalToken', 'adminToken'] }
      });
      res = await request
        .delete(`/users/${username1}`)
        .set('Authorization', authKey);
      assert.strictEqual(res.status, 200);
    });
  });
  // ---------------- loop loop -------------- //
  // [isDnsLess]
  const settingsToTest = [
    [true],
    [false]
  ];
  const testIDs = [
    [
      'CM5Q',
      'BQXA',
      '4Y76',
      '710F',
      'GUPH',
      'JNVS',
      'C58U',
      'IH6T',
      '75IW',
      'MPXH',
      '635G'
    ],
    [
      'T21Z',
      'K4J1',
      'TIKT',
      'WMMV',
      '9ZTM',
      'T3UK',
      'O73J',
      'N8TR',
      '7WMG',
      'UWYY',
      'U004'
    ]
  ];
  [0, 1].forEach(function (i) {
    describe(`[DOA${i}] dnsLess:isActive = ${settingsToTest[i][0]}`, function () {
      before(async function () {
        config.injectTestConfig({
          dnsLess: { isActive: settingsToTest[i][0] }
        });
      });
      after(async function () {
        config.injectTestConfig({});
      });
      describe(`[D7H${i}] when given existing username`, function () {
        let userToDelete;
        const delivered = [];
        before(async function () {
          userToDelete = await initiateUserWithData(username1);
          await initiateUserWithData(username2);
          if (pubsub.isTransportEnabled()) {
            pubsub.setTestDeliverHook(function (scopeName, eventName, payload) {
              delivered.push({ scopeName, eventName, payload });
            });
          } // true OpenSource Setup
          res = await request
            .delete(`/users/${username1}`)
            .set('Authorization', authKey);
        });
        after(async function () {
          if (!pubsub.isTransportEnabled()) {
            return;
          } // true OpenSource Setup
          pubsub.setTestDeliverHook(null);
        });
        it(`[${testIDs[i][0]}] should respond with 200`, function () {
          assert.strictEqual(res.status, 200);
          assert.strictEqual(res.body.userDeletion.username, username1);
        });
        it(`[${testIDs[i][1]}] should delete user entries from impacted collections`, async function () {
          const user = await usersRepository.getUserById(username1);
          assert.ok(user == null);
          const dbCollections = [
            app.storageLayer.accesses,
            app.storageLayer.profile,
            app.storageLayer.webhooks
          ];
          const collectionsNotEmptyChecks = dbCollections.map(async function (coll) {
            const collectionEntriesForUser = await promisify((id, o1, o2, cb) => coll.find(id, o1, o2, cb))({ id: username1 }, {}, {});
            assert.ok(collectionEntriesForUser.length === 0);
          });
          await Promise.all(collectionsNotEmptyChecks);
          // check events from mall
          const events = await mall.events.get(username1, {});
          assert.ok(events.length === 0);
          // check streams from mall
          let streams = await mall.streams.get(username1, {
            storeId: 'local',
            includeTrashed: true,
            hideStoreRoots: true
          });
          streams = removeSystemStreams(streams);
          assert.ok(streams.length === 0);
          const sessions = await promisify((q, cb) => app.storageLayer.sessions.getMatching(q, cb))({ username: username1 });
          assert(sessions == null || sessions.length === 0);
        });
        it(`[${testIDs[i][2]}] should delete user event files`, async function () {
          const infos = await mall.getUserStorageInfos(userToDelete.attrs.id);
          assert.strictEqual(infos.local.files.sizeKb, 0);
        });
        it(`[${testIDs[i][8]}] should delete HF data`, async function () {
          const databases = await seriesConn.getDatabases();
          const isFound = databases.indexOf(`user.${userToDelete.attrs.username}`) >= 0;
          assert.strictEqual(isFound, false);
        });
        it(`[${testIDs[i][9]}] should delete user audit events`, async function () {
          if (!isAuditActive) this.skip();
          const pathToUserAuditData = require('storage').userLocalDirectory.getPathForUser(userToDelete.attrs.id);
          const userFileExists = fs.existsSync(pathToUserAuditData);
          assert.strictEqual(userFileExists, false);
        });
        it(`[${testIDs[i][10]}] should delete user from the cache`, async function () {
          const usersExists = cache.getUserId(userToDelete.attrs.id);
          assert.strictEqual(usersExists, undefined);
          if (pubsub.isTransportEnabled()) {
            assert.strictEqual(delivered.length, 1);
            assert.strictEqual(delivered[0].scopeName, 'cache.' + MESSAGES.UNSET_USER);
            assert.strictEqual(delivered[0].eventName, MESSAGES.UNSET_USER);
            assert.strictEqual(delivered[0].payload.username, userToDelete.attrs.id);
          }
        });
        it(`[${testIDs[i][3]}] should not delete entries of other users`, async function () {
          const user = await usersRepository.getUserById(username2);
          assert.ok(user != null);
          const dbCollections = [app.storageLayer.accesses, app.storageLayer.webhooks];
          const collectionsEmptyChecks = dbCollections.map(async function (coll) {
            const collectionEntriesForUser = await promisify((id, o1, o2, cb) => coll.find(id, o1, o2, cb))({ id: username2 }, {}, {});
            assert.ok(collectionEntriesForUser.length > 0);
          });
          await Promise.all(collectionsEmptyChecks);
          // check events from mall
          const events = await mall.events.get(username2, {});
          assert.ok(events.length > 0);
          // check streams from mall
          let streams = await mall.streams.get(username2, {
            storeId: 'local',
            includeTrashed: true,
            hideStoreRoots: true
          });
          streams = removeSystemStreams(streams);
          assert.ok(streams.length > 0);
          const sessions = await promisify((q, cb) => app.storageLayer.sessions.getMatching(q, cb))({ username: username2 });
          assert(sessions !== null || sessions !== []);
        });
        it(`[${testIDs[i][4]}] should not delete other user event files`, async function () {
          const sizeInfo = await mall.getUserStorageInfos(username2);
          assert.notStrictEqual(sizeInfo.local.files.sizeKb, 0);
        });
      });
      describe('[DL01] when given invalid authorization key', function () {
        before(async function () {
          res = await request
            .delete(`/users/${username1}`)
            .set('Authorization', 'somekey');
        });
        it(`[${testIDs[i][5]}] should respond with 404`, function () {
          assert.strictEqual(res.status, 404);
        });
      });
      describe('[DL02] when given not existing username', function () {
        before(async function () {
          res = await request
            .delete(`/users/${username1}`)
            .set('Authorization', authKey);
        });
        it(`[${testIDs[i][6]}] should respond with 404`, function () {
          assert.strictEqual(res.status, 404);
        });
      });
    });
  });
  describe('[DL03] User - Create - Delete - Create - Login', function () {
    // Use cuid for unique username to avoid parallel test conflicts
    const usernamex = 'testdelx' + cuid.slug().toLowerCase();
    it('[JBZM] should be able to recreate this user, and login', async function () {
      await createUser();
      await deleteUser();
      await createUser();
      res = await request
        .post('/' + usernamex + '/auth/login')
        .set('Origin', 'http://test.pryv.local')
        .send({
          appId: 'pryv-test',
          username: usernamex,
          password: 'blupblipblop'
        });
      assert.strictEqual(res.status, 200, 'should login');
      assert.strictEqual(typeof res.body.apiEndpoint, 'string', 'should receive an api Endpoint');
      assert.strictEqual(typeof res.body.token, 'string', 'should receive a token');
      await deleteUser();
      async function createUser () {
        res = await request.post('/users').send({
          appId: 'pryv-test',
          username: usernamex,
          password: 'blupblipblop',
          email: usernamex + '@example.com',
          insurancenumber: '123456789'
        });
        assert.strictEqual(res.status, 201, 'should create a new user');
        assert.strictEqual(typeof res.body.apiEndpoint, 'string', 'should receive an api Endpoint');
        const token = res.body.apiEndpoint.split('//')[1].split('@')[0];
        res = await request
          .post(`/${usernamex}/`)
          .set('Authorization', token)
          .send([
            {
              method: 'streams.create',
              params: { id: 'diary', name: 'Journal' }
            },
            {
              method: 'events.create',
              params: { streamIds: ['diary'], type: 'mass/kg', content: 70 }
            }
          ]);
        assert.strictEqual(res.status, 200, 'should create a stream and an event');
        assert.ok(Array.isArray(res.body.results), 'should receive an array of results');
        assert.ok(typeof res.body.results[0].stream === 'object' && res.body.results[0].stream !== null, 'should receive an stream');
        assert.ok(typeof res.body.results[1].event === 'object' && res.body.results[1].event !== null, 'should receive an event');
      }
      async function deleteUser () {
        res = await request
          .delete(`/users/${usernamex}`)
          .set('Authorization', authKey);
        assert.strictEqual(res.status, 200, 'should delete the user');
        assert.strictEqual(res.body.userDeletion?.username, usernamex, 'should receive the deleted username');
      }
    });
  });
});
/**
 * @param {string} userId
 * @returns {Promise<any>}
 */
async function initiateUserWithData (userId) {
  const user = await mongoFixtures.user(userId);
  const stream = await user.stream({ id: cuid() });
  const eventId = cuid();
  await stream.event({
    id: eventId,
    type: 'mass/kg',
    content: charlatan.Number.digit()
  });
  const token = cuid();
  await user.access({
    id: cuid(),
    token,
    type: 'app',
    permissions: [{ streamId: stream.attrs.id, level: 'read' }]
  });
  await user.session(cuid());
  user.webhook({ id: cuid() }, cuid());
  const tempDir = join(tmpdir(), 'service-core-tests');
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = join(tempDir, `test-file-${userId}`);
  fs.writeFileSync(filePath, 'Just some text');
  const attachmentItem = {
    fileName: 'sample-file.txt',
    type: 'text/txt',
    size: 'Just some text'.length,
    attachmentData: fs.createReadStream(path.resolve(filePath)) // simulate full pass-thru of attachement until implemented
  };
  await mall.events.addAttachment(userId, eventId, attachmentItem);
  await fs.promises.unlink(filePath);
  const usersSeries = await seriesRepository.get(`user.${userId}`, `event.${cuid()}`);
  const data = new DataMatrix(['deltaTime', 'value'], [
    [0, 10],
    [1, 20]
  ]);
  await usersSeries.append(data);
  // generate audit trace
  await request.get(`/${userId}/events`).set('Authorization', token);
  return user;
}
