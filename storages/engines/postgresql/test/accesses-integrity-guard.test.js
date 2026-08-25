/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for the write-time integrity guard in AccessesPG.applyDefaults.
 * The guard fails loudly, at the write site, if integrity is active but the
 * access being persisted carries no `integrity` value — instead of letting
 * the gap surface one operation later as an "access has no integrity
 * property" scan failure. applyDefaults touches no database, so these tests
 * drive it directly with a stub db and a stubbed integrity ref.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AccessesPG } = require('../src/user/AccessesPG.ts');

// applyDefaults never touches the connection, so a bare stub is enough.
const stubDb = {};

function newAccessParams () {
  return { name: 'guard-test-access', type: 'shared' };
}

describe('[AIGP] AccessesPG write-time integrity guard', function () {
  it('[AIG1] active integrity that sets a value passes and keeps the value', function () {
    const activeSetting = {
      isActive: true,
      set: (item) => { item.integrity = 'ACCESS:0:sha256-stub'; }
    };
    const storage = new AccessesPG(stubDb, activeSetting);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, 'ACCESS:0:sha256-stub');
  });

  it('[AIG2] active integrity that silently skips the hash throws at the write site', function () {
    const brokenSetting = {
      isActive: true,
      set: () => { /* no-op: models a silently-disabled integrity ref */ }
    };
    const storage = new AccessesPG(stubDb, brokenSetting);
    assert.throws(
      () => storage.applyDefaults(newAccessParams()),
      /access persisted without an integrity property/
    );
  });

  it('[AIG3] inactive integrity is a no-op — no value, no throw', function () {
    const inactiveSetting = { isActive: false, set: () => {} };
    const storage = new AccessesPG(stubDb, inactiveSetting);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, undefined);
  });

  it('[AIG4] missing integrity ref throws at construction (required-arg contract)', function () {
    assert.throws(
      () => new AccessesPG(stubDb),
      /requires an integrityAccesses ref/
    );
  });
});

/**
 * The integrity-preserving update/delete write the row hash-less in statement 1
 * and restore the hash in statement 2. Both MUST run inside one transaction, on
 * the transaction CLIENT — never the pool (`this.db.query`). A pool-issued
 * statement escapes the transaction (reinstating the B-2026-08-25-1 window) AND
 * self-deadlocks on the transaction's row lock. This is the regression guard for
 * that constraint: it fails if any statement inside the wrap runs on the pool.
 */
describe('[AITX] AccessesPG integrity writes run in one transaction on the tx client', function () {
  const activeSetting = { isActive: true, set: (a) => { a.integrity = 'ACCESS:0:stub'; } };

  function makeDb () {
    const calls = { pool: 0, poolInsideTx: 0, client: 0 };
    let inTx = false;
    const client = {
      query: () => { calls.client++; return Promise.resolve({ rows: [{ id: 'acc-x', name: 'n', type: 'shared' }], rowCount: 1 }); }
    };
    const db = {
      query: () => { calls.pool++; if (inTx) calls.poolInsideTx++; return Promise.resolve({ rows: [], rowCount: 0 }); },
      withTransaction: async (fn) => { inTx = true; try { return await fn(client); } finally { inTx = false; } }
    };
    return { db, calls };
  }

  it('[AITX1] updateOne runs both statements on the tx client, none on the pool', function (done) {
    const { db, calls } = makeDb();
    const storage = new AccessesPG(db, activeSetting);
    storage.updateOne({ id: 'u' }, { id: 'acc-x' }, { modified: 1, $set: { name: 'n2' } }, (err) => {
      try {
        assert.ifError(err);
        assert.strictEqual(calls.poolInsideTx, 0, 'no pool query inside the transaction');
        assert.ok(calls.client >= 2, 'both statements ran on the tx client');
        done();
      } catch (e) { done(e); }
    });
  });

  it('[AITX2] delete runs batch-unset + recompute on the tx client, none on the pool', function (done) {
    const { db, calls } = makeDb();
    const storage = new AccessesPG(db, activeSetting);
    storage.delete({ id: 'u' }, { id: 'acc-x' }, (err) => {
      try {
        assert.ifError(err);
        assert.strictEqual(calls.poolInsideTx, 0, 'no pool query inside the transaction');
        assert.ok(calls.client >= 2, 'batch-unset + recompute ran on the tx client');
        done();
      } catch (e) { done(e); }
    });
  });
});
