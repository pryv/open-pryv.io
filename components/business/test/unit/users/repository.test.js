/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const charlatan = require('charlatan');
require('test-helpers/src/api-server-tests-config.ts');
const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { getUsersRepository, User } = require('business/src/users/index.ts');
const { ErrorIds } = require('errors');

describe('[USRP] Users repository', () => {
  let fixtures;
  before(async function () {
    fixtures = databaseFixture(await produceStorageConnection());
    await fixtures.clean();
  });
  after(async () => {
    await fixtures.clean();
  });
  let username;
  let email;
  let customRegistrationUniqueField;
  describe('[UR01] createUser()', () => {
    before(async () => {
      username = charlatan.Lorem.characters(10);
      customRegistrationUniqueField = charlatan.App.name();
      email = charlatan.Internet.email();
      try {
        await fixtures.user(username, {
          email,
          customRegistrationUniqueField
        });
      } catch (err) {
        console.log('Preseeding of the test failed', err);
      }
    });
    after(async () => {
      await fixtures.clean();
    });
    it('[7C22] must throw an item already exists error when username field is not unique', async () => {
      try {
        const usersRepository = await getUsersRepository();
        const userObj = new User({
          id: charlatan.Lorem.characters(10),
          username,
          password: charlatan.Lorem.characters(10),
          email: charlatan.Internet.email()
        });
        await usersRepository.insertOne(userObj);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.id, ErrorIds.ItemAlreadyExists);
        assert.deepStrictEqual(err.data, { username });
      }
    });
    it('[6CFE] must throw an item already exists error when email field is not unique', async () => {
      try {
        const usersRepository = await getUsersRepository();
        const userObj = new User({
          id: charlatan.Lorem.characters(10),
          username: charlatan.Lorem.characters(10),
          email
        });
        await usersRepository.insertOne(userObj);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.id, ErrorIds.ItemAlreadyExists);
        assert.deepStrictEqual(err.data, { email });
      }
    });
  });

  describe('[UR02] insertOne() compensation on local failure', () => {
    it('[URB1] releases platform reservations so the same unique fields can register again', async () => {
      const usersRepository = await getUsersRepository();
      const uname = charlatan.Lorem.characters(10).toLowerCase();
      const mail = charlatan.Internet.email();
      const failing = new User({
        id: charlatan.Lorem.characters(25),
        username: uname,
        password: charlatan.Lorem.characters(10),
        email: mail
      });
      const originalCreateLocal = usersRepository.createLocalUserData;
      usersRepository.createLocalUserData = async () => { throw new Error('simulated local-creation failure'); };
      try {
        await usersRepository.insertOne(failing);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.message, 'simulated local-creation failure');
      } finally {
        usersRepository.createLocalUserData = originalCreateLocal;
      }
      // The platform reservation must be gone: registering the SAME
      // username + email again succeeds (would throw item-already-exists
      // if the failed attempt had leaked its unique-field rows).
      const retry = new User({
        id: charlatan.Lorem.characters(25),
        username: uname,
        password: charlatan.Lorem.characters(10),
        email: mail
      });
      await usersRepository.insertOne(retry);
      await usersRepository.deleteOne(retry.id, uname);
    });

    it('[URB2] a failure after the session and personal access were created leaves neither, nor a user directory', async () => {
      const usersRepository = await getUsersRepository();
      const { userLocalDirectory } = require('storage');
      const uname = charlatan.Lorem.characters(10).toLowerCase();
      const mail = charlatan.Internet.email();
      const failing = new User({
        id: charlatan.Lorem.characters(25),
        username: uname,
        password: charlatan.Lorem.characters(10),
        email: mail,
        appId: 'urb2-app'
      });
      // the password write is the last local write of a registration
      const accountStorage = usersRepository.userAccountStorage;
      const originalAddPasswordHash = accountStorage.addPasswordHash;
      accountStorage.addPasswordHash = async () => { throw new Error('simulated password failure'); };
      try {
        await usersRepository.insertOne(failing, true);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.message, 'simulated password failure');
      } finally {
        accountStorage.addPasswordHash = originalAddPasswordHash;
      }
      // first: the lookups below open (and so create) the per-user SQLite files
      assert.equal(require('node:fs').existsSync(userLocalDirectory.getPathForUser(failing.id)), false, 'no user directory left');
      const session = await new Promise((resolve, reject) => usersRepository.sessionsStorage.getMatching(
        { username: uname, appId: 'urb2-app', userId: failing.id }, (err, id) => err ? reject(err) : resolve(id)));
      assert.equal(session, null, 'no session left');
      const accesses = await new Promise((resolve, reject) => usersRepository.accessStorage.find(
        { id: failing.id }, {}, null, (err, res) => err ? reject(err) : resolve(res)));
      assert.deepEqual(accesses, [], 'no access left');
      assert.ok(await usersRepository.usersIndex.getUserId(uname) == null, 'no index row for the name');
      assert.ok(await usersRepository.usersIndex.getUsername(failing.id) == null, 'no index row for the id');
      assert.deepEqual(await accountStorage.getAccountFields(failing.id), {}, 'no account field left');
      assert.ok(await accountStorage.getPasswordHash(failing.id) == null, 'no password left');
      // On SQLite the two reads above recreated the account file of the discarded id.
      accountStorage.closeUser?.(failing.id);
      await userLocalDirectory.deleteUserDirectory(failing.id);
      // The same name and email register again.
      const retry = new User({
        id: charlatan.Lorem.characters(25),
        username: uname,
        password: charlatan.Lorem.characters(10),
        email: mail,
        appId: 'urb2-app'
      });
      await usersRepository.insertOne(retry, true);
      try {
        assert.equal(await usersRepository.usersIndex.getUserId(uname), retry.id);
      } finally {
        await usersRepository.deleteOne(retry.id, uname);
      }
    });
  });

  describe('[PGUG] registration writes the index entry before any row of the account', () => {
    it('[PGUG5] a registration with a session indexes the id before its personal access, which is stored', async () => {
      const usersRepository = await getUsersRepository();
      const uname = charlatan.Lorem.characters(10).toLowerCase();
      const user = new User({
        id: charlatan.Lorem.characters(25),
        username: uname,
        password: charlatan.Lorem.characters(10),
        email: charlatan.Internet.email(),
        appId: 'pgug5-app'
      });
      const order = [];
      const index = usersRepository.usersIndex;
      const originalAddUser = index.addUser;
      const originalCreateAccess = usersRepository.createPersonalAccessForUser;
      index.addUser = async function (...args) { order.push('index'); return await originalAddUser.apply(this, args); };
      usersRepository.createPersonalAccessForUser = async function (...args) { order.push('access'); return await originalCreateAccess.apply(this, args); };
      try {
        await usersRepository.insertOne(user, true);
      } finally {
        index.addUser = originalAddUser;
        usersRepository.createPersonalAccessForUser = originalCreateAccess;
      }
      try {
        assert.deepStrictEqual(order, ['index', 'access']);
        const accesses = await new Promise((resolve, reject) => usersRepository.accessStorage.find(
          { id: user.id }, {}, null, (err, res) => err ? reject(err) : resolve(res)));
        assert.deepStrictEqual(accesses.map((a) => a.type), ['personal'], 'the personal access is stored');
        assert.ok(user.token != null);
      } finally {
        await usersRepository.deleteOne(user.id, uname);
      }
    });
  });

  describe('[UR04] PostgreSQL: registration and account update take no transaction client', () => {
    // A transaction client held while each write runs on another pool
    // connection: concurrent calls up to the pool size would each hold one
    // and wait for a second, stalling the pool.
    it('[URT1] insertOne with a session and updateOne never check out a dedicated client', async function () {
      const db = require('storages').databasePG;
      if (db == null) return this.skip();
      const usersRepository = await getUsersRepository();
      const uname = charlatan.Lorem.characters(10).toLowerCase();
      const user = new User({
        id: charlatan.Lorem.characters(25),
        username: uname,
        password: charlatan.Lorem.characters(10),
        email: charlatan.Internet.email(),
        appId: 'urt1-app'
      });
      const originalGetClient = db.getClient;
      let clients = 0;
      // Counts every getClient of the process in the window: nothing else runs in this test process.
      db.getClient = async function (...args) { clients++; return originalGetClient.apply(this, args); };
      try {
        await usersRepository.insertOne(user, true);
        assert.equal(clients, 0, 'registration');
        await usersRepository.updateOne(user, { language: 'fr' }, 'system');
        assert.equal(clients, 0, 'account update');
        db.getClient = originalGetClient;
        assert.equal(await usersRepository.getOnePropertyValue(user.id, 'language'), 'fr');
      } finally {
        db.getClient = originalGetClient;
        await usersRepository.deleteOne(user.id, uname);
      }
    });
  });

  describe('[UR03] insertOne() indexed field defaults', () => {
    const nconf = require('nconf');
    const systemStreamsConfig = require('../../../../../config/plugins/systemStreams');
    const accountStreams = require('business/src/system-streams/index.ts');
    it('[URD1] a custom indexed field left empty is indexed with its configured default', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('NODE_ENV', 'test');
      store.set('custom:systemStreams:account', [
        { id: 'region', type: 'identifier/string', isIndexed: true, default: 'zone-a' }
      ]);
      systemStreamsConfig.load(store);
      await accountStreams.reloadForTests(store);
      const usersRepository = await getUsersRepository();
      const savedPlatform = usersRepository.platform;
      const savedCompensate = usersRepository.compensateFailedInsert;
      let operations = null;
      usersRepository.platform = {
        async updateUser (_username, ops) { operations = ops; throw new Error('stop after the platform write'); }
      };
      usersRepository.compensateFailedInsert = async () => {};
      try {
        await assert.rejects(usersRepository.insertOne(new User({
          id: charlatan.Lorem.characters(25),
          username: charlatan.Lorem.characters(10).toLowerCase(),
          password: charlatan.Lorem.characters(10)
        })), /stop after the platform write/);
      } finally {
        usersRepository.platform = savedPlatform;
        usersRepository.compensateFailedInsert = savedCompensate;
        // Back to the test configuration before the per-test hooks run.
        await accountStreams.reloadForTests();
      }
      const byKey = Object.fromEntries(operations.map((op) => [op.key, op.value]));
      assert.strictEqual(byKey.region, 'zone-a', 'custom field default');
      assert.strictEqual(byKey.language, 'en', 'built-in field default');
    });
  });
});
