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
 * [ATRN] Access tokens and ids that are names of built-in object properties.
 *
 * The access cache is keyed by token and by access id, both client-supplied
 * strings. A lookup for `constructor`, `__proto__` or `toString` must be an
 * ordinary unknown token (403), and such names cannot be chosen as tokens.
 */

const { ErrorIds } = require('errors/src/index.ts');

const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];

describe('[ATRN] access tokens named like built-in object properties', function () {
  let fixtures, username, personalToken, appToken, streamId, eventId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  beforeEach(async function () {
    username = cuid();
    personalToken = cuid();
    appToken = cuid();
    streamId = cuid();
    eventId = cuid();
    const user = await fixtures.user(username, {});
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    await user.stream({ id: streamId, name: 'atrn-' + streamId });
    await user.event({ id: eventId, streamIds: [streamId], type: 'note/txt', content: 'atrn' });
    await user.access({ id: cuid(), type: 'app', token: appToken, name: 'atrn-app', permissions: [{ streamId, level: 'contribute' }] });
  });

  afterEach(async function () {
    await fixtures.clean();
  });

  it('[ATRN1] a lookup by such a name answers 403, also once the user\'s accesses are cached', async function () {
    for (const name of PROTOTYPE_NAMES) {
      const cold = await coreRequest.get('/' + username + '/events').set('Authorization', name);
      assert.strictEqual(cold.status, 403, name + ' (cold cache): ' + JSON.stringify(cold.body));
    }
    // Fill the user's access cache, then probe again.
    const ok = await coreRequest.get('/' + username + '/events').set('Authorization', appToken);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    for (const name of PROTOTYPE_NAMES) {
      const res = await coreRequest.get('/' + username + '/events').set('Authorization', name);
      assert.strictEqual(res.status, 403, name + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidAccessToken, name);
    }
  });

  it('[ATRN2] a read token naming such an access id is refused, not an error', async function () {
    const ok = await coreRequest.get('/' + username + '/events').set('Authorization', appToken);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    for (const name of PROTOTYPE_NAMES) {
      const res = await coreRequest.get('/' + username + '/events/' + eventId + '/file-id?readToken=' + encodeURIComponent(name + '-signature'));
      assert.ok(res.status === 401 || res.status === 403 || res.status === 404, name + ': ' + res.status + ' ' + JSON.stringify(res.body));
    }
  });

  it('[ATRN3] accesses.create refuses such a name as token', async function () {
    for (const name of PROTOTYPE_NAMES) {
      const res = await coreRequest.post('/' + username + '/accesses').set('Authorization', personalToken)
        .send({ name: 'atrn-' + cuid(), type: 'shared', token: name, permissions: [{ streamId, level: 'read' }] });
      assert.strictEqual(res.status, 400, name + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidItemId, name);
    }
    // An app token cannot either.
    const res = await coreRequest.post('/' + username + '/accesses').set('Authorization', appToken)
      .send({ name: 'atrn-' + cuid(), type: 'shared', token: '__proto__', permissions: [{ streamId, level: 'read' }] });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    // An ordinary chosen token is still accepted.
    const chosen = 'atrn-token-' + cuid();
    const accepted = await coreRequest.post('/' + username + '/accesses').set('Authorization', personalToken)
      .send({ name: 'atrn-' + cuid(), type: 'shared', token: chosen, permissions: [{ streamId, level: 'read' }] });
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    assert.strictEqual(accepted.body.access.token, chosen);
  });
});
