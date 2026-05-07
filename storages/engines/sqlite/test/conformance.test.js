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
const conformanceTests = require('storages/interfaces/auditStorage/conformance/AuditStorage.test');

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
    }
  );
});
