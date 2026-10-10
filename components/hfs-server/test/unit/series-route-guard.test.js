/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const superagent = require('superagent');
const Application = require('../../src/application.ts').default;

// A series route whose operation rejects with something that is not an Error
// (here `null`) must still answer an error, and the worker must keep serving.
describe('[HFGD] HFS series routes answer every failure', function () {
  let application, server;
  before(async () => {
    application = new Application();
    await application.init();
    server = application.server;
    await server.start();
  });
  after(() => {
    server.stop();
    application.context.metadata.close();
  });

  it('[HFGD1] an operation rejecting with null answers 500, and the server keeps serving', async function () {
    const { BatchRequest } = require('business').series;
    const originalParse = BatchRequest.parse;
    BatchRequest.parse = async function () { throw null; }; // eslint-disable-line no-throw-literal
    let res;
    try {
      res = await superagent.post(new URL('/alice/series/batch', server.baseUrl).toString())
        .set('Authorization', 'some-token')
        .send({ format: 'seriesBatch', data: [] })
        .timeout(3000)
        .ok(() => true);
    } finally {
      BatchRequest.parse = originalParse;
    }
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error.id, 'unexpected-error');
    const status = await superagent.get(new URL('/system/status', server.baseUrl).toString());
    assert.strictEqual(status.status, 200);
  });
});
