/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { factory, errorHandling, ErrorIds } = require('../../src/index.ts');

// A server-side fault answers a generic message with a short reference; the
// detail (paths, driver and database messages) stays on the server log.
describe('[UNXE] unexpected errors keep their detail on the server', function () {
  const detail = 'ENOENT: no such file or directory, open \'/app/var-pryv/users/x\'';

  it('[UNX1] the public message is generic and carries a reference', function () {
    const err = factory.unexpectedError(new Error(detail));
    assert.strictEqual(err.id, ErrorIds.UnexpectedError);
    assert.strictEqual(err.httpStatus, 500);
    assert.match(err.message, /^Unexpected error \(ref [0-9a-f]{8}\)$/);
    assert.ok(!err.message.includes('ENOENT') && !err.message.includes('/app/'), err.message);
    assert.strictEqual(err.innerError.message, detail);
    const pub = errorHandling.getPublicErrorData(err);
    assert.deepStrictEqual(Object.keys(pub).sort(), ['id', 'message']);
    assert.ok(!JSON.stringify(pub).includes('ENOENT'), JSON.stringify(pub));
  });

  it('[UNX2] each error gets its own reference', function () {
    const a = factory.unexpectedError(new Error('x'));
    const b = factory.unexpectedError(new Error('x'));
    assert.notStrictEqual(a.message, b.message);
  });

  it('[UNX3] the error log line carries the reference and the detail', function () {
    const err = factory.unexpectedError(new Error(detail));
    const logged = [];
    const capture = (msg, meta) => logged.push(msg + ' ' + JSON.stringify(meta));
    errorHandling.logError(err, { url: '/alice/events', method: 'GET' }, { debug: capture, info: capture, warn: capture, error: capture });
    assert.strictEqual(logged.length, 1);
    const ref = err.message.match(/ref ([0-9a-f]{8})/)[1];
    assert.ok(logged[0].includes(ref), logged[0]);
    assert.ok(logged[0].includes('ENOENT'), logged[0]);
  });

  it('[UNX4] an explicit message is kept as given', function () {
    const err = factory.unexpectedError(new Error('inner'), 'the mail service is not configured');
    assert.strictEqual(err.message, 'Unexpected error: the mail service is not configured');
  });
});
