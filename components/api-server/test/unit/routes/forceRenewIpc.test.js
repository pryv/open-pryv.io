/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

require('test-helpers/src/api-server-tests-config');

/**
 * Plan 54 Phase D — unit tests for the worker-side IPC client used by
 * POST /system/admin/certs/force-renew. Stubs `process` so we can drive
 * master replies without spinning up the cluster.
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { forceRenew } = require('api-server/src/routes/forceRenewIpc');

function makeFakeProcess (replyFn) {
  // EventEmitter gives us .on/.removeListener; we add .send to round-trip
  // the master reply via a microtask.
  const ee = new EventEmitter();
  ee.send = (msg) => {
    queueMicrotask(() => {
      const reply = replyFn(msg);
      if (reply !== undefined) ee.emit('message', reply);
    });
  };
  return ee;
}

describe('[FORCERENEWIPC] forceRenewIpc.forceRenew', function () {
  it('happy path: master replies ok with hostname/expiresAt → resolves to {ok:true,...}', async () => {
    const issuedAt = Date.now() - 1000;
    const expiresAt = Date.now() + 90 * 24 * 3600 * 1000;
    const proc = makeFakeProcess((sent) => {
      assert.equal(sent.type, 'acme:force-renew');
      assert.ok(sent.requestId);
      assert.equal(sent.hostname, '*.example.com');
      return {
        type: 'acme:force-renew:reply',
        requestId: sent.requestId,
        ok: true,
        hostname: '*.example.com',
        issuedAt,
        expiresAt
      };
    });
    const reply = await forceRenew({ hostname: '*.example.com', processHandle: proc, timeoutMs: 1000 });
    assert.equal(reply.ok, true);
    assert.equal(reply.hostname, '*.example.com');
    assert.equal(reply.issuedAt, issuedAt);
    assert.equal(reply.expiresAt, expiresAt);
  });

  it('master replies ok:false with reason → resolves with that reason', async () => {
    const proc = makeFakeProcess((sent) => ({
      type: 'acme:force-renew:reply',
      requestId: sent.requestId,
      ok: false,
      error: 'not the certRenewer core'
    }));
    const reply = await forceRenew({ processHandle: proc, timeoutMs: 1000 });
    assert.equal(reply.ok, false);
    assert.equal(reply.error, 'not the certRenewer core');
  });

  it('ignores reply with mismatched requestId until the matching one arrives', async () => {
    const proc = makeFakeProcess((sent) => undefined);
    // Hand-emit a noise reply, then the matching reply.
    setTimeout(() => proc.emit('message', { type: 'acme:force-renew:reply', requestId: 'OTHER', ok: false }), 5);
    setTimeout(() => proc.emit('message', { type: 'unrelated', requestId: 'whatever' }), 10);
    setTimeout(() => {
      // Re-trigger with the actual requestId by intercepting the next send.
    }, 0);
    proc.send = (msg) => {
      // Reply only after a couple of unrelated messages have flowed.
      setTimeout(() => proc.emit('message', {
        type: 'acme:force-renew:reply',
        requestId: msg.requestId,
        ok: true,
        hostname: 'h.example.com',
        issuedAt: 1,
        expiresAt: 2
      }), 20);
    };
    const reply = await forceRenew({ processHandle: proc, timeoutMs: 1000 });
    assert.equal(reply.ok, true);
    assert.equal(reply.hostname, 'h.example.com');
  });

  it('times out when master never replies', async () => {
    const proc = makeFakeProcess(() => undefined); // master never replies
    const reply = await forceRenew({ processHandle: proc, timeoutMs: 30 });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /timed out after 30ms/);
  });

  it('returns ok:false when running outside cluster (no process.send)', async () => {
    const reply = await forceRenew({ processHandle: { on () {}, removeListener () {} } });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /no IPC channel/);
  });

  it('surfaces process.send synchronous throws', async () => {
    const proc = new EventEmitter();
    proc.send = () => { throw new Error('IPC channel closed'); };
    const reply = await forceRenew({ processHandle: proc, timeoutMs: 1000 });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /IPC send failed.*IPC channel closed/);
  });

  it('removes its message listener after settling (no leak)', async () => {
    const proc = makeFakeProcess((sent) => ({
      type: 'acme:force-renew:reply',
      requestId: sent.requestId,
      ok: true,
      hostname: 'h',
      issuedAt: 1,
      expiresAt: 2
    }));
    await forceRenew({ processHandle: proc, timeoutMs: 1000 });
    assert.equal(proc.listenerCount('message'), 0);
  });
});
