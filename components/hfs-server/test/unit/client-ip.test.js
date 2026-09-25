/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * HF requests build a method context to resolve the access. Its source must
 * carry the requesting client's ip, taken like the API server takes it,
 * not a placeholder.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
const assert = require('node:assert');

const { MethodContext } = require('business');
const { MetadataLoader, requestClientIp } = require('../../src/metadata_cache.ts');
const controllerFactory = require('../../src/web/controller.ts').default;

const STOP = new Error('stop after capture');

describe('[HFIP] HF series client ip', () => {
  describe('[HFI1] requestClientIp', () => {
    it('[HFI2] prefers the X-Forwarded-For header set by the front proxy', () => {
      const req = { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '10.0.0.1' } };
      assert.strictEqual(requestClientIp(req), '203.0.113.7');
    });

    it('[HFI3] falls back to the socket peer address, then to null', () => {
      assert.strictEqual(requestClientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
      assert.strictEqual(requestClientIp({ headers: {} }), null);
    });
  });

  describe('[HFI4] MetadataLoader', () => {
    let originalInit;
    let captured;
    before(() => {
      originalInit = MethodContext.prototype.init;
      MethodContext.prototype.init = async function () {
        captured = this.source;
        throw STOP;
      };
    });
    after(() => {
      MethodContext.prototype.init = originalInit;
    });

    it('[HFI5] builds the method context source with the client ip', async () => {
      captured = null;
      const loader = new MetadataLoader();
      await assert.rejects(loader.forSeries('user', 'event', 'token', '203.0.113.7'), STOP);
      assert.deepStrictEqual(captured, { name: 'hf', ip: '203.0.113.7' });
    });

    it('[HFI6] leaves the ip out when none is known, never a placeholder', async () => {
      captured = null;
      const loader = new MetadataLoader();
      await assert.rejects(loader.forSeries('user', 'event', 'token'), STOP);
      assert.deepStrictEqual(captured, { name: 'hf' });
    });
  });

  describe('[HFI7] series operations pass the request ip to the metadata lookup', () => {
    function setup () {
      const calls = [];
      const ctx = {
        childSpan: () => ({ finish () {} }),
        metadata: {
          forSeries: async (...args) => { calls.push(args); throw STOP; }
        }
      };
      return { calls, controller: controllerFactory(ctx) };
    }
    function call (handler, req) {
      return new Promise((resolve) => handler(req, {}, (err) => resolve(err)));
    }
    const headers = { authorization: 'token', 'x-forwarded-for': '203.0.113.7' };

    it('[HFI8] store and query series data', async () => {
      const { calls, controller } = setup();
      const req = { params: { user_name: 'user', event_id: 'event' }, headers, query: {}, body: {} };
      assert.strictEqual(await call(controller.storeSeriesData, req), STOP);
      assert.strictEqual(await call(controller.querySeriesData, req), STOP);
      assert.deepStrictEqual(calls.map(c => c[3]), ['203.0.113.7', '203.0.113.7']);
    });

    it('[HFI9] store series batch', async () => {
      const { calls, controller } = setup();
      const req = {
        params: { user_name: 'user' },
        headers,
        body: { format: 'seriesBatch', data: [{ eventId: 'event', data: { format: 'flatJSON', fields: ['deltaTime', 'value'], points: [[0, 1]] } }] }
      };
      await call(controller.storeSeriesBatch, req);
      assert.deepStrictEqual(calls.map(c => c[3]), ['203.0.113.7']);
    });
  });
});
