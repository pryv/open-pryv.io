/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UserStorage conformance test suite.
 * Tests the common BaseStorage contract: insertOne -> find -> findOne ->
 * updateOne -> delete -> findDeletions -> removeAll -> count.
 *
 * @param {Function} getStorage - function returning an initialized BaseStorage subclass instance
 * @param {Function} getUserId - function returning a unique userId for test isolation
 * @param {Function} cleanupFn - function(userId, callback) called after tests for cleanup
 */
module.exports = function conformanceTests (getStorage, getUserId, cleanupFn) {
  const assert = require('node:assert');
  const { validateUserStorage } = require('../UserStorage');

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

    it('[US02] getCollectionInfo() must return name, indexes, and useUserId', () => {
      const info = storage.getCollectionInfo(userId);
      assert.ok(info.name, 'must have a collection name');
      assert.ok(Array.isArray(info.indexes), 'must have indexes array');
      assert.ok(info.useUserId, 'must have useUserId');
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

      it('[US13] importAll() must insert raw documents', (done) => {
        const items = [
          { _id: 'import-1', data: 'imported', userId },
          { _id: 'import-2', data: 'imported2', userId }
        ];
        storage.importAll(userId, items, (err) => {
          if (err) return done(err);
          storage.exportAll(userId, (err2, docs) => {
            if (err2) return done(err2);
            assert.strictEqual(docs.length, 2);
            // Clean up
            storage.clearAll(userId, done);
          });
        });
      });

      it('[US14] importAll() with empty array must be a no-op', (done) => {
        storage.importAll(userId, [], (err) => {
          if (err) return done(err);
          done();
        });
      });
    });
  });
};
