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
const { ExternalIdsService } = require('business/src/external-ids/service.ts');
const { setNamespace } = require('platform/src/externalIdIndex.ts');
const { ExternalIdConflict } = require('storages/interfaces/baseStorage/ExternalIdsLocalDB.ts');

// One shared platform store (the replicated rows), seen by several cores.
function fakePlatformStore () {
  return new Map();
}

function fakePlatform (store, coreId) {
  return {
    coreId,
    hashFor: (field, value) => crypto.createHash('sha256').update(field + '\0' + value).digest('hex'),
    coreIdToUrl: (id) => 'https://' + id + '.example.test/',
    async getPlatformKv (key) { return store.get(key) ?? null; },
    async setPlatformKv (key, value) { store.set(key, value); },
    async deletePlatformKv (key) { store.delete(key); },
    async listPlatformKvEntries (prefix) {
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
    async claimCoreRow (prefix, key, value) {
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

// A core's local table, with the engine's two unique constraints.
function fakeLocalDB () {
  const rows = [];
  const db = {
    rows,
    failNextInsert: null,
    async init () {},
    async insert (row) {
      if (db.failNextInsert != null) { const e = db.failNextInsert; db.failNextInsert = null; throw e; }
      if (rows.some((r) => r.nsToken === row.nsToken && r.valueToken === row.valueToken)) throw new ExternalIdConflict('value-taken');
      if (rows.some((r) => r.userId === row.userId && r.nsToken === row.nsToken)) throw new ExternalIdConflict('namespace-taken');
      rows.push({ ...row });
    },
    // Copies, as the engines return fresh objects.
    async getByUser (userId) { return rows.filter((r) => r.userId === userId).map((r) => ({ ...r })); },
    async getByTokens (ns, v) { const r = rows.find((x) => x.nsToken === ns && x.valueToken === v); return r ? { ...r } : null; },
    async getByUserAndNamespace (u, ns) { const r = rows.find((x) => x.userId === u && x.nsToken === ns); return r ? { ...r } : null; },
    async replaceForUser (u, ns, values) {
      if (rows.some((r) => r.nsToken === ns && r.valueToken === values.valueToken)) throw new ExternalIdConflict('value-taken');
      const r = rows.find((x) => x.userId === u && x.nsToken === ns);
      Object.assign(r, values);
    },
    async deleteByUserAndNamespace (u, ns) {
      const i = rows.findIndex((r) => r.userId === u && r.nsToken === ns);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    async deleteByUser (u) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === u) rows.splice(i, 1);
      return before - rows.length;
    },
    async scanAll () { return rows.slice(); },
    async deleteAll () { rows.length = 0; }
  };
  return db;
}

function value () {
  return crypto.randomBytes(32).toString('base64url');
}

function extIdRows (store) {
  return [...store.entries()].filter(([k]) => k.startsWith('ext-id/'));
}

async function assertApiError (promise, id, check) {
  await assert.rejects(promise, (err) => {
    assert.strictEqual(err.id, id, 'error id, got ' + err.id + ': ' + err.message);
    if (check) check(err);
    return true;
  });
}

describe('[XIDS] external ids service', () => {
  let store, coreA, coreB, ns;

  beforeEach(async () => {
    store = fakePlatformStore();
    const platA = fakePlatform(store, 'core-a');
    coreA = new ExternalIdsService(platA, fakeLocalDB(), () => 1000);
    coreB = new ExternalIdsService(fakePlatform(store, 'core-b'), fakeLocalDB(), () => 2000);
    ns = 'ehr-practice-1';
    await setNamespace(platA, ns, { label: 'Practice 1 EHR' }, 1);
  });

  it('[XIDS1] claim, then list (namespace and date only), holds, and an idempotent second claim', async () => {
    const v = value();
    assert.deepStrictEqual(await coreA.claim('u1', ns, v), { externalId: { namespace: ns, claimedAt: 1000 }, created: true });
    assert.deepStrictEqual(await coreA.list('u1'), [{ namespace: ns, claimedAt: 1000 }]);
    assert.strictEqual(await coreA.holds('u1', ns, v), true);
    assert.strictEqual(await coreA.holds('u2', ns, v), false);
    assert.deepStrictEqual(await coreA.claim('u1', ns, v), { externalId: { namespace: ns, claimedAt: 1000 }, created: false });
    assert.strictEqual(coreA.db.rows.length, 1);
    assert.strictEqual(JSON.stringify(await coreA.list('u1')).includes(v), false, 'list never returns the value');
  });

  it('[XIDS2] two accounts of the SAME core: the second gets 409 value-taken, the platform row stays', async () => {
    const v = value();
    await coreA.claim('u1', ns, v);
    await assertApiError(coreA.claim('u2', ns, v), 'external-id-already-claimed', (err) => {
      assert.deepStrictEqual(err.data, { namespace: ns, reason: 'value-taken' });
      assert.strictEqual(err.message.includes(v), false);
    });
    assert.strictEqual(coreA.db.rows.length, 1);
    assert.strictEqual(extIdRows(store).length, 1);
    assert.strictEqual(extIdRows(store)[0][1], 'core-a');
  });

  it('[XIDS3] two cores: the second core gets 409 and keeps no local row', async () => {
    const v = value();
    await coreA.claim('u1', ns, v);
    await assertApiError(coreB.claim('u9', ns, v), 'external-id-already-claimed');
    assert.strictEqual(coreB.db.rows.length, 0);
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v), 'https://core-a.example.test/');
  });

  it('[XIDS4] a second id in the same namespace is refused (namespace-taken); replace swaps it', async () => {
    const v1 = value();
    const v2 = value();
    await coreA.claim('u1', ns, v1);
    await assertApiError(coreA.claim('u1', ns, v2), 'external-id-already-claimed',
      (err) => assert.strictEqual(err.data.reason, 'namespace-taken'));
    await coreA.replace('u1', ns, v2);
    assert.strictEqual(await coreA.holds('u1', ns, v2), true);
    assert.strictEqual(await coreA.holds('u1', ns, v1), false);
    assert.strictEqual(extIdRows(store).length, 1, 'the old platform row is released');
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v1), null);
    // v1 is free again, for another account on another core.
    await coreB.claim('u9', ns, v1);
  });

  it('[XIDS5] replace with a value held elsewhere is refused and keeps the old id', async () => {
    const v1 = value();
    const vHeld = value();
    await coreA.claim('u1', ns, v1);
    await coreB.claim('u9', ns, vHeld);
    await assertApiError(coreA.replace('u1', ns, vHeld), 'external-id-already-claimed');
    assert.strictEqual(await coreA.holds('u1', ns, v1), true);
    assert.strictEqual(extIdRows(store).length, 2);
  });

  it('[XIDS6] a failed local insert releases the platform row just claimed (compensation)', async () => {
    const v = value();
    coreA.db.failNextInsert = new Error('disk full');
    await assert.rejects(coreA.claim('u1', ns, v), /disk full/);
    assert.strictEqual(extIdRows(store).length, 0, 'no platform row left without a local owner');
    await coreB.claim('u9', ns, v);
  });

  it('[XIDS7] release is idempotent and frees the id; releaseAllForUser frees every id', async () => {
    const ns2 = 'ehr-practice-2';
    await setNamespace(coreA.platform, ns2, {}, 1);
    const v = value();
    await coreA.claim('u1', ns, v);
    await coreA.claim('u1', ns2, value());
    await coreA.release('u1', ns);
    await coreA.release('u1', ns);
    assert.deepStrictEqual((await coreA.list('u1')).map((x) => x.namespace), [ns2]);
    await coreB.claim('u9', ns, v);
    assert.strictEqual(await coreA.releaseAllForUser('u1'), 1);
    assert.strictEqual(coreA.db.rows.length, 0);
    assert.strictEqual(extIdRows(store).length, 1, 'only u9 on core-b remains');
  });

  it('[XIDS8] unknown namespace and malformed values are refused without echoing the value', async () => {
    await assertApiError(coreA.claim('u1', 'unknown-ns', value()), 'invalid-parameters-format',
      (err) => assert.strictEqual(err.data.param, 'namespace'));
    const bad = 'short';
    await assertApiError(coreA.claim('u1', ns, bad), 'invalid-parameters-format', (err) => {
      assert.strictEqual(err.data.param, 'blindedValue');
      assert.strictEqual(err.message.includes(bad), false);
    });
    await assertApiError(coreA.claim('u1', ns, 'a'.repeat(200)), 'invalid-parameters-format');
    await assertApiError(coreA.claim('u1', ns, value() + '='), 'invalid-parameters-format');
    assert.strictEqual(await coreA.lookupCoreUrl('unknown-ns', value()), null);
    assert.strictEqual(await coreA.lookupCoreUrl(ns, value()), null);
  });
});
