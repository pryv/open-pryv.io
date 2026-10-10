/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const produceErrorHandlingMiddleware = require('../../src/middleware/errors.ts').default;

// A fault in a series route answers like the API does: an unexpected-error 500
// with a generic message, the detail and the stack on the error log.
describe('[HFEU] HFS unexpected errors', function () {
  function run (error) {
    const logged = [];
    const capture = (level) => (msg, meta) => logged.push({ level, line: msg + ' ' + JSON.stringify(meta) });
    const logger = { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') };
    const answer = {};
    const res = {
      status (code) { answer.status = code; return this; },
      json (body) { answer.body = body; return this; }
    };
    produceErrorHandlingMiddleware(logger)(error, { url: '/alice/series/batch', method: 'POST' }, res, () => {});
    return { answer, logged };
  }

  it('[HFE1] a non-API error answers unexpected-error without the detail, and logs the detail and the stack', function () {
    const { answer, logged } = run(new Error('internal-detail-hfe1 /app/var-pryv/series'));
    assert.strictEqual(answer.status, 500);
    assert.strictEqual(answer.body.error.id, 'unexpected-error');
    assert.match(answer.body.error.message, /^Unexpected error \(ref [0-9a-f]{8}\)$/);
    assert.ok(!JSON.stringify(answer.body).includes('internal-detail-hfe1'), JSON.stringify(answer.body));
    const errorLines = logged.filter((l) => l.level === 'error');
    assert.strictEqual(errorLines.length, 1, JSON.stringify(logged));
    assert.ok(errorLines[0].line.includes('internal-detail-hfe1'), errorLines[0].line);
    assert.ok(errorLines[0].line.includes('errors-middleware.test.js'), 'the stack is logged: ' + errorLines[0].line);
  });

  it('[HFE2] a body-parser error stays a 400 invalid-request-structure', function () {
    const parserError = Object.assign(new Error('Unexpected token b in JSON'), { status: 400 });
    const { answer } = run(parserError);
    assert.strictEqual(answer.status, 400);
    assert.strictEqual(answer.body.error.id, 'invalid-request-structure');
  });
});
