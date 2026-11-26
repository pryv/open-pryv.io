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

describe('[UNXP] a platform read that got no answer (leader change)', function () {
  function noAnswer () {
    return Object.assign(new Error('rqlite query got no result at level default: not leader'), { name: 'RqliteNoAnswerError' });
  }

  it('[UNXP1] answers 503 api-unavailable with Retry-After: 2, the source kept as innerError, its text not public', function () {
    const source = noAnswer();
    const err = factory.unexpectedError(source);
    assert.strictEqual(err.id, ErrorIds.ApiUnavailable);
    assert.strictEqual(err.httpStatus, 503);
    assert.strictEqual(err.httpHeaders?.['Retry-After'], '2');
    assert.strictEqual(err.innerError, source);
    assert.ok(!JSON.stringify(errorHandling.getPublicErrorData(err)).includes('rqlite'));
  });

  it('[UNXP2] wrapped (innerError, cause) it maps the same; mapped once, it is kept as it is', function () {
    const wrapped = factory.unexpectedError(Object.assign(new Error('Error from data store "local"'), { innerError: noAnswer() }));
    assert.strictEqual(wrapped.httpStatus, 503);
    assert.strictEqual(factory.unexpectedError(new Error('x', { cause: noAnswer() })).httpStatus, 503);
    const once = factory.unexpectedError(noAnswer());
    assert.strictEqual(factory.unexpectedError(once), once);
  });

  it('[UNXP3] is logged at warn, never at error level', function () {
    const err = factory.unexpectedError(noAnswer());
    const logged = { debug: [], info: [], warn: [], error: [] };
    const logger = Object.fromEntries(Object.keys(logged).map((level) => [level, (msg, meta) => logged[level].push({ msg, meta })]));
    errorHandling.logError(err, { url: '/alice/events', method: 'GET' }, logger);
    assert.strictEqual(logged.warn.length, 1);
    assert.strictEqual(logged.error.length + logged.info.length, 0);
  });

  it('[UNXP4] another error named otherwise stays a 500', function () {
    assert.strictEqual(factory.unexpectedError(new Error('rqlite query failed (500): boom')).httpStatus, 500);
  });
});

describe('[UNXD] a data store error of another copy of @pryv/datastore wrapping a platform no-answer', function () {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const MARK = Symbol.for('@pryv/datastore:error');
  let tmp, foreign;

  function noAnswer () {
    return Object.assign(new Error('rqlite query got no result at level default: not leader'), { name: 'RqliteNoAnswerError' });
  }

  before(function () {
    // A second copy of the package, loaded from another path, as a store
    // resolving its own node_modules would.
    const pkgDir = path.dirname(require.resolve('@pryv/datastore/package.json'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unxd-'));
    fs.cpSync(path.join(pkgDir, 'src'), path.join(tmp, 'src'), { recursive: true });
    foreign = require(path.join(tmp, 'src', 'index.js'));
  });

  after(function () {
    if (tmp != null) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function marked (err) {
    err[MARK] = true;
    return err;
  }

  it('[UNXD1] an unexpected-error wrapping it answers 503 api-unavailable with Retry-After, marked or not', function () {
    for (const source of [marked(foreign.errors.unexpectedError('store lost', null, noAnswer())), foreign.errors.unexpectedError('store lost', null, noAnswer())]) {
      const err = factory.unexpectedError(source);
      assert.strictEqual(err.id, ErrorIds.ApiUnavailable);
      assert.strictEqual(err.httpStatus, 503);
      assert.strictEqual(err.httpHeaders?.['Retry-After'], '2');
    }
  });

  it('[UNXD2] an unknown-resource wrapping it keeps its id: 404, no Retry-After', function () {
    const err = factory.unexpectedError(marked(foreign.errors.unknownResource('stream', 's1', noAnswer())));
    assert.strictEqual(err.id, ErrorIds.UnknownResource);
    assert.strictEqual(err.httpStatus, 404);
    assert.strictEqual(err.httpHeaders?.['Retry-After'], undefined);
  });
});

describe('[UNSO] an operation the server or a data store does not support', function () {
  it('[UNSO1] answers 501 with the catalogue id unsupported-operation', function () {
    const err = factory.unsupportedOperation('streams.create');
    assert.strictEqual(err.id, 'unsupported-operation');
    assert.strictEqual(err.id, ErrorIds.UnsupportedOperation);
    assert.strictEqual(err.httpStatus, 501);
    assert.strictEqual(err.message, 'streams.create');
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

  it('[PGUG10] is logged at warn with the refusal and its table: outside an erasure it is a write under a wrong id', function () {
    const source = Object.assign(refused('PU001'), { table: 'accesses' });
    const err = factory.unexpectedError(Object.assign(new Error('Error from data store "local"'), { innerError: source }));
    const logged = { debug: [], info: [], warn: [], error: [] };
    const logger = Object.fromEntries(Object.keys(logged).map((level) => [level, (msg, meta) => logged[level].push({ msg, meta })]));
    errorHandling.logError(err, { url: '/alice/accesses', method: 'POST' }, logger);
    assert.strictEqual(logged.warn.length, 1);
    assert.strictEqual(logged.info.length + logged.error.length, 0);
    assert.strictEqual(logged.warn[0].meta.table, 'accesses');
    assert.match(logged.warn[0].meta.refusal, /not in the users index/);
  });
});
