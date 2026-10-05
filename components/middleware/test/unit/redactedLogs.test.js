/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');

// Preview and attachment links carry the access token in `?auth=`; neither the
// request trace nor the error log may write it out.
describe('[RDLG] access tokens kept out of request logs', function () {
  it('[RDL1] the request trace logs the URL with auth redacted', function () {
    require('../../src/requestTrace.ts'); // registers the token
    const morgan = require('morgan');
    const url = morgan['redacted-url']({ originalUrl: '/alice/previews/events/ev1?w=64&auth=secret-token' });
    assert.strictEqual(url, '/alice/previews/events/ev1?w=64&auth=***');
  });

  it('[RDL2] the error log context carries the URL with auth redacted', function () {
    const { errorHandling } = require('errors/src/errorHandling.ts');
    const logged = [];
    const capture = (msg, meta) => logged.push(meta);
    const logger = { debug: capture, info: capture, warn: capture, error: capture };
    errorHandling.logError(new Error('boom'), { url: '/alice/events/ev1?auth=secret-token&w=1', method: 'GET' }, logger);
    assert.ok(logged.length > 0);
    const text = JSON.stringify(logged);
    assert.ok(!text.includes('secret-token'), text);
    assert.ok(text.includes('auth=***'), text);
  });
});
