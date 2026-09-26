/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * UserStorage conformance test suite.
 * Tests the common BaseStorage contract: insertOne -> find -> findOne ->
 * updateOne -> delete -> findDeletions -> removeAll -> count, the backup
 * round-trip, and the update-path contract [USUP]. Run against a real
 * collection on each engine by components/storage/test/unit/userStorageConformance.test.js.
 *
 * @param {Function} getStorage - function returning an initialized BaseStorage subclass instance
 * @param {Function} getUserId - function returning a unique userId for test isolation
 * @param {Function} cleanupFn - function(userId, callback) called after tests for cleanup
 */
export default function conformanceTests (getStorage, getUserId, cleanupFn) {
  const assert = require('node:assert');
  const { validateUserStorage } = require('../UserStorage.ts');

  describe('UserStorage conformance', () => {
    let storage;
    let userId;

    before(() => {
      storage = getStorage();
      userId = getUserId();
    });

    after((done) => {
      if (cleanupFn) return cleanupFn(userId, done);
      done();
    });

    it('[US01] must pass validateUserStorage', () => {
      validateUserStorage(storage);
    });

    it('[US02] getCollectionInfo() must return name and useUserId', () => {
      const info = storage.getCollectionInfo(userId);
      assert.ok(info.name, 'must have a collection name');
      assert.strictEqual(info.useUserId, userId);
    });

    it('[US03] countAll() must return 0 initially', (done) => {
      storage.countAll(userId, (err, count) => {
        if (err) return done(err);
        assert.strictEqual(count, 0);
        done();
      });
    });

    it('[US04] insertOne() must insert an item', (done) => {
      storage.insertOne(userId, { id: 'test-item-1', data: 'hello' }, (err, result) => {
        if (err) return done(err);
        assert.ok(result, 'must return the inserted item');
        done();
      });
    });

    it('[US05] find() must return the inserted item', (done) => {
      storage.find(userId, {}, null, (err, items) => {
        if (err) return done(err);
        assert.ok(Array.isArray(items));
        assert.ok(items.length >= 1);
        done();
      });
    });

    it('[US06] findOne() must return a single item', (done) => {
      storage.findOne(userId, { id: 'test-item-1' }, null, (err, item) => {
        if (err) return done(err);
        assert.ok(item, 'must find the item');
        assert.strictEqual(item.id, 'test-item-1');
        done();
      });
    });

    it('[US07] count() must reflect inserted items', (done) => {
      storage.count(userId, {}, (err, count) => {
        if (err) return done(err);
        assert.ok(count >= 1);
        done();
      });
    });

    it('[US08] findOneAndUpdate() must update and return the item', (done) => {
      storage.findOneAndUpdate(userId, { id: 'test-item-1' }, { data: 'updated' }, (err, item) => {
        if (err) return done(err);
        assert.ok(item);
        assert.strictEqual(item.data, 'updated');
        done();
      });
    });

    it('[US09] removeOne() must remove a single item', (done) => {
      storage.insertOne(userId, { id: 'test-item-2', data: 'to-remove' }, (err) => {
        if (err) return done(err);
        storage.removeOne(userId, { id: 'test-item-2' }, (err2) => {
          if (err2) return done(err2);
          storage.findOne(userId, { id: 'test-item-2' }, null, (err3, item) => {
            if (err3) return done(err3);
            assert.strictEqual(item, null);
            done();
          });
        });
      });
    });

    it('[US10] removeAll() must remove all items', (done) => {
      storage.removeAll(userId, (err) => {
        if (err) return done(err);
        storage.countAll(userId, (err2, count) => {
          if (err2) return done(err2);
          assert.strictEqual(count, 0);
          done();
        });
      });
    });

    describe('migration methods', () => {
      it('[US11] exportAll() must return all raw documents', (done) => {
        storage.insertOne(userId, { id: 'export-1', data: 'raw' }, (err) => {
          if (err) return done(err);
          storage.exportAll(userId, (err2, docs) => {
            if (err2) return done(err2);
            assert.ok(Array.isArray(docs));
            assert.ok(docs.length >= 1);
            done();
          });
        });
      });

      it('[US12] clearAll() must remove all documents', (done) => {
        storage.clearAll(userId, (err) => {
          if (err) return done(err);
          storage.countAll(userId, (err2, count) => {
            if (err2) return done(err2);
            assert.strictEqual(count, 0);
            done();
          });
        });
      });

      it('[US13] importAll() restores what exportAll() produced (the backup round-trip)', async () => {
        const call = (fn, ...args) => new Promise((resolve, reject) => fn.call(storage, userId, ...args, (err, res) => err ? reject(err) : resolve(res)));
        await call(storage.insertOne, { id: 'import-1', data: { a: 1 } });
        await call(storage.insertOne, { id: 'import-2', data: 'imported2' });
        const byId = (docs) => [...docs].sort((x, y) => x.id.localeCompare(y.id));
        const exported = byId(await call(storage.exportAll));
        assert.strictEqual(exported.length, 2);
        await call(storage.clearAll);
        await call(storage.importAll, exported);
        assert.deepStrictEqual(byId(await call(storage.exportAll)), exported);
        await call(storage.clearAll);
      });

      it('[US14] importAll() with empty array must be a no-op', (done) => {
        storage.importAll(userId, [], (err) => {
          if (err) return done(err);
          done();
        });
      });
    });

    // The shared update-path contract (interfaces/_shared/updatePath.ts): a
    // JSON field merges ONE level, the object form's sub-keys are literal (they
    // may contain dots), and a deeper dotted key is refused on every engine.
    describe('[USUP] update paths on a JSON field', () => {
      const call = (fn, ...args) => new Promise((resolve, reject) => fn.call(storage, userId, ...args, (err, res) => err ? reject(err) : resolve(res)));
      const read = async () => (await call(storage.findOne, { id: 'upd' }, null)).data;

      beforeEach(async () => {
        await call(storage.removeAll);
        await call(storage.insertOne, { id: 'upd', data: { keep: 1, drop: 2 } });
      });

      it('[USU1] $set and $unset of "field.key" touch that one entry', async () => {
        await call(storage.updateOne, { id: 'upd' }, { $set: { 'data.added': 3 }, $unset: { 'data.drop': '' } });
        assert.deepStrictEqual(await read(), { keep: 1, added: 3 });
      });

      it('[USU2] the object form merges one level, its sub-keys literal (dots included)', async () => {
        await call(storage.updateOne, { id: 'upd' }, { data: { 'com.example.app': { x: 1 }, drop: null } });
        assert.deepStrictEqual(await read(), { keep: 1, 'com.example.app': { x: 1 } });
      });

      it('[USU3] a deeper dotted key is refused and leaves the item untouched', async () => {
        await assert.rejects(call(storage.updateOne, { id: 'upd' }, { $set: { 'data.a.b': 1 } }));
        assert.deepStrictEqual(await read(), { keep: 1, drop: 2 });
      });
    });
  });
}
