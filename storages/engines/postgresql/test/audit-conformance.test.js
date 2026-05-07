/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createId: cuid } = require('@paralleldrive/cuid2');
const helpers = require('../../../test/helpers');
const { DatabasePG } = require('../src/DatabasePG.ts');
const { AuditStoragePG } = require('../src/AuditStoragePG.ts');
const conformanceTests = require('storages/interfaces/auditStorage/conformance/AuditStorage.test.js').default;

describe('[PGAC] PostgreSQL AuditStorage conformance', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });

  let db;

  conformanceTests(
    async () => {
      await helpers.dependencies.init();
      db = new DatabasePG(helpers.state.config);
      await db.waitForConnection();
      // Set up getLogger on _internals for AuditStoragePG
      const { _internals } = require('../src/_internals.ts');
      if (!_internals.getLogger) {
        _internals.set('getLogger', helpers.getLogger);
      }
      const storage = new AuditStoragePG(db);
      await storage.init();
      return storage;
    },
    () => 'pg-audit-' + cuid(),
    async (userId) => {
      if (db) {
        await db.query('DELETE FROM audit_events WHERE user_id LIKE $1', [userId + '%']);
      }
    }
  );
});
