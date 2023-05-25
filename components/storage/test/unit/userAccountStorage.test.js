/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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

const assert = require('chai').assert;
const cuid = require('cuid');
const timestamp = require('unix-timestamp');
const encryption = require('utils').encryption;

const { userLocalDirectory, getUserAccountStorage } = require('storage');

describe('[UAST] Users Account Storage', () => {
  const passwords = []; // password will be stored in reverse order (oldest first)
  const userId = cuid();
  let userAccountStorage;

  before(async () => {
    userAccountStorage = await getUserAccountStorage();
    // create five passwords with one day delay between each other
    const now = timestamp.now();
    for (let i = 4; i >= 0; i--) { // in descending order
      const password = `pass_${i}`;
      const passwordHash = await encryption.hash(password);
      const createdPassword = await userAccountStorage.addPasswordHash(userId, passwordHash, 'test', timestamp.add(now, `-${i}d`));
      assert.exists(createdPassword.time);
      createdPassword.password = password;
      passwords.push(createdPassword);
    }
  });

  after(async () => {
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  describe('addPasswordHash()', () => {
    it('[B2I7] must throw an error if two passwords are added with the same time', async () => {
      const userId2 = cuid();
      const now = timestamp.now();
      await userAccountStorage.addPasswordHash(userId2, 'hash_1', 'test', now);
      try {
        await userAccountStorage.addPasswordHash(userId2, 'hash_2', 'test', now);
      } catch (e) {
        assert.equal(e.message, 'UNIQUE constraint failed: passwords.time');
        return;
      }
      assert.isFalse(true, 'should throw an error');
    });
  });

  describe('getCurrentPasswordTime()', () => {
    it('[85PW] must return the time of the current password', async () => {
      const uId = cuid();
      const time = timestamp.now('-1w');
      await userAccountStorage.addPasswordHash(uId, 'hash', 'test', time);
      const actualTime = await userAccountStorage.getCurrentPasswordTime(uId);
      assert.strictEqual(actualTime, time, 'times should match');
    });

    it('[V54S] must throw an error if there is no password for the user id', async () => {
      try {
        await userAccountStorage.getCurrentPasswordTime(cuid());
      } catch (e) {
        assert.match(e.message, /No password found/);
      }
    });
  });

  describe('passwordExistsInHistory()', () => {
    it('[1OQP] must return true when looking for existing passwords', async () => {
      for (const password of passwords) {
        const passwordExists = await userAccountStorage.passwordExistsInHistory(userId, password.password, passwords.length);
        assert.isTrue(passwordExists, 'should find password ' + JSON.stringify(password));
      }
    });

    it('[DO33] must return false when looking for a non-existing password', async () => {
      const passwordExists = await userAccountStorage.passwordExistsInHistory(userId, 'unknown-password', passwords.length);
      assert.isFalse(passwordExists, 'should not find password with non-existing hash');
    });

    it('[FEYP] must return false when looking for an existing password that is beyond the given range', async () => {
      const oldestPassword = passwords[0];
      const passwordExists = await userAccountStorage.passwordExistsInHistory(userId, oldestPassword.password, passwords.length - 1);
      assert.isFalse(passwordExists, 'should not find password beyond the given range: ' + JSON.stringify(oldestPassword));
    });
  });
});
