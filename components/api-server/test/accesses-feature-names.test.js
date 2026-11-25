/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const validation = require('../src/schema/validation.ts');
const methodsSchema = require('../src/schema/accessesMethods.ts');
const accessSchema = require('../src/schema/access.ts').default;
const Action = require('../src/schema/Action.ts');
const { FEATURE_PERMISSION_NAMES, unknownFeatureMessage } = require('business/src/accesses/permissionSet.ts');
const accessState = require('../src/routes/reg/accessState.ts');

// Feature permission names are a closed set where permissions are submitted;
// a name stored before the set was closed is read back as it is.
describe('[FPNS] accesses: feature permission names', function () {
  this.timeout(60_000);

  const KNOWN = ['selfRevoke', 'secretSharing', 'webhooks', 'accessCreation', 'selfAudit'];
  let fixtures, username, token, user;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'fpns-' + cuid().slice(-8);
    token = cuid();
    user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'fpns', name: 'fpns' });
  });

  after(async function () {
    await accessState.clear();
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  const typo = { feature: 'webhook', setting: 'forbidden' };

  function createAccess (permissions, name = 'fpns ' + cuid()) {
    return coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name, type: 'shared', permissions });
  }

  function assertUnknownFeature (res, feature = 'webhook') {
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error.id, 'invalid-parameters-format', res.text);
    assert.strictEqual(res.body.error.message, unknownFeatureMessage(feature));
    assert.match(res.body.error.message, new RegExp('"' + feature + '".*' + KNOWN.join(', ')));
    assert.deepStrictEqual(res.body.error.data, { feature, knownFeatures: KNOWN });
  }

  function schemaAccepts (data, schema) {
    return new Promise((resolve) => validation.validate(data, schema, (err) => resolve(err == null)));
  }

  it('[FPN8] accesses.create with an unknown feature name is refused, naming it and the known names; nothing is created', async function () {
    const name = 'fpn8 ' + cuid();
    const res = await createAccess([{ streamId: 'fpns', level: 'read' }, typo], name);
    assertUnknownFeature(res);
    const list = await coreRequest.get('/' + username + '/accesses').set('Authorization', token);
    assert.ok(!list.body.accesses.some((a) => a.name === name), 'no access created');
  });

  it('[FPN9] the create and checkApp schemas refuse an unknown feature name; the update and read schemas accept it', async function () {
    assert.deepStrictEqual([...FEATURE_PERMISSION_NAMES], KNOWN);
    const create = (feature) => ({ name: 'x', permissions: [{ feature, setting: 'forbidden' }] });
    assert.strictEqual(await schemaAccepts(create('webhooks'), methodsSchema.create.params), true);
    assert.strictEqual(await schemaAccepts(create('webhook'), methodsSchema.create.params), false);
    const checkApp = { requestingAppId: 'fpn9-app', requestedPermissions: [typo] };
    assert.strictEqual(await schemaAccepts(checkApp, methodsSchema.checkApp.params), false);
    assert.strictEqual(await schemaAccepts({ id: 'fpn9', update: { permissions: [typo] } }, methodsSchema.update.params), true);
    assert.strictEqual(await schemaAccepts([typo], accessSchema.permissions(Action.READ)), true);
  });

  it('[FPNA] accesses.update adding an unknown feature name is refused', async function () {
    const created = await createAccess([{ streamId: 'fpns', level: 'read' }]);
    assert.strictEqual(created.status, 201, created.text);
    const res = await coreRequest.put('/' + username + '/accesses/' + created.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: 'fpns', level: 'read' }, typo] });
    assertUnknownFeature(res);
  });

  it('[FPNB] accesses.checkApp with an unknown feature name is refused', async function () {
    const res = await coreRequest.post('/' + username + '/accesses/check-app').set('Authorization', token)
      .send({ requestingAppId: 'fpnb-app', requestedPermissions: [{ streamId: 'fpns', level: 'read', defaultName: 'Fpns' }, typo] });
    assertUnknownFeature(res);
  });

  it('[FPNC] each known name is accepted, forbidden and allowed', async function () {
    for (const feature of KNOWN) {
      for (const setting of ['forbidden', 'allowed']) {
        const res = await createAccess([{ streamId: 'fpns', level: 'read' }, { feature, setting }]);
        assert.strictEqual(res.status, 201, feature + ' ' + setting + ' ' + res.text);
        assert.ok(res.body.access.permissions.some((p) => p.feature === feature && p.setting === setting), feature + ' ' + setting);
      }
    }
  });

  it('[FPND] an access stored with an unknown name keeps working, is read back as it is, and can be updated', async function () {
    const storedToken = cuid();
    const stored = await user.access({
      type: 'shared',
      name: 'fpnd ' + cuid(),
      token: storedToken,
      permissions: [{ streamId: 'fpns', level: 'read' }, typo],
    });
    const id = stored.attrs.id;
    const list = await coreRequest.get('/' + username + '/accesses').set('Authorization', token);
    assert.strictEqual(list.status, 200, list.text);
    const listed = list.body.accesses.find((a) => a.id === id);
    assert.ok(listed != null, 'listed');
    assert.ok(listed.permissions.some((p) => p.feature === 'webhook'), 'read back as stored');
    const info = await coreRequest.get('/' + username + '/access-info').set('Authorization', storedToken);
    assert.strictEqual(info.status, 200, info.text);
    assert.ok(info.body.permissions.some((p) => p.feature === 'webhook'), 'access-info');
    const events = await coreRequest.get('/' + username + '/events').set('Authorization', storedToken);
    assert.strictEqual(events.status, 200, events.text);
    // Its name alone
    const renamed = await coreRequest.put('/' + username + '/accesses/' + id).set('Authorization', token)
      .send({ name: 'fpnd renamed ' + cuid() });
    assert.strictEqual(renamed.status, 200, renamed.text);
    // Its permissions as read back: the name it already holds is kept
    const echoed = await coreRequest.put('/' + username + '/accesses/' + renamed.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: 'fpns', level: 'contribute' }, typo] });
    assert.strictEqual(echoed.status, 200, echoed.text);
    assert.ok(echoed.body.access.permissions.some((p) => p.feature === 'webhook'), 'kept');
    // A new unknown name is refused
    const added = await coreRequest.put('/' + username + '/accesses/' + echoed.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: 'fpns', level: 'read' }, typo, { feature: 'selfrevoke', setting: 'forbidden' }] });
    assertUnknownFeature(added, 'selfrevoke');
    // The setting of a held name may change
    const flipped = await coreRequest.put('/' + username + '/accesses/' + echoed.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: 'fpns', level: 'read' }, { feature: 'webhook', setting: 'allowed' }] });
    assert.strictEqual(flipped.status, 200, flipped.text);
    assert.ok(flipped.body.access.permissions.some((p) => p.feature === 'webhook' && p.setting === 'allowed'), 'flipped');
    // Once dropped, the name cannot come back
    const dropped = await coreRequest.put('/' + username + '/accesses/' + flipped.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: 'fpns', level: 'read' }] });
    assert.strictEqual(dropped.status, 200, dropped.text);
    const readded = await coreRequest.put('/' + username + '/accesses/' + dropped.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: 'fpns', level: 'read' }, typo] });
    assertUnknownFeature(readded);
  });

  it('[FPNE] POST /reg/access with an unknown feature name is refused, with or without a consent sidecar', async function () {
    for (const extra of [{}, { consent: { allowUserChoice: true } }]) {
      const res = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'fpne-app', requestedPermissions: [{ streamId: 'diary', level: 'read' }, typo], ...extra });
      assert.strictEqual(res.status, 400, JSON.stringify(extra) + ' ' + res.text);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      assert.strictEqual(res.body.error.message, unknownFeatureMessage('webhook'));
    }
    const ok = await coreRequest.post('/reg/access')
      .send({ requestingAppId: 'fpne-app', requestedPermissions: [{ streamId: 'diary', level: 'read' }, { feature: 'selfRevoke', setting: 'forbidden' }] });
    assert.strictEqual(ok.status, 201, ok.text);
  });
});
