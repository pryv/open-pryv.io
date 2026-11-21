/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ERLU] the erasure ledger's row logic over an in-memory key/value store:
 * replacement rules, other-key rows, merge, retention, paging.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as ledger from '../../src/erasureLedger/index.ts';
import { describeErasureLedgerConfig, erasureLedgerConfig } from '../../src/erasureLedger/config.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function memoryKv () {
  const map = new Map();
  return {
    map,
    async getPlatformKv (k) { return map.has(k) ? map.get(k) : null; },
    async setPlatformKv (k, v) { map.set(k, v); },
    async deletePlatformKv (k) { map.delete(k); },
    async listPlatformKvEntries (prefix) { return [...map].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); }
  };
}

function keyOf (seed) {
  return ledger.ledgerKey({ get: (k) => k === 'accountErasure:ledger:hmacKey' ? seed : undefined });
}

function facts (overrides = {}) {
  return { userId: 'u1', username: 'Alice', startedAt: 1000, deletedAt: 2000, trigger: 'holder', coreId: 'c1', stepsCompleted: ['deleteUser'], auditMode: 'erase', attempts: 1, serverVersion: 'test', ...overrides };
}

describe('[ERLU] erasure ledger rows', function () {
  const key = keyOf(randomBytes(32).toString('base64'));

  it('[ERLU1] the key: explicit base64 of 32 bytes, else derived from the admin key, else none', function () {
    assert.throws(() => keyOf('c2hvcnQ='), /not base64 of 32 bytes/);
    const derived = ledger.ledgerKey({ get: (k) => k === 'auth:adminAccessKey' ? 'an-admin-key' : undefined });
    assert.equal(derived.keyId.length, 8);
    assert.notEqual(derived.keyId, key.keyId);
    assert.throws(() => ledger.ledgerKey({ get: () => undefined }), /has no key/);
  });

  it('[ERLU2] the row names the account by hashes only; usernames match whatever their case', async function () {
    const kv = memoryKv();
    const entry = await ledger.writeErasureRecord(kv, key, facts());
    const raw = [...kv.map.values()][0];
    assert.ok(!raw.includes('u1') && !raw.toLowerCase().includes('alice'));
    assert.equal(entry.usernameHash, ledger.usernameHash(key, 'ALICE'));
    assert.deepEqual((await ledger.lookupErasureRecords(kv, key, { username: 'aLiCe' })).map((e) => e.userIdHash), [entry.userIdHash]);
  });

  it('[ERLU3] the same erasure written twice keeps the first row (the step ran again)', async function () {
    const kv = memoryKv();
    await ledger.writeErasureRecord(kv, key, facts());
    await ledger.writeErasureRecord(kv, key, facts({ deletedAt: 9000, attempts: 2 }));
    const row = await ledger.readErasureRecord(kv, key, 'u1');
    assert.equal(row.deletedAt, 2000);
    assert.equal(row.attempts, 1);
  });

  it('[ERLU4] a later erasure of an account no restore marked keeps the first date and trigger', async function () {
    const kv = memoryKv();
    await ledger.writeErasureRecord(kv, key, facts());
    await ledger.writeErasureRecord(kv, key, facts({ startedAt: 5000, deletedAt: 6000, trigger: 'ledger-replay' }));
    let row = await ledger.readErasureRecord(kv, key, 'u1');
    assert.equal(row.trigger, 'ledger-replay');
    assert.equal(row.firstDeletedAt, 2000);
    assert.equal(row.firstTrigger, 'holder');
    // replaced again: still the first one
    await ledger.writeErasureRecord(kv, key, facts({ startedAt: 7000, deletedAt: 8000, trigger: 'ledger-replay' }));
    row = await ledger.readErasureRecord(kv, key, 'u1');
    assert.equal(row.firstDeletedAt, 2000);
    assert.equal(row.firstTrigger, 'holder');
  });

  it('[ERLU5] after a restore marked it, a later erasure is a new record (no restoredAt, no first erasure)', async function () {
    const kv = memoryKv();
    await ledger.writeErasureRecord(kv, key, facts());
    assert.equal(await ledger.markRestored(kv, key, 'u1', 3000), true);
    assert.equal(ledger.erasedAfter(await ledger.readErasureRecord(kv, key, 'u1'), 0), false);
    await ledger.writeErasureRecord(kv, key, facts({ startedAt: 4000, deletedAt: 5000, trigger: 'date' }));
    const row = await ledger.readErasureRecord(kv, key, 'u1');
    assert.equal(row.restoredAt, undefined);
    assert.equal(row.firstDeletedAt, undefined);
    assert.equal(ledger.erasedAfter(row, 4500), true);
    assert.equal(ledger.erasedAfter(row, 6000), false);
    assert.equal(ledger.erasedAfter(row, null), true, 'a backup of unknown date: refused');
  });

  it('[ERLU6] a record written already restored (an unfinished erasure a restore overrode)', async function () {
    const kv = memoryKv();
    await ledger.writeErasureRecord(kv, key, facts({ restoredAt: 3000 }));
    const row = await ledger.readErasureRecord(kv, key, 'u1');
    assert.equal(row.restoredAt, 3000);
    assert.equal(ledger.erasedAfter(row, 0), false);
  });

  it('[ERLU7] rows of another key are counted, listed, never matched', async function () {
    const kv = memoryKv();
    const other = keyOf(randomBytes(32).toString('base64'));
    await ledger.writeErasureRecord(kv, other, facts());
    await ledger.writeErasureRecord(kv, key, facts({ userId: 'u2', username: 'bob' }));
    assert.equal(await ledger.otherKeyRecordCount(kv, key), 1);
    assert.equal(await ledger.readErasureRecord(kv, key, 'u1'), null);
    assert.equal((await ledger.allErasureRecords(kv)).length, 2);
    assert.match(ledger.otherKeyWarning(1), /1 record\(s\) written under another key/);
    assert.equal(ledger.otherKeyWarning(0), null);
  });

  it('[ERLU8] merge: absent written, newer kept, a later restoredAt added, nothing removed, malformed skipped', async function () {
    const kv = memoryKv();
    const a = await ledger.writeErasureRecord(memoryKv(), key, facts({ userId: 'a' }));
    const b = await ledger.writeErasureRecord(kv, key, facts({ userId: 'b', deletedAt: 9000 }));
    const live = await ledger.writeErasureRecord(kv, key, facts({ userId: 'live' }));
    const rowOf = (e, extra = {}) => ({ key: ledger.LEDGER_PREFIX + e.userIdHash, value: JSON.stringify({ ...e, userIdHash: undefined, ...extra }) });
    const counts = await ledger.mergeErasureLedgerRows(kv, [rowOf(a), rowOf(b, { deletedAt: 5000 }), { key: ledger.LEDGER_PREFIX + 'x', value: '{}' }]);
    assert.deepEqual(counts, { written: 1, kept: 1, skipped: 1 });
    assert.equal((await ledger.readErasureRecord(kv, key, 'b')).deletedAt, 9000);
    assert.ok(await ledger.readErasureRecord(kv, key, 'live') != null);
    await ledger.mergeErasureLedgerRows(kv, [rowOf(live, { restoredAt: 7000 })]);
    assert.equal((await ledger.readErasureRecord(kv, key, 'live')).restoredAt, 7000);
  });

  it('[ERLU9] retention removes the older rows only; 0 keeps all', async function () {
    const kv = memoryKv();
    const now = 100 * DAY_MS;
    await ledger.writeErasureRecord(kv, key, facts({ userId: 'old', deletedAt: now - 11 * DAY_MS }));
    await ledger.writeErasureRecord(kv, key, facts({ userId: 'new', deletedAt: now - 9 * DAY_MS }));
    assert.equal(await ledger.purgeExpiredErasureRecords(kv, 0, now), 0);
    assert.equal(await ledger.purgeExpiredErasureRecords(kv, 10, now), 1);
    assert.equal(await ledger.readErasureRecord(kv, key, 'old'), null);
    assert.ok(await ledger.readErasureRecord(kv, key, 'new') != null);
  });

  it('[ERLU10] listing: since, order by date then hash, cursor paging', async function () {
    const kv = memoryKv();
    for (let i = 0; i < 5; i++) await ledger.writeErasureRecord(kv, key, facts({ userId: 'p' + i, deletedAt: 1000 + (i % 3) * 10 }));
    const all = (await ledger.listErasureRecords(kv, { since: 0, limit: 1000 })).erasures;
    assert.equal(all.length, 5);
    const seen = [];
    let after = null;
    do {
      const page = await ledger.listErasureRecords(kv, { since: 1010, limit: 2, after });
      seen.push(...page.erasures);
      after = page.next != null ? ledger.parseCursor(page.next) : null;
    } while (after != null);
    assert.deepEqual(seen.map((e) => e.userIdHash), all.filter((e) => e.deletedAt >= 1010).map((e) => e.userIdHash));
    assert.equal(ledger.parseCursor('nope'), null);
  });

  it('[ERLU11] configuration: defaults, malformed values refused, short retention warned', function () {
    assert.deepEqual(erasureLedgerConfig({ get: () => undefined }), { enabled: true, retentionDays: 1825, hmacKey: null });
    assert.deepEqual(describeErasureLedgerConfig({ enabled: true, retentionDays: 1825, hmacKey: '' }), { problems: [], warnings: [] });
    const bad = describeErasureLedgerConfig({ enabled: 'yes', retentionDays: -1, hmacKey: 'c2hvcnQ=' });
    assert.deepEqual(bad.problems.map((p) => p.path.join('.')), ['accountErasure.ledger.enabled', 'accountErasure.ledger.retentionDays', 'accountErasure.ledger.hmacKey']);
    assert.equal(describeErasureLedgerConfig({ retentionDays: 30 }).warnings.length, 1);
  });
});
