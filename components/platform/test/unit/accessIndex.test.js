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
const accessIndex = require('../../src/accessIndex.ts');

/**
 * Behavioural coverage for the access reverse-index (accessId -> owning user
 * + operational metadata), exercised against an in-memory PlatformDB fake so
 * the real Platform + accessIndex code runs without booting storages. Each
 * case runs in cleartext and hashed mode.
 *
 * Invariants pinned: the access token is NEVER stored; the access name is
 * NEVER stored; hashed mode replaces the plaintext username with the same
 * HMAC token the user-core map uses; delete RETAINS the row with a `deleted`
 * timestamp; user-erasure default removes only that user's rows; the keep
 * variant tombstones (strips the username, keeps type + deleted).
 */

const PEPPER_B64 = crypto.randomBytes(PEPPER_BYTES).toString('base64');

/** Minimal in-memory PlatformDB providing the generic KV surface accessIndex uses. */
function makeFakePlatformDB () {
  const kv = new Map();
  return {
    _kv: kv,
    async setPlatformKv (key, value) { kv.set(key, value); },
    async getPlatformKv (key) { return kv.has(key) ? kv.get(key) : null; },
    async deletePlatformKv (key) { kv.delete(key); },
    async listPlatformKvKeys (prefix) {
      return [...kv.keys()].filter((k) => k.startsWith(prefix));
    }
  };
}

function makePlatform ({ hashed }) {
  const platform = new Platform();
  const db = makeFakePlatformDB();
  const hasher = hashed ? new PiiHasher(PEPPER_B64) : null;
  platform._setDependenciesForTests(db, hasher);
  return { platform, db, hasher };
}

/** Storage-form username: plaintext in cleartext mode, HMAC token in hashed. */
function storedUser (hasher, username) {
  return hasher == null ? username : hasher.hashFor('username', username);
}

function accessRow (over = {}) {
  return {
    id: 'cacc-base-01',
    type: 'app',
    name: 'Dr Meier oncology follow-up', // must NOT reach the index
    token: 'secret-token-value', // must NEVER reach the index
    expires: 1800000000, // pryv seconds
    created: 1700000000, // pryv seconds
    modified: 1700000000, // pryv seconds (last mutation)
    serial: null,
    ...over
  };
}

for (const hashed of [false, true]) {
  const mode = hashed ? 'hashed' : 'cleartext';

  describe(`[ACCIDX] access reverse-index (${mode})`, () => {
    it('[ACCIDX-01] put + get round-trips the routing metadata; username per mode', async () => {
      const { platform, hasher } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow());

      const entry = await accessIndex.getAccessIndex(platform, 'cacc-base-01');
      assert.ok(entry != null);
      assert.strictEqual(entry.accessId, 'cacc-base-01');
      assert.strictEqual(entry.type, 'app');
      assert.strictEqual(entry.expires, 1800000000);
      assert.strictEqual(entry.created, 1700000000);
      assert.strictEqual(entry.lastModified, 1700000000);
      assert.ok(entry.deleted == null);

      if (hashed) {
        assert.strictEqual(entry.usernameToken, storedUser(hasher, 'alice'));
        assert.ok(!('username' in entry));
        assert.notStrictEqual(entry.usernameToken, 'alice'); // no plaintext leaked
      } else {
        assert.strictEqual(entry.username, 'alice');
        assert.ok(!('usernameToken' in entry));
      }
    });

    it('[ACCIDX-02] the access token and name are NEVER stored', async () => {
      const { platform } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow());
      const entry = await accessIndex.getAccessIndex(platform, 'cacc-base-01');
      assert.ok(!('token' in entry), 'index row must not carry the access token');
      assert.ok(!('name' in entry), 'index row must not carry the access name');
      // Belt and braces: the serialized bytes contain neither secret.
      const raw = await platform.getPlatformKv('access-index/cacc-base-01');
      assert.ok(!raw.includes('secret-token-value'));
      assert.ok(!raw.includes('oncology'));
    });

    it('[ACCIDX-03] update is a stateless full-row write: created preserved, lastModified + expires refreshed', async () => {
      const { platform } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow());
      // A later update (renamed / new expiry): created stays, lastModified bumps.
      await accessIndex.putAccessIndex(platform, 'alice', accessRow({ expires: 1900000000, modified: 1700000500 }));
      const entry = await accessIndex.getAccessIndex(platform, 'cacc-base-01');
      assert.strictEqual(entry.created, 1700000000);
      assert.strictEqual(entry.lastModified, 1700000500);
      assert.strictEqual(entry.expires, 1900000000);
    });

    it('[ACCIDX-04] markDeleted RETAINS the row with a deleted timestamp (resolvable after revocation)', async () => {
      const { platform } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow());
      await accessIndex.markAccessDeletedInIndex(platform, 'alice', accessRow(), 1700009999);
      const entry = await accessIndex.getAccessIndex(platform, 'cacc-base-01');
      assert.ok(entry != null, 'row must survive deletion');
      assert.strictEqual(entry.deleted, 1700009999);
      assert.strictEqual(entry.lastModified, 1700009999);
      assert.strictEqual(entry.created, 1700000000);
    });

    it('[ACCIDX-05] markDeleted upserts a full row even with no prior index entry (pre-backfill)', async () => {
      const { platform } = makePlatform({ hashed });
      // No prior put — delete a never-indexed access.
      await accessIndex.markAccessDeletedInIndex(platform, 'alice', accessRow(), 1700009999);
      const entry = await accessIndex.getAccessIndex(platform, 'cacc-base-01');
      assert.ok(entry != null);
      assert.strictEqual(entry.deleted, 1700009999);
      assert.strictEqual(entry.type, 'app');
    });

    it('[ACCIDX-06] getAccessIndex returns null for an unknown / empty id', async () => {
      const { platform } = makePlatform({ hashed });
      assert.strictEqual(await accessIndex.getAccessIndex(platform, 'nope'), null);
      assert.strictEqual(await accessIndex.getAccessIndex(platform, ''), null);
    });

    it('[ACCIDX-07] listAccessIndexKeys returns base ids only', async () => {
      const { platform } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow({ id: 'a1' }));
      await accessIndex.putAccessIndex(platform, 'alice', accessRow({ id: 'a2' }));
      const keys = (await accessIndex.listAccessIndexKeys(platform)).sort();
      assert.deepStrictEqual(keys, ['a1', 'a2']);
    });

    it('[ACCIDX-08] deleteAccessIndexForUser removes only that user rows (Art.17 default)', async () => {
      const { platform } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow({ id: 'a1' }));
      await accessIndex.putAccessIndex(platform, 'alice', accessRow({ id: 'a2' }));
      await accessIndex.putAccessIndex(platform, 'bob', accessRow({ id: 'b1' }));

      const removed = await accessIndex.deleteAccessIndexForUser(platform, 'alice');
      assert.strictEqual(removed, 2);
      assert.strictEqual(await accessIndex.getAccessIndex(platform, 'a1'), null);
      assert.strictEqual(await accessIndex.getAccessIndex(platform, 'a2'), null);
      assert.ok(await accessIndex.getAccessIndex(platform, 'b1') != null);
    });

    it('[ACCIDX-09] tombstoneAccessIndexForUser strips username, keeps type + deleted, sets userDeleted', async () => {
      const { platform } = makePlatform({ hashed });
      await accessIndex.putAccessIndex(platform, 'alice', accessRow({ id: 'a1' }));
      await accessIndex.markAccessDeletedInIndex(platform, 'alice', accessRow({ id: 'a2' }), 1700005000);
      await accessIndex.putAccessIndex(platform, 'bob', accessRow({ id: 'b1' }));

      const n = await accessIndex.tombstoneAccessIndexForUser(platform, 'alice', 1700009999);
      assert.strictEqual(n, 2);

      const a1 = await accessIndex.getAccessIndex(platform, 'a1');
      assert.ok(!('username' in a1) && !('usernameToken' in a1), 'no username survives cluster-wide');
      assert.strictEqual(a1.userDeleted, true);
      assert.strictEqual(a1.type, 'app');
      assert.strictEqual(a1.lastModified, 1700009999);

      const a2 = await accessIndex.getAccessIndex(platform, 'a2');
      assert.strictEqual(a2.deleted, 1700005000, 'prior deleted timestamp preserved through tombstone');
      assert.strictEqual(a2.userDeleted, true);

      // bob untouched.
      const b1 = await accessIndex.getAccessIndex(platform, 'b1');
      assert.ok(('username' in b1) || ('usernameToken' in b1));
      assert.ok(!b1.userDeleted);
    });

    it('[ACCIDX-10] safeIndexAccessMutation never rejects on a PlatformDB failure', async () => {
      const { platform } = makePlatform({ hashed });
      platform.setPlatformKv = async () => { throw new Error('rqlite quorum lost'); };
      // Must resolve (swallow), not throw — access CRUD must not break.
      await accessIndex.safeIndexAccessMutation(platform, 'alice', accessRow());
      await accessIndex.safeMarkAccessDeleted(platform, 'alice', accessRow(), Date.now());
    });
  });
}
