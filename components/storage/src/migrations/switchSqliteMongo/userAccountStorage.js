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

const { getApplication } = require('api-server/src/application');
const { getUsersLocalIndex } = require('storage');

async function switchDB () {
  const mongo = require('../../userAccountStorageMongo');
  const sqlite = require('../../userAccountStorageSqlite');

  getApplication();

  await sqlite.init();
  await mongo.init();

  const userIndex = await getUsersLocalIndex();

  const allUsers = await userIndex.getAllByUsername();
  const allUsersIds = Object.values(allUsers);
  let migratedCount = 0;
  for (const userId of allUsersIds) {
    // --- password --- //
    const passwords = await sqlite._getPasswordHistory(userId);
    for (const password of passwords) {
      try {
        await mongo.addPasswordHash(userId, password.hash, password.time);
      } catch (e) {
        if (e.message.startsWith('E11000 duplicate key error collection: pryv-node-test.stores-key-value index: storeId_1_userId_1_key_1 dup key')) {
          console.log('Ignoring duplicate password for ' + userId + ' with time ' + password.time);
        } else {
          console.log('######');
          throw e;
        }
      }
    }
    if (passwords.length !== 0) {
      await sqlite.clearHistory(userId);
      console.log('migrated password history for ' + userId + ', items count: ' + passwords.length);
    }

    // --- store key values --//
    const storeKeyValues = await sqlite._getAllStoreData(userId);
    for (const i of storeKeyValues) {
      await mongo._addKeyValueData(i.storeId, i.userId, i.key, i.value);
      console.log(i.storeId, i.userId, i.key, i.value);
    }
    if (storeKeyValues.length !== 0) {
      await sqlite._clearStoreData(userId);
      console.log('migrated storeKeyValues history for ' + userId + ' with ' + storeKeyValues.length + ' items: ');
    }
    if (storeKeyValues.length !== 0 || passwords.length !== 0) {
      migratedCount++;
    }
  }
  console.log('Migrated ' + migratedCount + ' users over ' + allUsersIds.length);
  process.exit(0);
}

switchDB();
