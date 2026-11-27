/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cuid = require('cuid');
const userLocalDirectory = require('../../../test/helpers').userLocalDirectory;
const { SqliteStorage: Storage } = require('storages/engines/sqlite/src/userSQLite/Storage.ts');
const conformanceTests = require('storages/interfaces/auditStorage/conformance/AuditStorage.test.js').default;
const { _setSummaryChunkRows } = require('storages/engines/sqlite/src/userSQLite/UserDatabase.ts');

describe('[SQCF] UserSQLite conformance', () => {
  conformanceTests(
    async () => {
      await userLocalDirectory.init();
      const storage = new Storage('audit-test-' + cuid().slice(0, 8));
      await storage.init();
      return storage;
    },
    () => cuid(),
    async (userId) => {
      await userLocalDirectory.deleteUserDirectory(userId);
    },
    {
      setSummaryChunkRows: _setSummaryChunkRows,
      // This test storage has a name of its own: its file in the trail's
      // directory holds only the rows the tests wrote.
      removePlatformTrailRows: async (storage) => {
        const fs = require('node:fs');
        const { PLATFORM_TRAIL_USER_ID } = require('storages/interfaces/auditStorage/AuditStorage.ts');
        storage.closeUser(PLATFORM_TRAIL_USER_ID);
        const dbPath = storage.existingPathForUser(PLATFORM_TRAIL_USER_ID);
        for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(file, { force: true });
      }
    }
  );
});
