/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * cluster_kv unit tests.
 *
 * Two layers:
 *   - in-memory shim: a fake `cluster` + `process` round-trip in the
 *     same process, exercising both master handler and client wire-up.
 *   - degraded-path: client without an IPC channel returns null on get,
 *     throws on set/delete/clear.
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const clusterKv = require('messages/src/cluster_kv.ts');

function makeFakeCluster () {
  // EventEmitter exposes .on/.emit/.removeListener — same surface as
  // node:cluster's primary-side message events.
  return new EventEmitter();
}

function makeFakeProcessPair () {
  // Bidirectional: client.send(msg) → reaches master via clusterEmitter
  //                master replies via worker.send(msg) → reaches client
  // The "worker" object passed to master handlers needs .send(msg) to
  // route the reply back into the client's `processHandle.on('message')`.
  const clientHandle = new EventEmitter();
  const workerSink = { send: (msg) => clientHandle.emit('message', msg) };
  return { clientHandle, workerSink };
}

describe('[CLUSTERKV] clusterKv', function () {
  this.timeout(5000);

  let cluster;

  beforeEach(() => {
    cluster = makeFakeCluster();
    clusterKv.masterStart({ log: () => {}, cluster });
  });

  afterEach(() => {
    clusterKv.masterStop();
  });

  function wireClient () {
    const { clientHandle, workerSink } = makeFakeProcessPair();
    clientHandle.send = (msg) => cluster.emit('message', workerSink, msg);
    const client = clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 1000 });
    return { client, clientHandle };
  }

  it('set + get round-trip', async () => {
    const { client } = wireClient();
    await client.set('foo', { a: 1 });
    const v = await client.get('foo');
    assert.deepEqual(v, { a: 1 });
  });

  it('[CKV1] concurrent requests share one message listener, removed when idle', async () => {
    const { client, clientHandle } = wireClient();
    let maxListeners = 0;
    const origSend = clientHandle.send;
    // Observe the listener count at each send, while requests are in flight.
    clientHandle.send = (msg) => {
      maxListeners = Math.max(maxListeners, clientHandle.listenerCount('message'));
      setImmediate(() => origSend(msg));
    };
    const values = await Promise.all(Array.from({ length: 25 }, (_, i) => client.set('k' + i, i).then(() => client.get('k' + i))));
    assert.deepEqual(values, Array.from({ length: 25 }, (_, i) => i));
    assert.equal(maxListeners, 1);
    assert.equal(clientHandle.listenerCount('message'), 0);
  });

  it('get returns null for missing key', async () => {
    const { client } = wireClient();
    const v = await client.get('absent');
    assert.equal(v, null);
  });

  it('delete removes the key', async () => {
    const { client } = wireClient();
    await client.set('foo', 42);
    await client.delete('foo');
    assert.equal(await client.get('foo'), null);
  });

  it('clear empties the store', async () => {
    const { client } = wireClient();
    await client.set('a', 1);
    await client.set('b', 2);
    await client.clear();
    assert.equal(await client.get('a'), null);
    assert.equal(await client.get('b'), null);
  });

  it('TTL: get after expire returns null + entry pruned', async () => {
    const { client } = wireClient();
    await client.set('foo', 'bar', { ttlMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await client.get('foo'), null);
    // Master store should also have lazily evicted the expired entry.
    assert.equal(clusterKv._masterStoreForTests().has('foo'), false);
  });

  it('TTL: ttlMs=0 means no expiry (lives across the gap)', async () => {
    const { client } = wireClient();
    await client.set('foo', 'bar'); // no ttl
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await client.get('foo'), 'bar');
  });

  it('cross-worker: two clients share a single master-held store', async () => {
    const a = wireClient();
    const b = wireClient();
    await a.client.set('shared', 'hello');
    assert.equal(await b.client.get('shared'), 'hello');
    await b.client.delete('shared');
    assert.equal(await a.client.get('shared'), null);
  });

  it('client without IPC channel + fallback: false : strict no-cluster semantics', async () => {
    const noChannel = { on () {}, removeListener () {} }; // no .send
    const client = clusterKv.clientFor({ processHandle: noChannel, timeoutMs: 100, fallback: false });
    assert.equal(await client.get('foo'), null);
    await assert.rejects(client.set('foo', 1), /no IPC channel/);
    await assert.rejects(client.delete('foo'), /no IPC channel/);
    await assert.rejects(client.clear(), /no IPC channel/);
  });

  it('client without IPC channel + default fallback: in-process store works', async () => {
    clusterKv._resetInProcessFallbackForTests();
    const noChannel = { on () {}, removeListener () {} }; // no .send
    const client = clusterKv.clientFor({ processHandle: noChannel });
    await client.set('foo', { v: 1 });
    assert.deepEqual(await client.get('foo'), { v: 1 });
    await client.delete('foo');
    assert.equal(await client.get('foo'), null);
  });

  it('fallback respects TTL (lazy expire)', async () => {
    clusterKv._resetInProcessFallbackForTests();
    const noChannel = { on () {}, removeListener () {} };
    const client = clusterKv.clientFor({ processHandle: noChannel });
    await client.set('foo', 'bar', { ttlMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await client.get('foo'), null);
  });

  it('client times out when master never replies', async () => {
    clusterKv.masterStop(); // unwire master so requests vanish
    const { clientHandle } = makeFakeProcessPair();
    // Provide a .send that swallows messages silently
    clientHandle.send = () => {};
    const client = clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 30 });
    await assert.rejects(client.set('foo', 1), /timed out after 30ms/);
  });

  it('listener cleanup: 0 listeners after settle', async () => {
    const { client, clientHandle } = wireClient();
    await client.set('foo', 1);
    await client.get('foo');
    await client.delete('foo');
    assert.equal(clientHandle.listenerCount('message'), 0);
  });

  it('mismatched-requestId / unrelated message types are ignored', async () => {
    const { client, clientHandle } = wireClient();
    setTimeout(() => clientHandle.emit('message', { type: 'kv:reply', requestId: 'OTHER', ok: false }), 1);
    setTimeout(() => clientHandle.emit('message', { type: 'unrelated', requestId: 'whatever' }), 2);
    // Real reply still resolves the awaited call.
    await client.set('foo', 1);
    assert.equal(await client.get('foo'), 1);
  });

  describe('[CKVC] guarded write (ifUnderPrefix)', () => {
    const guard = (max) => ({ ifUnderPrefix: { prefix: 'ns/', max } });

    it('[CKC1] writes while the prefix has room, refuses once it is full', async () => {
      const { client } = wireClient();
      assert.equal(await client.set('ns/a', 1, guard(2)), true);
      assert.equal(await client.set('ns/b', 2, guard(2)), true);
      assert.equal(await client.set('ns/c', 3, guard(2)), false);
      // The refused write stored nothing.
      assert.equal(await client.get('ns/c'), null);
    });

    it('[CKC2] an expired entry holds no slot, and is dropped as it is met', async () => {
      const { client } = wireClient();
      await client.set('ns/a', 1, guard(2));
      await client.set('ns/gone', 2, { ttlMs: 5, ifUnderPrefix: { prefix: 'ns/', max: 2 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await client.set('ns/c', 3, guard(2)), true);
      // The scan removed it rather than leaving it for the 60 s sweep.
      assert.equal(clusterKv._masterStoreForTests().has('ns/gone'), false);
    });

    it('[CKC3] the ceiling counts only its own prefix, and replacing a key is not growth', async () => {
      const { client } = wireClient();
      await client.set('other/a', 1);
      await client.set('other/b', 2);
      assert.equal(await client.set('ns/a', 1, guard(1)), true);
      // Full for new keys...
      assert.equal(await client.set('ns/b', 2, guard(1)), false);
      // ...but rewriting the existing one still works.
      assert.equal(await client.set('ns/a', 'again', guard(1)), true);
      assert.equal(await client.get('ns/a'), 'again');
    });

    it('[CKC4] an unguarded write is never refused, and the fallback guards the same way', async () => {
      const { client } = wireClient();
      await client.set('ns/a', 1, guard(1));
      assert.equal(await client.set('ns/plain', 2), true);

      clusterKv._resetInProcessFallbackForTests();
      const fallback = clusterKv.clientFor({ processHandle: {} });
      assert.equal(await fallback.set('ns/a', 1, guard(1)), true);
      assert.equal(await fallback.set('ns/b', 2, guard(1)), false);
      assert.equal(await fallback.set('ns/b', 2), true);
      clusterKv._resetInProcessFallbackForTests();
    });

    it('[CKC5] a guarded write fails loud when the master answers without a verdict', async () => {
      const { clientHandle } = makeFakeProcessPair();
      // A master that does not know the guard replies ok with no value; the
      // ceiling must not silently switch off.
      clientHandle.send = (msg) => setImmediate(() =>
        clientHandle.emit('message', { type: 'kv:reply', requestId: msg.requestId, ok: true }));
      const client = clusterKv.clientFor({ processHandle: clientHandle, timeoutMs: 1000 });
      await assert.rejects(() => client.set('ns/a', 1, guard(1)), /no boolean reply/);
    });
  });

  describe('[CKVI] the in-process fallback isolates values like the IPC channel', () => {
    it('[CKVI1] mutating what was read back does not rewrite the stored value', async () => {
      clusterKv._resetInProcessFallbackForTests();
      const client = clusterKv.clientFor({ processHandle: {} });
      await client.set('iso/a', { status: 'PENDING', nested: { n: 1 } });

      const first = await client.get('iso/a');
      first.status = 'ACCEPTED';
      first.nested.n = 99;

      const second = await client.get('iso/a');
      assert.equal(second.status, 'PENDING', 'a reader must not be able to rewrite stored state');
      assert.equal(second.nested.n, 1, 'nested values are detached too');
      clusterKv._resetInProcessFallbackForTests();
    });

    it('[CKVI2] mutating what was written does not rewrite the stored value', async () => {
      clusterKv._resetInProcessFallbackForTests();
      const client = clusterKv.clientFor({ processHandle: {} });
      const written = { status: 'PENDING' };
      await client.set('iso/b', written);
      written.status = 'ACCEPTED';

      const read = await client.get('iso/b');
      assert.equal(read.status, 'PENDING', 'the store keeps its own copy of what was written');
      clusterKv._resetInProcessFallbackForTests();
    });

    it('[CKVI3] two readers get independent objects', async () => {
      clusterKv._resetInProcessFallbackForTests();
      const client = clusterKv.clientFor({ processHandle: {} });
      await client.set('iso/c', { n: 1 });
      const a = await client.get('iso/c');
      const b = await client.get('iso/c');
      assert.notEqual(a, b, 'each read yields its own object');
      a.n = 2;
      assert.equal(b.n, 1);
      clusterKv._resetInProcessFallbackForTests();
    });
  });

  it('masterStart is idempotent (second call no-ops)', () => {
    // Second call from the harness shouldn't throw; cluster.on listener count stable.
    clusterKv.masterStart({ log: () => {}, cluster });
    clusterKv.masterStart({ log: () => {}, cluster });
    assert.equal(cluster.listenerCount('message'), 1);
  });
});
