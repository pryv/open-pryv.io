/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Tests data migration between versions.
 */

const util = require('util');
const helpers = require('../../../../test/helpers');
const testData = helpers.data;
const { remove } = require('fs-extra');
const path = require('path');
const { getMall, accountStreams, userLocalDirectory, integrityFinalCheck, config } = helpers;
const mongoFolder = config.mongoFolder;

const { getVersions } = require('./util');

const userWithAttachments = 'u_0';

describe('[MG90] Migration - 1.9.0', function () {
  this.timeout(20000);

  before(async function () {
    // remove user attachments
    await userLocalDirectory.init();
    const userLocalDir = await userLocalDirectory.getPathForUser(userWithAttachments);
    const newAttachmentDirPath = path.join(userLocalDir, 'attachments');
    await remove(newAttachmentDirPath);

    const newVersion = getVersions('1.9.0');
    await accountStreams.init();
    await util.promisify(testData.restoreFromDump)('1.8.0', mongoFolder);

    // perform migration
    await newVersion.migrateIfNeeded();
  });

  after(async () => { });

  it('[MCHA] Check attachments', async () => {
    const mall = await getMall();
    const allUserEvents = await mall.events.get(userWithAttachments, {});
    for (const event of allUserEvents) {
      if (event.attachments) {
        for (const attachment of event.attachments) {
          // throw error if does not exists
          await mall.events.getAttachment(userWithAttachments, { id: event.id }, attachment.id);
        }
      }
    }
  });

  it('[XAAB] Check integrity of database', async () => {
    await integrityFinalCheck.all();
  });
});
