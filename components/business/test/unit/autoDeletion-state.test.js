/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Per-user auto-deletion state: write-on-change bookkeeping, the setting
 * field, the encrypted identity and its key.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createAutoDeletionState,
  isMaterialChange,
  resolveIdentityKey,
  SETTING_FIELD,
  IDENTITY_FIELD,
  BOOKKEEPING_STORE_ID
} = require('../../src/autoDeletion/state.ts');

const DAY = 24 * 60 * 60;

// In-memory account storage counting writes; account fields keep versions.
function fakeStorage () {
  const fields = new Map();
  const kv = new Map();
  const writes = { fields: 0, kv: 0, deletes: 0, stores: [] };
  return {
    writes,
    fields,
    async getAccountField (userId, field) {
      const versions = fields.get(userId + '/' + field);
      return versions == null ? null : versions[versions.length - 1];
    },
    async setAccountField (userId, field, value) {
      writes.fields++;
      const k = userId + '/' + field;
      fields.set(k, (fields.get(k) ?? []).concat([value]));
    },
    async deleteAccountField (userId, field) {
      writes.deletes++;
      fields.delete(userId + '/' + field);
    },
    getKeyValueDataForStore (storeId) {
      writes.stores.push(storeId);
      return {
        async get (userId, key) { return kv.get(storeId + '/' + userId + '/' + key) ?? null; },
        async set (userId, key, value) {
          writes.kv++;
          if (value == null) kv.delete(storeId + '/' + userId + '/' + key); else kv.set(storeId + '/' + userId + '/' + key, structuredClone(value));
        }
      };
    }
  };
}

function bookkeeping (over = {}) {
  return {
    appliedPolicy: { source: 'operator', mode: 'inactivity', inactivityDays: 365 },
    policyAppliedAt: 1000,
    lastActivity: { personal: 5000, app: null, delegate: null, max: 5000, by: 'owner' },
    deadline: 5000 + 365 * DAY,
    deadlineReason: 'inactivity',
    reminders: { deadlineDay: null, sent: [] },
    ...over
  };
}

describe('[ADKS] account auto-deletion state', function () {
  it('[ADKS1] activity moves and same-day deadline moves are not material; the rest is', function () {
    const prev = bookkeeping();
    assert.equal(isMaterialChange(prev, bookkeeping({ lastActivity: { personal: 5060, app: null, delegate: null, max: 5060, by: 'owner' }, deadline: prev.deadline + 60 })), false);
    assert.equal(isMaterialChange(prev, bookkeeping({ deadline: prev.deadline + DAY })), true, 'deadline on another day');
    assert.equal(isMaterialChange(prev, bookkeeping({ reminders: { deadlineDay: 1, sent: [{ leadDays: 60, at: 9 }] } })), true, 'reminder sent');
    assert.equal(isMaterialChange(prev, bookkeeping({ policyAppliedAt: 2000 })), true);
    assert.equal(isMaterialChange(prev, bookkeeping({ blocked: { reason: 'guard', at: 1 } })), true);
    assert.equal(isMaterialChange(null, null), false);
    assert.equal(isMaterialChange(null, prev), true);
    assert.equal(isMaterialChange(prev, null), true);
  });

  it('[ADKS2] key order does not make a change', function () {
    const a = bookkeeping();
    const b = { reminders: a.reminders, deadlineReason: a.deadlineReason, deadline: a.deadline, lastActivity: a.lastActivity, policyAppliedAt: a.policyAppliedAt, appliedPolicy: { inactivityDays: 365, mode: 'inactivity', source: 'operator' } };
    assert.equal(isMaterialChange(a, b), false);
  });

  it('[ADKS3] ten idle passes write nothing; a material change writes once', async function () {
    const storage = fakeStorage();
    const state = createAutoDeletionState(storage);
    assert.deepEqual(storage.writes.stores, [BOOKKEEPING_STORE_ID]);
    assert.equal(await state.saveBookkeeping('u1', null, bookkeeping()), true);
    let prev = await state.getBookkeeping('u1');
    for (let i = 1; i <= 10; i++) {
      const next = bookkeeping({ lastActivity: { personal: 5000 + i, app: null, delegate: null, max: 5000 + i, by: 'owner' }, deadline: prev.deadline + i });
      assert.equal(await state.saveBookkeeping('u1', prev, next), false);
    }
    assert.equal(storage.writes.kv, 1);
    // no policy, no row: an account the feature does not concern is never written
    assert.equal(await state.saveBookkeeping('u2', null, null), false);
    assert.equal(storage.writes.kv, 1);
    prev = await state.getBookkeeping('u1');
    assert.equal(await state.saveBookkeeping('u1', prev, null), true);
    assert.equal(await state.getBookkeeping('u1'), null);
  });

  it('[ADKS4] the setting keeps its history; clearing appends null', async function () {
    const storage = fakeStorage();
    const state = createAutoDeletionState(storage);
    assert.equal(await state.getSetting('u1'), null);
    const setting = { mode: 'inactivity', inactivityDays: 365, action: 'delete', updatedAt: 1 };
    await state.setSetting('u1', setting, 'acc1');
    assert.deepEqual(await state.getSetting('u1'), setting);
    await state.setSetting('u1', null, 'acc1');
    assert.equal(await state.getSetting('u1'), null);
    assert.deepEqual(storage.fields.get('u1/' + SETTING_FIELD), [setting, null]);
  });

  it('[ADKS5] the identity is stored encrypted, replaced and erased without leftovers', async function () {
    const storage = fakeStorage();
    const state = createAutoDeletionState(storage);
    const key = crypto.randomBytes(32);
    await state.setIdentity('u1', { name: 'Ada Lovelace', dateOfBirth: '1815-12-10' }, key, 'acc1');
    const stored = storage.fields.get('u1/' + IDENTITY_FIELD);
    assert.equal(stored.length, 1);
    assert.equal(typeof stored[0], 'string');
    assert.ok(!stored[0].includes('Ada') && !stored[0].includes('1815'), 'no plain text');
    assert.deepEqual(await state.getIdentity('u1', key), { name: 'Ada Lovelace', dateOfBirth: '1815-12-10' });
    await assert.rejects(state.getIdentity('u1', crypto.randomBytes(32)));
    await state.setIdentity('u1', { name: 'Ada King' }, key, 'acc1');
    assert.equal(storage.fields.get('u1/' + IDENTITY_FIELD).length, 1, 'the previous identity is not kept as a version');
    await state.eraseIdentity('u1');
    assert.equal(await state.getIdentity('u1', key), null);
  });

  it('[ADKS6] the identity key is the configured one, else derived from the admin key', function () {
    const configured = crypto.randomBytes(32);
    assert.deepEqual(resolveIdentityKey(configured.toString('base64'), 'admin'), configured);
    const derived = resolveIdentityKey(null, 'an-admin-key');
    assert.equal(derived.length, 32);
    assert.deepEqual(resolveIdentityKey('', 'an-admin-key'), derived, 'stable');
    assert.notDeepEqual(resolveIdentityKey(null, 'another-admin-key'), derived);
    assert.equal(resolveIdentityKey(null, null), null);
    assert.throws(() => resolveIdentityKey(crypto.randomBytes(16).toString('base64'), 'admin'), /32 bytes/);
  });
});
