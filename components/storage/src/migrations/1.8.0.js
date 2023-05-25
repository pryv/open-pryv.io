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

const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { getUsersRepository } = require('business/src/users/repository');
const { getLogger } = require('@pryv/boiler');
const PlatformWideDB = require('platform/src/DB');

/**
 * v1.7.5:
 * - migrate system streamIds in access permissions
 */
module.exports = async function (context, callback) {
  const logger = getLogger('migration-1.8.0');
  logger.info('V1.7.5 => v1.8.0 Migration started');
  await SystemStreamsSerializer.init();
  const eventsCollection = await context.database.getCollection({
    name: 'events'
  });
  try {
    await setAllTrashed();
    await migrateUserids();
    await migratePasswords();
    await migrateIndexedFieldsToPlatform();
    await setAllTrashed();
  } catch (e) {
    return callback(e);
  }

  logger.info('V1.7.5 => v1.8.0 Migration finished');
  callback();

  async function setAllTrashed () { // Check this!
    await eventsCollection.updateMany({ trashed: null, deleted: null }, { $set: { trashed: false } });
  }

  async function migrateUserids () {
    const usersIndex = await require('storage').getUsersLocalIndex();
    const query = { streamIds: { $in: [':_system:username'] } };
    const cursor = eventsCollection.find(query, {
      projection: { _id: 1, userId: 1, content: 1 }
    });
    while (await cursor.hasNext()) {
      const event = await cursor.next();
      await usersIndex.addUser(event.content, event.userId);
      await eventsCollection.deleteMany({ userId: event.userId, _id: event._id });
    }
  }

  async function migratePasswords () {
    const userAccountStorage = await require('storage').getUserAccountStorage();
    const query = { streamIds: { $in: [':_system:passwordHash'] } };
    const cursor = await eventsCollection.find(query, { projection: { _id: 1, userId: 1, content: 1, created: 1, createdBy: 1 } });
    while (await cursor.hasNext()) {
      const event = await cursor.next();
      await userAccountStorage.addPasswordHash(event.userId, event.content, event.createdBy || 'system', event.created);
      await eventsCollection.deleteMany({ userId: event.userId, _id: event._id });
    }
  }

  async function migrateIndexedFieldsToPlatform () {
    const platformWideDB = new PlatformWideDB();
    await platformWideDB.init();
    // Retrieve all existing users
    const usersRepository = await getUsersRepository();
    const users = await usersRepository.getAll();
    const indexedFields = SystemStreamsSerializer.getIndexedAccountStreamsIdsWithoutPrefix();
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const username = user.username;
      for (const field of indexedFields) {
        const value = user[field];
        if (value == null) { continue; }
        const isUnique = SystemStreamsSerializer.isUniqueAccountField(field);
        function logDebug (txt) {
          logger.debug('platform: user <' +
                        user.username +
                        '> field: <' +
                        field +
                        '> value: <' +
                        user[field] +
                        '> unique: <' +
                        isUnique +
                        '> => ' +
                        txt);
        }
        if (isUnique) {
          const currentUsername = await platformWideDB.getUsersUniqueField(field, value);
          if (currentUsername === username) {
            logDebug('skip');
            continue;
          } // already set
          if (currentUsername != null) {
            throw new Error('Error while migrating user unique field to user: ' +
                            username +
                            ', value: ' +
                            value +
                            ' is already associated with user: ' +
                            currentUsername);
          }
          await platformWideDB.setUserUniqueField(username, field, value);
          logDebug('set unique');
        } else {
          const currentValue = await platformWideDB.getUserIndexedField(username, field);
          if (currentValue === value) {
            logDebug('skip');
            continue;
          } // already set
          if (currentValue != null) {
            throw new Error('Error while migrating user indexed field to user: ' +
                            username +
                            ', value: ' +
                            value +
                            ' is already set to : ' +
                            currentValue);
          }
          await platformWideDB.setUserIndexedField(username, field, value);
          logDebug('set indexed');
        }
      }
    }
    await platformWideDB.close();
  }
};
