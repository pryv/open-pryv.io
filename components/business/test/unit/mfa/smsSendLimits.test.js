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

const { SmsSendLimiter, SEND_LIMIT_DEFAULTS, smsDestination } = require('../../../src/mfa/smsSendLimits.ts');
const { SmsMethod } = require('../../../src/mfa/index.ts');
const clusterKv = require('messages/src/cluster_kv.ts');

/**
 * [MSSL] limits on SMS sends: per MFA session (minimum interval), per user
 * (per hour) and per destination phone (per day), on cluster_kv.
 */
describe('[MSSL] mfa/smsSendLimits', () => {
  let cluster, realNow;

  function kvClient () {
    const clientHandle = new EventEmitter();
    const workerSink = { send: (msg) => clientHandle.emit('message', msg) };
    clientHandle.send = (msg) => cluster.emit('message', workerSink, msg);
    return clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 1000 });
  }
  const limiter = (limits = {}, sharedCounters = null) => new SmsSendLimiter({ ...SEND_LIMIT_DEFAULTS, ...limits }, { kvClient: kvClient(), sharedCounters });
  // The platform store's counter, in memory (shared by every limiter given it).
  function memoryCounters () {
    const rows = new Map();
    return {
      rows,
      async bumpWindowedCounter (key, max, windowMs, now) {
        const row = rows.get(key);
        if (row == null || row.windowEndsAt <= now) { rows.set(key, { count: 1, windowEndsAt: now + windowMs }); return null; }
        if (row.count >= max) return row.windowEndsAt;
        row.count++;
        return null;
      },
      async releaseWindowedCounter (key) { const row = rows.get(key); if (row != null && row.count > 0) row.count--; }
    };
  }
  const send = (sessionId, userId = 'alice-id', destination = '+41791234567') => ({ sessionId, userId, destination });
  const advanceClock = (ms) => { const base = Date.now(); Date.now = () => base + ms; };

  async function assertTooMany (promise) {
    try {
      await promise;
    } catch (err) {
      assert.strictEqual(err.id, 'too-many-attempts', err.message);
      assert.strictEqual(err.httpStatus, 429);
      const seconds = err.data.retryAfterSeconds;
      assert.ok(Number.isInteger(seconds) && seconds >= 1, `retryAfterSeconds: ${seconds}`);
      assert.strictEqual(err.httpHeaders['Retry-After'], String(seconds));
      return seconds;
    }
    assert.fail('the send should have been refused');
  }

  beforeEach(() => {
    cluster = new EventEmitter();
    clusterKv.masterStop();
    clusterKv.masterStart({ log: () => {}, cluster });
    realNow = Date.now;
  });
  afterEach(() => {
    Date.now = realNow;
    clusterKv.masterStop();
  });

  it('[MSSL1] the defaults: 30 s per session, 5 per user per hour, 100 per core per hour, 10 per destination per day', () => {
    assert.deepStrictEqual(SEND_LIMIT_DEFAULTS, { minIntervalSeconds: 30, perUserPerHour: 5, perCorePerHour: 100, perDestinationPerDay: 10 });
  });

  it('[MSSL2] a second send on one session within the interval is refused, and allowed after it', async () => {
    const l = limiter();
    await l.reserve(send('s1'));
    const seconds = await assertTooMany(l.reserve(send('s1')));
    assert.ok(seconds <= 30 && seconds >= 29, `retry in ${seconds}`);
    await l.reserve(send('s2')); // another session is not held back
    advanceClock(31000);
    await l.reserve(send('s1'));
  });

  it('[MSSL3] the 6th send of a user within an hour is refused, the window opens with the first send', async () => {
    const l = limiter({ minIntervalSeconds: 0 });
    for (let i = 0; i < 5; i++) await l.reserve(send('s' + i));
    const seconds = await assertTooMany(l.reserve(send('s5')));
    assert.ok(seconds > 3500 && seconds <= 3600, `retry in ${seconds}`);
    await l.reserve(send('s6', 'bob')); // another user is not held back
    advanceClock(3601 * 1000);
    await l.reserve(send('s7'));
  });

  it('[MSSL4] the 11th send to one destination within a day is refused, whoever the user', async () => {
    const l = limiter({ minIntervalSeconds: 0 });
    for (let i = 0; i < 10; i++) await l.reserve(send('s' + i, 'user' + i));
    const seconds = await assertTooMany(l.reserve(send('s10', 'user10')));
    assert.ok(seconds > 86000 && seconds <= 86400, `retry in ${seconds}`);
    await l.reserve(send('s11', 'user11', '+41790000000')); // another destination is not held back
  });

  it('[MSSL5] a refused send leaves no budget taken', async () => {
    const l = limiter({ perDestinationPerDay: 1 });
    await l.reserve(send('s1', 'alice'));
    // Refused on the destination: neither alice's hourly count nor the session interval is spent.
    await assertTooMany(l.reserve(send('s2', 'alice')));
    await assertTooMany(l.reserve(send('s2', 'alice')));
    const other = limiter({ perDestinationPerDay: 0, perUserPerHour: 2 });
    await other.reserve(send('s2', 'alice', '+41790000000'));
    await assertTooMany(other.reserve(send('s3', 'alice', '+41790000001')));
  });

  it('[MSSL6] parallel sends each take their own slot: exactly the limit gets through', async () => {
    const l = limiter({ minIntervalSeconds: 0, perUserPerHour: 5, perDestinationPerDay: 100 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => l.reserve(send('p' + i))));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 5);
    const sameSession = await Promise.allSettled(Array.from({ length: 10 }, () => limiter().reserve(send('one', 'zoe'))));
    assert.strictEqual(sameSession.filter((r) => r.status === 'fulfilled').length, 1);
  });

  it('[MSSL7] 0 disables a limit', async () => {
    const l = limiter({ minIntervalSeconds: 0, perUserPerHour: 0, perDestinationPerDay: 0 });
    for (let i = 0; i < 30; i++) await l.reserve(send('same'));
  });

  it('[MSSL8] the destination is keyed by a hash, never the phone in clear', async () => {
    await limiter().reserve(send('s1', 'alice', '+41791234567'));
    const keys = [...clusterKv._masterStoreForTests().keys()];
    assert.ok(keys.some((k) => /^mfa-sms-send\/destination\/[0-9a-f]{64}$/.test(k)), JSON.stringify(keys));
    assert.ok(!JSON.stringify(keys).includes('41791234567'), JSON.stringify(keys));
    assert.ok(!JSON.stringify([...clusterKv._masterStoreForTests().values()]).includes('41791234567'));
    assert.strictEqual(smsDestination({ phone: '+41791234567', language: 'fr' }), '+41791234567');
    assert.notStrictEqual(smsDestination({ number: 'a' }), smsDestination({ number: 'b' }));
  });

  it('[MSSL9] the SMS method checks the limits before it sends, and sends nothing when refused', async () => {
    const calls = [];
    const service = { challenge: async (...args) => { calls.push(args); }, verify: async () => {} };
    const method = new SmsMethod(service, [], limiter());
    const profile = { content: { phone: '+41791234567' } };
    await method.challenge('alice', profile, { headers: {}, body: { password: 'secret' }, sessionId: 's1', userId: 'alice-id' });
    await assertTooMany(method.challenge('alice', profile, { headers: {}, body: {}, sessionId: 's1', userId: 'alice-id' }));
    assert.strictEqual(calls.length, 1, 'the refused send never reached the provider service');
    assert.deepStrictEqual(calls[0][2], { headers: {}, body: {}, sessionId: 's1' }, 'nothing of the client request is passed on');
  });

  it('[MSSLA] the per-user budget follows the account, not its username', async () => {
    const calls = [];
    const service = { challenge: async (...args) => { calls.push(args); }, verify: async () => {} };
    const method = new SmsMethod(service, [], limiter({ minIntervalSeconds: 0, perUserPerHour: 2, perDestinationPerDay: 100 }));
    const profile = { content: { phone: '+41791234567' } };
    const challenge = (username, userId, sessionId) => method.challenge(username, profile, { headers: {}, body: {}, sessionId, userId });
    await challenge('alice', 'id-alice', 'a1');
    await challenge('alice', 'id-alice', 'a2');
    // a username change does not buy a fresh budget
    await assertTooMany(challenge('alice-renamed', 'id-alice', 'a3'));
    // the next holder of the released name does not inherit the spent one
    await challenge('alice', 'id-newcomer', 'n1');
    assert.strictEqual(calls.length, 3);
    // a challenge without the account's id sends nothing
    let refused = null;
    try { await challenge('carol', undefined, 'x2'); } catch (err) { refused = err; }
    assert.ok(refused != null, 'refused without a user id');
    assert.strictEqual(calls.length, 3);
  });

  it('[MSSL10] the core budget caps the sends of all users, and a refusal there gives back the user budget', async () => {
    const l = limiter({ perCorePerHour: 3 });
    for (let i = 0; i < 3; i++) await l.reserve(send('c' + i, 'user' + i, '+4179000000' + i));
    await assertTooMany(l.reserve(send('c3', 'user3', '+41790000003')));
    advanceClock(60 * 60 * 1000 + 1);
    await l.reserve(send('c4', 'user3', '+41790000003')); // user3's hour budget was not used up by the refusal
  });

  it('[MSSL11] the destination budget is shared by the cores (platform store)', async () => {
    const shared = memoryCounters();
    const coreA = limiter({}, shared);
    const coreB = limiter({}, shared);
    for (let i = 0; i < 10; i++) await (i % 2 === 0 ? coreA : coreB).reserve(send('d' + i, 'user' + i));
    await assertTooMany(coreB.reserve(send('d10', 'user10')));
    assert.strictEqual(shared.rows.size, 1);
    assert.ok(![...shared.rows.keys()][0].includes('+41791234567'), 'keyed by a hash');
  });

  it('[MSSL12] a platform store failure refuses the send and gives back the other budgets', async () => {
    const failing = { bumpWindowedCounter: async () => { throw new Error('store down'); }, releaseWindowedCounter: async () => {} };
    const l = limiter({ perUserPerHour: 1 }, failing);
    await assertTooMany(l.reserve(send('f1')));
    const ok = limiter({ perUserPerHour: 1 }, memoryCounters());
    ok.kv = l.kv; // same core counters: the user's budget was given back
    await ok.reserve(send('f2'));
  });
});
