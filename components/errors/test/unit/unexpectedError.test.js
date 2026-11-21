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

describe('[UNXS] a statement stopped by the database time limit', function () {
  function cancelled () {
    const err = new Error('canceling statement due to statement timeout');
    err.code = '57014';
    err.statementText = 'SELECT * FROM events WHERE user_id = $1';
    return err;
  }

  it('[UNXS1] answers 503 api-unavailable, without Retry-After, the source kept as innerError', function () {
    const source = cancelled();
    const err = factory.unexpectedError(source);
    assert.strictEqual(err.id, ErrorIds.ApiUnavailable);
    assert.strictEqual(err.httpStatus, 503);
    assert.match(err.message, /ran longer than this server allows/);
    assert.strictEqual(err.innerError, source);
    assert.strictEqual(err.httpHeaders?.['Retry-After'], undefined);
    assert.ok(!JSON.stringify(errorHandling.getPublicErrorData(err)).includes('SELECT'));
  });

  it('[UNXS2] is logged once at warn, with the statement text and never at error level', function () {
    const err = factory.unexpectedError(cancelled());
    const logged = { debug: [], info: [], warn: [], error: [] };
    const logger = Object.fromEntries(Object.keys(logged).map((level) => [level, (msg, meta) => logged[level].push({ msg, meta })]));
    errorHandling.logError(err, { url: '/alice/events', method: 'GET' }, logger);
    assert.strictEqual(logged.error.length, 0);
    assert.strictEqual(logged.info.length, 0);
    assert.strictEqual(logged.warn.length, 1);
    assert.strictEqual(logged.warn[0].meta.statement, 'SELECT * FROM events WHERE user_id = $1');
    assert.strictEqual(logged.warn[0].meta.context.location, '/alice/events');
  });

  it('[UNXS4] wrapped again (a data store wraps it, then the method), it stays the 503', function () {
    const once = factory.unexpectedError(cancelled());
    once.message = 'Error from data store "local": ' + once.message;
    const twice = factory.unexpectedError(once);
    assert.strictEqual(twice, once);
    assert.strictEqual(twice.httpStatus, 503);
    assert.strictEqual(twice.id, ErrorIds.ApiUnavailable);
  });

  it('[UNXS3] another database error is still a 500', function () {
    const err = new Error('deadlock detected');
    err.code = '40P01';
    assert.strictEqual(factory.unexpectedError(err).httpStatus, 500);
  });
});

describe('[PGUG] a storage refusal for an account erased while the request ran', function () {
  function refused (code) {
    const err = new Error(code === 'PU001' ? 'user id "u1" is not in the users index: row refused' : 'user directory erased: u1');
    err.code = code;
    return err;
  }

  it('[PGUG7] answers 404 unknown-resource "Unknown user", the source kept as innerError, also when wrapped again', function () {
    for (const code of ['PU001', 'USER_ERASED']) {
      const source = refused(code);
      const err = factory.unexpectedError(source);
      assert.strictEqual(err.id, ErrorIds.UnknownResource, code);
      assert.strictEqual(err.httpStatus, 404, code);
      assert.strictEqual(err.message, 'Unknown user');
      assert.strictEqual(err.innerError, source);
      assert.ok(!JSON.stringify(errorHandling.getPublicErrorData(err)).includes('u1'), 'the id is not echoed');
      assert.strictEqual(factory.unexpectedError(err), err, code + ': wrapped again');
      // A data store's wrapping of the refusal maps the same.
      const wrapped = factory.unexpectedError(Object.assign(new Error('Error from data store "local"'), { innerError: source }));
      assert.strictEqual(wrapped.httpStatus, 404, code + ': wrapped');
    }
  });
});
