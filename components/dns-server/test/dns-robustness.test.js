/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const assert = require('assert');
const path = require('path');
const dgram = require('dgram');
const net = require('net');
const { spawn } = require('child_process');
const dns2 = require('dns2');
const { Packet } = dns2;

const CHILD = path.resolve(__dirname, 'fixtures/dns-child.js');
const TEST_DOMAIN = 'test.pryv.me';

let queryId = 1;
function queryBuffer (name, type = 'A') {
  const typeValue = typeof type === 'number' ? type : Packet.TYPE[type];
  const q = new Packet();
  q.header.id = queryId++;
  q.header.rd = 1;
  q.questions.push({ name, type: typeValue, class: Packet.CLASS.IN });
  return q.toBuffer();
}

// Craft a raw message: 12-octet header + the given question bytes.
function rawMessage ({ qr = 0, opcode = 0, qd = 1, ar = 0 } = {}, questionBytes) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(queryId++, 0);
  let flags = 0;
  flags |= (qr & 1) << 15;
  flags |= (opcode & 0xf) << 11;
  flags |= 1 << 8; // rd
  h.writeUInt16BE(flags >>> 0, 2);
  h.writeUInt16BE(qd, 4);
  h.writeUInt16BE(ar, 10);
  return Buffer.concat([h, questionBytes]);
}

function questionBytes (labels, type = 1, cls = 1) {
  const parts = [];
  for (const l of labels) { const lb = Buffer.from(l, 'latin1'); parts.push(Buffer.from([lb.length]), lb); }
  parts.push(Buffer.from([0]));
  const tc = Buffer.alloc(4);
  tc.writeUInt16BE(type, 0);
  tc.writeUInt16BE(cls, 2);
  return Buffer.concat([...parts, tc]);
}

const children = [];

function startChild (opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, DNS_CHILD_OPTS: JSON.stringify(opts) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => reject(new Error('child did not become READY: ' + errOut)), 15000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.startsWith('READY '));
      if (line) {
        clearTimeout(timer);
        resolve({ child, ports: JSON.parse(line.slice('READY '.length)) });
      }
    });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); if (out.indexOf('READY') === -1) reject(new Error('child exited before READY (code ' + code + '): ' + errOut)); });
  });
}

// Send a raw UDP datagram; resolve the parsed reply, or null if none arrives.
function udpSend (port, buf, { timeout = 800 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve(null); }, timeout);
    sock.on('message', (msg) => { clearTimeout(timer); sock.close(); try { resolve(Packet.parse(msg)); } catch (e) { reject(e); } });
    sock.on('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
    sock.send(buf, port, '127.0.0.1');
  });
}

// Send raw bytes over TCP; resolve { reply, closed } — reply is the parsed
// message (if the server answered) and closed says the socket ended.
function tcpSendRaw (port, buf, { timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.connect({ port, host: '127.0.0.1' }, () => sock.write(buf));
    const timer = setTimeout(() => { sock.destroy(); resolve({ reply: null, closed: false }); }, timeout);
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      let reply = null;
      if (data.length > 2) { try { reply = Packet.parse(data.subarray(2, 2 + data.readUInt16BE(0))); } catch { reply = null; } }
      resolve({ reply, closed: true });
    });
    sock.on('error', () => {}); // a reset shows up as close
  });
}

function tcpQuery (port, name, type = 'A', { timeout = 1500 } = {}) {
  const q = queryBuffer(name, type);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(q.length);
  return tcpSendRaw(port, Buffer.concat([len, q]), { timeout });
}

describe('[DNR] DNS Server: per-request fault isolation (forked child)', function () {
  this.timeout(30000);

  afterEach(() => {
    while (children.length) {
      const c = children.pop();
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  const baseOpts = {
    userCores: { alice: 'core1' },
    coreInfos: [{ id: 'core1', ip: '10.0.0.1' }]
  };

  it('[DNR01] a compression-pointer loop does not stall the server; a following query answers', async () => {
    const { child, ports } = await startChild(baseOpts);
    const loop = rawMessage({}, Buffer.concat([Buffer.from([0xc0, 0x0c]), Buffer.alloc(4)]));
    await udpSend(ports.udp, loop); // reply or not, must not hang the event loop
    const res = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    assert.ok(res != null, 'server answered the following query');
    assert.deepStrictEqual(res.answers.map((a) => a.address), ['10.0.0.1']);
    assert.strictEqual(child.exitCode, null, 'child still running');
  });

  it('[DNR02] a message that is itself a response (QR=1) gets no reply; a following query answers', async () => {
    const { child, ports } = await startChild(baseOpts);
    const resp = rawMessage({ qr: 1 }, questionBytes(['alice', 'test', 'pryv', 'me']));
    const reply = await udpSend(ports.udp, resp, { timeout: 600 });
    assert.strictEqual(reply, null, 'no reply to a response packet');
    const res = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    assert.ok(res != null && res.answers.length === 1);
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR03] a non-QUERY opcode is answered NOTIMP; a following query answers', async () => {
    const { child, ports } = await startChild(baseOpts);
    const notify = rawMessage({ opcode: 4 }, questionBytes(['alice', 'test', 'pryv', 'me']));
    const reply = await udpSend(ports.udp, notify);
    assert.ok(reply != null, 'got a reply');
    assert.strictEqual(reply.header.rcode, 4, 'NOTIMP');
    const res = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    assert.ok(res != null && res.answers.length === 1);
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR04] a query with no question is answered FORMERR; a following query answers', async () => {
    const { child, ports } = await startChild(baseOpts);
    const empty = rawMessage({ qd: 0 }, Buffer.alloc(0));
    const reply = await udpSend(ports.udp, empty);
    assert.ok(reply != null && reply.header.rcode === 1, 'FORMERR');
    const res = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    assert.ok(res != null && res.answers.length === 1);
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR05] a class other than IN is answered REFUSED; a following query answers', async () => {
    const { child, ports } = await startChild(baseOpts);
    const chaos = rawMessage({}, questionBytes(['alice', 'test', 'pryv', 'me'], 1, 3));
    const reply = await udpSend(ports.udp, chaos);
    assert.ok(reply != null && reply.header.rcode === 5, 'REFUSED');
    const res = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    assert.ok(res != null && res.answers.length === 1);
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR06] a UDP response over 512 octets is truncated (TC=1, no records)', async () => {
    const big = 'A'.repeat(1400);
    const { child, ports } = await startChild({ ...baseOpts, staticEntries: { bigtxt: { txt: [big] } } });
    const res = await udpSend(ports.udp, queryBuffer(`bigtxt.${TEST_DOMAIN}`, 'TXT'));
    assert.ok(res != null, 'got a reply');
    assert.strictEqual(res.header.tc, 1, 'TC set');
    assert.strictEqual(res.answers.length, 0, 'no records in a truncated answer');
    // Over TCP the same answer is returned in full (no 512 limit).
    const viaTcp = await tcpQuery(ports.tcp, `bigtxt.${TEST_DOMAIN}`, 'TXT');
    assert.ok(viaTcp.reply != null && viaTcp.reply.answers.length === 1);
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR07] a stored record of the wrong shape is skipped; its name answers and the server stays up', async () => {
    const { child, ports } = await startChild({
      ...baseOpts,
      persisted: [{ subdomain: 'bad', records: { a: 12345 } }]
    });
    const res = await udpSend(ports.udp, queryBuffer(`bad.${TEST_DOMAIN}`, 'A'));
    assert.ok(res != null, 'the malformed name still gets an answer');
    assert.strictEqual(res.answers.length, 0, 'the malformed record is not served');
    const ok = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    assert.ok(ok != null && ok.answers.length === 1, 'a valid name still answers');
    assert.strictEqual(child.exitCode, null, 'child did not exit');
  });

  it('[DNR08] a TCP message with trailing bytes closes the connection; the server still answers', async () => {
    const { child, ports } = await startChild(baseOpts);
    const q = queryBuffer(`alice.${TEST_DOMAIN}`, 'A');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(q.length);
    const withTrailer = Buffer.concat([len, q, Buffer.from([0x00, 0x00, 0x00])]);
    const bad = await tcpSendRaw(ports.tcp, withTrailer);
    assert.strictEqual(bad.closed, true, 'connection closed');
    assert.strictEqual(bad.reply, null, 'no answer for a framing violation');
    const good = await tcpQuery(ports.tcp, `alice.${TEST_DOMAIN}`, 'A');
    assert.ok(good.reply != null && good.reply.answers.length === 1, 'a fresh connection answers');
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR09] a TCP length prefix below the header size closes the connection', async () => {
    const { child, ports } = await startChild(baseOpts);
    const bad = await tcpSendRaw(ports.tcp, Buffer.from([0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]));
    assert.strictEqual(bad.closed, true);
    assert.strictEqual(bad.reply, null);
    const good = await tcpQuery(ports.tcp, `alice.${TEST_DOMAIN}`, 'A');
    assert.ok(good.reply != null && good.reply.answers.length === 1);
    assert.strictEqual(child.exitCode, null);
  });

  it('[DNR10] a valid query answers over both UDP and TCP', async () => {
    const { ports } = await startChild(baseOpts);
    const viaUdp = await udpSend(ports.udp, queryBuffer(`alice.${TEST_DOMAIN}`, 'A'));
    const viaTcp = await tcpQuery(ports.tcp, `alice.${TEST_DOMAIN}`, 'A');
    assert.deepStrictEqual(viaUdp.answers.map((a) => a.address), ['10.0.0.1']);
    assert.deepStrictEqual(viaTcp.reply.answers.map((a) => a.address), ['10.0.0.1']);
  });
});
