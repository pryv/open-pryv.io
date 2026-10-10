/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, config */

const { inspect } = require('node:util');

// A server-side fault inside an API method answers a generic message with a
// reference; the fault's own message (paths, driver or database text) goes to
// the error log only, and the audit record carries the generic message.
describe('[UNXR] unexpected errors answered without internal detail', function () {
  this.timeout(30000);
  let fixtures, username, token, storageLayer;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await require('storage').getStorageLayer();
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

  it('[UNXR1] the 500 body carries a reference, the error log and not the client gets the detail', async function () {
    const detail = 'internal-detail-unxr1 /app/var-pryv/users/' + username;
    const profile = storageLayer.profile;
    const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('log-capture'));
    const originalLog = proto.log;
    const lines = [];
    proto.log = function (level, msg, ...rest) {
      lines.push({ level, name: this._name(), text: String(msg) + ' ' + inspect(rest, { depth: 8 }) });
      return originalLog.call(this, level, msg, ...rest);
    };
    const ownFindOne = Object.prototype.hasOwnProperty.call(profile, 'findOne');
    const originalFindOne = profile.findOne;
    profile.findOne = function (user, query, options, callback) { callback(new Error(detail)); };
    let res;
    try {
      res = await coreRequest.get('/' + username + '/profile/private').set('Authorization', token);
    } finally {
      if (ownFindOne) profile.findOne = originalFindOne;
      else delete profile.findOne;
      proto.log = originalLog;
    }
    assert.strictEqual(res.status, 500, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'unexpected-error');
    const match = res.body.error.message.match(/^Unexpected error \(ref ([0-9a-f]{8})\)$/);
    assert.ok(match != null, res.body.error.message);
    assert.ok(!JSON.stringify(res.body).includes('internal-detail-unxr1'), JSON.stringify(res.body));

    const errorLines = lines.filter((l) => l.level === 'error' && l.text.includes(match[1]));
    assert.strictEqual(errorLines.length, 1, inspect(lines));
    assert.ok(errorLines[0].text.includes('internal-detail-unxr1'), errorLines[0].text);

    if (!config.get('audit:active')) return;
    let record;
    for (let i = 0; i < 20 && record == null; i++) {
      const audit = await coreRequest.get('/' + username + '/events').set('Authorization', token)
        .query({ streams: [':_audit:action-profile.get'] });
      assert.strictEqual(audit.status, 200, JSON.stringify(audit.body));
      record = audit.body.events.find((e) => e.type === 'audit-log/pryv-api-error');
      if (record == null) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(record != null, 'the failed call is audited');
    assert.strictEqual(record.content.message, res.body.error.message);
  });
});

// The error middleware answers every API error; if building that answer fails
// (here an error whose data cannot be serialized), the client still gets a 500
// and the server keeps serving.
describe('[ERMG] error middleware keeps serving when an answer cannot be built', function () {
  this.timeout(30000);
  let fixtures, username, token, storageLayer;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await require('storage').getStorageLayer();
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

  it('[ERMG1] an error carrying unserializable data answers 500, then the next request is served', async function () {
    const { APIError } = require('errors');
    const profile = storageLayer.profile;
    const ownFindOne = Object.prototype.hasOwnProperty.call(profile, 'findOne');
    const originalFindOne = profile.findOne;
    // thrown, so the method chain forwards the API error as it is
    profile.findOne = function () {
      throw new APIError('invalid-operation', 'refused', { httpStatus: 400, data: { size: 10n } });
    };
    let res;
    try {
      res = await coreRequest.get('/' + username + '/profile/private').set('Authorization', token).timeout(5000);
    } finally {
      if (ownFindOne) profile.findOne = originalFindOne;
      else delete profile.findOne;
    }
    assert.strictEqual(res.status, 500, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'unexpected-error');
    const next = await coreRequest.get('/' + username + '/profile/private').set('Authorization', token);
    assert.strictEqual(next.status, 200, JSON.stringify(next.body));
  });
});
