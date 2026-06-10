/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { getConfig } = require('@pryv/boiler');

const { reconcileContentIndexes, buildIndexStatements } = require('../engines/postgresql/src/contentIndexReconciler.ts');

const noopLogger = { debug () {}, info () {}, warn () {}, error () {} };

describe('[CQIX] Content-query index reconciler (PostgreSQL)', function () {
  describe('[IXSL] statement builder', () => {
    it('[IX01] builds partial jsonb + text indexes for a nested path', () => {
      const statements = buildIndexStatements({ field: 'content', path: 'drug.codes.atc', types: ['medication/exposure-assertion-v1'] });
      assert.strictEqual(statements.length, 2);
      const [jb, tx] = statements;
      assert.match(jb.name, /^pryv_cq_[0-9a-f]{12}_jb$/);
      assert.match(jb.sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS pryv_cq_[0-9a-f]{12}_jb ON events \(\(\(content #> '\{"drug","codes","atc"\}'\)\)\) WHERE \(content #> '\{"drug","codes","atc"\}'\) IS NOT NULL AND type IN \('medication\/exposure-assertion-v1'\)/);
      assert.match(tx.sql, /#>> '\{"drug","codes","atc"\}'\)\) text_pattern_ops\)/);
    });

    it('[IX02] supports root $ and clientData column', () => {
      const [jb] = buildIndexStatements({ path: '$' });
      assert.match(jb.sql, /ON events \(\(content\)\) WHERE content IS NOT NULL/);
      const [jbCd] = buildIndexStatements({ field: 'clientData', path: 'ehr-sync:v2.externalId' });
      assert.match(jbCd.sql, /client_data #> '\{"ehr-sync:v2","externalId"\}'/);
    });

    it('[IX03] rejects invalid declarations loudly', () => {
      assert.throws(() => buildIndexStatements({ path: 'a..b' }), /Invalid path/);
      assert.throws(() => buildIndexStatements({ path: 'a', field: 'integrity' }), /field must be/);
      assert.throws(() => buildIndexStatements({ path: 'a', types: ["x'); DROP TABLE events; --"] }), /types/);
      assert.throws(() => buildIndexStatements({}), /missing "path"/);
    });

    it('[IX04] names are deterministic and types-order-insensitive', () => {
      const a = buildIndexStatements({ path: 'a.b', types: ['t/1', 't/2'] })[0].name;
      const b = buildIndexStatements({ path: 'a.b', types: ['t/2', 't/1'] })[0].name;
      assert.strictEqual(a, b);
    });
  });

  describe('[IXDB] reconciliation against the test database', function () {
    if (process.env.STORAGE_ENGINE === 'sqlite') {
      // SQLite matrix: PG is not the base engine — reconciler is a PG-only capability.
      it.skip('[IX10] skipped under SQLite matrix', () => {});
      return;
    }

    let db;
    before(async () => {
      const config = await getConfig();
      const pgSettings = config.get('storages:engines:postgresql');
      const { _internals } = require('../engines/postgresql/src/_internals.ts');
      if (typeof _internals.getLogger !== 'function') {
        _internals.set('getLogger', () => noopLogger);
      }
      const { DatabasePG } = require('../engines/postgresql/src/DatabasePG.ts');
      db = new DatabasePG({
        host: pgSettings.host,
        port: pgSettings.port,
        database: pgSettings.database,
        user: pgSettings.user,
        password: pgSettings.password,
        max: 2
      });
      await db.query('SELECT 1'); // ensure connection + schema
    });
    after(async () => {
      if (db == null) return;
      // leave no pryv_cq_* indexes behind
      await reconcileContentIndexes(db, [], noopLogger);
      await db.close();
    });

    async function listCqIndexes () {
      const res = await db.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'events' AND indexname LIKE 'pryv_cq_%' ORDER BY indexname");
      return res.rows.map((r) => r.indexname);
    }

    it('[IX10] creates declared indexes, keeps them on re-run, drops on undeclare', async () => {
      const declarations = [
        { field: 'content', path: 'drug.codes.atc', types: ['medication/exposure-assertion-v1'] },
        { field: 'clientData', path: 'related' }
      ];
      const first = await reconcileContentIndexes(db, declarations, noopLogger);
      assert.strictEqual(first.created.length, 4); // 2 per declaration
      assert.deepStrictEqual(await listCqIndexes(), [...first.created].sort());

      const second = await reconcileContentIndexes(db, declarations, noopLogger);
      assert.strictEqual(second.created.length, 0);
      assert.strictEqual(second.dropped.length, 0);
      assert.strictEqual(second.kept.length, 4);

      const third = await reconcileContentIndexes(db, [declarations[0]], noopLogger);
      assert.strictEqual(third.dropped.length, 2);
      assert.strictEqual(third.kept.length, 2);

      const cleanup = await reconcileContentIndexes(db, [], noopLogger);
      assert.strictEqual(cleanup.dropped.length, 2);
      assert.deepStrictEqual(await listCqIndexes(), []);
    });

    it('[IX11] declared indexes are valid and usable', async () => {
      await reconcileContentIndexes(db, [{ path: 'drug.codes.atc' }], noopLogger);
      const res = await db.query(`
        SELECT c.relname AS name, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'events' AND c.relname LIKE 'pryv_cq_%'`);
      assert.strictEqual(res.rows.length, 2);
      for (const row of res.rows) assert.strictEqual(row.valid, true, `${row.name} should be valid`);
      await reconcileContentIndexes(db, [], noopLogger);
    });

    it('[IX12] rejects a non-array declaration', async () => {
      await assert.rejects(() => reconcileContentIndexes(db, { path: 'a' }, noopLogger), /expected an array/);
    });
  });
});
