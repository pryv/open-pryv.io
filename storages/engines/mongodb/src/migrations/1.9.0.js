/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const accountStreams = require('business/src/system-streams');
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
  await accountStreams.init();
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
  const oldAttachmentsDirPath = config.get('storages:engines:filesystem:attachmentsDirPath');
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
