/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('chai').assert;
const { EventEmitter } = require('node:events');

const SessionStore = require('../../../src/mfa/SessionStore');
const Profile = require('../../../src/mfa/Profile');
const clusterKv = require('messages/src/clusterKv');

/**
 * Plan 55 Phase 4 — SessionStore is now backed by clusterKv. Each test
 * spins up a fake `cluster` so master+client share an in-memory store.
 */

function makeKvHarness () {
  const cluster = new EventEmitter();
  clusterKv.masterStop(); // ensure clean slate
  clusterKv.masterStart({ log: () => {}, cluster });
  const clientHandle = new EventEmitter();
  const workerSink = { send: (msg) => clientHandle.emit('message', msg) };
  clientHandle.send = (msg) => cluster.emit('message', workerSink, msg);
  const kvClient = clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 1000 });
  return { kvClient, teardown: () => clusterKv.masterStop() };
}

describe('[MFAT] mfa/SessionStore', () => {
  let harness;
  beforeEach(() => { harness = makeKvHarness(); });
  afterEach(() => { harness.teardown(); });

  it('[MT1A] create() returns a UUID v4 mfaToken and stores the session', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const profile = new Profile({ phone: '+41' });
    const ctx = { user: 'alice' };
    const token = await store.create(profile, ctx);
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.isTrue(await store.has(token));
    const got = await store.get(token);
    assert.equal(got.id, token);
    // Profile is JSON-serialised through clusterKv, so the deep shape is
    // preserved but identity isn't (Object reference no longer equal).
    assert.deepEqual(got.profile.content, profile.content);
    assert.deepEqual(got.context, ctx);
  });

  it('[MT1B] each create() yields a fresh token', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const a = await store.create(new Profile({ x: 1 }), {});
    const b = await store.create(new Profile({ x: 2 }), {});
    assert.notEqual(a, b);
    assert.isTrue(await store.has(a));
    assert.isTrue(await store.has(b));
  });

  it('[MT2A] get() returns undefined for unknown ids', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    assert.isUndefined(await store.get('not-a-real-token'));
    assert.isFalse(await store.has('not-a-real-token'));
  });

  it('[MT2B] clear() removes the session and returns true', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), {});
    assert.isTrue(await store.clear(token));
    assert.isFalse(await store.has(token));
  });

  it('[MT2C] clear() is idempotent — second clear returns false', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), {});
    assert.isTrue(await store.clear(token));
    assert.isFalse(await store.clear(token));
    assert.isFalse(await store.clear('totally-unknown'));
  });

  it('[MT3A] sessions auto-expire after the ttl', async () => {
    const store = new SessionStore(0.05, { kvClient: harness.kvClient }); // 50 ms
    const token = await store.create(new Profile({ x: 1 }), {});
    assert.isTrue(await store.has(token));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.isFalse(await store.has(token));
  });

  it('[MT4A] clearAll() drops every session', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const a = await store.create(new Profile({ x: 1 }), {});
    const b = await store.create(new Profile({ x: 2 }), {});
    await store.clearAll();
    assert.isFalse(await store.has(a));
    assert.isFalse(await store.has(b));
  });

  it('[MT5A] cross-worker: two SessionStore instances on the same kv share sessions', async () => {
    // Same harness (single master-side store) but distinct client wires —
    // models two api-server workers in the same core.
    const storeA = new SessionStore(1800, { kvClient: harness.kvClient });
    const storeB = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await storeA.create(new Profile({ x: 1 }), { user: 'alice' });
    const fromB = await storeB.get(token);
    assert.isOk(fromB);
    assert.equal(fromB.id, token);
    assert.equal(fromB.context.user, 'alice');
  });
});
