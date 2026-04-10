/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('chai').assert;

const SessionStore = require('../../../src/mfa/SessionStore');
const Profile = require('../../../src/mfa/Profile');

describe('[MFAT] mfa/SessionStore', () => {
  it('[MT1A] create() returns a UUID v4 mfaToken and stores the session', () => {
    const store = new SessionStore(1800);
    const profile = new Profile({ phone: '+41' });
    const ctx = { user: 'alice' };
    const token = store.create(profile, ctx);
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.isTrue(store.has(token));
    assert.equal(store.size(), 1);
    const got = store.get(token);
    assert.equal(got.id, token);
    assert.strictEqual(got.profile, profile);
    assert.deepEqual(got.context, ctx);
  });

  it('[MT1B] each create() yields a fresh token', () => {
    const store = new SessionStore(1800);
    const a = store.create(new Profile({ x: 1 }), {});
    const b = store.create(new Profile({ x: 2 }), {});
    assert.notEqual(a, b);
    assert.equal(store.size(), 2);
  });

  it('[MT2A] get() returns undefined for unknown ids', () => {
    const store = new SessionStore(1800);
    assert.isUndefined(store.get('not-a-real-token'));
    assert.isFalse(store.has('not-a-real-token'));
  });

  it('[MT2B] clear() removes the session and returns true', () => {
    const store = new SessionStore(1800);
    const token = store.create(new Profile({ x: 1 }), {});
    assert.isTrue(store.clear(token));
    assert.isFalse(store.has(token));
    assert.equal(store.size(), 0);
  });

  it('[MT2C] clear() is idempotent — second clear returns false', () => {
    const store = new SessionStore(1800);
    const token = store.create(new Profile({ x: 1 }), {});
    assert.isTrue(store.clear(token));
    assert.isFalse(store.clear(token));
    assert.isFalse(store.clear('totally-unknown'));
  });

  it('[MT3A] sessions auto-expire after the ttl', function (done) {
    // 50 ms TTL — short to keep the test fast
    const store = new SessionStore(0.05);
    const token = store.create(new Profile({ x: 1 }), {});
    assert.isTrue(store.has(token));
    setTimeout(() => {
      assert.isFalse(store.has(token));
      assert.equal(store.size(), 0);
      done();
    }, 100);
  });

  it('[MT4A] clearAll() drops every session and cancels every timer', () => {
    const store = new SessionStore(1800);
    store.create(new Profile({ x: 1 }), {});
    store.create(new Profile({ x: 2 }), {});
    store.create(new Profile({ x: 3 }), {});
    assert.equal(store.size(), 3);
    store.clearAll();
    assert.equal(store.size(), 0);
  });
});
