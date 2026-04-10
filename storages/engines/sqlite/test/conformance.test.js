/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const cuid = require('cuid');
const userLocalDirectory = require('../../../test/helpers').userLocalDirectory;
const Storage = require('storages/engines/sqlite/src/userSQLite/Storage');
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
