/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, assert, config */

const cuid = require('cuid');

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

      // Plan 27 Phase 1: record must be persisted to PlatformDB.
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
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.id, 'forbidden');
    });

    it('[RR03] must reject request with wrong admin key', async () => {
      const res = await coreRequest.post('/reg/records')
        .set('Authorization', 'wrong-key')
        .send({
          subdomain: '_acme-challenge',
          records: { txt: ['token'] }
        });
      assert.strictEqual(res.status, 403);
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
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.id, 'forbidden');
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
