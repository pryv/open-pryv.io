/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const crypto = require('node:crypto');
const idx = require('platform/src/externalIdIndex.ts');

function fakeDb (hashed) {
  const store = new Map();
  return {
    store,
    coreId: 'core-a',
    hashFor: hashed
      ? (field, value) => crypto.createHmac('sha256', 'pepper').update(field + '\0' + value).digest('hex')
      : (field, value) => value,
    async getPlatformKv (key) { return store.get(key) ?? null; },
    async setPlatformKv (key, value) { store.set(key, value); },
    async deletePlatformKv (key) { store.delete(key); },
    async listPlatformKvEntries (prefix) {
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
    async claimCoreRow (prefix, key, value) {
      // Yield first, so concurrent callers interleave like on a real engine.
      await new Promise((resolve) => setImmediate(resolve));
      if (!store.has(prefix + key)) store.set(prefix + key, value);
      return store.get(prefix + key) === value;
    },
    async getCoreRow (prefix, key) { return store.get(prefix + key) ?? null; },
    async deleteCoreRowIfValue (prefix, key, value) {
      if (store.get(prefix + key) !== value) return false;
      store.delete(prefix + key);
      return true;
    },
    async getAllCoreRows (prefix) {
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k.slice(prefix.length), coreId: v }));
    }
  };
}

describe('[XIDN] external-id index (platform layer)', () => {
  it('[XIDN1] namespace names follow the rule; label and mode are checked', async () => {
    const db = fakeDb(true);
    assert.ok(idx.isValidNamespaceName('ehr-prod-1'));
    for (const bad of ['a', '-ehr', 'Ehr', 'ehr_1', 'x'.repeat(64), '', null]) assert.ok(!idx.isValidNamespaceName(bad), String(bad));
    await assert.rejects(idx.setNamespace(db, 'Bad', {}, 1), (e) => e.id === 'invalid-parameters-format');
    await assert.rejects(idx.setNamespace(db, 'ok-ns', { label: '' }, 1), (e) => e.data.param === 'label');
    await assert.rejects(idx.setNamespace(db, 'ok-ns', { defaultMode: 'loose' }, 1), (e) => e.data.param === 'defaultMode');
  });

  it('[XIDN2] create once with a salt that never changes; concurrent creates keep one salt', async () => {
    const db = fakeDb(true);
    const results = await Promise.all([idx.setNamespace(db, 'ns-a', {}, 1), idx.setNamespace(db, 'ns-a', { label: 'L' }, 2)]);
    assert.strictEqual(results.filter((r) => r.created).length, 1, 'exactly one create');
    const row = await idx.getNamespace(db, 'ns-a');
    assert.strictEqual(Buffer.from(row.salt, 'base64url').length, 32);
    assert.match(row.salt, /^[A-Za-z0-9_-]+$/, 'base64url: no "/" in a cleartext key');
    await idx.setNamespace(db, 'ns-a', { label: 'Renamed', defaultMode: 'forced' }, 3);
    const after = await idx.getNamespace(db, 'ns-a');
    assert.strictEqual(after.salt, row.salt);
    assert.strictEqual(after.label, 'Renamed');
    assert.strictEqual(after.defaultMode, 'forced');
    assert.ok(!JSON.stringify(await idx.listNamespaces(db)).includes(row.salt), 'listing never shows the salt');
  });

  it('[XIDN3] delete is refused while ids are claimed, unless forced', async () => {
    const db = fakeDb(false);
    await idx.setNamespace(db, 'ns-b', {}, 1);
    const row = await idx.getNamespace(db, 'ns-b');
    const tokens = idx.tokensFor(db, row, crypto.randomBytes(32).toString('base64url'));
    assert.ok(await idx.claimRow(db, tokens));
    await assert.rejects(idx.deleteNamespace(db, 'ns-b'), (e) => e.id === 'external-id-namespace-in-use');
    assert.strictEqual(await idx.deleteNamespace(db, 'ns-b', { force: true }), true);
    assert.strictEqual(await idx.deleteNamespace(db, 'ns-b', { force: true }), false);
  });

  it('[XIDN4] cleartext mode: tokens are the salt and the value; hashed mode: neither appears in the key', async () => {
    const v = crypto.randomBytes(32).toString('base64url');
    const clear = fakeDb(false);
    await idx.setNamespace(clear, 'ns-c', {}, 1);
    const clearRow = await idx.getNamespace(clear, 'ns-c');
    assert.deepStrictEqual(idx.tokensFor(clear, clearRow, v), { nsToken: clearRow.salt, valueToken: v });
    const hashed = fakeDb(true);
    await idx.setNamespace(hashed, 'ns-c', {}, 1);
    const hashedRow = await idx.getNamespace(hashed, 'ns-c');
    const t = idx.tokensFor(hashed, hashedRow, v);
    assert.ok(!t.nsToken.includes(hashedRow.salt) && !t.valueToken.includes(v));
  });

  it('[XIDN5] restore of namespace rows: absent written, same salt kept, other salt kept and reported', async () => {
    const source = fakeDb(true);
    await idx.setNamespace(source, 'ns-same', {}, 1);
    await idx.setNamespace(source, 'ns-other', {}, 1);
    await idx.setNamespace(source, 'ns-new', {}, 1);
    const entries = await idx.exportNamespaceRows(source);
    assert.strictEqual(entries.length, 3);
    assert.ok(entries.every((e) => idx.isNamespaceRowEntry(e)));

    const target = fakeDb(true);
    await target.setPlatformKv('ext-id-ns/ns-same', source.store.get('ext-id-ns/ns-same'));
    await idx.setNamespace(target, 'ns-other', {}, 5);
    const liveOther = target.store.get('ext-id-ns/ns-other');
    const malformed = [{ key: 'ext-id-ns/ns-bad', value: JSON.stringify({ createdAt: 1, salt: 'short', label: 'x', defaultMode: 'hint' }) },
      { key: 'ext-id-ns/ns-bad2', value: 'not json' }];
    const result = await idx.importNamespaceRows(target, [...entries, ...malformed]);
    assert.deepStrictEqual(result, { imported: 1, kept: 1, skipped: 2, saltMismatch: ['ns-other'] });
    assert.ok(!target.store.has('ext-id-ns/ns-bad'), 'a malformed row is not installed');
    assert.strictEqual(target.store.get('ext-id-ns/ns-other'), liveOther, 'never overwritten');
    assert.strictEqual(target.store.get('ext-id-ns/ns-new'), source.store.get('ext-id-ns/ns-new'));
  });
});
