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

const SingleService = require('../../../src/mfa/SingleService.ts').default;
const SessionStore = require('../../../src/mfa/SessionStore.ts').default;
const Profile = require('../../../src/mfa/Profile.ts').default;
const clusterKv = require('messages/src/cluster_kv.ts');

/**
 * [MFSS] SMS single mode: the expected code belongs to one MFA session (its
 * hash, in the session record, shared by the API workers through cluster_kv)
 * with its own lifetime, and verify refuses unless the exact pending code of
 * that session is sent before it expires. Each service instance stands for one
 * API worker.
 */
describe('[MFSS] mfa/SingleService', () => {
  let stopMaster, cluster, workerA, workerB, sessions, sent, realNow;
  const profile = { content: { phone: '+41791234567' } };

  function workerClient () {
    const clientHandle = new EventEmitter();
    const workerSink = { send: (msg) => clientHandle.emit('message', msg) };
    clientHandle.send = (msg) => cluster.emit('message', workerSink, msg);
    return clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 1000 });
  }

  function newWorker (opts = {}) {
    const svc = new SingleService({
      sms: { endpoints: { single: { url: 'https://sms.example', method: 'POST', headers: {}, body: '{{ code }}' } } },
      sessions: { ttlSeconds: 60 }
    }, { sessionStore: new SessionStore(60, { kvClient: workerClient() }), ...opts });
    svc._makeRequest = async (method, url, headers, body) => { sent = body; };
    return svc;
  }

  async function assertRefused (promise) {
    try {
      await promise;
    } catch (err) {
      assert.strictEqual(err.data?.id, 'invalid-mfa-code');
      return err;
    }
    assert.fail('verify should have been refused');
  }

  /** A fresh pending session; returns its id. */
  function newSession () {
    return sessions.create(new Profile(profile.content), { kind: 'login' });
  }
  const request = (sessionId, code) => ({ body: code === undefined ? {} : { code }, sessionId });
  const advanceClock = (ms) => { const base = Date.now(); Date.now = () => base + ms; };

  beforeEach(() => {
    cluster = new EventEmitter();
    clusterKv.masterStop();
    clusterKv.masterStart({ log: () => {}, cluster });
    stopMaster = () => clusterKv.masterStop();
    workerA = newWorker();
    workerB = newWorker();
    sessions = new SessionStore(60, { kvClient: workerClient() });
    sent = null;
    realNow = Date.now;
  });
  afterEach(() => {
    Date.now = realNow;
    stopMaster();
  });

  it('[MFSS1] a 6-digit code sent by one worker is accepted by another, once', async () => {
    const id = await newSession();
    await workerA.challenge('alice', profile, request(id));
    assert.match(sent, /^[0-9]{6}$/);
    await workerB.verify('alice', profile, request(id, sent));
    await assertRefused(workerA.verify('alice', profile, request(id, sent)));
  });

  it('[MFSS2] no code, no session, or no code pending on the session is refused', async () => {
    const id = await newSession();
    await assertRefused(workerB.verify('bob', profile, request(id, '123456')));
    await workerA.challenge('bob', profile, request(id));
    await assertRefused(workerB.verify('bob', profile, request(id)));
    await assertRefused(workerB.verify('bob', profile, request(id, '')));
    await assertRefused(workerB.verify('bob', profile, request(undefined, sent)));
    await assertRefused(workerB.verify('bob', profile, request('not-a-session', sent)));
  });

  it('[MFSS3] a wrong code is refused and the error does not repeat it', async () => {
    const id = await newSession();
    await workerA.challenge('carol', profile, request(id));
    const wrong = sent === '000000' ? '111111' : '000000';
    const err = await assertRefused(workerB.verify('carol', profile, request(id, wrong)));
    assert.notInclude(err.message, wrong);
    await assertRefused(workerB.verify('carol', profile, request(id, ['x'])));
    await assertRefused(workerB.verify('carol', profile, request(id, sent + 'é')));
  });

  it('[MFSS4] refuses when the store answers undefined for a missing session', async () => {
    const svc = new SingleService({
      sms: { endpoints: { single: { url: 'https://sms.example', method: 'POST', headers: {}, body: '' } } }
    }, { sessionStore: { get: async () => undefined, setSmsCode: async () => false } });
    await assertRefused(svc.verify('dave', profile, request('s1')));
    await assertRefused(svc.verify('dave', profile, request('s1', '123456')));
  });

  it('[MFSS5] a code is refused after its lifetime while its session still lives', async () => {
    const svc = newWorker({ codeTtlSeconds: 5 });
    const id = await newSession();
    await svc.challenge('erin', profile, request(id));
    const code = sent;
    advanceClock(6000);
    assert.isTrue(await sessions.has(id), 'the session outlives the code');
    await assertRefused(svc.verify('erin', profile, request(id, code)));
  });

  it('[MFSS6] two sessions get different codes, and a code works on its own session only', async () => {
    const svc = newWorker({ codeLength: 10 });
    const a = await newSession();
    const b = await newSession();
    await svc.challenge('frank', profile, request(a));
    const codeA = sent;
    await svc.challenge('frank', profile, request(b));
    const codeB = sent;
    assert.notStrictEqual(codeA, codeB);
    assert.notStrictEqual((await sessions.get(a)).smsCode.hash, (await sessions.get(b)).smsCode.hash);
    await assertRefused(svc.verify('frank', profile, request(b, codeA)));
    await svc.verify('frank', profile, request(a, codeA));
    await svc.verify('frank', profile, request(b, codeB));
  });

  it('[MFSS7] a new challenge on a session replaces its code and restarts its lifetime', async () => {
    const svc = newWorker({ codeLength: 10, codeTtlSeconds: 5 });
    const id = await newSession();
    await svc.challenge('gina', profile, request(id));
    const first = sent;
    advanceClock(4000);
    await svc.challenge('gina', profile, request(id));
    const second = sent;
    assert.notStrictEqual(first, second);
    await assertRefused(svc.verify('gina', profile, request(id, first)));
    // Past the first code's lifetime, within the second's.
    advanceClock(3000);
    await svc.verify('gina', profile, request(id, second));
  });

  it('[MFSS8] only the hash of the code is stored, never the code', async () => {
    const id = await newSession();
    await workerA.challenge('hugo', profile, request(id));
    const stored = JSON.stringify(clusterKv._masterStoreForTests().get('mfa-session/' + id));
    assert.notInclude(stored, sent);
    assert.match((await sessions.get(id)).smsCode.hash, /^[0-9a-f]{64}$/);
  });

  it('[MFSS9] a challenge on a session that is gone is refused, and nothing is sent', async () => {
    try {
      await workerA.challenge('ivan', profile, request('gone-session'));
      assert.fail('expected a refusal');
    } catch (err) {
      assert.strictEqual(err.id, 'invalid-access-token');
    }
    assert.isNull(sent);
  });
});
