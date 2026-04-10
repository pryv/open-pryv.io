/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PasswordResetRequests conformance test suite.
 * Tests: generate -> get -> destroy flow, clearAll.
 *
 * @param {Function} getStore - function returning an initialized PasswordResetRequests instance
 * @param {Function} cleanupFn - function(callback) called after tests for cleanup
 */
module.exports = function conformanceTests (getStore, cleanupFn) {
  const assert = require('node:assert');
  const { validatePasswordResetRequests } = require('../PasswordResetRequests');

  describe('PasswordResetRequests conformance', () => {
    let store;

    before(() => {
      store = getStore();
    });

    after((done) => {
      if (cleanupFn) return cleanupFn(done);
      done();
    });

    it('[PR01] must pass validatePasswordResetRequests', () => {
      validatePasswordResetRequests(store);
    });

    let resetId;
    const username = 'test-user-reset';

    it('[PR02] generate() must create a reset request and return its id', (done) => {
      store.generate(username, (err, id) => {
        if (err) return done(err);
        assert.ok(id, 'must return a reset request id');
        resetId = id;
        done();
      });
    });

    it('[PR03] get() must return the reset request', (done) => {
      store.get(resetId, username, (err, request) => {
        if (err) return done(err);
        assert.ok(request, 'must return the reset request');
        assert.strictEqual(request.username, username);
        done();
      });
    });

    it('[PR04] get() must return null for non-existent request', (done) => {
      store.get('non-existent-id', username, (err, request) => {
        if (err) return done(err);
        assert.strictEqual(request, null);
        done();
      });
    });

    it('[PR05] get() must return null for wrong username', (done) => {
      store.get(resetId, 'wrong-user', (err, request) => {
        if (err) return done(err);
        assert.strictEqual(request, null);
        done();
      });
    });

    it('[PR06] destroy() must remove the reset request', (done) => {
      store.destroy(resetId, username, (err) => {
        if (err) return done(err);
        store.get(resetId, username, (err2, request) => {
          if (err2) return done(err2);
          assert.strictEqual(request, null);
          done();
        });
      });
    });

    it('[PR07] clearAll() must remove all reset requests', (done) => {
      store.generate('user1', (err) => {
        if (err) return done(err);
        store.generate('user2', (err2) => {
          if (err2) return done(err2);
          store.clearAll((err3) => {
            if (err3) return done(err3);
            done();
          });
        });
      });
    });

    describe('migration methods', () => {
      it('[PR08] exportAll() must return all raw documents', (done) => {
        store.generate('export-user', (err) => {
          if (err) return done(err);
          store.exportAll((err2, docs) => {
            if (err2) return done(err2);
            assert.ok(Array.isArray(docs));
            assert.ok(docs.length >= 1);
            store.clearAll(done);
          });
        });
      });

      it('[PR09] importAll() must insert raw documents', (done) => {
        const items = [
          { _id: 'import-reset-1', username: 'imported-user', expires: new Date(Date.now() + 3600000) }
        ];
        store.importAll(items, (err) => {
          if (err) return done(err);
          store.get('import-reset-1', 'imported-user', (err2, request) => {
            if (err2) return done(err2);
            assert.ok(request);
            assert.strictEqual(request.username, 'imported-user');
            store.clearAll(done);
          });
        });
      });

      it('[PR10] importAll() with empty array must be a no-op', (done) => {
        store.importAll([], (err) => {
          if (err) return done(err);
          done();
        });
      });
    });
  });
};
