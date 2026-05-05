/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs');

const { _internals } = require('../../_internals');
const { UserDatabase } = require('../UserDatabase');
const { migrateUserDB: migrate0to1 } = require('./1');
const logger = _internals.lazyLogger('sqlite-storage-migration');

export { migrateUserDBsIfNeeded };

async function migrateUserDBsIfNeeded (storage: any): Promise<{ migrated: number, skipped: number } | undefined> {
  const usersBaseDirectory = _internals.userLocalDirectory.getBasePath();
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

  async function checkUserDir (userId: string, userDir: string): Promise<void> {
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
    } catch (err: any) {
      logger.error('ERROR during Migration V0 to V1: ' + err.message + ' >> For User: ' + userId + '>>> Check Dbs in: ' + userDir);
      logger.error(err);
      await fs.promises.unlink(v1dbPath);
      process.exit(1);
    }
  }
}

async function foreachUserDirectory (asyncCallBack: (uid: string, path: string) => Promise<void>, userDataPath: string, logger: any): Promise<void> {
  await loop(userDataPath, '');

  async function loop (loopPath: string, tail: string): Promise<void> {
    if (!fs.existsSync(loopPath)) {
      logger.error('Cannot find dir' + loopPath);
      return;
    }
    const fileNames: string[] = fs.readdirSync(loopPath);

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
