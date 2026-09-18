/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
const timestamp = require('unix-timestamp');
const sinon = require('sinon');
const assert = require('node:assert');
const MethodContext = require('../../src/MethodContext.ts').default;
const cache = require('cache').default;

const contextSource = {
  name: 'test',
  ip: '127.0.0.1'
};

describe('[MCTX] MethodContext', () => {
  describe('[MCTX1] #parseAuth', () => {
    const username = 'USERNAME';
    const customAuthStep = null;
    it('[ZRW8] should parse token out', () => {
      const mc = new MethodContext(contextSource, username, 'TOKEN', customAuthStep);
      assert.strictEqual(mc.accessToken, 'TOKEN');
      assert.strictEqual(mc.callerId, null);
    });
    it('[AUIY] should also parse the callerId when available', () => {
      const mc = new MethodContext(contextSource, username, 'TOKEN CALLERID', customAuthStep);
      assert.strictEqual(mc.accessToken, 'TOKEN');
      assert.strictEqual(mc.callerId, 'CALLERID');
    });
  });

  describe('[MCTX4] #originalQuery (what the audit trail records)', () => {
    const username = 'USERNAME';
    it('[MCQT] keeps no credential: the call\'s own auth and an app-chosen access token are dropped', () => {
      const query = {
        auth: 'CALL-TOKEN',
        token: 'app-chosen-access-token',
        requestingAppId: 'an-app',
        expireAfter: 3600
      };
      const mc = new MethodContext(contextSource, username, 'TOKEN', null, {}, query, null);
      assert.strictEqual(mc.originalQuery.auth, undefined);
      assert.strictEqual(mc.originalQuery.token, undefined);
      // everything else is kept for the audit trail
      assert.strictEqual(mc.originalQuery.requestingAppId, 'an-app');
      assert.strictEqual(mc.originalQuery.expireAfter, 3600);
      // the caller's object is not mutated
      assert.strictEqual(query.token, 'app-chosen-access-token');
    });
  });

  describe('[MCTX2] #retrieveAccessFromId', () => {
    const username = 'USERNAME';
    const customAuthStep = null;
    let access;
    let mc, findOne, storage;
    beforeEach(() => {
      mc = new MethodContext(contextSource, username, 'TOKEN CALLERID', customAuthStep);
      access = {
        id: 'accessIdFromAccess',
        token: 'tokenFromAccess'
      };
      findOne = sinon.fake.yields(null, access);
      storage = {
        accesses: {
          findOne
        }
      };
    });
    it('[OJW2] checks expiry of the access', async () => {
      access.expires = timestamp.now('-1d');
      let caught = false;
      try {
        // storage is a fake
        await mc.retrieveAccessFromId(storage, 'accessId');
      } catch (err) {
        caught = true;
      }
      assert.strictEqual(caught, true);
    });
  });

  describe('[MCTX3] #_retrieveAccess set-after-unset cache fence', () => {
    const username = 'USERNAME';
    const customAuthStep = null;
    let mc, userId, staleAccess;

    before(async () => {
      // Guarantee the cache is active so the fence is actually exercised.
      await cache.loadConfiguration();
    });
    let seq = 0;
    beforeEach(() => {
      userId = 'mcuser-' + (++seq) + '-' + process.pid; // unique: avoid cross-test cache state
      staleAccess = { id: 'aid-' + userId, token: 'tok-' + userId };
      mc = new MethodContext(contextSource, username, staleAccess.token, customAuthStep);
      mc.user = { id: userId, username };
    });
    afterEach(() => {
      cache.unsetAccessLogic(userId, staleAccess);
    });

    it('[MCEF] skips the cache insert when an unset lands during the storage read', async () => {
      const storage = {
        accesses: {
          findOne: (user, query, options, cb) => {
            // concurrent invalidation lands mid-read (local or cross-process)
            cache.unsetAccessLogic(userId, { id: staleAccess.id, token: staleAccess.token });
            cb(null, staleAccess);
          }
        }
      };
      await mc.retrieveAccessFromToken(storage);
      // the request's own read stays authoritative for THIS request
      assert.ok(mc.access != null);
      assert.strictEqual(mc.access.id, staleAccess.id);
      // but the shared cache must NOT have been poisoned for later requests
      assert.ok(cache.getAccessLogicForToken(userId, staleAccess.token) == null, 'stale entry must not be cached');
    });

    it('[MCED] same fence via unsetUserData landing mid-read', async () => {
      const storage = {
        accesses: {
          findOne: (user, query, options, cb) => {
            cache.unsetUserData(userId);
            cb(null, staleAccess);
          }
        }
      };
      await mc.retrieveAccessFromToken(storage);
      assert.ok(cache.getAccessLogicForToken(userId, staleAccess.token) == null, 'stale entry must not be cached');
    });

    it('[MCEC] control: caches the access when no unset intervenes', async () => {
      const storage = { accesses: { findOne: sinon.fake.yields(null, staleAccess) } };
      await mc.retrieveAccessFromToken(storage);
      const cached = cache.getAccessLogicForToken(userId, staleAccess.token);
      assert.ok(cached != null, 'entry should be cached');
      assert.strictEqual(cached.id, staleAccess.id);
    });
  });
});
