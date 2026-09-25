/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * UserAccountStorage conformance test suite.
 * @param {Function} getStorage - async function returning an initialized UserAccountStorage instance
 * @param {Function} cleanupFn - async function called after tests for cleanup (receives userId)
 */
export default function conformanceTests (getStorage, cleanupFn) {
  const assert = require('node:assert');
  const cuid = require('cuid');
  const timestamp = require('unix-timestamp');
  const encryption = require('utils').encryption;

  describe('UserAccountStorage conformance', () => {
    const passwords = [];
    const userId = cuid();
    let storage;

    before(async () => {
      storage = await getStorage();
      // create five passwords with one day delay between each other
      const now = timestamp.now();
      for (let i = 4; i >= 0; i--) {
        const password = `pass_${i}`;
        const passwordHash = await encryption.hash(password);
        const created = await storage.addPasswordHash(userId, passwordHash, 'test', timestamp.add(now, `-${i}d`));
        assert.ok(created.time != null);
        created.password = password;
        passwords.push(created);
      }
    });

    after(async () => {
      if (cleanupFn) await cleanupFn(userId);
    });

    describe('addPasswordHash()', () => {
      it('[B2I7] must throw an error if two passwords are added with the same time', async () => {
        const userId2 = cuid();
        const now = timestamp.now();
        await storage.addPasswordHash(userId2, 'hash_1', 'test', now);
        try {
          await storage.addPasswordHash(userId2, 'hash_2', 'test', now);
          assert.fail('should throw an error');
        } catch (e) {
          if (e.code === 'ERR_ASSERTION') throw e;
          // Expected: duplicate time constraint violation
        } finally {
          await storage._clearAll(userId2);
        }
      });
    });

    describe('getPasswordHash()', () => {
      it('must return the most recent password hash', async () => {
        const hash = await storage.getPasswordHash(userId);
        assert.ok(hash != null);
        // The most recent password is the last one added (pass_0)
        const lastPassword = passwords[passwords.length - 1];
        assert.strictEqual(hash, lastPassword.hash);
      });
    });

    describe('getCurrentPasswordTime()', () => {
      it('[85PW] must return the time of the current password', async () => {
        const uId = cuid();
        const time = timestamp.now('-1w');
        await storage.addPasswordHash(uId, 'hash', 'test', time);
        const actualTime = await storage.getCurrentPasswordTime(uId);
        assert.strictEqual(actualTime, time, 'times should match');
      });

      it('[V54S] must throw an error if there is no password for the user id', async () => {
        try {
          await storage.getCurrentPasswordTime(cuid());
        } catch (e) {
          assert.match(e.message, /No password found/);
          return;
        }
        assert.fail('should throw an error');
      });
    });

    describe('passwordExistsInHistory()', () => {
      it('[1OQP] must return true when looking for existing passwords', async () => {
        for (const password of passwords) {
          const passwordExists = await storage.passwordExistsInHistory(userId, password.password, passwords.length);
          assert.strictEqual(passwordExists, true, 'should find password ' + JSON.stringify(password));
        }
      });

      it('[DO33] must return false when looking for a non-existing password', async () => {
        const passwordExists = await storage.passwordExistsInHistory(userId, 'unknown-password', passwords.length);
        assert.strictEqual(passwordExists, false, 'should not find password with non-existing hash');
      });

      it('[FEYP] must return false when looking for an existing password that is beyond the given range', async () => {
        const oldestPassword = passwords[0];
        const passwordExists = await storage.passwordExistsInHistory(userId, oldestPassword.password, passwords.length - 1);
        assert.strictEqual(passwordExists, false, 'should not find password beyond the given range: ' + JSON.stringify(oldestPassword));
      });
    });

    describe('getKeyValueDataForStore()', () => {
      const storeId = 'test-store-' + cuid();

      it('must set and get a value', async () => {
        const kvStore = storage.getKeyValueDataForStore(storeId);
        await kvStore.set(userId, 'key1', { some: 'value' });
        const value = await kvStore.get(userId, 'key1');
        assert.deepStrictEqual(value, { some: 'value' });
      });

      it('must return null for non-existing key', async () => {
        const kvStore = storage.getKeyValueDataForStore(storeId);
        const value = await kvStore.get(userId, 'non-existing');
        assert.strictEqual(value, null);
      });

      it('must return all values with getAll', async () => {
        const kvStore = storage.getKeyValueDataForStore(storeId);
        await kvStore.set(userId, 'key2', 'value2');
        const all = await kvStore.getAll(userId);
        assert.ok(all.key1 != null);
        assert.ok(all.key2 != null);
      });
    });

    describe('clearHistory()', () => {
      it('must clear password history for user', async () => {
        const uId = cuid();
        await storage.addPasswordHash(uId, 'hash1', 'test', timestamp.now());
        await storage.clearHistory(uId);
        const hash = await storage.getPasswordHash(uId);
        assert.strictEqual(hash, undefined);
      });
    });

    describe('migration methods', () => {
      it('_exportAll() must return passwords and storeKeyValues', async () => {
        const uId = cuid();
        const time = timestamp.now();
        await storage.addPasswordHash(uId, 'hash_export', 'test', time);
        const kvStore = storage.getKeyValueDataForStore('migration-store');
        await kvStore.set(uId, 'mkey', 'mvalue');

        const data = await storage._exportAll(uId);
        assert.ok(Array.isArray(data.passwords));
        assert.ok(data.passwords.length >= 1);
        assert.ok(Array.isArray(data.storeKeyValues));
      });

      it('[UAX1] _exportAll() then _importAll() must round-trip the password history with its author', async () => {
        const src = cuid();
        const dst = cuid();
        const t0 = timestamp.now('-2d');
        const t1 = timestamp.now('-1d');
        await storage.addPasswordHash(src, 'hash_rt_0', 'access-a', t0);
        await storage.addPasswordHash(src, 'hash_rt_1', 'access-b', t1);

        const exported = await storage._exportAll(src);
        const byTime = (a, b) => a.time - b.time;
        assert.deepStrictEqual(
          exported.passwords.map(p => ({ hash: p.hash, time: p.time, createdBy: p.createdBy })).sort(byTime),
          [
            { hash: 'hash_rt_0', time: t0, createdBy: 'access-a' },
            { hash: 'hash_rt_1', time: t1, createdBy: 'access-b' }
          ]
        );

        await storage._importAll(dst, exported);
        const reExported = await storage._exportAll(dst);
        assert.deepStrictEqual(
          reExported.passwords.map(p => ({ hash: p.hash, time: p.time, createdBy: p.createdBy })).sort(byTime),
          exported.passwords.map(p => ({ hash: p.hash, time: p.time, createdBy: p.createdBy })).sort(byTime)
        );
        assert.strictEqual(await storage.getPasswordHash(dst), 'hash_rt_1');
        await storage._clearAll(src);
        await storage._clearAll(dst);
      });

      it('[UAX2] _importAll() must accept a legacy export whose password history lacks createdBy', async () => {
        const dst = cuid();
        const time = timestamp.now('-1d');
        await storage._importAll(dst, {
          passwords: [{ hash: 'hash_legacy', time }],
          storeKeyValues: []
        });
        assert.strictEqual(await storage.getPasswordHash(dst), 'hash_legacy');
        await storage._clearAll(dst);
      });

      it('_clearAll() must remove all data for user', async () => {
        const uId = cuid();
        await storage.addPasswordHash(uId, 'hash_clear', 'test', timestamp.now());
        await storage._clearAll(uId);
        const hash = await storage.getPasswordHash(uId);
        assert.strictEqual(hash, undefined);
      });
    });
  });
}
