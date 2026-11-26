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
 * missing ones for negativeTtlMs, never from a read that overlapped a write of
 * this process; the uncached getUserCore always reads the store.
 */

const PEPPER_B64 = crypto.randomBytes(PEPPER_BYTES).toString('base64');

function makeUserCoreDb () {
  const rows = new Map();
  const db = {
    reads: 0,
    purposes: [],
    // When set, every read waits for this promise before answering.
    holdReads: null,
    failReads: false,
    async getUserCore (token, purpose) {
      db.reads++;
      db.purposes.push(purpose);
      const value = rows.has(token) ? rows.get(token) : null;
      if (db.holdReads != null) await db.holdReads;
      if (db.failReads) throw new Error('store down');
      return value;
    },
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
    async moveCoreRows (prefix, from, to) {
      let n = 0;
      for (const [k, v] of rows) if (v === from) { rows.set(k, to); n++; }
      return n;
    },
    async deleteAll () { rows.clear(); },
    // A write made elsewhere (another core or process): no cache invalidation here.
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const hashed of [false, true]) {
  const mode = hashed ? 'hashed' : 'cleartext';

  describe(`[PUCC] routing cache of name to core (${mode})`, () => {
    it('[PUCC1] a found mapping is served from the cache until it expires; getUserCore always reads; the routing read asks for purpose routing', async () => {
      const { platform, db, token } = makePlatform({ hashed, config: { 'cluster:userCoreCache:positiveTtlMs': 400 } });
      await platform.setUserCore('alice', 'core-a');
      db.reads = 0;
      assert.equal(await platform.getUserCoreForRouting('alice'), 'core-a');
      assert.equal(db.purposes.at(-1), 'routing');
      db.writeBehind(token('alice'), 'core-b');
      assert.equal(await platform.getUserCoreForRouting('alice'), 'core-a', 'cached');
      assert.equal(db.reads, 1);
      assert.equal(await platform.getUserCore('alice'), 'core-b', 'the uncached read sees the store');
      assert.equal(db.purposes.at(-1), undefined, 'the uncached read has no routing purpose');
      await wait(500);
      assert.equal(await platform.getUserCoreForRouting('alice'), 'core-b', 'read again once expired');
    });

    it('[PUCC2] a missing mapping is cached for the negative TTL; repeated misses cost one read per window', async () => {
      const { platform, db, token } = makePlatform({ hashed, config: { 'cluster:userCoreCache:negativeTtlMs': 300 } });
      for (let i = 0; i < 5; i++) assert.equal(await platform.getUserCoreForRouting('nobody'), null);
      assert.equal(db.reads, 1);
      db.writeBehind(token('nobody'), 'core-b');
      assert.equal(await platform.getUserCoreForRouting('nobody'), null, 'still the cached miss');
      await wait(400);
      assert.equal(await platform.getUserCoreForRouting('nobody'), 'core-b');
    });

    it('[PUCC3] this process\'s own writes clear the entry', async () => {
      const { platform, token } = makePlatform({ hashed });
      assert.equal(await platform.getUserCoreForRouting('bob'), null);
      assert.equal(await platform.setUserCoreIfNotExists('bob', 'core-a'), true);
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-a', 'a claim clears the cached miss');
      await platform.setUserCore('bob', 'core-b');
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-b', 'an overwrite clears it');
      await platform.deleteUserCoreIfValue('bob', 'core-b');
      assert.equal(await platform.getUserCoreForRouting('bob'), null, 'a conditional delete clears it');
      await platform.setUserCoreByPreHashedUsername(token('bob'), 'core-a');
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-a', 'a pre-hashed write clears it');
      await platform.moveCoreRows('user-core/', 'core-a', 'core-c');
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-c', 'moving user-core rows clears the cache');
      await platform.deleteUserCoreByPreHashedUsername(token('bob'));
      assert.equal(await platform.getUserCoreForRouting('bob'), null, 'a pre-hashed delete clears it');
      await platform.setUserCore('bob', 'core-a');
      assert.equal(await platform.getUserCoreForRouting('bob'), 'core-a');
      await platform.deleteAll();
      assert.equal(await platform.getUserCoreForRouting('bob'), null, 'deleteAll clears the cache');
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

    it('[PUCC5] a read that overlapped a write of this process is not cached', async () => {
      const { platform, db } = makePlatform({ hashed });
      await platform.setUserCore('erin', 'core-a');
      let release;
      db.holdReads = new Promise((resolve) => { release = resolve; });
      const overlapping = platform.getUserCoreForRouting('erin'); // reads core-a, held
      await wait(10);
      db.holdReads = null;
      await platform.setUserCore('erin', 'core-b'); // the write lands while the read is held
      release();
      assert.equal(await overlapping, 'core-a', 'the overlapping read answers what it read');
      assert.equal(await platform.getUserCoreForRouting('erin'), 'core-b', 'but its answer was not cached');
    });

    it('[PUCC6] concurrent misses for one name share one read; a failed read caches nothing', async () => {
      const { platform, db } = makePlatform({ hashed });
      let release;
      db.holdReads = new Promise((resolve) => { release = resolve; });
      const all = Promise.all(Array.from({ length: 10 }, () => platform.getUserCoreForRouting('frank')));
      await wait(10);
      release();
      db.holdReads = null;
      assert.deepEqual(await all, new Array(10).fill(null));
      assert.equal(db.reads, 1);
      db.failReads = true;
      await assert.rejects(platform.getUserCoreForRouting('gina'), /store down/);
      db.failReads = false;
      await platform.setUserCoreByPreHashedUsername(platform.hashFor('username', 'gina'), 'core-a');
      assert.equal(await platform.getUserCoreForRouting('gina'), 'core-a');
    });

    it('[PUCC8] a read the platform database did not answer is never cached as a miss; concurrent callers share the rejection', async () => {
      const { platform, db } = makePlatform({ hashed });
      const noAnswer = Object.assign(new Error('rqlite query got no result at level linearizable: not leader'), { name: 'RqliteNoAnswerError' });
      let release;
      db.holdReads = new Promise((resolve) => { release = resolve; });
      const realGet = db.getUserCore;
      db.getUserCore = async (...args) => { await realGet(...args); throw noAnswer; };
      const both = [platform.getUserCoreForRouting('hana'), platform.getUserCoreForRouting('hana')];
      await wait(10);
      release();
      db.holdReads = null;
      for (const p of both) await assert.rejects(p, { name: 'RqliteNoAnswerError' });
      assert.equal(db.reads, 1, 'one read for both callers');
      assert.equal(platform.peekUserCoreForRouting('hana'), undefined, 'nothing cached, neither a miss nor a hit');
      db.getUserCore = realGet;
      assert.equal(await platform.getUserCoreForRouting('hana'), null, 'the next call reads again');
      assert.equal(db.reads, 2);
    });

    it('[PUCC7] a name longer than any username is read every time, never cached', async () => {
      const { platform, db } = makePlatform({ hashed });
      const long = 'x'.repeat(101);
      assert.equal(await platform.getUserCoreForRouting(long), null);
      assert.equal(await platform.getUserCoreForRouting(long), null);
      assert.equal(db.reads, 2);
      const ok = 'y'.repeat(60);
      await platform.getUserCoreForRouting(ok);
      await platform.getUserCoreForRouting(ok);
      assert.equal(db.reads, 3);
    });
  });
}
