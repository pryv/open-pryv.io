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

  it('[RDL3] the error log keeps the request body keys, never credential values', function () {
    const { errorHandling } = require('errors/src/errorHandling.ts');
    const { APIError } = require('errors');
    const logged = [];
    const capture = (msg, meta) => logged.push(meta);
    const logger = { debug: capture, info: capture, warn: capture, error: capture };
    const body = {
      appId: 'rdl-app',
      resetToken: 'live-reset-token-rdl3',
      oldPassword: 'old-pass-rdl3',
      newPassword: 'short',
      recoveryCode: 'recovery-rdl3',
      invitationToken: 'invite-rdl3',
      emailProof: 'proof-rdl3',
      token: 'app-token-rdl3'
    };
    errorHandling.logError(new APIError('invalid-parameters-format', 'bad'), { url: '/alice/account/reset-password', method: 'POST', body }, logger);
    errorHandling.logError(new Error('boom'), { url: '/reg/access/key', method: 'POST', body }, logger);
    const text = JSON.stringify(logged);
    for (const secret of ['live-reset-token-rdl3', 'old-pass-rdl3', 'recovery-rdl3', 'invite-rdl3', 'proof-rdl3', 'app-token-rdl3', 'short']) {
      assert.ok(!text.includes(secret), 'not logged: ' + secret + ' in ' + text);
    }
    assert.ok(text.includes('resetToken') && text.includes('rdl-app'), 'keys and harmless values stay: ' + text);
  });

  it('[RDL4] URLs and messages hide current-format tokens and one-time link tokens', function () {
    const { redactUrl } = require('utils/src/redactUrl.ts');
    assert.strictEqual(redactUrl('/s/x?resetToken=abc&w=1&mfaToken=def'), '/s/x?resetToken=***&w=1&mfaToken=***');
    const { inspectAndHide } = require('@pryv/boiler/src/logging.ts');
    const hidden = JSON.stringify(inspectAndHide({ msg: 'GET /u/ev?auth=zq8x4k2b7c9d0e1f2g3h4i5j', resetToken: 'r', oldPassword: 'o' }));
    assert.ok(!hidden.includes('zq8x4k2b7c9d0e1f2g3h4i5j') && !hidden.includes('"r"') && !hidden.includes('"o"'), hidden);
  });
});
