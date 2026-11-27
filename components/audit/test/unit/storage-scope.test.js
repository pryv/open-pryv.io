/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, assert, cuid */

/**
 * [AUSC] The audit reaches audit records only, and what lists the actions and
 * accesses of a trail exists on the audit storage only.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sourcesUnder = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)));

describe('[AUSC] audit storage scope', function () {
  before(async function () {
    await initTests();
    await initCore();
  });

  it('[AUSC1] the audit component reads no storage of the barrel but the audit storage', function () {
    const reached = new Set();
    for (const file of sourcesUnder('components/audit/src')) {
      const text = read(file);
      for (const m of text.matchAll(/require\('storages'\)\.(\w+)/g)) reached.add(m[1]);
      assert.ok(!/\{[^}]*\}\s*=\s*require\('storages'\)/.test(text), file + ' takes storages out of the barrel');
      assert.ok(!/from 'storages'|require\('storages\/(?!interfaces)/.test(text), file + ' imports the barrel or an engine');
      assert.ok(!/userAccountStorage|UserAccountStorage|usersLocalIndex|require\('mall'/.test(text), file + ' reaches account data');
    }
    assert.deepStrictEqual([...reached], ['auditStorage']);
  });

  it('[AUSC2] on PostgreSQL the audit statements name the audit table, and the users index for the guard only', function () {
    const tables = new Set();
    for (const file of ['AuditStoragePG.ts', 'UserAuditDatabasePG.ts']) {
      for (const m of read('storages/engines/postgresql/src/' + file).matchAll(/\b(?:FROM|INTO|JOIN|UPDATE)\s+([a-z_]+)\b/g)) tables.add(m[1]);
    }
    // `audit_event_streams`: the index of records by access (kept by triggers
    // on audit_events); `terms`: the recursive query listing its access ids.
    assert.deepStrictEqual([...tables].sort(), ['audit_event_streams', 'audit_events', 'terms', 'users_index']);
    const indexReads = read('storages/engines/postgresql/src/UserAuditDatabasePG.ts').match(/users_index/g);
    assert.strictEqual(indexReads.length, 1, 'the guarded insert only');
  });

  it('[AUSC3] on SQLite the audit handle lists actions and accesses, the handle of the user events does not', async function () {
    const { SqliteStorage } = require('storages/engines/sqlite/src/userSQLite/Storage.ts');
    const { getStorage } = require('storages/engines/sqlite/src/userSQLite/index.ts');
    const userId = 'ausc-' + cuid();
    const auditStorage = new SqliteStorage('audit-scope-test');
    await auditStorage.init();
    const local = await getStorage('local');
    try {
      const auditDb = await auditStorage.forUser(userId);
      const eventsDb = await local.forUser(userId);
      for (const method of ['getAllActions', 'getAllAccesses']) {
        assert.strictEqual(typeof auditDb[method], 'function', method);
        assert.strictEqual(eventsDb[method], undefined, method);
      }
      const tables = auditDb.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      const own = tables.filter((name) => name !== 'events' && !name.startsWith('events_'));
      assert.deepStrictEqual(own, [], 'the audit file holds no other collection');
    } finally {
      await auditStorage.deleteUser(userId);
      await local.deleteUser(userId);
      auditStorage.close();
    }
  });
});
