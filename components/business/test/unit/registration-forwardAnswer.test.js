/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { Registration } = require('../../src/auth/registration.ts');

// What the landing core answers when the core it forwards a registration to
// answers (or does not): a refusal of the registration is relayed, anything
// else is a 503 that names neither the other core nor its answer.
describe('[XCRF] cross-core registration forward: the answer the client gets', function () {
  const TARGET_URL = 'http://127.0.0.1:13999/';
  let savedFetch;

  before(function () {
    savedFetch = globalThis.fetch;
  });

  afterEach(function () {
    globalThis.fetch = savedFetch;
  });

  function registration () {
    const r = new Registration(null, null, {});
    r.platform = {
      isSingleCore: false,
      coreId: 'core-a',
      selectCoreForRegistration: async () => 'core-b',
      coreIdToUrl: () => TARGET_URL
    };
    return r;
  }

  // Runs the forward step with `fetch` answering `answer` (a function).
  async function forward (answer) {
    globalThis.fetch = answer;
    const result = {};
    const err = await new Promise((resolve) => {
      registration().forwardIfCrossCore({ source: { ip: '192.0.2.1' } }, { username: 'xcrfuser', hosting: 'hb' }, result, resolve);
    });
    return { err, result };
  }

  function answering (status, body) {
    return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('[XCRF1] a refusal of the registration (409) reaches the client with its id, message and data', async function () {
    const { err } = await forward(answering(409, { error: { id: 'item-already-exists', message: 'taken', data: { username: 'xcrfuser' } } }));
    assert.strictEqual(err.httpStatus, 409);
    assert.strictEqual(err.id, 'item-already-exists');
    assert.strictEqual(err.message, 'taken');
    assert.deepStrictEqual(err.data, { username: 'xcrfuser' });
  });

  it('[XCRF2] a 401, 403 or 5xx from the target answers 503 cross-core-registration-failed; its answer stays in the log', async function () {
    for (const status of [401, 403, 500, 502]) {
      const { err } = await forward(answering(status, { error: { id: 'forbidden', message: 'Invalid registration forward.' } }));
      assert.strictEqual(err.httpStatus, 503, String(status));
      assert.strictEqual(err.id, 'cross-core-registration-failed', String(status));
      assert.ok(!err.message.includes('forward.') && !err.message.includes(String(status)), err.message);
      assert.strictEqual(err.data, null, String(status));
      assert.match(err.innerError.message, new RegExp('core-b answered ' + status + ' forbidden'));
    }
  });

  it('[XCRF3] an unreachable target answers 503; the network cause is in the log, not in the answer', async function () {
    const { err } = await forward(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:13999') });
    });
    assert.strictEqual(err.httpStatus, 503);
    assert.strictEqual(err.id, 'cross-core-registration-failed');
    assert.ok(!err.message.includes('ECONNREFUSED') && !err.message.includes('13999'), err.message);
    assert.match(err.innerError.message, /core-b at http:\/\/127\.0\.0\.1:13999\/: connect ECONNREFUSED/);
  });

  it('[XCRF5] a 4xx that is not an API answer (a proxy\'s HTML 404, an empty 400) answers 503, not the 4xx', async function () {
    const html = async () => new Response('<html><body>404 Not Found</body></html>', { status: 404, headers: { 'content-type': 'text/html' } });
    for (const [label, answer] of [['html 404', html], ['empty 400', answering(400, {})]]) {
      const { err } = await forward(answer);
      assert.strictEqual(err.httpStatus, 503, label);
      assert.strictEqual(err.id, 'cross-core-registration-failed', label);
      assert.strictEqual(err.data, null, label);
      assert.match(err.innerError.message, /core-b answered 40[04] \(not an API error\)/, label);
    }
  });

  it('[XCRF4] an accepted forward fills the result from the target\'s answer, without its meta', async function () {
    const { err, result } = await forward(answering(201, { username: 'xcrfuser', apiEndpoint: 'https://t@xcrfuser.example/', meta: { apiVersion: 'x' } }));
    assert.strictEqual(err, undefined);
    assert.strictEqual(result.forwarded, true);
    assert.strictEqual(result.username, 'xcrfuser');
    assert.ok(!('meta' in result));
  });
});
