/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const charlatan = require('charlatan');
require('test-helpers/src/api-server-tests-config');
const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { getUsersRepository, User } = require('business/src/users');
const { ErrorIds } = require('errors');

describe('[USRP] Users repository', () => {
  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture(await produceStorageConnection());
    await mongoFixtures.clean();
  });
  after(async () => {
    await mongoFixtures.clean();
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
        await mongoFixtures.user(username, {
          email,
          customRegistrationUniqueField
        });
      } catch (err) {
        console.log('Preseeding of the test failed', err);
      }
    });
    after(async () => {
      await mongoFixtures.clean();
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
});
