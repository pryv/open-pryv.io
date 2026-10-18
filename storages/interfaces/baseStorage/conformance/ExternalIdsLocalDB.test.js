/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * ExternalIdsLocalDB conformance test suite.
 * @param {Function} getDB - async function returning an initialized ExternalIdsLocalDB instance
 */
export default function conformanceTests (getDB) {
  const assert = require('node:assert');
  const cuid = require('cuid');
  const { ExternalIdConflict } = require('storages/interfaces/baseStorage/ExternalIdsLocalDB.ts');

  function row (overrides = {}) {
    return {
      userId: cuid(),
      nsToken: 'ns-' + cuid(),
      valueToken: 'v-' + cuid(),
      blindedValue: 'b-' + cuid(),
      claimedAt: 1760000000.5,
      ...overrides
    };
  }

  async function assertConflict (promise, reason) {
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof ExternalIdConflict, 'an ExternalIdConflict, got ' + err);
      assert.strictEqual(err.reason, reason);
      return true;
    });
  }

  describe('[XIDL] ExternalIdsLocalDB conformance', () => {
    let db;

    before(async () => {
      db = await getDB();
    });

    afterEach(async () => {
      await db.deleteAll();
    });

    it('[XIDL1] must insert a row and read it back by user, by tokens and by user + namespace', async () => {
      const r = row();
      await db.insert(r);
      assert.deepStrictEqual(await db.getByUser(r.userId), [r]);
      assert.deepStrictEqual(await db.getByTokens(r.nsToken, r.valueToken), r);
      assert.deepStrictEqual(await db.getByUserAndNamespace(r.userId, r.nsToken), r);
      assert.strictEqual(await db.getByTokens(r.nsToken, 'other'), null);
      assert.strictEqual(await db.getByUserAndNamespace(cuid(), r.nsToken), null);
    });

    it('[XIDL2] must refuse a second account for the same id (value-taken)', async () => {
      const r = row();
      await db.insert(r);
      await assertConflict(db.insert(row({ nsToken: r.nsToken, valueToken: r.valueToken })), 'value-taken');
      assert.deepStrictEqual(await db.getByTokens(r.nsToken, r.valueToken), r);
    });

    it('[XIDL3] must refuse a second id for the same account and namespace (namespace-taken)', async () => {
      const r = row();
      await db.insert(r);
      await assertConflict(db.insert(row({ userId: r.userId, nsToken: r.nsToken })), 'namespace-taken');
    });

    it('[XIDL4] concurrent inserts of the same id: exactly one succeeds', async () => {
      const nsToken = 'ns-' + cuid();
      const valueToken = 'v-' + cuid();
      const results = await Promise.allSettled([
        db.insert(row({ nsToken, valueToken })),
        db.insert(row({ nsToken, valueToken }))
      ]);
      assert.strictEqual(results.filter((x) => x.status === 'fulfilled').length, 1);
      const rejected = results.find((x) => x.status === 'rejected');
      assert.ok(rejected.reason instanceof ExternalIdConflict);
      assert.strictEqual(rejected.reason.reason, 'value-taken');
    });

    it('[XIDL5] replaceForUser must change the value in place, and refuse a held value', async () => {
      const r = row();
      const other = row();
      await db.insert(r);
      await db.insert(other);
      await db.replaceForUser(r.userId, r.nsToken, { valueToken: 'v2', blindedValue: 'b2', claimedAt: 1760000100 });
      assert.deepStrictEqual(await db.getByUserAndNamespace(r.userId, r.nsToken),
        { ...r, valueToken: 'v2', blindedValue: 'b2', claimedAt: 1760000100 });
      assert.strictEqual(await db.getByTokens(r.nsToken, r.valueToken), null);
      // `other` holds (other.nsToken, other.valueToken): move r into that namespace's value.
      const r2 = row({ nsToken: other.nsToken });
      await db.insert(r2);
      await assertConflict(db.replaceForUser(r2.userId, other.nsToken,
        { valueToken: other.valueToken, blindedValue: 'x', claimedAt: 1 }), 'value-taken');
    });

    it('[XIDL6] deletes by user + namespace and by user report what they removed', async () => {
      const userId = cuid();
      const a = row({ userId });
      const b = row({ userId });
      const kept = row();
      await db.insert(a);
      await db.insert(b);
      await db.insert(kept);
      assert.strictEqual(await db.deleteByUserAndNamespace(userId, a.nsToken), true);
      assert.strictEqual(await db.deleteByUserAndNamespace(userId, a.nsToken), false);
      assert.strictEqual(await db.deleteByUser(userId), 1);
      assert.strictEqual(await db.deleteByUser(userId), 0);
      assert.deepStrictEqual(await db.scanAll(), [kept]);
    });

    it('[XIDL8] retoken changes both tokens in place, keeps the value and date, and refuses a held key', async () => {
      const r = row();
      const other = row();
      await db.insert(r);
      await db.insert(other);
      assert.strictEqual(await db.retoken(r.userId, r.nsToken, { nsToken: 'ns-new', valueToken: 'v-new' }), true);
      assert.deepStrictEqual(await db.getByUserAndNamespace(r.userId, 'ns-new'), { ...r, nsToken: 'ns-new', valueToken: 'v-new' });
      assert.strictEqual(await db.getByUserAndNamespace(r.userId, r.nsToken), null);
      assert.strictEqual(await db.retoken(r.userId, 'no-such-ns', { nsToken: 'x', valueToken: 'y' }), false);
      await assertConflict(db.retoken(r.userId, 'ns-new', { nsToken: other.nsToken, valueToken: other.valueToken }), 'value-taken');
    });

    it('[XIDL7] scanAll returns every row of the core', async () => {
      const rows = [row(), row(), row()];
      for (const r of rows) await db.insert(r);
      const all = await db.scanAll();
      const byKey = (x, y) => x.valueToken.localeCompare(y.valueToken);
      assert.deepStrictEqual(all.sort(byKey), rows.sort(byKey));
    });
  });
}
