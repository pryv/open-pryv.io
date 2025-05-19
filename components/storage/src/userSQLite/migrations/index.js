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

const path = require('path');
const fs = require('fs');

const userLocalDirectory = require('storage').userLocalDirectory;
const UserDatabase = require('../UserDatabase');
const migrate0to1 = require('./1');
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('sqlite-storage-migration');

module.exports = {
  migrateUserDBsIfNeeded
};

async function migrateUserDBsIfNeeded (storage) {
  const usersBaseDirectory = userLocalDirectory.getBasePath();
  if (!fs.existsSync(usersBaseDirectory)) {
    fs.mkdirSync(usersBaseDirectory, { recursive: true });
  }
  const auditDBVersionFile = path.join(usersBaseDirectory, `audit-db-version-${storage.getVersion()}.txt`);
  if (fs.existsSync(auditDBVersionFile)) {
    logger.debug('Audit db version file found, skipping migration for ' + storage.getVersion());
    return;
  }

  const result = { migrated: 0, skipped: 0 };

  await foreachUserDirectory(checkUserDir, usersBaseDirectory, logger);

  logger.info(`Migration done for ${storage.getVersion()}: ${result.migrated} migrated, ${result.skipped} skipped`);
  fs.writeFileSync(auditDBVersionFile, 'DO NOT DELETE THIS FILE - IT IS USED TO DETECT MIGRATION SUCCESS');

  return result;

  async function checkUserDir (userId, userDir) {
    // check if a migration from a non upgradeable schema (copy file to file) is needed
    const v0dbPath = path.join(userDir, 'audit.sqlite');

    if (!fs.existsSync(v0dbPath)) {
      logger.info('OK for ' + userId);
      result.skipped++;
      return; // skip as file exists
    }

    const v1dbPath = await storage.dbgetPathForUser(userId);
    if (fs.existsSync(v1dbPath)) {
      logger.error('ERROR: Found V0 and V1 database for: ' + userId + '>>> Manually delete one of the version in: ' + userDir);
      process.exit(1);
    }

    const v1user = new UserDatabase(logger, { dbPath: v1dbPath });

    try {
      await v1user.init();
      const resMigrate = await migrate0to1(v0dbPath, v1user, logger);
      logger.info('Migrated ' + resMigrate.count + ' records for ' + userId);
      v1user.close();
      result.migrated++;
    } catch (err) {
      logger.error('ERROR during Migration V0 to V1: ' + err.message + ' >> For User: ' + userId + '>>> Check Dbs in: ' + userDir);
      logger.error(err);
      await fs.promises.unlink(v1dbPath);
      process.exit(1);
    }
  }
}

/**
 * @param {Function} asyncCallBack(uid, path)
 * @param {string} [userDataPath] -- Optional, user data path
 * @param {any} [logger] -- Optional, logger
 */
async function foreachUserDirectory (asyncCallBack, userDataPath, logger) {
  await loop(userDataPath, '');

  async function loop (loopPath, tail) {
    if (!fs.existsSync(loopPath)) {
      logger.error('Cannot find dir' + loopPath);
      return;
    }
    const fileNames = fs.readdirSync(loopPath);

    for (const fileName of fileNames) {
      if (tail.length < 3 && fileName.length !== 1) { logger.warn('Skipping no 1 char' + fileName); continue; }
      const myDirPath = path.join(loopPath, fileName);
      if (!fs.statSync(myDirPath).isDirectory()) { logger.warn('Skipping File' + fileName); continue; }
      const myTail = fileName + tail;

      if (tail.length < 3) {
        await loop(myDirPath, myTail);
      } else {
        if (!fileName.endsWith(tail)) { logger.warn('Skipping not valid userDir' + myDirPath); continue; }
        await asyncCallBack(fileName, myDirPath);
      }
    }
  }
}
