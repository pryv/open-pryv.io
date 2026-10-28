/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * DeletionNoticesLocalDB conformance test suite.
 * @param {Function} getDB - async function returning an initialized DeletionNoticesLocalDB instance
 */
export default function conformanceTests (getDB) {
  const assert = require('node:assert');
  const cuid = require('cuid');

  function row (overrides = {}) {
    return {
      id: cuid(),
      deletedUserId: cuid(),
      accessId: cuid(),
      apiEndpoint: 'https://tok@peer.example.com/bob/',
      path: 'events',
      body: { streamIds: [':_cmc:inbox'], type: 'consent/revoke-cmc', content: { accessId: 'a1', revokedAt: 1760000000.5 } },
      attempts: 1,
      nextAttemptAfter: 1_000,
      status: 'pending',
      lastFailureReason: 'cmc-revoke-delivery-failed',
      lastFailureDetail: { status: 503 },
      createdAt: 500,
      ...overrides
    };
  }

  describe('[DNLD] DeletionNoticesLocalDB conformance', () => {
    let db;

    before(async () => {
      db = await getDB();
    });

    beforeEach(async () => {
      await db.deleteAll();
    });

    it('[DNLD1] a row reads back as written, JSON fields included', async () => {
      const r = row();
      await db.insert(r);
      assert.deepStrictEqual(await db.listAll(), [r]);
    });

    it('[DNLD2] listDue: pending rows due at now, oldest first, limited', async () => {
      const a = row({ createdAt: 300, nextAttemptAfter: 900 });
      const b = row({ createdAt: 100, nextAttemptAfter: 1_000 });
      const later = row({ createdAt: 50, nextAttemptAfter: 5_000 });
      const failed = row({ createdAt: 10, status: 'failed-permanent' });
      for (const r of [a, b, later, failed]) await db.insert(r);
      assert.deepStrictEqual((await db.listDue(1_000, 10)).map((r) => r.id), [b.id, a.id]);
      assert.deepStrictEqual((await db.listDue(1_000, 1)).map((r) => r.id), [b.id]);
      assert.strictEqual(await db.countPending(), 3);
    });

    it('[DNLD3] update writes the mutable fields; delete removes the row', async () => {
      const r = row();
      await db.insert(r);
      const updated = { ...r, apiEndpoint: 'https://peer.example.com/bob/', attempts: 3, nextAttemptAfter: 9_000, status: 'failed-permanent', lastFailureReason: 'cmc-retry-stale', lastFailureDetail: null };
      assert.strictEqual(await db.update(updated), true);
      assert.deepStrictEqual(await db.listAll(), [updated]);
      assert.strictEqual(await db.update(row()), false, 'no such row');
      assert.strictEqual(await db.delete(r.id), true);
      assert.strictEqual(await db.delete(r.id), false);
      assert.deepStrictEqual(await db.listAll(), []);
    });

    it('[DNLD4] pruneFailedBefore deletes only the failed rows created before the date', async () => {
      const oldFailed = row({ createdAt: 100, status: 'failed-permanent' });
      const newFailed = row({ createdAt: 2_000, status: 'failed-permanent' });
      const oldPending = row({ createdAt: 100 });
      for (const r of [oldFailed, newFailed, oldPending]) await db.insert(r);
      assert.strictEqual(await db.pruneFailedBefore(1_000), 1);
      assert.deepStrictEqual((await db.listAll()).map((r) => r.id).sort(), [newFailed.id, oldPending.id].sort());
    });
  });
}
