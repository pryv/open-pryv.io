/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const accountStreams = require('business/src/system-streams');
const { getLogger } = require('@pryv/boiler');

/**
 * v1.9.4:
 * - Copy account data from events collection to account-fields collection.
 *   This prepares for routing system stream events through the account store
 *   instead of the local store.
 *
 *   Events are NOT deleted — the local store still serves them until routing
 *   is switched in a subsequent release.
 *
 *   Idempotent: duplicate (userId, field, time) entries are skipped.
 */
module.exports = async function (context, callback) {
  const logger = getLogger('migration-1.9.4');
  logger.info('v1.9.3 => v1.9.4 Migration started');

  try {
    await accountStreams.init();
    await migrateAccountEvents(context, logger);
  } catch (e) {
    return callback(e);
  }

  logger.info('v1.9.3 => v1.9.4 Migration finished');
  callback();
};

async function migrateAccountEvents (context, logger) {
  // Build set of account stream IDs (both :_system: and :system: prefixes)
  const accountMap = accountStreams.accountMap;
  const accountStreamIds = Object.keys(accountMap);

  if (accountStreamIds.length === 0) {
    logger.info('No account streams configured — nothing to migrate');
    return;
  }

  logger.info(`Migrating account events for streams: ${accountStreamIds.join(', ')}`);

  const eventsCollection = await context.database.getCollection({ name: 'events' });
  const accountFieldsCollection = await context.database.getCollection({ name: 'account-fields' });

  // Find all events belonging to account streams
  const query = {
    streamIds: { $in: accountStreamIds }
  };
  const projection = {
    _id: 0,
    userId: 1,
    streamIds: 1,
    content: 1,
    time: 1,
    created: 1,
    createdBy: 1,
    modified: 1,
    modifiedBy: 1
  };

  const cursor = await eventsCollection.find(query, { projection });

  let migrated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const event = await cursor.next();

    // Extract the field name from the event's streamIds
    const fieldName = extractFieldName(event.streamIds, accountStreamIds);
    if (!fieldName) {
      logger.warn(`Skipping event with unrecognized streamIds: ${JSON.stringify(event.streamIds)}`);
      skipped++;
      continue;
    }

    // Insert into account-fields (skip if already exists for same userId/field/time)
    const time = event.modified || event.created || event.time;
    const createdBy = event.modifiedBy || event.createdBy || 'system';
    try {
      await accountFieldsCollection.insertOne({
        userId: event.userId,
        field: fieldName,
        value: event.content,
        time,
        createdBy
      });
      migrated++;
    } catch (e) {
      if (e.message && e.message.includes('E11000 duplicate key error')) {
        // Already migrated — idempotent skip
        skipped++;
      } else {
        throw e;
      }
    }

    if ((migrated + skipped) % 200 === 0) {
      logger.info(`Progress: ${migrated} migrated, ${skipped} skipped`);
    }
  }

  logger.info(`Migration complete: ${migrated} account fields migrated, ${skipped} skipped`);
}

/**
 * Extract the field name (without prefix) from an event's streamIds.
 * Matches against known account stream IDs and strips the prefix.
 *
 * @param {string[]} eventStreamIds - the event's streamIds array
 * @param {string[]} accountStreamIds - known account stream IDs (with prefix)
 * @returns {string|null} field name without prefix, or null
 */
function extractFieldName (eventStreamIds, accountStreamIds) {
  for (const sid of eventStreamIds) {
    if (accountStreamIds.includes(sid)) {
      const lastColon = sid.lastIndexOf(':');
      return lastColon >= 0 ? sid.substring(lastColon + 1) : sid;
    }
  }
  return null;
}
