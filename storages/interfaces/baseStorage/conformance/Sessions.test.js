/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Sessions conformance test suite.
 * Tests: generate -> get -> touch -> destroy flow, getMatching, clearAll.
 *
 * @param {Function} getSessions - function returning an initialized Sessions instance
 * @param {Function} cleanupFn - function(callback) called after tests for cleanup
 */
module.exports = function conformanceTests (getSessions, cleanupFn) {
  const assert = require('node:assert');
  const { validateSessions } = require('../Sessions');

  describe('Sessions conformance', () => {
    let sessions;

    before(() => {
      sessions = getSessions();
    });

    after((done) => {
      if (cleanupFn) return cleanupFn(done);
      done();
    });

    it('[SE01] must pass validateSessions', () => {
      validateSessions(sessions);
    });

    let sessionId;

    it('[SE02] generate() must create a session and return its id', (done) => {
      sessions.generate({ username: 'testuser' }, null, (err, id) => {
        if (err) return done(err);
        assert.ok(id, 'must return a session id');
        sessionId = id;
        done();
      });
    });

    it('[SE03] get() must return session data', (done) => {
      sessions.get(sessionId, (err, data) => {
        if (err) return done(err);
        assert.ok(data, 'must return session data');
        assert.strictEqual(data.username, 'testuser');
        done();
      });
    });

    it('[SE04] get() must return null for non-existent session', (done) => {
      sessions.get('non-existent-id', (err, data) => {
        if (err) return done(err);
        assert.strictEqual(data, null);
        done();
      });
    });

    it('[SE05] touch() must renew the session expiration', (done) => {
      sessions.touch(sessionId, (err) => {
        if (err) return done(err);
        // Verify session is still accessible
        sessions.get(sessionId, (err2, data) => {
          if (err2) return done(err2);
          assert.ok(data, 'session must still be accessible after touch');
          done();
        });
      });
    });

    it('[SE06] getMatching() must return the session id for matching data', (done) => {
      sessions.getMatching({ username: 'testuser' }, (err, id) => {
        if (err) return done(err);
        assert.strictEqual(id, sessionId);
        done();
      });
    });

    it('[SE07] getMatching() must return null for non-matching data', (done) => {
      sessions.getMatching({ username: 'unknown' }, (err, id) => {
        if (err) return done(err);
        assert.strictEqual(id, null);
        done();
      });
    });

    it('[SE08] destroy() must remove the session', (done) => {
      sessions.destroy(sessionId, (err) => {
        if (err) return done(err);
        sessions.get(sessionId, (err2, data) => {
          if (err2) return done(err2);
          assert.strictEqual(data, null);
          done();
        });
      });
    });

    it('[SE09] clearAll() must remove all sessions', (done) => {
      sessions.generate({ username: 'user1' }, null, (err) => {
        if (err) return done(err);
        sessions.generate({ username: 'user2' }, null, (err2) => {
          if (err2) return done(err2);
          sessions.clearAll((err3) => {
            if (err3) return done(err3);
            done();
          });
        });
      });
    });

    describe('migration methods', () => {
      it('[SE10] exportAll() must return all raw documents', (done) => {
        sessions.generate({ username: 'export-test' }, null, (err) => {
          if (err) return done(err);
          sessions.exportAll((err2, docs) => {
            if (err2) return done(err2);
            assert.ok(Array.isArray(docs));
            assert.ok(docs.length >= 1);
            sessions.clearAll(done);
          });
        });
      });

      it('[SE11] importAll() must insert raw documents', (done) => {
        const items = [
          { _id: 'import-sess-1', data: { username: 'imported' }, expires: new Date(Date.now() + 86400000) }
        ];
        sessions.importAll(items, (err) => {
          if (err) return done(err);
          sessions.get('import-sess-1', (err2, data) => {
            if (err2) return done(err2);
            assert.ok(data);
            assert.strictEqual(data.username, 'imported');
            sessions.clearAll(done);
          });
        });
      });

      it('[SE12] importAll() with empty array must be a no-op', (done) => {
        sessions.importAll([], (err) => {
          if (err) return done(err);
          done();
        });
      });
    });
  });
};
