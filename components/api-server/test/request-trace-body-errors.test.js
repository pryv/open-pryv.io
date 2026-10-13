/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * Record the request-trace lines written while `fn` runs.
 */
async function captureTrace (fn) {
  const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('log-capture'));
  const original = proto.log;
  const lines = [];
  proto.log = function (level, msg, ...rest) {
    if (this._name().endsWith('request-trace')) lines.push(String(msg));
    return original.call(this, level, msg, ...rest);
  };
  try {
    await fn();
    // the request trace writes when the response finishes
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    proto.log = original;
  }
  return lines;
}

describe('[RTBE] request trace for requests refused by the body parsers', function () {
  this.timeout(30000);
  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    const user = await fixtures.user(username);
    token = cuid();
    await user.access({ type: 'personal', token });
    await user.session(token);
  });

  after(async function () {
    await fixtures.clean();
  });

  it('[RTB1] a malformed JSON body is answered 400 and leaves a trace line', async function () {
    let res;
    const lines = await captureTrace(async () => {
      res = await coreRequest.post('/' + username + '/events')
        .set('Authorization', token)
        .set('Content-Type', 'application/json')
        .send('{"streamIds": [');
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    const line = lines.find((l) => l.includes('/' + username + '/events'));
    assert.ok(line != null, 'no trace line among: ' + JSON.stringify(lines));
    assert.match(line, /" 400 /);
  });

  it('[RTB2] a body in an unsupported charset is refused and leaves a trace line', async function () {
    let res;
    const lines = await captureTrace(async () => {
      res = await coreRequest.post('/' + username + '/events')
        .set('Authorization', token)
        .set('Content-Type', 'application/json; charset=x-unknown')
        .send('{}');
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    const line = lines.find((l) => l.includes('/' + username + '/events'));
    assert.ok(line != null, 'no trace line among: ' + JSON.stringify(lines));
    assert.match(line, /" 400 /);
  });
});
