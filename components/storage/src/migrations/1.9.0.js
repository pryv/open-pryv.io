/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
const { getLogger, getConfig } = require('@pryv/boiler');
const { integrity } = require('business');
const { move } = require('fs-extra');
const { readdirSync, statSync } = require('fs');
const path = require('path');

/**
 * v1.9.0:
 * - migrate system streamIds in access permissions
 */
module.exports = async function (context, callback) {
  const logger = getLogger('migration-1.9.0');
  logger.info('V1.8.0 => v1.9.0 Migration started');
  await SystemStreamsSerializer.init();
  try {
    await moveAttachments();
    await migratePasswords(context);
    await migrateHistory(context);
  } catch (e) {
    return callback(e);
  }

  logger.info('V1.8.0 => v1.9.0 Migration finished');
  callback();
};

async function moveAttachments () {
  const { userLocalDirectory } = require('storage');
  const logger = getLogger('migration-1.9.0:attachments');
  const config = await getConfig();
  await userLocalDirectory.init();
  const oldAttachmentsDirPath = config.get('eventFiles:attachmentsDirPath');
  const fileNames = readdirSync(oldAttachmentsDirPath);
  // for each user with existing attachments dir in old location, move the dir to new location
  for (const userId of fileNames) {
    const oldAttachmentUserDirPath = path.join(oldAttachmentsDirPath, userId);
    if (!statSync(oldAttachmentUserDirPath).isDirectory()) {
      logger.warn('Skipping file', oldAttachmentUserDirPath);
      continue;
    }
    const userLocalDir = await userLocalDirectory.ensureUserDirectory(userId);
    const newAttachmentDirPath = path.join(userLocalDir, 'attachments');
    await move(oldAttachmentUserDirPath, newAttachmentDirPath);
    logger.info('Attachmend moved for userId: ' + userId + ' to: ' + newAttachmentDirPath);
  }
}

async function migratePasswords (context) {
  const logger = getLogger('migration-1.9.0:passwords');
  const userAccountStorage = await require('storage').getUserAccountStorage();
  const query = { streamIds: { $in: [':_system:passwordHash'] } };
  const eventsCollection = await context.database.getCollection({
    name: 'events'
  });
  const cursor = await eventsCollection.find(query, { projection: { _id: 1, userId: 1, content: 1, created: 1, createdBy: 1 } });
  while (await cursor.hasNext()) {
    const event = await cursor.next();
    await userAccountStorage.addPasswordHash(event.userId, event.content, event.createdBy || 'system', event.created);
    await eventsCollection.deleteMany({ userId: event.userId, _id: event._id });
    logger.info('Migrating password for userId: ' + event.userId);
  }
}

async function migrateHistory (context) {
  const logger = getLogger('migration-1.9.0:historical-events');
  const eventsCollection = await context.database.getCollection({
    name: 'events'
  });

  // integrity values in history have changed... re-compute them
  const query = { headId: { $exists: true, $ne: null }, integrity: { $exists: true, $ne: null } };
  const cursor = eventsCollection.find(query, {});

  const BUFFER_SIZE = 500;
  let requests = [];
  while (await cursor.hasNext()) {
    const event = await cursor.next();
    const originalId = event._id;
    event.id = event.headId;
    delete event.headId;
    delete event.userId;
    delete event._id;
    const eventNewIntegrity = integrity.events.compute(event).integrity;

    if (event.integrity === eventNewIntegrity) continue;

    const request = {
      updateOne: {
        filter: { _id: originalId },
        update: {
          $set: { integrity: eventNewIntegrity }
        }
      }
    };
    requests.push(request);
    if (requests.length > BUFFER_SIZE) {
      requests = [];
      await flushToDb(requests, eventsCollection);
    }
  }
  await flushToDb(requests, eventsCollection);

  async function flushToDb (requests, eventsCollection) {
    if (requests.length === 0) { return; }
    const result = await eventsCollection.bulkWrite(requests);
    logger.info(`flushed ${result.nModified} modifications into database`);
    return [];
  }
}
