/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { ErrorIds } = require('errors');

/**
 * [ACUF] accesses.update changes only the declared updatable fields
 * (name, deviceName, permissions, expireAfter, expires, clientData);
 * any other field is refused and the stored access is left as it was.
 * A personal access is only valid with a session opened for its own account.
 */
describe('[ACUF] accesses.update protected fields', function () {
  this.timeout(60_000);
  let fixtures, username, otherUsername, appToken, appId, sharedId, sharedToken, streamId, fxUser, fxOther;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'acuf-' + cuid().slice(-8);
    otherUsername = 'acufo-' + cuid().slice(-8);
    streamId = 'acuf-s-' + cuid().slice(-6);
    appToken = cuid();
    appId = 'acuf-app-' + cuid().slice(-6);
    sharedId = 'acuf-sh-' + cuid().slice(-6);
    sharedToken = cuid();
    fxUser = await fixtures.user(username);
    await fxUser.stream({ id: streamId, name: 'acuf' });
    await fxUser.access({ id: appId, token: appToken, type: 'app', name: 'acuf app', permissions: [{ streamId, level: 'manage' }] });
    await fxUser.access({
      id: sharedId,
      token: sharedToken,
      type: 'shared',
      name: 'acuf shared',
      permissions: [{ streamId, level: 'read' }],
      createdBy: appId,
      modifiedBy: appId
    });
    fxOther = await fixtures.user(otherUsername);
  });

  after(async function () {
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function getShared () {
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', appToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses.find((a) => a.id === sharedId);
  }

  async function update (fields) {
    return coreRequest
      .put('/' + username + '/accesses/' + sharedId)
      .set('Authorization', appToken)
      .send(fields);
  }

  for (const [code, field, value] of [
    ['ACUF1', 'type', 'personal'],
    ['ACUF2', 'token', 'acuf-new-token-value'],
    ['ACUF3', 'id', 'acuf-other-id'],
    ['ACUF4', 'createdBy', 'acuf-someone-else'],
    ['ACUF5', 'alias', 'acuf-alias']
  ]) {
    it(`[${code}] refuses a change of "${field}" and leaves the access unchanged`, async function () {
      const before = await getShared();
      const res = await update({ [field]: value });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      const after = await getShared();
      assert.ok(after != null, 'the access is still there under its id');
      assert.deepStrictEqual(after, before);
    });
  }

  it('[ACUF6] refuses a mix of allowed and protected fields as a whole', async function () {
    const before = await getShared();
    const res = await update({ name: 'acuf renamed', type: 'personal' });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.deepStrictEqual(await getShared(), before);
  });

  it('[ACUF7] still accepts the updatable fields', async function () {
    const res = await update({ name: 'acuf shared renamed', clientData: { acuf: true } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    // An update bumps the serial carried in the wire id: read back by the returned id.
    const list = await coreRequest.get('/' + username + '/accesses').set('Authorization', appToken);
    const after = list.body.accesses.find((a) => a.id === res.body.access.id);
    assert.strictEqual(after.name, 'acuf shared renamed');
    assert.strictEqual(after.type, 'shared');
    assert.deepStrictEqual(after.clientData, { acuf: true });
  });

  it('[ACUF8] a personal access backed by another account\'s session is not valid', async function () {
    const token = cuid();
    await fxOther.session(token);
    await fxUser.access({ token, type: 'personal', name: 'acuf borrowed session' });
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', token);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, ErrorIds.InvalidAccessToken);
  });

  it('[ACUF9] a personal access with its own account\'s session works', async function () {
    const token = cuid();
    await fxUser.session(token);
    await fxUser.access({ token, type: 'personal', name: 'acuf own session' });
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });
});
