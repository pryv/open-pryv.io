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

  // The access-request key alone fetches the granted token: it is a credential
  // wherever it appears in a URL (poll path, auth page query).
  it('[RDL5] the request trace hides the access-request key in the poll path', function () {
    require('../../src/requestTrace.ts');
    const morgan = require('morgan');
    assert.strictEqual(morgan['redacted-url']({ originalUrl: '/reg/access/k1k2k3k4k5k6k7k8?x=1' }), '/reg/access/***?x=1');
    // reg.<domain>/access/<key>: the path the poll URL has behind the register host
    assert.strictEqual(morgan['redacted-url']({ originalUrl: '/access/k1k2k3k4k5k6k7k8' }), '/access/***');
    // the routes that are not keyed stay readable
    assert.strictEqual(morgan['redacted-url']({ originalUrl: '/reg/access' }), '/reg/access');
    assert.strictEqual(morgan['redacted-url']({ originalUrl: '/reg/access/invitationtoken/check' }), '/reg/access/invitationtoken/check');
    assert.strictEqual(morgan['redacted-url']({ originalUrl: '/alice/accesses/acc1' }), '/alice/accesses/acc1');
  });

  it('[RDL6] URLs hide the key, poll and readToken query values', function () {
    const { redactUrl } = require('utils/src/redactUrl.ts');
    const shown = redactUrl('/auth?key=K1rdl6xx&poll=https%3A%2F%2Fc%2Freg%2Faccess%2FK1rdl6xx&lang=en');
    assert.ok(!shown.includes('K1rdl6xx'), shown);
    assert.ok(shown.includes('lang=en'), shown);
    const attachment = redactUrl('/alice/events/ev1/f1/a.png?readToken=rt-rdl6&w=1');
    assert.ok(!attachment.includes('rt-rdl6'), attachment);
  });

  it('[RDL7] the request trace never prints a Basic-auth user name (a token in Pryv)', function () {
    const { COMBINED_REDACTED } = require('../../src/requestTrace.ts');
    const morgan = require('morgan');
    const line = morgan.compile(COMBINED_REDACTED)(morgan, {
      ip: '10.0.0.1',
      method: 'GET',
      url: '/alice/',
      originalUrl: '/alice/',
      httpVersionMajor: 1,
      httpVersionMinor: 1,
      headers: { authorization: 'Basic ' + Buffer.from('tok-rdl7:').toString('base64') }
    }, { headersSent: false });
    assert.ok(!line.includes('tok-rdl7'), line);
    assert.ok(line.startsWith('10.0.0.1 - - ['), line);
  });
});
