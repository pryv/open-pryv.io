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

const { Platform } = require('../../src/Platform.ts');
const { PiiHasher, PEPPER_BYTES } = require('../../src/PiiHasher.ts');

/**
 * [PUCC] The routing read of which core hosts a name (getUserCoreForRouting) is
 * cached per process: found mappings for cluster.userCoreCache.positiveTtlMs,
 * missing ones for negativeTtlMs, cleared by this process's own writes; the
 * uncached getUserCore always reads the store.
 */

const PEPPER_B64 = crypto.randomBytes(PEPPER_BYTES).toString('base64');

function makeUserCoreDb () {
  const rows = new Map();
  const db = {
    reads: 0,
    async getUserCore (token) { db.reads++; return rows.has(token) ? rows.get(token) : null; },
    async setUserCore (token, coreId) { rows.set(token, coreId); },
    async setUserCoreIfNotExists (token, coreId) {
      if (!rows.has(token)) rows.set(token, coreId);
      return rows.get(token) === coreId;
    },
    async deleteUserCore (token) { rows.delete(token); },
    async deleteCoreRowIfValue (prefix, token, coreId) {
      if (rows.get(token) !== coreId) return false;
      rows.delete(token);
      return true;
    },
    // A write made elsewhere (another core or worker): no cache invalidation here.
    writeBehind (token, coreId) { if (coreId == null) rows.delete(token); else rows.set(token, coreId); }
  };
  return db;
}

function makePlatform ({ hashed = false, config = {} } = {}) {
  const platform = new Platform();
  const db = makeUserCoreDb();
  const store = { 'core:isSingleCore': false, 'core:id': 'core-a', ...config };
  platform._setDependenciesForTests(db, hashed ? new PiiHasher(PEPPER_B64) : null, { get: (key) => store[key] });
  const token = (username) => platform.hashFor('username', username);
  return { platform, db, token };
}

for (const hashed of [false, true]) {
  const mode = hashed ? 'hashed' : 'cleartext';

  describe(`[PUCC] routing cache of name to core (${mode})`, () => {
    it('[PUCC1] a found mapping is served from the cache until it expires; getUserCore always reads', async () => {
      const { platform, db, token } = makePlatform({ hashed, config: { 'cluster:userCoreCache:positiveTtlMs': 80 } });
      await platform.setUserCore('alice', 'core-a');
      db.reads = 0;
      assert.equal(await platform.getUserCoreForRouting('alice'), 'core-a');
      db.writeBehind(token('alice'), 'core-b');
      assert.equal(await platform.getUserCoreForRouting('alice'), 'core-a', 'cached');
      assert.equal(db.reads, 1);
      assert.equal(await platform.getUserCore('alice'), 'core-b', 'the uncached read sees the store');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await platform.getUserCoreForRouting('alice'), 'core-b', 'read again once expired');
    });

    it('[PUCC2] a missing mapping is cached for the negative TTL; random names cost one read each per window', async () => {
      const { platform, db, token } = makePlatform({ hashed, config: { 'cluster:userCoreCache:negativeTtlMs': 60 } });
      for (let i = 0; i < 5; i++) assert.equal(await platform.getUserCoreForRouting('nobody'), null);
      assert.equal(db.reads, 1);
      db.writeBehind(token('nobody'), 'core-b');
      assert.equal(await platform.getUserCoreForRouting('nobody'), null, 'still the cached miss');
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(await platform.getUserCoreForRouting('nobody'), 'core-b');
    });

    it('[PUCC3] this process\'s own writes clear the entry at once', async () => {
      const { platform } = makePlatform({ hashed });
      assert.equal(await platform.getUserCoreForRouting('bob'), null);
      assert.equal(await platform.setUserCoreIfNotExists('bob', 'core-a'), true);
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-a', 'a claim clears the cached miss');
      await platform.setUserCore('bob', 'core-b');
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-b', 'an overwrite clears it');
      await platform.deleteUserCoreIfValue('bob', 'core-b');
      assert.equal(await platform.getUserCoreForRouting('bob'), null, 'a conditional delete clears it');
      await platform.setUserCore('bob', 'core-a');
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-a');
      await platform.deleteUserCore('bob');
      assert.equal(await platform.getUserCoreForRouting('bob'), null, 'a delete clears it');
    });

    it('[PUCC4] 0 turns either cache off', async () => {
      const { platform, db, token } = makePlatform({ hashed, config: { 'cluster:userCoreCache:positiveTtlMs': 0, 'cluster:userCoreCache:negativeTtlMs': 0 } });
      await platform.setUserCore('carol', 'core-a');
      db.reads = 0;
      assert.equal(await platform.getUserCoreForRouting('carol'), 'core-a');
      db.writeBehind(token('carol'), 'core-b');
      assert.equal(await platform.getUserCoreForRouting('carol'), 'core-b');
      assert.equal(await platform.getUserCoreForRouting('dave'), null);
      assert.equal(await platform.getUserCoreForRouting('dave'), null);
      assert.equal(db.reads, 4);
    });
  });
}
