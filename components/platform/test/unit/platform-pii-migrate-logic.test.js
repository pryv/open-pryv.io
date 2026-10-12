/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { PiiHasher, PEPPER_BYTES } = require('../../src/PiiHasher.ts');

/**
 * Unit-level coverage for the migration + rotation algorithms used by
 * bin/platform-pii-migrate.js (cleartext to hashed) and
 * bin/platform-pii-rotate.js (old-pepper to new-pepper).
 *
 * The bins boot the full boiler/storages stack; replaying that inside a
 * mocha worker is heavy and brittle. The transform logic is small and
 * side-effect-free, so the test replicates it inline against a fake
 * PlatformDB. Any drift against PiiHasher's contract surfaces here. Real
 * DB exercise lives in the storages-component conformance suite.
 *
 * DNS-record subdomains are operator infrastructure names, NOT user PII,
 * so they are stored cleartext and intentionally NOT migrated/rotated;
 * the fake DB below has no dns-record surface.
 */

const PEPPER = crypto.randomBytes(PEPPER_BYTES).toString('base64');
const PEPPER_NEW = crypto.randomBytes(PEPPER_BYTES).toString('base64');
const HEX_64 = /^[0-9a-f]{64}$/;
const USERNAME_FIELD = 'username';

/** Minimal in-memory PlatformDB stub matching the surface the migration
 *  + rotation scripts call. */
function makeFakePlatformDB () {
  const userCore = new Map();          // username -> coreId
  const userUnique = new Map();        // `${field} ${value}` -> username
  const userIndexed = new Map();       // `${field} ${username}` -> value

  return {
    async setUserCore (username, coreId) { userCore.set(username, coreId); },
    async getUserCore (username) { return userCore.has(username) ? userCore.get(username) : null; },
    async deleteUserCore (username) { userCore.delete(username); },
    async getAllUserCores () { return Array.from(userCore.entries()).map(([username, coreId]) => ({ username, coreId })); },
    async setUserUniqueField (username, field, value) { userUnique.set(field + ' ' + value, username); },
    async deleteUserUniqueField (field, value) { userUnique.delete(field + ' ' + value); },
    async getUsersUniqueField (field, value) {
      const k = field + ' ' + value;
      return userUnique.has(k) ? userUnique.get(k) : null;
    },
    async setUserIndexedField (username, field, value) { userIndexed.set(field + ' ' + username, value); },
    async deleteUserIndexedField (username, field) { userIndexed.delete(field + ' ' + username); },
    async getUserIndexedField (username, field) {
      const k = field + ' ' + username;
      return userIndexed.has(k) ? userIndexed.get(k) : null;
    },
    async reassignInvitationConsumer () { /* no invitations in this fake */ },
    async getAllWithPrefix (prefix) {
      const out = [];
      if (prefix === 'user-' || prefix === 'user') {
        for (const [k, v] of userUnique.entries()) {
          const [field, value] = k.split(' ');
          out.push({ field, value, username: v, isUnique: true });
        }
        for (const [k, v] of userIndexed.entries()) {
          const [field, username] = k.split(' ');
          out.push({ field, value: v, username, isUnique: false });
        }
      }
      return out;
    }
  };
}

/** Replica of the migration's plan/apply algorithm (user-* rows only). */
async function runMigratePlanAndApply (platformDB, hasher) {
  const plan = {
    userCore: [],
    userUnique: [],
    userIndexed: [],
    alreadyHashed: { userCore: 0, userUnique: 0, userIndexed: 0 }
  };
  for (const { username, coreId } of await platformDB.getAllUserCores()) {
    if (HEX_64.test(username)) { plan.alreadyHashed.userCore++; continue; }
    plan.userCore.push({ username, coreId });
  }
  for (const entry of await platformDB.getAllWithPrefix('user-')) {
    if (entry.field == null) continue;
    if (entry.isUnique) {
      if (HEX_64.test(entry.value)) { plan.alreadyHashed.userUnique++; continue; }
      plan.userUnique.push({ field: entry.field, value: entry.value, ownerUsername: entry.username });
    } else if (entry.username != null) {
      if (HEX_64.test(entry.username)) { plan.alreadyHashed.userIndexed++; continue; }
      plan.userIndexed.push({ username: entry.username, field: entry.field, value: entry.value });
    }
  }

  for (const { username, coreId } of plan.userCore) {
    const t = hasher.hashFor(USERNAME_FIELD, username);
    await platformDB.setUserCore(t, coreId);
    await platformDB.deleteUserCore(username);
  }
  for (const { field, value, ownerUsername } of plan.userUnique) {
    const vt = hasher.hashFor(field, value);
    const ut = hasher.hashFor(USERNAME_FIELD, ownerUsername);
    await platformDB.setUserUniqueField(ut, field, vt);
    if (vt !== value) await platformDB.deleteUserUniqueField(field, value);
  }
  for (const { username, field, value } of plan.userIndexed) {
    const ut = hasher.hashFor(USERNAME_FIELD, username);
    await platformDB.setUserIndexedField(ut, field, value);
    if (ut !== username) await platformDB.deleteUserIndexedField(username, field);
  }
  return plan;
}

describe('[PMIG] platform-pii-migrate transform logic', () => {
  let db, hasher;
  beforeEach(() => {
    db = makeFakePlatformDB();
    hasher = new PiiHasher(PEPPER);
  });

  it('[PMIG-01] rehashes user-core/username rows into HMAC-keyed equivalents', async () => {
    await db.setUserCore('alice', 'core-use1');
    await db.setUserCore('bob', 'core-euc1');

    await runMigratePlanAndApply(db, hasher);

    assert.equal(await db.getUserCore(hasher.hashFor(USERNAME_FIELD, 'alice')), 'core-use1');
    assert.equal(await db.getUserCore(hasher.hashFor(USERNAME_FIELD, 'bob')), 'core-euc1');
    assert.equal(await db.getUserCore('alice'), null);
    assert.equal(await db.getUserCore('bob'), null);
  });

  it('[PMIG-02] rehashes user-unique rows: BOTH the key value AND the row username value', async () => {
    await db.setUserUniqueField('alice', 'email', 'alice@x.com');

    await runMigratePlanAndApply(db, hasher);

    const emailToken = hasher.hashFor('email', 'alice@x.com');
    const usernameToken = hasher.hashFor(USERNAME_FIELD, 'alice');
    assert.equal(await db.getUsersUniqueField('email', emailToken), usernameToken);
    assert.equal(await db.getUsersUniqueField('email', 'alice@x.com'), null);
  });

  it('[PMIG-03] rehashes user-indexed rows: username key only, VALUE stays cleartext', async () => {
    await db.setUserIndexedField('alice', 'language', 'fr');

    await runMigratePlanAndApply(db, hasher);

    const usernameToken = hasher.hashFor(USERNAME_FIELD, 'alice');
    assert.equal(await db.getUserIndexedField(usernameToken, 'language'), 'fr');
    assert.equal(await db.getUserIndexedField('alice', 'language'), null);
  });

  it('[PMIG-05] is idempotent: a second run is a no-op (rows already-hashed)', async () => {
    await db.setUserCore('alice', 'core-use1');
    await db.setUserUniqueField('alice', 'email', 'alice@x.com');
    await db.setUserIndexedField('alice', 'language', 'fr');

    const firstPlan = await runMigratePlanAndApply(db, hasher);
    assert.equal(firstPlan.userCore.length, 1);
    assert.equal(firstPlan.userUnique.length, 1);
    assert.equal(firstPlan.userIndexed.length, 1);

    const secondPlan = await runMigratePlanAndApply(db, hasher);
    assert.equal(secondPlan.userCore.length, 0);
    assert.equal(secondPlan.userUnique.length, 0);
    assert.equal(secondPlan.userIndexed.length, 0);
    assert.equal(secondPlan.alreadyHashed.userCore, 1);
    assert.equal(secondPlan.alreadyHashed.userUnique, 1);
    assert.equal(secondPlan.alreadyHashed.userIndexed, 1);
  });

  it('[PMIG-06] tolerates a half-migrated state: completes whatever cleartext rows remain', async () => {
    const aliceToken = hasher.hashFor(USERNAME_FIELD, 'alice');
    await db.setUserCore(aliceToken, 'core-use1');       // already hashed
    await db.setUserUniqueField('alice', 'email', 'alice@x.com'); // cleartext leftover

    await runMigratePlanAndApply(db, hasher);

    assert.equal(await db.getUserCore(aliceToken), 'core-use1');
    const emailToken = hasher.hashFor('email', 'alice@x.com');
    assert.equal(await db.getUsersUniqueField('email', emailToken), aliceToken);
    assert.equal(await db.getUsersUniqueField('email', 'alice@x.com'), null);
  });

  it('[PMIG-07] email normalisation: User@x.com stored under the same token as user@x.com', async () => {
    await db.setUserUniqueField('alice', 'email', 'User@X.com');

    await runMigratePlanAndApply(db, hasher);

    const expectedToken = hasher.hashFor('email', 'user@x.com');
    assert.equal(await db.getUsersUniqueField('email', expectedToken), hasher.hashFor(USERNAME_FIELD, 'alice'));
  });
});

/** Replica of the rotation algorithm for a single-core scenario. */
async function runRotateSingleCore (platformDB, oldHasher, newHasher, users, coreId, indexedFields, uniqueFields) {
  for (const user of users) {
    const oldUserToken = oldHasher.hashFor(USERNAME_FIELD, user.username);
    const newUserToken = newHasher.hashFor(USERNAME_FIELD, user.username);
    if (oldUserToken !== newUserToken) {
      await platformDB.setUserCore(newUserToken, coreId);
      await platformDB.deleteUserCore(oldUserToken);
    }
    for (const field of uniqueFields) {
      if (field === 'username') continue;
      const v = user[field];
      if (v == null) continue;
      const ov = oldHasher.hashFor(field, String(v));
      const nv = newHasher.hashFor(field, String(v));
      await platformDB.setUserUniqueField(newUserToken, field, nv);
      await platformDB.deleteUserUniqueField(field, ov);
    }
    for (const field of indexedFields) {
      if (uniqueFields.includes(field)) continue;
      const v = user[field];
      if (v == null) continue;
      if (oldUserToken === newUserToken) continue;
      await platformDB.setUserIndexedField(newUserToken, field, String(v));
      await platformDB.deleteUserIndexedField(oldUserToken, field);
    }
  }
}

describe('[PROT] platform-pii-rotate transform logic (single-core)', () => {
  let db, oldHasher, newHasher;
  const users = [{ username: 'alice', email: 'alice@x.com', language: 'fr' }];

  beforeEach(async () => {
    db = makeFakePlatformDB();
    oldHasher = new PiiHasher(PEPPER);
    newHasher = new PiiHasher(PEPPER_NEW);
    const oldUserToken = oldHasher.hashFor(USERNAME_FIELD, 'alice');
    await db.setUserCore(oldUserToken, 'core-use1');
    await db.setUserUniqueField(oldUserToken, 'email', oldHasher.hashFor('email', 'alice@x.com'));
    await db.setUserIndexedField(oldUserToken, 'language', 'fr');
  });

  it('[PROT-01] re-derives user-core under the new pepper', async () => {
    await runRotateSingleCore(db, oldHasher, newHasher, users, 'core-use1', ['language', 'email'], ['username', 'email']);
    const newUserToken = newHasher.hashFor(USERNAME_FIELD, 'alice');
    assert.equal(await db.getUserCore(newUserToken), 'core-use1');
    assert.equal(await db.getUserCore(oldHasher.hashFor(USERNAME_FIELD, 'alice')), null);
  });

  it('[PROT-02] re-derives user-unique under the new pepper (both key + value)', async () => {
    await runRotateSingleCore(db, oldHasher, newHasher, users, 'core-use1', ['language', 'email'], ['username', 'email']);
    const newEmailToken = newHasher.hashFor('email', 'alice@x.com');
    const newUserToken = newHasher.hashFor(USERNAME_FIELD, 'alice');
    assert.equal(await db.getUsersUniqueField('email', newEmailToken), newUserToken);
    assert.equal(await db.getUsersUniqueField('email', oldHasher.hashFor('email', 'alice@x.com')), null);
  });

  it('[PROT-03] re-derives user-indexed under the new pepper (username key only)', async () => {
    await runRotateSingleCore(db, oldHasher, newHasher, users, 'core-use1', ['language', 'email'], ['username', 'email']);
    const newUserToken = newHasher.hashFor(USERNAME_FIELD, 'alice');
    assert.equal(await db.getUserIndexedField(newUserToken, 'language'), 'fr');
    assert.equal(await db.getUserIndexedField(oldHasher.hashFor(USERNAME_FIELD, 'alice'), 'language'), null);
  });
});
