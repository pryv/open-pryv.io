/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { purgeAccessDeletionRecords, readRetentionDays } = require('../../src/accesses/deletionRecordsPurge.ts');

const DAY = 24 * 3600;
const NOW = 1_000_000_000;

/** In-memory accesses repository: rows per user id, the two queries the purge sends. */
function fakeRepo (rowsByUser, calls = []) {
  return {
    findIncludingDeletionsAndVersions (user, query, options, cb) {
      calls.push(['find', user.id]);
      const rows = (rowsByUser[user.id] || []).filter((r) => r.headId == null && r.deleted != null && r.deleted < query.deleted.$lt);
      cb(null, rows);
    },
    removeMany (user, query, cb) {
      const rows = rowsByUser[user.id] || [];
      let keep;
      if (query.headId) keep = rows.filter((r) => !query.headId.$in.includes(r.headId));
      else keep = rows.filter((r) => !(query.id.$in.includes(r.id) && r.deleted != null && r.deleted < query.deleted.$lt));
      calls.push(['remove', user.id, query.headId ? 'versions' : 'records', rows.length - keep.length]);
      rowsByUser[user.id] = keep;
      cb(null, rows.length - keep.length);
    }
  };
}

describe('[ADRP] access deletion records purge', function () {
  it('[ADR1] removes records past the retention with their versions; keeps recent and live rows', async function () {
    const rows = {
      u1: [
        { id: 'old', deleted: NOW - 40 * DAY },
        { id: 'v1', headId: 'old', deleted: null },
        { id: 'recent', deleted: NOW - 5 * DAY },
        { id: 'live', deleted: null }
      ],
      u2: [{ id: 'live2', deleted: null }]
    };
    const indexed = [];
    const r = await purgeAccessDeletionRecords({
      accesses: fakeRepo(rows),
      listUsers: async () => [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b' }],
      deleteIndexRow: async (id) => { indexed.push(id); },
      retentionDays: 30,
      now: () => NOW
    });
    assert.deepEqual(r, { users: 1, records: 1, versions: 1, failed: 0 });
    assert.deepEqual(rows.u1.map((x) => x.id), ['recent', 'live']);
    assert.deepEqual(indexed, ['old']);
  });

  it('[ADR2] an index row that cannot be removed keeps its access for the next pass', async function () {
    const rows = { u1: [{ id: 'a', deleted: NOW - 40 * DAY }, { id: 'b', deleted: NOW - 40 * DAY }] };
    const warnings = [];
    const r = await purgeAccessDeletionRecords({
      accesses: fakeRepo(rows),
      listUsers: async () => [{ id: 'u1', username: 'a' }],
      deleteIndexRow: async (id) => { if (id === 'a') throw new Error('down'); },
      retentionDays: 30,
      now: () => NOW,
      logger: { warn: (m) => warnings.push(m) }
    });
    assert.equal(r.records, 1);
    assert.equal(r.failed, 1);
    assert.deepEqual(rows.u1.map((x) => x.id), ['a']);
    assert.equal(warnings.length, 1);
  });

  it('[ADR3] a failing account does not stop the others', async function () {
    const rows = { u2: [{ id: 'x', deleted: NOW - 40 * DAY }] };
    const repo = fakeRepo(rows);
    const find = repo.findIncludingDeletionsAndVersions;
    repo.findIncludingDeletionsAndVersions = (user, q, o, cb) => (user.id === 'u1' ? cb(new Error('db')) : find(user, q, o, cb));
    const r = await purgeAccessDeletionRecords({
      accesses: repo,
      listUsers: async () => [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b' }],
      retentionDays: 30,
      now: () => NOW,
      logger: { warn: () => {} }
    });
    assert.equal(r.records, 1);
    assert.deepEqual(rows.u2, []);
  });

  it('[ADR4] removes in chunks of at most 200 ids', async function () {
    const many = [];
    for (let i = 0; i < 450; i++) many.push({ id: 'd' + i, deleted: NOW - 40 * DAY });
    const calls = [];
    const r = await purgeAccessDeletionRecords({
      accesses: fakeRepo({ u1: many }, calls),
      listUsers: async () => [{ id: 'u1', username: 'a' }],
      retentionDays: 30,
      now: () => NOW
    });
    assert.equal(r.records, 450);
    assert.deepEqual(calls.filter((c) => c[2] === 'records').map((c) => c[3]), [200, 200, 50]);
  });

  it('[ADR5] retention 0 or absent is off; a bad value refuses the boot', function () {
    const cfg = (v) => ({ get: () => v });
    assert.equal(readRetentionDays(cfg(undefined)), null);
    assert.equal(readRetentionDays(cfg(0)), null);
    assert.equal(readRetentionDays(cfg(365)), 365);
    for (const bad of [-1, '30', NaN, Infinity]) {
      assert.throws(() => readRetentionDays(cfg(bad)), (err) => err.bootFatal === true, String(bad));
    }
    return assert.rejects(purgeAccessDeletionRecords({ accesses: fakeRepo({}), listUsers: async () => [], retentionDays: 0 }));
  });
});
