/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./helpers');
const assert = require('node:assert');
const registerEventPreviews = require('../src/routes/event-previews.ts').default;

/**
 * The preview route is an async Express handler: anything it throws must
 * reach next(), since Express 4 does not observe a rejected handler and the
 * request would hang. The context middleware always runs first, so a missing
 * context is never seen in service; it stands in for any early failure.
 */
describe('[EPRG] event previews route guard', function () {
  it('[EPG1] an early failure reaches next() instead of rejecting the handler', async function () {
    const handlers = {};
    const fakeApp = { post () {}, all () {}, get (routePath, fn) { handlers[routePath] = fn; } };
    await registerEventPreviews(fakeApp, () => {}, () => {}, null);
    const handler = Object.values(handlers)[0];
    assert.strictEqual(typeof handler, 'function');
    let passed = null;
    await handler({ params: { id: 'some-event' }, query: {}, headers: {} }, {}, (err) => { passed = err; });
    assert.ok(passed instanceof Error, 'next() got the error');
  });
});
