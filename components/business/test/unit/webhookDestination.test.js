/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const http = require('node:http');
const {
  isRefusedAddress,
  compileAllowList,
  describeWebhooksConfig,
  webhookUrlProblem,
  postWebhook,
  describeCallFailure,
  WebhookCallError
} = require('../../src/webhooks/destination.ts');

const NONE = compileAllowList([]);

describe('[WDST] webhook destinations', function () {
  describe('[WDS1] address rules', function () {
    it('[WDA1] refuses loopback, private, CGNAT, link-local, unspecified, multicast, broadcast and reserved IPv4', function () {
      for (const address of [
        '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
        '100.64.0.1', '100.127.255.255', '169.254.169.254', '169.254.0.1', '0.0.0.0', '0.1.2.3',
        '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', '192.0.0.8', '198.18.0.1'
      ]) {
        assert.equal(isRefusedAddress(address, NONE), true, address);
      }
    });

    it('[WDA2] refuses IPv6 loopback, unspecified, unique-local, link-local, multicast, Teredo and IPv6 forms of refused IPv4', function () {
      for (const address of [
        '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', 'fec0::1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
        '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '::127.0.0.1',
        // Local-use NAT64 (RFC 8215): read in its /96 layout, refused as a block otherwise.
        '64:ff9b:1::7f00:1', '64:ff9b:1::a9fe:a9fe', '64:ff9b:1:808:8:800::', '64:ff9b:1:ffff::808:808',
        // Teredo (2001::/32), whatever the IPv4 address it carries.
        '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1'
      ]) {
        assert.equal(isRefusedAddress(address, NONE), true, address);
      }
    });

    it('[WDA3] accepts public addresses, also in their IPv6 forms', function () {
      for (const address of [
        '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.255.0.1', '2606:4700:4700::1111',
        '2a00:1450:4001::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '64:ff9b:1::808:808'
      ]) {
        assert.equal(isRefusedAddress(address, NONE), false, address);
      }
    });

    it('[WDA4] refuses anything that is not an IP address', function () {
      for (const value of ['localhost', 'example.com', '', '1.2.3', 'fe80::1%en0x']) {
        assert.equal(isRefusedAddress(value, NONE), true, value);
      }
    });

    it('[WDA5] the allow-list lifts the rule for its addresses and ranges only', function () {
      const allow = compileAllowList(['10.1.2.0/24', '127.0.0.1', 'fd00:1::/32']);
      assert.equal(isRefusedAddress('10.1.2.3', allow), false);
      assert.equal(isRefusedAddress('10.1.3.3', allow), true);
      assert.equal(isRefusedAddress('127.0.0.1', allow), false);
      assert.equal(isRefusedAddress('::ffff:127.0.0.1', allow), false);
      assert.equal(isRefusedAddress('127.0.0.2', allow), true);
      assert.equal(isRefusedAddress('fd00:1::5', allow), false);
      assert.equal(isRefusedAddress('fd00:2::5', allow), true);
    });
  });

  describe('[WDS2] URL rules decided without resolving the host', function () {
    it('[WDB1] accepts https and http URLs with a host name', function () {
      for (const url of ['https://hooks.example.com/pryv?u=1', 'http://hooks.example.com:8080/x', 'https://8.8.8.8/hook']) {
        assert.equal(webhookUrlProblem(url, NONE), null, url);
      }
    });

    it('[WDB2] refuses other schemes, credentials, relative and over-long URLs', function () {
      for (const url of [
        'ftp://hooks.example.com/', 'file:///etc/hosts', 'gopher://hooks.example.com/', 'javascript:alert(1)',
        'https://user:pass@hooks.example.com/', 'https://user@hooks.example.com/', '/relative/path', 'yololo', '',
        'https://hooks.example.com/' + 'a'.repeat(2048), 123, null
      ]) {
        assert.notEqual(webhookUrlProblem(url, NONE), null, String(url).slice(0, 60));
      }
    });

    it('[WDB3] refuses IP literals in refused ranges, in every notation the URL parser accepts', function () {
      for (const url of [
        'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/',
        'http://10.0.0.1/', 'http://192.168.0.10:8080/', 'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://0.0.0.0/',
        'http://127.0.0.1./'
      ]) {
        assert.notEqual(webhookUrlProblem(url, NONE), null, url);
      }
    });

    it('[WDB4] accepts an allow-listed IP literal', function () {
      const allow = compileAllowList(['10.1.2.0/24']);
      assert.equal(webhookUrlProblem('http://10.1.2.3/hook', allow), null);
      assert.notEqual(webhookUrlProblem('http://10.1.3.3/hook', allow), null);
    });
  });

  describe('[WDS3] config check', function () {
    it('[WDC1] accepts the default and valid entries', function () {
      assert.deepEqual(describeWebhooksConfig({ minIntervalMs: 5000, allowedPrivateHosts: [], requestTimeoutMs: 10000 }).problems, []);
      assert.deepEqual(describeWebhooksConfig(undefined).problems, []);
      assert.deepEqual(describeWebhooksConfig({ allowedPrivateHosts: ['hooks.internal', '10.0.0.0/8', '::1', 'fd00::/8', '[::1]'] }).problems, []);
    });

    it('[WDC2] reports an unusable list, entries and timeout', function () {
      assert.equal(describeWebhooksConfig({ allowedPrivateHosts: '10.0.0.0/8' }).problems.length, 1);
      const { problems } = describeWebhooksConfig({ allowedPrivateHosts: ['', 12, '10.0.0.0/33', '0.0.0.0/0', '::/0', 'not a host', '10.0.0.0/8/1', 'ok.example'] });
      assert.deepEqual(problems.map((p) => p.path[2]), [0, 1, 2, 3, 4, 5, 6]);
      assert.equal(describeWebhooksConfig({ requestTimeoutMs: 0 }).problems.length, 1);
      assert.equal(describeWebhooksConfig({ requestTimeoutMs: '1000' }).problems.length, 1);
    });
  });

  describe('[WDS4] calls', function () {
    const receivers = [];
    // A receiver on the loopback interface; `handler` decides the answer.
    async function receiver (handler) {
      const r = { requests: [], server: null, port: 0 };
      r.server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          r.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
          handler(req, res);
        });
      });
      await new Promise((resolve) => r.server.listen(0, '127.0.0.1', resolve));
      r.port = r.server.address().port;
      receivers.push(r);
      return r;
    }
    after(async function () {
      for (const r of receivers) {
        r.server.closeAllConnections();
        await new Promise((resolve) => r.server.close(resolve));
      }
    });
    const settings = (allowed, timeoutMs = 2000) => ({ allow: compileAllowList(allowed), timeoutMs });
    async function failure (promise) {
      try {
        await promise;
      } catch (e) {
        return e;
      }
      assert.fail('the call should have failed');
    }

    it('[WXA1] posts the JSON payload and resolves with the 2xx status', async function () {
      const r = await receiver((req, res) => { res.statusCode = 201; res.end('{}'); });
      const res = await postWebhook(`http://127.0.0.1:${r.port}/hook?a=1`, { messages: ['m'] }, settings(['127.0.0.1']));
      assert.deepEqual(res, { status: 201 });
      assert.equal(r.requests.length, 1);
      assert.equal(r.requests[0].method, 'POST');
      assert.equal(r.requests[0].url, '/hook?a=1');
      assert.equal(r.requests[0].headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(r.requests[0].body), { messages: ['m'] });
    });

    it('[WXA2] refuses a host name resolving to loopback before connecting', async function () {
      const r = await receiver((req, res) => res.end());
      const err = await failure(postWebhook(`http://localhost:${r.port}/hook`, {}, settings([])));
      assert.ok(err instanceof WebhookCallError);
      assert.equal(err.kind, 'refused');
      assert.equal(err.response, undefined);
      assert.equal(r.requests.length, 0);
    });

    it('[WXA3] refuses a loopback IP literal without connecting', async function () {
      const r = await receiver((req, res) => res.end());
      const err = await failure(postWebhook(`http://127.0.0.1:${r.port}/hook`, {}, settings([])));
      assert.equal(err.kind, 'refused');
      assert.equal(r.requests.length, 0);
    });

    it('[WXA4] lets an allow-listed private host through, by name or by range', async function () {
      const r = await receiver((req, res) => res.end());
      assert.deepEqual(await postWebhook(`http://localhost:${r.port}/a`, {}, settings(['localhost'])), { status: 200 });
      assert.deepEqual(await postWebhook(`http://localhost:${r.port}/b`, {}, settings(['127.0.0.0/8', '::1'])), { status: 200 });
      assert.equal(r.requests.length, 2);
    });

    it('[WXA5] does not follow a redirect and counts it as a failure', async function () {
      const target = await receiver((req, res) => res.end());
      const r = await receiver((req, res) => {
        res.writeHead(307, { Location: `http://127.0.0.1:${target.port}/elsewhere` });
        res.end();
      });
      const err = await failure(postWebhook(`http://127.0.0.1:${r.port}/hook`, {}, settings(['127.0.0.1'])));
      assert.equal(err.kind, 'status');
      assert.deepEqual(err.response, { status: 307 });
      assert.equal(r.requests.length, 1);
      assert.equal(target.requests.length, 0);
    });

    it('[WXA6] gives up on a receiver that does not answer within the timeout', async function () {
      const r = await receiver(() => { /* never answers */ });
      const start = Date.now();
      const err = await failure(postWebhook(`http://127.0.0.1:${r.port}/hook`, {}, settings(['127.0.0.1'], 200)));
      assert.equal(err.kind, 'timeout');
      assert.ok(Date.now() - start < 2000, 'took ' + (Date.now() - start) + ' ms');
      assert.equal(r.requests.length, 1);
    });

    it('[WXA7] reports a non-2xx answer with its status and a closed port as a connection failure', async function () {
      const r = await receiver((req, res) => { res.statusCode = 500; res.end(); });
      const err = await failure(postWebhook(`http://127.0.0.1:${r.port}/hook`, {}, settings(['127.0.0.1'])));
      assert.equal(err.kind, 'status');
      assert.deepEqual(err.response, { status: 500 });
      const closed = await receiver((req, res) => res.end());
      await new Promise((resolve) => closed.server.close(resolve));
      receivers.splice(receivers.indexOf(closed), 1);
      const err2 = await failure(postWebhook(`http://127.0.0.1:${closed.port}/hook`, {}, settings(['127.0.0.1'])));
      assert.equal(err2.kind, 'connection');
    });

    it('[WXA8] the logged reason names the host, never the path or query', async function () {
      const err = await failure(postWebhook('http://localhost:1/s3cr3t-path?token=s3cr3t', {}, settings([])));
      const line = describeCallFailure(err);
      assert.ok(line.includes('localhost'), line);
      assert.ok(!line.includes('s3cr3t'), line);
      assert.ok(!err.message.includes('s3cr3t'), err.message);
    });
  });
});
