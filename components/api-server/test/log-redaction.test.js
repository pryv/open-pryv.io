/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const crypto = require('node:crypto');
const { inspect } = require('node:util');
const accessState = require('../src/routes/reg/accessState.ts');
const { withInjectedConfig } = require('test-helpers');

/**
 * Record every log line written while `fn` runs (all loggers, all levels,
 * message and context), then restore the logger.
 */
async function captureLogs (fn) {
  const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('log-capture'));
  const original = proto.log;
  const lines = [];
  proto.log = function (level, msg, ...rest) {
    lines.push({ level, name: this._name(), text: String(msg) + (rest.length > 0 ? ' ' + inspect(rest, { depth: 8 }) : '') });
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

const traceLines = (lines) => lines.filter((l) => l.name.endsWith('request-trace'));
const keyRef = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

describe('[RALG] credentials kept out of the server logs', function () {
  this.timeout(30000);
  let fixtures, fixtureUser, username;
  let counter = 0;
  const OFFER = [{ streamId: 'diary', level: 'read' }];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    fixtureUser = await fixtures.user(username);
    await fixtureUser.stream({ id: 'diary', name: 'Journal' });
  });

  after(async function () {
    await accessState.clear();
    await fixtures.clean();
  });

  async function mintApp () {
    const n = ++counter;
    const token = 'tok-ral-' + n + '-' + cuid();
    await fixtureUser.access({ id: 'acc-ral-' + n + '-' + cuid(), type: 'app', name: 'ral-app-' + n, token, permissions: OFFER });
    return token;
  }

  async function createRequest (extra) {
    const res = await coreRequest.post('/reg/access')
      .send({ requestingAppId: 'test-app', requestedPermissions: OFFER, ...extra });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.key;
  }

  function accept (key, token) {
    return coreRequest.post('/reg/access/' + key)
      .send({ status: 'ACCEPTED', username, token, apiEndpoint: 'https://' + username + '.pryv.me/' });
  }

  it('[RAL1] polling and deciding an access request never logs its key', async function () {
    let key;
    const lines = await captureLogs(async () => {
      key = await createRequest();
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN');
      const refused = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'REFUSED', reasonId: 'ral1', message: 'no' });
      assert.strictEqual(refused.body.status, 'REFUSED', JSON.stringify(refused.body));
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'REFUSED');
    });
    const leaking = lines.filter((l) => l.text.includes(key));
    assert.deepStrictEqual(leaking, []);
    assert.ok(traceLines(lines).some((l) => l.text.includes('/reg/access/***')),
      'the poll is still traced: ' + inspect(traceLines(lines)));
  });

  it('[RAL2] a hand-off falling back to inline delivery logs a reference, not the key', async function () {
    let key;
    const lines = await captureLogs(async () => {
      await withInjectedConfig({ sharedSecrets: { enabled: false } }, async () => {
        key = await createRequest({ credentialHandoff: 'shared-secret' });
        const token = await mintApp();
        const res = await accept(key, token);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.token, token);
      });
    });
    assert.deepStrictEqual(lines.filter((l) => l.text.includes(key)), []);
    const fallback = lines.filter((l) => l.text.includes('fell back to inline'));
    assert.strictEqual(fallback.length, 1, inspect(lines));
    assert.ok(fallback[0].text.includes(keyRef(key)), fallback[0].text);
  });

  it('[RAL3] a consent check that cannot run logs a reference, not the key', async function () {
    const { MethodContext } = require('business');
    const original = MethodContext.prototype.retrieveExpandedAccess;
    let key;
    const lines = await captureLogs(async () => {
      key = await createRequest({ consent: { mandatory: ['diary'] } });
      const token = await mintApp();
      MethodContext.prototype.retrieveExpandedAccess = async function () { throw new Error('storage unavailable ral3'); };
      let res;
      try {
        res = await accept(key, token);
      } finally {
        MethodContext.prototype.retrieveExpandedAccess = original;
      }
      assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    });
    assert.deepStrictEqual(lines.filter((l) => l.text.includes(key)), []);
    const failure = lines.filter((l) => l.level === 'error' && l.text.includes('consent check unavailable'));
    assert.strictEqual(failure.length, 1, inspect(lines));
    assert.ok(failure[0].text.includes(keyRef(key)), failure[0].text);
    assert.ok(failure[0].text.includes('storage unavailable ral3'), failure[0].text);
  });

  it('[RAL4] a Basic-auth token is not traced on requests answered before authentication', async function () {
    const token = 'tok-ral4-' + cuid();
    const basic = 'Basic ' + Buffer.from(token + ':').toString('base64');
    const lines = await captureLogs(async () => {
      await coreRequest.get('/' + username + '/').set('Authorization', basic);
      await coreRequest.get('/reg/unknown-route-ral4').set('Authorization', basic);
    });
    const traces = traceLines(lines);
    assert.ok(traces.some((l) => l.text.includes('"GET /' + username + '/ ')), inspect(traces));
    assert.ok(traces.some((l) => l.text.includes('/reg/unknown-route-ral4')), inspect(traces));
    assert.deepStrictEqual(lines.filter((l) => l.text.includes(token)), []);
  });
});
