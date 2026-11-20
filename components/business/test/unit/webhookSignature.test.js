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
const { createHmac, timingSafeEqual } = require('node:crypto');
const {
  signatureHeader,
  SIGNATURE_HEADER,
  postWebhook,
  compileAllowList,
  generateWebhookSecret
} = require('../../src/webhooks/destination.ts');

// What a receiver does: split the header, recompute the HMAC over "<t>." and
// the raw body, compare in constant time.
function verifies (header, secret, rawBody) {
  const parts = Object.fromEntries(header.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const expected = createHmac('sha256', secret).update(parts.t + '.').update(rawBody).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

describe('[WHSG] signed webhook calls', function () {
  it('[WHSG1] signatureHeader matches a fixed vector', function () {
    // Computed independently: printf '%s' '<t>.<body>' | openssl dgst -sha256 -hmac '<secret>'
    const secret = 'whsec_QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU';
    const body = Buffer.from('{"messages":["test"],"meta":{"apiVersion":"2.0.0","serverTime":1763640000.123,"serial":"2019061301"}}');
    assert.equal(signatureHeader(secret, body, 1763640000),
      't=1763640000,v1=1be2dba8c98ed62beb1402442783c20fa638a0bd068c2deb1341edc815293871');
    // the time is whole seconds
    assert.equal(signatureHeader(secret, body, 1763640000.9), signatureHeader(secret, body, 1763640000));
    // another body, time or secret signs differently
    assert.notEqual(signatureHeader(secret, Buffer.from('{}'), 1763640000), signatureHeader(secret, body, 1763640000));
    assert.notEqual(signatureHeader(secret, body, 1763640001), signatureHeader(secret, body, 1763640000));
    assert.notEqual(signatureHeader(secret + 'x', body, 1763640000), signatureHeader(secret, body, 1763640000));
    assert.equal(SIGNATURE_HEADER, 'Pryv-Signature');
  });

  it('[WHSG8] a new secret is whsec_ and 32 random bytes in base64url', function () {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    assert.match(a, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.equal(Buffer.from(a.slice(6), 'base64url').length, 32);
  });

  describe('[WHSD] calls to a receiver', function () {
    let server, port;
    const requests = [];
    before(async function () {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          requests.push({ headers: req.headers, raw: Buffer.concat(chunks) });
          res.end();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });
    after(async function () {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const settings = { allow: compileAllowList(['127.0.0.1']), timeoutMs: 2000 };

    it('[WHSG9] with a secret, the call carries a signature of the exact bytes received; without, no header', async function () {
      const secret = generateWebhookSecret();
      const payload = { messages: ['m', 'é'], meta: { serverTime: 1.5 } };
      const before = Math.floor(Date.now() / 1000);
      await postWebhook(`http://127.0.0.1:${port}/hook`, payload, settings, secret);
      const signed = requests.at(-1);
      const header = signed.headers['pryv-signature'];
      assert.ok(header != null, 'header sent');
      assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
      const t = Number(header.slice(2, header.indexOf(',')));
      assert.ok(t >= before && t <= Math.floor(Date.now() / 1000) + 1, 't is the time of the call: ' + t);
      assert.ok(verifies(header, secret, signed.raw), 'verifies on the raw body');
      assert.ok(!verifies(header, generateWebhookSecret(), signed.raw), 'another secret does not verify');
      assert.ok(!verifies(header, secret, Buffer.from(JSON.stringify(JSON.parse(signed.raw.toString())) + ' ')), 'another body does not verify');

      await postWebhook(`http://127.0.0.1:${port}/hook`, payload, settings);
      assert.equal(requests.at(-1).headers['pryv-signature'], undefined, 'no secret, no header');
      await postWebhook(`http://127.0.0.1:${port}/hook`, payload, settings, null);
      assert.equal(requests.at(-1).headers['pryv-signature'], undefined, 'null secret, no header');
    });
  });
});
