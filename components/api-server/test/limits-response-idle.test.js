/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [RIDL] A client that stops reading must not hold server resources for good:
 * the API server closes a connection idle for http.responseIdleTimeoutMs, and
 * one access runs at most limits.audit.maxConcurrentReadsPerAccess streamed
 * audit reads at once (each holds a connection of the audit read pool).
 */

const http = require('node:http');
const net = require('node:net');
const { withInjectedConfig } = require('test-helpers');
const { ErrorIds } = require('errors/src/index.ts');
const {
  applyResponseIdleTimeout, readResponseIdleTimeoutMs, RESPONSE_IDLE_TIMEOUT_DEFAULT_MS,
  readAuditReadLimit, AUDIT_READS_PER_ACCESS_DEFAULT, acquireCallSlot, inflightCount
} = require('../src/callLimits.ts');

describe('[RIDL] stalled readers', function () {
  it('[RIDL1] a response the client stopped reading is cut after the idle timeout', async function () {
    this.timeout(15000);
    const chunk = Buffer.alloc(64 * 1024, 'x');
    let serverSocketClosed = null;
    const closed = new Promise((resolve) => { serverSocketClosed = resolve; });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      // Write until the client's buffers are full, then wait for a drain that never comes.
      const pump = () => { while (res.write(chunk)) { /* fill */ } res.once('drain', pump); };
      pump();
    });
    server.on('connection', (socket) => socket.on('close', () => serverSocketClosed(Date.now())));
    applyResponseIdleTimeout(server, 300);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = net.connect(server.address().port, '127.0.0.1');
    try {
      await new Promise((resolve) => client.once('connect', resolve));
      client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
      client.pause(); // never read
      const started = Date.now();
      const closedAt = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
      assert.ok(closedAt != null, 'the server closed the stalled connection');
      assert.ok(closedAt - started < 8000, 'within a few idle periods');
    } finally {
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('[RIDL2] defaults: 120 s idle timeout, 1 streamed audit read per access; 0 turns either off', function () {
    assert.strictEqual(readResponseIdleTimeoutMs(() => undefined), RESPONSE_IDLE_TIMEOUT_DEFAULT_MS);
    assert.strictEqual(RESPONSE_IDLE_TIMEOUT_DEFAULT_MS, 120000);
    assert.strictEqual(readAuditReadLimit(() => undefined), AUDIT_READS_PER_ACCESS_DEFAULT);
    assert.strictEqual(AUDIT_READS_PER_ACCESS_DEFAULT, 1);
    let set = null;
    applyResponseIdleTimeout({ setTimeout (ms) { set = ms; } }, 0);
    assert.strictEqual(set, null, '0 leaves Node\'s default (no timeout)');
    applyResponseIdleTimeout({ setTimeout (ms) { set = ms; } }, 5000);
    assert.strictEqual(set, 5000);
  });

  describe('audit reads per access', function () {
    let fixtures, username, appToken, appAccessId;

    before(async function () {
      await initTests();
      await initCore();
      fixtures = getNewFixture();
    });

    beforeEach(async function () {
      username = cuid();
      appToken = cuid();
      appAccessId = cuid();
      const streamId = cuid();
      const user = await fixtures.user(username, {});
      await user.stream({ id: streamId, name: 'ridl-' + streamId });
      await user.access({ id: appAccessId, type: 'app', token: appToken, name: 'ridl-app', permissions: [{ streamId, level: 'read' }] });
    });

    afterEach(async function () {
      await fixtures.clean();
    });

    function readOwnAudit () {
      return coreRequest.get('/' + username + '/events').set('Authorization', appToken)
        .query({ streams: JSON.stringify([':_audit:access-' + appAccessId]), limit: 20 });
    }

    it('[RIDL3] a second streamed audit read of the same access is refused while one is in progress, and the slot is given back once read', async function () {
      // Some calls of the access, so its audit stream has rows.
      for (let i = 0; i < 3; i++) await coreRequest.get('/' + username + '/events').set('Authorization', appToken);
      const held = acquireCallSlot('audit-read:' + appAccessId, AUDIT_READS_PER_ACCESS_DEFAULT);
      assert.ok(held != null, 'the test holds the access\'s only audit-read slot');
      try {
        const refused = await readOwnAudit();
        assert.strictEqual(refused.status, 429, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.error.id, ErrorIds.TooManyRequests);
        await withInjectedConfig({ limits: { audit: { maxConcurrentReadsPerAccess: 0 } } }, async () => {
          const unbounded = await readOwnAudit();
          assert.strictEqual(unbounded.status, 200, '0 disables the cap: ' + JSON.stringify(unbounded.body));
        });
      } finally {
        held();
      }
      const ok = await readOwnAudit();
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(Array.isArray(ok.body.events));
      // The read was sent: its slot is free again.
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(inflightCount('audit-read:' + appAccessId), 0);
      const again = await readOwnAudit();
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    });
  });
});
