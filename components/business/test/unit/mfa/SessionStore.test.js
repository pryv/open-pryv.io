/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('chai').assert;
const { EventEmitter } = require('node:events');

const SessionStore = require('../../../src/mfa/SessionStore.ts').default;
const Profile = require('../../../src/mfa/Profile.ts').default;
const clusterKv = require('messages/src/cluster_kv.ts');

/**
 * SessionStore is backed by clusterKv. Each test spins up a fake
 * `cluster` so master+client share an in-memory store.
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

  it('[MT6A] parallel attempts on one session each take their own slot', async () => {
    // Several guesses in flight at once (possibly on different workers): a
    // read-then-write counter lets them all read the same count.
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), { user: 'alice' });
    const slots = await Promise.all(Array.from({ length: 10 }, () => store.reserveAttempt(token, 100)));
    assert.deepEqual(slots.map((s) => s.attempts).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal((await store.get(token)).attempts, 10);
  });

  it('[MT6B] parallel attempts past the ceiling are refused, never reserved', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), { user: 'alice' });
    const slots = await Promise.all(Array.from({ length: 20 }, () => store.reserveAttempt(token, 5)));
    const reserved = slots.filter((s) => s.attempts != null).map((s) => s.attempts).sort((a, b) => a - b);
    assert.deepEqual(reserved, [1, 2, 3, 4, 5]);
    assert.isTrue(slots.filter((s) => s.attempts == null).every((s) => s.refused === 'ceiling' || s.refused === 'busy'));
    assert.equal((await store.get(token)).attempts, 5);
    assert.deepEqual(await store.reserveAttempt(token, 5), { refused: 'ceiling' });
  });

  it('[MT6C] an unknown session is refused as gone', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    assert.deepEqual(await store.reserveAttempt('not-a-real-token', 5), { refused: 'gone' });
  });

  it('[MT6D] releaseAttempt() gives one slot back, never below zero', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), { user: 'alice' });
    await store.reserveAttempt(token, 5);
    await store.reserveAttempt(token, 5);
    assert.isTrue(await store.releaseAttempt(token));
    assert.equal((await store.get(token)).attempts, 1);
    assert.isTrue(await store.releaseAttempt(token));
    assert.isFalse(await store.releaseAttempt(token));
    assert.equal((await store.get(token)).attempts, 0);
    assert.isFalse(await store.releaseAttempt('not-a-real-token'));
  });

  it('[MT7A] setSmsCode() stores a code with the session, replaces it, and keeps the attempt count', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), { user: 'alice' });
    assert.isNull((await store.get(token)).smsCode);
    await store.reserveAttempt(token, 5);
    assert.isTrue(await store.setSmsCode(token, { hash: 'h1', expiresAt: 1 }));
    assert.isTrue(await store.setSmsCode(token, { hash: 'h2', expiresAt: 2 }));
    const got = await store.get(token);
    assert.deepEqual(got.smsCode, { hash: 'h2', expiresAt: 2 });
    assert.equal(got.attempts, 1);
    assert.isTrue(await store.setSmsCode(token, null));
    assert.isNull((await store.get(token)).smsCode);
    assert.isFalse(await store.setSmsCode('not-a-real-token', { hash: 'h', expiresAt: 1 }));
  });

  it('[MT7B] takeEnrolSlot() keeps one pending enrolment per user: the previous session is cleared', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const first = await store.create(new Profile({ x: 1 }), { kind: 'enroll' });
    assert.isNull(await store.takeEnrolSlot('u1', first));
    const second = await store.create(new Profile({ x: 2 }), { kind: 'enroll' });
    assert.equal(await store.takeEnrolSlot('u1', second), first);
    assert.isFalse(await store.has(first));
    assert.isTrue(await store.has(second));
    // Another user's slot is untouched.
    const other = await store.create(new Profile({ x: 3 }), { kind: 'enroll' });
    assert.isNull(await store.takeEnrolSlot('u2', other));
    assert.isTrue(await store.has(second));
  });

  it('[MT7C] concurrent takeEnrolSlot() calls leave exactly one pending enrolment', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const tokens = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(new Profile({ i }), { kind: 'enroll' })));
    await Promise.all(tokens.map((t) => store.takeEnrolSlot('u1', t).catch(() => null)));
    const alive = [];
    for (const t of tokens) if (await store.has(t)) alive.push(t);
    assert.lengthOf(alive, 1, JSON.stringify(alive));
  });
});
