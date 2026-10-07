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
const clusterKv = require('messages/src/cluster_kv.ts');

/**
 * [MFSS] SMS single mode: the expected code is shared by the API workers
 * (cluster_kv) and verify refuses unless the exact pending code is sent.
 * Each service instance stands for one API worker.
 */
describe('[MFSS] mfa/SingleService', () => {
  let stopMaster, workerA, workerB, sent;

  function workerClient (cluster) {
    const clientHandle = new EventEmitter();
    const workerSink = { send: (msg) => clientHandle.emit('message', msg) };
    clientHandle.send = (msg) => cluster.emit('message', workerSink, msg);
    return clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 1000 });
  }

  function newWorker (cluster) {
    const svc = new SingleService({
      sms: { endpoints: { single: { url: 'https://sms.example', method: 'POST', headers: {}, body: '{{ code }}' } } },
      sessions: { ttlSeconds: 60 }
    }, { kvClient: workerClient(cluster) });
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

  beforeEach(() => {
    const cluster = new EventEmitter();
    clusterKv.masterStop();
    clusterKv.masterStart({ log: () => {}, cluster });
    stopMaster = () => clusterKv.masterStop();
    workerA = newWorker(cluster);
    workerB = newWorker(cluster);
    sent = null;
  });
  afterEach(() => { stopMaster(); });

  it('[MFSS1] a code sent by one worker is accepted by another, once', async () => {
    await workerA.challenge('alice', { content: {} }, { body: {} });
    assert.match(sent, /^[0-9]{4}$/);
    await workerB.verify('alice', { content: {} }, { body: { code: sent } });
    await assertRefused(workerA.verify('alice', { content: {} }, { body: { code: sent } }));
  });

  it('[MFSS2] no code sent is refused, whether or not a code is pending', async () => {
    await assertRefused(workerB.verify('bob', { content: {} }, { body: {} }));
    await workerA.challenge('bob', { content: {} }, { body: {} });
    await assertRefused(workerB.verify('bob', { content: {} }, { body: {} }));
    await assertRefused(workerB.verify('bob', { content: {} }, { body: { code: '' } }));
  });

  it('[MFSS3] a wrong code is refused and the error does not repeat it', async () => {
    await workerA.challenge('carol', { content: {} }, { body: {} });
    const wrong = sent === '0000' ? '1111' : '0000';
    const err = await assertRefused(workerB.verify('carol', { content: {} }, { body: { code: wrong } }));
    assert.notInclude(err.message, wrong);
    await assertRefused(workerB.verify('carol', { content: {} }, { body: { code: ['x'] } }));
    await assertRefused(workerB.verify('carol', { content: {} }, { body: { code: sent + 'é' } }));
  });

  it('[MFSS4] refuses a missing code even when the store answers undefined for a missing entry', async () => {
    const store = new Map();
    const svc = new SingleService({
      sms: { endpoints: { single: { url: 'https://sms.example', method: 'POST', headers: {}, body: '' } } }
    }, { kvClient: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); return true; }, delete: async (k) => { store.delete(k); } } });
    await assertRefused(svc.verify('dave', { content: {} }, { body: {} }));
    await assertRefused(svc.verify('dave', { content: {} }, { body: { code: undefined } }));
  });
});
