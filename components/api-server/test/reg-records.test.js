/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert, config, getNewFixture */

const cuid = require('cuid');
const { captureWarnings } = require('test-helpers/src/captureWarnings.ts');

describe('[RGRC] Register records admin endpoint', () => {
  let adminAccessKey;
  let platform;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    adminAccessKey = config.get('auth:adminAccessKey');
    // Lazy require: Platform.js calls getLogger('platform') at module scope,
    // which throws before boiler is initialized. initTests() initializes boiler.
    const { getPlatform } = require('platform');
    platform = await getPlatform();
  });

  describe('POST /reg/records', () => {
    it('[RR01] must accept valid record update with admin auth', async () => {
      const sub = '_acme-challenge-' + cuid();
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({
          subdomain: sub,
          records: { txt: ['validation-token-123'] }
        });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.subdomain, sub);
      assert.strictEqual(res.body.status, 'ok');

      // Record must be persisted to PlatformDB.
      const stored = await platform.getDnsRecord(sub);
      assert.deepStrictEqual(stored, { txt: ['validation-token-123'] });
      await platform.deleteDnsRecord(sub); // cleanup
    });

    it('[RR02] must reject request without admin auth', async () => {
      const res = await coreRequest.post('/reg/records')
        .send({
          subdomain: '_acme-challenge',
          records: { txt: ['token'] }
        });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, 'unknown-resource');
    });

    it('[RR03] must reject request with wrong admin key', async () => {
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', 'wrong-key')
        .send({
          subdomain: '_acme-challenge',
          records: { txt: ['token'] }
        });
      assert.strictEqual(res.status, 404);
    });

    it('[RR07] a near-miss key answers 404, stores nothing, and logs a warning with the client IP but not the key', async () => {
      const sub = '_acme-nearmiss-' + cuid();
      const nearMiss = adminAccessKey.slice(0, -1) + 'x';
      const capture = captureWarnings();
      let res;
      try {
        res = await coreRequest.post('/reg/records')
          .set('Authorization', nearMiss)
          .send({ subdomain: sub, records: { txt: ['token'] } });
      } finally {
        capture.restore();
      }
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, 'unknown-resource');
      assert.strictEqual(await platform.getDnsRecord(sub), null);
      const warning = capture.warnings.find((w) => /Unauthorized attempt/.test(String(w.args[0])));
      assert.ok(warning != null, 'a warning is logged');
      assert.ok(typeof warning.args[1].ip === 'string' && warning.args[1].ip.length > 0, 'with the client IP');
      assert.ok(!JSON.stringify(warning.args).includes(nearMiss), 'never the key sent');
    });

    it('[RR08] must reject a record with an invalid shape', async () => {
      const sub = '_acme-invalid-' + cuid();
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({ subdomain: sub, records: { a: ['not-an-ip'] } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      assert.strictEqual(await platform.getDnsRecord(sub), null);
    });

    it('[RR04] must reject request with missing subdomain', async () => {
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({
          records: { txt: ['token'] }
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    });

    it('[RR09] a body that is not an object is answered 400, never left hanging', async () => {
      // `_json` holding no object nor array is refused as it is read; an array
      // reaches the route, which refuses it
      for (const [json, errorId] of [['null', 'invalid-request-structure'], ['42', 'invalid-request-structure'],
        ['"text"', 'invalid-request-structure'], ['[1]', 'invalid-parameters']]) {
        const res = await coreRequest.post('/reg/records')
          .set('Authorization', adminAccessKey)
          .type('form')
          .send({ _json: json })
          .timeout(5000);
        assert.strictEqual(res.status, 400, json);
        assert.strictEqual(res.body.error.id, errorId, json);
      }
    });

    it('[RR05] must reject request with missing records', async () => {
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({
          subdomain: '_acme-challenge'
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    });

    it('[RR06] record must persist to PlatformDB and overwrite cleanly', async () => {
      // PlatformDB is the source of truth for runtime DNS entries.
      const sub = '_acme-persist-' + cuid();

      let res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({ subdomain: sub, records: { txt: ['first-value'] } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await platform.getDnsRecord(sub), { txt: ['first-value'] });

      res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({ subdomain: sub, records: { txt: ['second-value'] } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await platform.getDnsRecord(sub), { txt: ['second-value'] });

      await platform.deleteDnsRecord(sub);
    });
  });

  describe('names shared with accounts', () => {
    it('[RR13] a new record under an account\'s name is refused; an existing one may change', async () => {
      const username = 'rrname' + cuid().slice(-8).toLowerCase();
      const fixtures = getNewFixture();
      await fixtures.user(username);
      try {
        let res = await coreRequest.post('/reg/records')
          .set('Authorization', adminAccessKey)
          .send({ subdomain: username, records: { a: ['10.0.0.9'] } });
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'item-already-exists');
        assert.strictEqual(await platform.getDnsRecord(username), null);
        // a record written before the account existed may still be updated
        await platform.setDnsRecord(username, { a: ['10.0.0.8'] });
        res = await coreRequest.post('/reg/records')
          .set('Authorization', adminAccessKey)
          .send({ subdomain: username, records: { a: ['10.0.0.9'] } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      } finally {
        await platform.deleteDnsRecord(username);
        await fixtures.clean();
      }
    });

    it('[RR14] a runtime record name is reported reserved by check_username', async () => {
      const sub = 'rrrec' + cuid().slice(-8).toLowerCase();
      assert.strictEqual((await coreRequest.get('/reg/' + sub + '/check_username')).body.reserved, false);
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', adminAccessKey)
        .send({ subdomain: sub, records: { a: ['10.0.0.9'] } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      try {
        // the check reads the names at most every 10 s: start a new window
        await platform.refreshPlatformNames();
        assert.strictEqual((await coreRequest.get('/reg/' + sub + '/check_username')).body.reserved, true);
      } finally {
        await platform.deleteDnsRecord(sub);
      }
    });
  });

  describe('DELETE /reg/records/:subdomain', () => {
    it('[RR10] must delete a persisted record with admin auth', async () => {
      const sub = '_acme-del-' + cuid();
      await platform.setDnsRecord(sub, { txt: ['to-delete'] });
      assert.deepStrictEqual(await platform.getDnsRecord(sub), { txt: ['to-delete'] });

      const res = await coreRequest.delete('/reg/records/' + sub)
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.subdomain, sub);
      assert.strictEqual(res.body.status, 'deleted');

      assert.strictEqual(await platform.getDnsRecord(sub), null);
    });

    it('[RR11] must reject delete without admin auth', async () => {
      const res = await coreRequest.delete('/reg/records/_acme-challenge');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, 'unknown-resource');
    });

    it('[RR12] must 404 on unknown subdomain', async () => {
      const sub = '_never-existed-' + cuid();
      const res = await coreRequest.delete('/reg/records/' + sub)
        .set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, 'unknown-resource');
    });
  });
});
