/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const chai = require('chai');
const assert = chai.assert;
const charlatan = require('charlatan');
require('test-helpers/src/api-server-tests-config');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection } = require('api-server/test/test-helpers');
const { getUsersRepository, User } = require('business/src/users');
const { ErrorIds } = require('errors');

describe('Users repository', () => {
  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    await mongoFixtures.clean();
  });
  after(async () => {
    await mongoFixtures.clean();
  });
  let username;
  let email;
  let customRegistrationUniqueField;
  describe('createUser()', () => {
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
        assert.isTrue(false);
      } catch (err) {
        assert.equal(err.id, ErrorIds.ItemAlreadyExists);
        assert.deepEqual(err.data, { username });
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
        assert.isTrue(false);
      } catch (err) {
        assert.equal(err.id, ErrorIds.ItemAlreadyExists);
        assert.deepEqual(err.data, { email });
      }
    });
  });
});
