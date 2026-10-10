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

  it('[MT8A] create() is refused at maxPending live sessions (429 too-many-requests), and accepted again once one is cleared', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 2 });
    const a = await store.create(new Profile({ x: 1 }), {});
    await store.create(new Profile({ x: 2 }), {});
    let refused = null;
    try { await store.create(new Profile({ x: 3 }), {}); } catch (err) { refused = err; }
    assert.isNotNull(refused, 'the 3rd session must be refused');
    assert.equal(refused.httpStatus, 429);
    assert.equal(refused.id, 'too-many-requests');
    assert.deepEqual(refused.httpHeaders, { 'Retry-After': '60' });
    await store.clear(a);
    assert.isTrue(await store.has(await store.create(new Profile({ x: 4 }), {})));
  });

  it('[MT8B] enrolment slots and SMS send counters do not count toward maxPending', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 2 });
    // Other keys of the MFA state, more of them than the cap.
    for (const k of ['a', 'b', 'c']) {
      await harness.kvClient.set('mfa-sms-send/user/' + k, 1, { ttlMs: 60000 });
      await harness.kvClient.set('mfa-session-enrol-slot/' + k, 'x', { ttlMs: 60000 });
    }
    const first = await store.create(new Profile({ x: 1 }), { kind: 'enroll' });
    assert.isNull(await store.takeEnrolSlot('u1', first));
    const second = await store.create(new Profile({ x: 2 }), { kind: 'enroll' });
    assert.isNull(await store.takeEnrolSlot('u2', second));
    assert.isTrue(await store.has(first));
    assert.isTrue(await store.has(second));
  });

  it('[MT8C] maxPending: 0 disables the cap', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 0 });
    for (let i = 0; i < 5; i++) await store.create(new Profile({ i }), {});
  });

  it('[MT9A] attempts, released attempts and new SMS codes never extend a session past its creation lifetime', async () => {
    const store = new SessionStore(0.4, { kvClient: harness.kvClient }); // 400 ms
    const token = await store.create(new Profile({ x: 1 }), {});
    const until = Date.now() + 700;
    // Keep rewriting the session, as re-challenges and attempts would.
    while (Date.now() < until) {
      await store.reserveAttempt(token, 1000);
      await store.releaseAttempt(token);
      await store.setSmsCode(token, { hash: 'h', expiresAt: Date.now() + 60000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.isFalse(await store.has(token), 'the session outlived its lifetime');
    assert.deepEqual(await store.reserveAttempt(token, 1000), { refused: 'gone' });
    assert.isFalse(await store.setSmsCode(token, null));
  });

  it('[MT9B] a record past its expiresAt is refused even while the store still holds it', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), {});
    const record = await harness.kvClient.get('mfa-session/' + token);
    assert.isNumber(record.expiresAt);
    await harness.kvClient.set('mfa-session/' + token, { ...record, expiresAt: Date.now() - 1 }, { ttlMs: 60000 });
    assert.isUndefined(await store.get(token));
    assert.isFalse(await store.has(token));
    assert.deepEqual(await store.reserveAttempt(token, 5), { refused: 'gone' });
    assert.isFalse(await store.setSmsCode(token, null));
  });

  it('[MT7C] concurrent takeEnrolSlot() calls leave exactly one pending enrolment', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const tokens = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(new Profile({ i }), { kind: 'enroll' })));
    await Promise.all(tokens.map((t) => store.takeEnrolSlot('u1', t).catch(() => null)));
    const alive = [];
    for (const t of tokens) if (await store.has(t)) alive.push(t);
    assert.lengthOf(alive, 1, JSON.stringify(alive));
  });

  it('[MT7D] claimEnrolSlot() clears nothing; giveBackEnrolSlot() hands the slot back, or clears the previous one once a later claim superseded both', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const enrol = (i) => store.create(new Profile({ i }), { kind: 'enroll' });
    const first = await enrol(1);
    assert.isNull(await store.claimEnrolSlot('u1', first));
    const second = await enrol(2);
    assert.equal(await store.claimEnrolSlot('u1', second), first);
    assert.isTrue(await store.has(first), 'a claim alone clears nothing');
    // Refused: the slot goes back to the first, which stays the pending one.
    await store.giveBackEnrolSlot('u1', second, first);
    await store.clear(second);
    assert.isTrue(await store.has(first));
    const third = await enrol(3);
    assert.equal(await store.claimEnrolSlot('u1', third), first);
    // A later claim came in meanwhile: the refused one's previous is cleared.
    const fourth = await enrol(4);
    assert.equal(await store.claimEnrolSlot('u1', fourth), third);
    await store.giveBackEnrolSlot('u1', third, first);
    assert.isFalse(await store.has(first));
    assert.equal(await store.takeEnrolSlot('u1', await enrol(5)), fourth);
  });

  it('[MT10A] addToContext() adds to the context of a live session, keeps its code and attempts, and answers false once it is gone', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient });
    const token = await store.create(new Profile({ x: 1 }), { kind: 'login', user: { id: 'u1' } });
    assert.isTrue(await store.setSmsCode(token, { hash: 'h', expiresAt: Date.now() + 60000 }));
    await store.reserveAttempt(token, 5);
    assert.isTrue(await store.addToContext(token, { token: 't', apiEndpoint: 'e' }));
    const got = await store.get(token);
    assert.deepEqual(got.context, { kind: 'login', user: { id: 'u1' }, token: 't', apiEndpoint: 'e' });
    assert.equal(got.smsCode.hash, 'h');
    assert.equal(got.attempts, 1);
    await store.clear(token);
    assert.isFalse(await store.addToContext(token, { token: 't' }));
  });

  it('[MT11A] past maxPendingPerUser, a login session of a user ends that user\'s oldest one; other users are not affected', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 100, maxPendingPerUser: 2 });
    const a1 = await store.create(new Profile({ x: 1 }), { kind: 'login' }, { userKey: 'u1' });
    const a2 = await store.create(new Profile({ x: 2 }), { kind: 'login' }, { userKey: 'u1' });
    const b1 = await store.create(new Profile({ x: 3 }), { kind: 'login' }, { userKey: 'u2' });
    const a3 = await store.create(new Profile({ x: 4 }), { kind: 'login' }, { userKey: 'u1' });
    assert.isFalse(await store.has(a1), 'the oldest session of u1 was ended');
    assert.isTrue(await store.has(a2));
    assert.isTrue(await store.has(a3));
    assert.isTrue(await store.has(b1), 'u2 is not affected');
  });

  it('[MT11B] a session already ended does not count toward the user\'s cap', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 100, maxPendingPerUser: 2 });
    const a1 = await store.create(new Profile({ x: 1 }), { kind: 'login' }, { userKey: 'u1' });
    const a2 = await store.create(new Profile({ x: 2 }), { kind: 'login' }, { userKey: 'u1' });
    await store.clear(a1);
    const a3 = await store.create(new Profile({ x: 3 }), { kind: 'login' }, { userKey: 'u1' });
    assert.isTrue(await store.has(a2), 'a live session is kept while an ended one makes room');
    assert.isTrue(await store.has(a3));
  });

  it('[MT11C] concurrent creations for one user leave at most maxPendingPerUser live sessions', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 100, maxPendingPerUser: 3 });
    const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      store.create(new Profile({ i }), { kind: 'login' }, { userKey: 'u1' })));
    const ids = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    for (const s of settled) {
      if (s.status === 'rejected') assert.equal(s.reason.httpStatus, 429, String(s.reason));
    }
    let live = 0;
    for (const id of ids) if (await store.has(id)) live++;
    assert.isAtMost(live, 3);
    assert.isAtLeast(live, 1);
  });

  it('[MT11D] sessions created without a user key (enrolments) are not counted; 0 disables the per-user cap', async () => {
    const store = new SessionStore(1800, { kvClient: harness.kvClient, maxPending: 100, maxPendingPerUser: 1 });
    const e1 = await store.create(new Profile({ x: 1 }), { kind: 'enroll' });
    const l1 = await store.create(new Profile({ x: 2 }), { kind: 'login' }, { userKey: 'u1' });
    assert.isTrue(await store.has(e1));
    assert.isTrue(await store.has(l1));
    const open = new SessionStore(1800, { kvClient: harness.kvClient, namespace: 'mfa-open/', maxPending: 100, maxPendingPerUser: 0 });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await open.create(new Profile({ i }), { kind: 'login' }, { userKey: 'u1' }));
    for (const id of ids) assert.isTrue(await open.has(id));
  });
});
