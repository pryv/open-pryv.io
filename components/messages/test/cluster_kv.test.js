/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 55 Phase 3 — clusterKv unit tests.
 *
 * Two layers:
 *   - in-memory shim: a fake `cluster` + `process` round-trip in the
 *     same process, exercising both master handler and client wire-up.
 *   - degraded-path: client without an IPC channel returns null on get,
 *     throws on set/delete/clear.
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const clusterKv = require('messages/src/clusterKv');

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

  it('masterStart is idempotent (second call no-ops)', () => {
    // Second call from the harness shouldn't throw; cluster.on listener count stable.
    clusterKv.masterStart({ log: () => {}, cluster });
    clusterKv.masterStart({ log: () => {}, cluster });
    assert.equal(cluster.listenerCount('message'), 1);
  });
});
