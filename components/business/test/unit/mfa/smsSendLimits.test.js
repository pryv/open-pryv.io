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
  const limiter = (limits = {}) => new SmsSendLimiter({ ...SEND_LIMIT_DEFAULTS, ...limits }, { kvClient: kvClient() });
  const send = (sessionId, username = 'alice', destination = '+41791234567') => ({ sessionId, username, destination });
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

  it('[MSSL1] the defaults: 30 s per session, 5 per user per hour, 10 per destination per day', () => {
    assert.deepStrictEqual(SEND_LIMIT_DEFAULTS, { minIntervalSeconds: 30, perUserPerHour: 5, perDestinationPerDay: 10 });
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
    await method.challenge('alice', profile, { headers: {}, body: { password: 'secret' }, sessionId: 's1' });
    await assertTooMany(method.challenge('alice', profile, { headers: {}, body: {}, sessionId: 's1' }));
    assert.strictEqual(calls.length, 1, 'the refused send never reached the provider service');
    assert.deepStrictEqual(calls[0][2], { headers: {}, body: {}, sessionId: 's1' }, 'nothing of the client request is passed on');
  });
});
