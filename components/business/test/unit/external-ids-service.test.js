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

// The derivation is switchable (`platform.pepper`): null = cleartext mode.
function hmacWith (pepper) {
  return (field, value) => crypto.createHmac('sha256', pepper).update(field + '\0' + value).digest('hex');
}

function fakePlatform (store, coreId, pepper = 'pepper-1') {
  return {
    coreId,
    pepper,
    hashFor (field, value) { return this.pepper == null ? value : hmacWith(this.pepper)(field, value); },
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
    // Runs once just before the next replaceForUser (a concurrent request).
    beforeReplace: null,
    async replaceForUser (u, ns, values) {
      if (db.beforeReplace != null) { const hook = db.beforeReplace; db.beforeReplace = null; await hook(); }
      if (rows.some((r) => r.nsToken === ns && r.valueToken === values.valueToken)) throw new ExternalIdConflict('value-taken');
      const r = rows.find((x) => x.userId === u && x.nsToken === ns);
      if (r == null) return false;
      Object.assign(r, values);
      return true;
    },
    async retoken (u, oldNs, tokens) {
      const r = rows.find((x) => x.userId === u && x.nsToken === oldNs);
      if (r == null) return false;
      if (rows.some((x) => x !== r && x.nsToken === tokens.nsToken && x.valueToken === tokens.valueToken)) throw new ExternalIdConflict('value-taken');
      Object.assign(r, tokens);
      return true;
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
    async scanAll () { return rows.map((r) => ({ ...r })); },
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

  // Mutation checks, to repeat after touching the code under test (each must make
  // its test fail): XIDS2, drop the value-taken check of the fake local table
  // (the engines carry it as the primary key, proven by [XIDL2] / [XIDL4] on both
  // engines and by the API-level concurrent pair [XIDC4]); XIDS6, remove the
  // `#releaseIfUnowned` call in `claim`; XIDS11, remove the insert fallback in
  // `replace`; XIDS12, remove the re-claim in `#releaseIfUnowned`.
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

  it('[XIDS9] reconcile heals each drift state and never touches another core\'s rows', async () => {
    const { tokensFor, getNamespace } = require('platform/src/externalIdIndex.ts');
    const nsRow = await getNamespace(coreA.platform, ns);
    const keyOf = (v) => { const t = tokensFor(coreA.platform, nsRow, v); return 'ext-id/' + t.nsToken + '/' + t.valueToken; };
    // kept: claimed normally on core A
    const vKept = value();
    await coreA.claim('u1', ns, vKept);
    // stale self-row: platform row for core A, no local owner
    const vStale = value();
    store.set(keyOf(vStale), 'core-a');
    // missing self-row: local row on core A, no platform row
    const vMissing = value();
    await coreA.claim('u2', ns, vMissing);
    store.delete(keyOf(vMissing));
    // lost: local row on core A, platform row held by core B
    const vLost = value();
    await coreA.claim('u3', ns, vLost);
    store.set(keyOf(vLost), 'core-b');
    // orphan user: local row of an account that no longer exists
    const vOrphan = value();
    await coreA.claim('gone', ns, vOrphan);
    // another core's row with no local owner here: never touched
    const vOther = value();
    await coreB.claim('u9', ns, vOther);
    const userExists = async (id) => id !== 'gone';

    const dry = await coreA.reconcile({ dryRun: true, userExists });
    assert.deepStrictEqual(dry, { localRows: 4, refreshed: 0, corruptTokens: 0, staleDeleted: 1, orphanUsersReleased: 1, missingHealed: 1, lostToOtherCore: 1, namespaceMissing: 0 });
    assert.ok(store.has(keyOf(vStale)), 'dry run writes nothing');
    assert.strictEqual(coreA.db.rows.length, 4);

    const applied = await coreA.reconcile({ dryRun: false, userExists });
    assert.deepStrictEqual(applied, dry);
    assert.ok(!store.has(keyOf(vStale)), 'stale self-row deleted');
    assert.strictEqual(store.get(keyOf(vMissing)), 'core-a', 'missing self-row re-claimed');
    assert.strictEqual(store.get(keyOf(vLost)), 'core-b', 'the other core keeps its id');
    assert.strictEqual(await coreA.holds('u3', ns, vLost), false, 'the lost local row is dropped');
    assert.ok(!store.has(keyOf(vOrphan)), 'orphan account released');
    assert.strictEqual(store.get(keyOf(vOther)), 'core-b', 'another core\'s row untouched');
    assert.strictEqual(await coreA.holds('u1', ns, vKept), true);
    const again = await coreA.reconcile({ dryRun: false, userExists });
    assert.deepStrictEqual(again, { localRows: 2, refreshed: 0, corruptTokens: 0, staleDeleted: 0, orphanUsersReleased: 0, missingHealed: 0, lostToOtherCore: 0, namespaceMissing: 0 }, 'idempotent');
  });

  it('[XIDS11] replace after the row vanished (concurrent release) ends as a plain claim, not a lost id', async () => {
    const v1 = value();
    const v2 = value();
    await coreA.claim('u1', ns, v1);
    coreA.db.beforeReplace = () => coreA.release('u1', ns);
    const res = await coreA.replace('u1', ns, v2);
    assert.strictEqual(res.externalId.namespace, ns);
    assert.strictEqual(await coreA.holds('u1', ns, v2), true, 'the account holds what the answer says');
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v2), 'https://core-a.example.test/');
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v1), null);
    assert.deepStrictEqual((await coreA.list('u1')).map((x) => x.namespace), [ns]);
  });

  it('[XIDS12] a compensation that races another account\'s insert claims the row back', async () => {
    const v = value();
    const { tokensFor, getNamespace } = require('platform/src/externalIdIndex.ts');
    const t = tokensFor(coreA.platform, await getNamespace(coreA.platform, ns), v);
    // u2's insert fails; right when its compensation deletes the platform row,
    // u1's insert of the same id commits on this core.
    coreA.db.failNextInsert = new Error('disk hiccup');
    const realDelete = coreA.platform.deleteCoreRowIfValue;
    coreA.platform.deleteCoreRowIfValue = async (...args) => {
      coreA.platform.deleteCoreRowIfValue = realDelete;
      const deleted = await realDelete.apply(coreA.platform, args);
      coreA.db.rows.push({ userId: 'u1', ...t, blindedValue: v, claimedAt: 1 });
      return deleted;
    };
    await assert.rejects(coreA.claim('u2', ns, v), /disk hiccup/);
    assert.strictEqual(store.get('ext-id/' + t.nsToken + '/' + t.valueToken), 'core-a', 'the platform row is claimed back for u1');
    assert.strictEqual(await coreA.holds('u1', ns, v), true);
  });

  it('[XIDS13] the reconcile refuses to delete this core\'s rows when its local table is empty', async () => {
    await coreA.claim('u1', ns, value());
    await coreA.claim('u2', ns, value());
    coreA.db.rows.length = 0;
    const refused = await coreA.reconcile({ dryRun: false, userExists: async () => true });
    assert.strictEqual(refused.refusedEmptyLocal, true);
    assert.strictEqual(extIdRows(store).length, 2, 'nothing deleted');
    const dry = await coreA.reconcile({ dryRun: true, userExists: async () => true });
    assert.strictEqual(dry.staleDeleted, 2, 'a dry run still reports');
    const forced = await coreA.reconcile({ dryRun: false, userExists: async () => true, forceEmptyLocal: true });
    assert.strictEqual(forced.staleDeleted, 2);
    assert.strictEqual(extIdRows(store).length, 0);
  });

  it('[XIDS14] a refresh conflict on one row is counted and the refresh goes on', async () => {
    const { getNamespace } = require('platform/src/externalIdIndex.ts');
    const v = value();
    const vOther = value();
    await coreA.claim('u1', ns, v);
    await coreA.claim('u3', ns, vOther);
    const salt = (await getNamespace(coreA.platform, ns)).salt;
    // A second, corrupt local row for the same id in its cleartext form.
    coreA.db.rows.push({ userId: 'u2', nsToken: salt, valueToken: v, blindedValue: v, claimedAt: 1 });
    coreA.platform.pepper = 'pepper-2';
    coreB.platform.pepper = 'pepper-2';
    const s = await coreA.reconcile({ dryRun: false, userExists: async () => true, oldHasher: { hashFor: hmacWith('pepper-1') } });
    assert.strictEqual(s.corruptTokens, 1);
    assert.strictEqual(await coreA.holds('u3', ns, vOther), true, 'rows after the conflict are still refreshed');
  });

  it('[XIDS15] registration: reserve, then link or give back; a held id stays with its holder', async () => {
    const v = value();
    const field = await coreA.parseFlowField({ namespace: ns, blindedValue: v });
    assert.strictEqual(field.mode, 'hint');
    // reserved then the account could not be written: given back
    const failed = await coreA.reserveAtRegistration(field);
    assert.strictEqual(failed.platformClaimed, true);
    await coreA.releaseRegistrationClaim(failed);
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v), null);
    // reserved then written: linked
    const ok = await coreA.reserveAtRegistration(field);
    assert.strictEqual(await coreA.linkAtRegistration('u1', ok), true);
    assert.strictEqual(await coreA.holds('u1', ns, v), true);
    // a second registration of the same id on this core: reserve says ours,
    // the link loses to u1's local row, and u1 keeps the platform row
    const again = await coreA.reserveAtRegistration(await coreA.parseFlowField({ namespace: ns, blindedValue: v }));
    assert.strictEqual(await coreA.linkAtRegistration('u2', again), false);
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v), 'https://core-a.example.test/');
    // on another core: not reserved, not linked
    const elsewhere = await coreB.reserveAtRegistration(await coreB.parseFlowField({ namespace: ns, blindedValue: v }));
    assert.strictEqual(elsewhere.platformClaimed, false);
    assert.strictEqual(await coreB.linkAtRegistration('u9', elsewhere), false);
    await coreB.releaseRegistrationClaim(elsewhere);
    assert.strictEqual(await coreB.lookupCoreUrl(ns, v), 'https://core-a.example.test/', 'giving back a claim never taken releases nothing');
  });

  it('[XIDS16] the flow field: forced refused for now, malformed refused without the value', async () => {
    await assertApiError(coreA.parseFlowField({ namespace: ns, blindedValue: value(), mode: 'forced' }), 'invalid-parameters-format',
      (err) => assert.strictEqual(err.data.reason, 'forced-mode-not-available'));
    await assertApiError(coreA.parseFlowField({ namespace: ns, blindedValue: value(), mode: 'other' }), 'invalid-parameters-format');
    await assertApiError(coreA.parseFlowField(null), 'invalid-parameters-format');
    await assertApiError(coreA.parseFlowField({ namespace: ns, blindedValue: 'abc' }), 'invalid-parameters-format',
      (err) => assert.strictEqual(err.data.param, 'externalId.blindedValue'));
  });

  // Mutation: drop the platform-row condition of `holds` and the stale-row
  // half fails; drop the local read of `isClaimed` and the last half fails.
  it('[XIDS17] holds needs both rows; isClaimed sees a platform row or a local row', async () => {
    const v = value();
    await coreA.claim('u1', ns, v);
    assert.strictEqual(await coreA.holds('u1', ns, v), true);
    const field = await coreB.parseFlowField({ namespace: ns, blindedValue: v });
    assert.strictEqual(await coreB.isClaimed(field), true, 'held on another core');
    // a local row left behind while the platform row now names another core
    const [[key]] = extIdRows(store);
    store.set(key, 'core-b');
    assert.strictEqual(await coreA.holds('u1', ns, v), false, 'a stale local row never passes');
    // a local row with no platform row (a half-done claim) is still claimed
    store.delete(key);
    assert.strictEqual(await coreA.isClaimed(await coreA.parseFlowField({ namespace: ns, blindedValue: v })), true);
    assert.strictEqual(await coreA.isClaimed(await coreA.parseFlowField({ namespace: ns, blindedValue: value() })), false);
  });

  describe('[XIDR] token refresh', () => {
    const userExists = async () => true;

    async function claimMany (service, count) {
      const values = [];
      for (let i = 0; i < count; i++) {
        const v = value();
        await service.claim('u' + i, ns, v);
        values.push(v);
      }
      return values;
    }

    async function assertAllResolve (service, values) {
      for (let i = 0; i < values.length; i++) {
        assert.strictEqual(await service.holds('u' + i, ns, values[i]), true, 'holds ' + i);
        assert.strictEqual(await coreB.lookupCoreUrl(ns, values[i]), 'https://core-a.example.test/', 'lookup ' + i);
        assert.deepStrictEqual((await service.list('u' + i)).map((x) => x.namespace), [ns]);
      }
    }

    it('[XIDR1] cleartext to hashed: the reconcile refreshes every row, then is a no-op', async () => {
      coreA.platform.pepper = null;
      coreB.platform.pepper = null;
      const values = await claimMany(coreA, 3);
      assert.ok(extIdRows(store).some(([k]) => k.includes(values[0])), 'cleartext keys hold the value');
      coreA.platform.pepper = 'pepper-1';
      coreB.platform.pepper = 'pepper-1';
      assert.strictEqual(await coreA.holds('u0', ns, values[0]), false, 'stale until the reconcile');
      const s = await coreA.reconcile({ dryRun: false, userExists });
      assert.strictEqual(s.refreshed, 3);
      assert.strictEqual(s.staleDeleted, 0, 'old keys deleted by the refresh itself');
      assert.strictEqual(extIdRows(store).length, 3);
      assert.ok(!extIdRows(store).some(([k]) => values.some((v) => k.includes(v))), 'no value left in a key');
      await assertAllResolve(coreA, values);
      const again = await coreA.reconcile({ dryRun: false, userExists });
      assert.strictEqual(again.refreshed, 0);
      assert.strictEqual(again.corruptTokens, 0);
    });

    it('[XIDR2] pepper rotation: unmatched without the retired pepper, refreshed with it', async () => {
      const values = await claimMany(coreA, 2);
      coreA.platform.pepper = 'pepper-2';
      coreB.platform.pepper = 'pepper-2';
      const blind = await coreA.reconcile({ dryRun: true, userExists });
      assert.strictEqual(blind.namespaceMissing, 2, 'not matchable without the retired pepper');
      const s = await coreA.reconcile({ dryRun: false, userExists, oldHasher: { hashFor: hmacWith('pepper-1') } });
      assert.strictEqual(s.refreshed, 2);
      assert.strictEqual(extIdRows(store).length, 2);
      await assertAllResolve(coreA, values);
    });

    it('[XIDR3] a crash after each step is healed by the plain reconcile; platform-first would lose the id', async () => {
      const { refreshExternalIdTokens } = require('business/src/external-ids/refresh.ts');
      const values = await claimMany(coreA, 3);
      coreA.platform.pepper = 'pepper-2';
      coreB.platform.pepper = 'pepper-2';
      const { tokensFor, getNamespace } = require('platform/src/externalIdIndex.ts');
      const nsRow = await getNamespace(coreA.platform, ns);
      const rowOf = (i) => coreA.db.rows.find((r) => r.userId === 'u' + i);
      // u0: crash after step 1 (local retoken only)
      const r0 = rowOf(0);
      await coreA.db.retoken('u0', r0.nsToken, tokensFor(coreA.platform, nsRow, r0.blindedValue));
      // u1: crash after step 2 (local retoken + new key claimed, old key left)
      const r1 = { ...rowOf(1) };
      const t1 = tokensFor(coreA.platform, nsRow, r1.blindedValue);
      await coreA.db.retoken('u1', r1.nsToken, t1);
      store.set('ext-id/' + t1.nsToken + '/' + t1.valueToken, 'core-a');
      // u2: the order the ruling rejects: new key claimed first, then crash
      const r2 = rowOf(2);
      const t2 = tokensFor(coreA.platform, nsRow, r2.blindedValue);
      store.set('ext-id/' + t2.nsToken + '/' + t2.valueToken, 'core-a');

      // The plain reconcile, without the retired pepper.
      await coreA.reconcile({ dryRun: false, userExists });
      assert.strictEqual(await coreA.holds('u0', ns, values[0]), true);
      assert.strictEqual(await coreB.lookupCoreUrl(ns, values[0]), 'https://core-a.example.test/', 'u0 healed');
      assert.strictEqual(await coreB.lookupCoreUrl(ns, values[1]), 'https://core-a.example.test/', 'u1 healed');
      assert.strictEqual(await coreB.lookupCoreUrl(ns, values[2]), null, 'platform-first: the new key was deleted as stale');
      assert.strictEqual(await coreA.holds('u2', ns, values[2]), false, '... and the local row is left on the retired tokens');
      assert.strictEqual(extIdRows(store).length, 3, 'u0 and u1 on new keys; u2 still on its retired key (its local row names it)');
      // Only the retired pepper recovers u2.
      const s = await refreshExternalIdTokens({ platform: coreA.platform, db: coreA.db, oldHasher: { hashFor: hmacWith('pepper-1') }, dryRun: false });
      assert.strictEqual(s.refreshed, 1);
      assert.strictEqual(await coreB.lookupCoreUrl(ns, values[2]), 'https://core-a.example.test/');
    });
  });

  it('[XIDS10] reconcile reports, and keeps, local rows of a deleted namespace', async () => {
    const { deleteNamespace } = require('platform/src/externalIdIndex.ts');
    await coreA.claim('u1', ns, value());
    await deleteNamespace(coreA.platform, ns, { force: true });
    const summary = await coreA.reconcile({ dryRun: false, userExists: async () => true });
    assert.strictEqual(summary.namespaceMissing, 1);
    assert.strictEqual(coreA.db.rows.length, 1);
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
