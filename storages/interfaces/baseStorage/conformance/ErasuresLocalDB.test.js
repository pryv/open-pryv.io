/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * ErasuresLocalDB conformance test suite.
 * @param {Function} getDB - async function returning an initialized ErasuresLocalDB instance
 */
export default function conformanceTests (getDB) {
  const assert = require('node:assert');
  const cuid = require('cuid');

  function row (overrides = {}) {
    return {
      userId: cuid(),
      username: 'erld' + cuid().slice(-8),
      trigger: 'inactivity',
      startedAt: 1_000,
      updatedAt: 1_500,
      doneSteps: ['runTeardownSteps', 'deleteUserFiles'],
      seriesNamespaces: ['user.a', 'user.b'],
      attempts: 1,
      lastError: null,
      ...overrides
    };
  }

  describe('[ERLD] ErasuresLocalDB conformance', () => {
    let db;

    before(async () => {
      db = await getDB();
    });

    beforeEach(async () => {
      await db.deleteAll();
    });

    it('[ERLD1] a row reads back as written, lists and null fields included', async () => {
      const a = row();
      const b = row({ trigger: null, seriesNamespaces: null, doneSteps: [], lastError: 'boom', startedAt: 500 });
      await db.put(a);
      await db.put(b);
      assert.deepStrictEqual(await db.get(a.userId), a);
      assert.deepStrictEqual(await db.get(b.userId), b);
      assert.deepStrictEqual(await db.listAll(), [b, a], 'oldest first');
      assert.strictEqual(await db.get(cuid()), null);
    });

    it('[ERLD2] put replaces the row of the same account', async () => {
      const a = row();
      await db.put(a);
      const next = { ...a, doneSteps: [...a.doneSteps, 'deleteHFData'], attempts: 2, updatedAt: 2_000, lastError: 'x' };
      await db.put(next);
      assert.deepStrictEqual(await db.listAll(), [next]);
    });

    it('[ERLD4] insertIfAbsent inserts once; the second insert of the account changes nothing', async () => {
      const a = row();
      assert.strictEqual(await db.insertIfAbsent(a), true);
      assert.strictEqual(await db.insertIfAbsent({ ...a, username: 'other', attempts: 9 }), false);
      assert.deepStrictEqual(await db.listAll(), [a]);
    });

    it('[ERLD5] claim is a compare-and-set of updatedAt: one of two claimers on the same value wins', async () => {
      const a = row({ updatedAt: 1_500 });
      await db.put(a);
      const [first, second] = await Promise.all([db.claim(a.userId, 1_500, 2_000), db.claim(a.userId, 1_500, 2_001)]);
      assert.deepStrictEqual([first, second].filter(Boolean).length, 1);
      assert.ok([2_000, 2_001].includes((await db.get(a.userId)).updatedAt));
      assert.strictEqual(await db.claim(a.userId, 1_500, 3_000), false, 'stale expectation');
      assert.strictEqual(await db.claim(cuid(), 0, 1), false, 'no row');
    });

    it('[ERLD3] delete removes one row and says whether it was there', async () => {
      const a = row();
      const b = row();
      await db.put(a);
      await db.put(b);
      assert.strictEqual(await db.delete(a.userId), true);
      assert.strictEqual(await db.delete(a.userId), false);
      assert.deepStrictEqual((await db.listAll()).map((r) => r.userId), [b.userId]);
    });
  });
}
