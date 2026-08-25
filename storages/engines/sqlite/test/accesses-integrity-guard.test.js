/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for the write-time integrity guard in
 * AccessesSQLite.applyDefaults. The guard fails loudly, at the write site,
 * if integrity is active but the access being persisted carries no
 * `integrity` value — instead of letting the gap surface one operation
 * later as an "access has no integrity property" scan failure. applyDefaults
 * touches no database, so these tests drive it directly with a stubbed
 * integrity ref.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AccessesSQLite } = require('../src/user/AccessesSQLite.ts');
const { UserBaseStorageDb } = require('../src/userBaseStorage/UserBaseStorageDb.ts');

function newAccessParams () {
  return { name: 'guard-test-access', type: 'shared' };
}

describe('[AIGS] AccessesSQLite write-time integrity guard', function () {
  it('[AIG5] active integrity that sets a value passes and keeps the value', function () {
    const activeSetting = {
      isActive: true,
      set: (item) => { item.integrity = 'ACCESS:0:sha256-stub'; }
    };
    const storage = new AccessesSQLite(activeSetting);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, 'ACCESS:0:sha256-stub');
  });

  it('[AIG6] active integrity that silently skips the hash throws at the write site', function () {
    const brokenSetting = {
      isActive: true,
      set: () => { /* no-op: models a silently-disabled integrity ref */ }
    };
    const storage = new AccessesSQLite(brokenSetting);
    assert.throws(
      () => storage.applyDefaults(newAccessParams()),
      /access persisted without an integrity property/
    );
  });

  it('[AIG7] inactive integrity is a no-op — no value, no throw', function () {
    const inactiveSetting = { isActive: false, set: () => {} };
    const storage = new AccessesSQLite(inactiveSetting);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, undefined);
  });

  it('[AIG8] missing integrity ref throws at construction (required-arg contract)', function () {
    assert.throws(
      () => new AccessesSQLite(),
      /requires an integrityAccesses ref/
    );
  });
});

/**
 * The integrity-preserving update/delete write the row hash-less then restore
 * the hash. Both statements MUST run inside ONE better-sqlite3 transaction so no
 * other connection observes the hash-less intermediate (B-2026-08-25-1). This is
 * the regression guard: it fails if the writes are not wrapped in a single
 * `db.transaction`. The per-user db is stubbed so no real SQLite file is touched.
 */
describe('[AITXS] AccessesSQLite integrity writes run in one better-sqlite3 transaction', function () {
  const activeSetting = { isActive: true, set: (a) => { a.integrity = 'ACCESS:0:stub'; } };
  let originalForUser, state;

  beforeEach(function () {
    originalForUser = UserBaseStorageDb.forUser;
    state = { txCalls: 0, writes: 0 };
    const stmt = {
      get: () => ({ id: 'acc-x', data: JSON.stringify({ name: 'n', type: 'shared' }) }),
      all: () => [{ id: 'acc-x', data: JSON.stringify({ name: 'n', type: 'shared' }) }],
      run: () => { state.writes++; return { changes: 1 }; }
    };
    const fakeDb = {
      prepare: () => stmt,
      transaction: (fn) => { state.txCalls++; return (...args) => fn(...args); }
    };
    const fakeUdb = { db: fakeDb, ensureTable: async () => {} };
    UserBaseStorageDb.forUser = async () => fakeUdb;
  });
  afterEach(function () { UserBaseStorageDb.forUser = originalForUser; });

  it('[AITXS1] updateOne wraps both statements in one db.transaction', function (done) {
    const storage = new AccessesSQLite(activeSetting);
    storage.updateOne({ id: 'u' }, { id: 'acc-x' }, { modified: 1, $set: { name: 'n2' } }, (err) => {
      try {
        assert.ifError(err);
        assert.strictEqual(state.txCalls, 1, 'exactly one transaction opened');
        assert.ok(state.writes >= 2, 'statement 1 + statement 2 both wrote');
        done();
      } catch (e) { done(e); }
    });
  });

  it('[AITXS2] delete wraps batch-unset + recompute in one db.transaction', function (done) {
    const storage = new AccessesSQLite(activeSetting);
    storage.delete({ id: 'u' }, { id: 'acc-x' }, (err) => {
      try {
        assert.ifError(err);
        assert.strictEqual(state.txCalls, 1, 'exactly one transaction opened');
        assert.ok(state.writes >= 2, 'batch-unset + recompute both wrote');
        done();
      } catch (e) { done(e); }
    });
  });
});
