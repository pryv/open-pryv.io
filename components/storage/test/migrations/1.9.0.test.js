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

/**
 * Tests data migration between versions.
 */

const util = require('util');
const helpers = require('test-helpers');
const testData = helpers.data;
const { getMall } = require('mall');
const mongoFolder = __dirname + '../../../../../var-pryv/mongodb-bin';
const { remove } = require('fs-extra');
const path = require('path');

const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const { getVersions } = require('./util');

const integrityFinalCheck = require('test-helpers/src/integrity-final-check');
const userWithAttachments = 'u_0';
const storage = require('storage');

describe('Migration - 1.9.0', function () {
  this.timeout(20000);
  let userLocalDirectory;

  before(async function () {
    const database = await storage.getDatabase();
    if (database.isFerret) this.skip();
    // remove user attachments
    userLocalDirectory = storage.userLocalDirectory;
    await userLocalDirectory.init();
    const userLocalDir = await userLocalDirectory.getPathForUser(userWithAttachments);
    const newAttachmentDirPath = path.join(userLocalDir, 'attachments');
    await remove(newAttachmentDirPath);

    const newVersion = getVersions('1.9.0');
    await SystemStreamsSerializer.init();
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
