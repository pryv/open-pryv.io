/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

// accesses.get options are validated and mean what they say; the account root
// stream cannot be granted at a level that writes.
describe('[ACIN] accesses input checks', function () {
  this.timeout(60_000);

  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'acin-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'acin', name: 'acin' });
    // one deleted access, so deletions exist
    const created = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name: 'to delete', type: 'shared', permissions: [{ streamId: 'acin', level: 'read' }] });
    assert.strictEqual(created.status, 201, created.text);
    const del = await coreRequest.delete('/' + username + '/accesses/' + created.body.access.id).set('Authorization', token);
    assert.strictEqual(del.status, 200, del.text);
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function getAccesses (query) {
    return coreRequest.get('/' + username + '/accesses').set('Authorization', token).query(query);
  }

  it('[AGOP1] `includeDeletions=false` leaves the deletions out; `true` returns them', async function () {
    const withDeletions = await getAccesses({ includeDeletions: true });
    assert.strictEqual(withDeletions.status, 200, withDeletions.text);
    assert.ok(Array.isArray(withDeletions.body.accessDeletions) && withDeletions.body.accessDeletions.length > 0);
    const without = await getAccesses({ includeDeletions: false });
    assert.strictEqual(without.status, 200, without.text);
    assert.strictEqual(without.body.accessDeletions, undefined);
  });

  it('[AGOP2] `includeDeletions` / `includeExpired` must be booleans', async function () {
    for (const query of [{ includeDeletions: 'yes' }, { includeExpired: 'later' }]) {
      const res = await getAccesses(query);
      assert.strictEqual(res.status, 400, JSON.stringify(query) + ' ' + res.text);
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    }
  });

  it('[ACRT1] the account root stream can be granted at `read` or `none` only', async function () {
    for (const level of ['read', 'none']) {
      const res = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
        .send({ name: 'root ' + level, type: 'shared', permissions: [{ streamId: ':_system:account', level }] });
      assert.strictEqual(res.status, 201, level + ' ' + res.text);
    }
    for (const level of ['contribute', 'manage', 'create-only']) {
      const res = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
        .send({ name: 'root ' + level, type: 'app', permissions: [{ streamId: ':_system:account', level }] });
      assert.strictEqual(res.status, 400, level + ' ' + res.text);
      assert.strictEqual(res.body.error.id, 'invalid-operation');
    }
  });

  it('[ACRT2] an update cannot raise the account root stream to a writing level', async function () {
    const created = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name: 'root update', type: 'app', permissions: [{ streamId: ':_system:account', level: 'read' }] });
    assert.strictEqual(created.status, 201, created.text);
    const res = await coreRequest.put('/' + username + '/accesses/' + created.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: ':_system:account', level: 'contribute' }] });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error.id, 'invalid-operation');
  });

  // An access holds one level per stream: two entries for the same stream
  // would silently keep only one of them, depending on their order.
  const duplicates = [
    [{ streamId: 'acin', level: 'manage' }, { streamId: 'acin', level: 'read' }],
    [{ streamId: 'acin', level: 'read' }, { streamId: 'acin', level: 'none' }],
    [{ streamId: 'acin', level: 'read' }, { streamId: ':local:acin', level: 'manage' }],
    [{ streamId: '*', level: 'read' }, { streamId: ':local:*', level: 'contribute' }]
  ];

  it('[ACDP1] two permissions on the same stream are refused at creation', async function () {
    for (const permissions of duplicates) {
      const res = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
        .send({ name: 'dup ' + cuid(), type: 'app', permissions });
      assert.strictEqual(res.status, 400, JSON.stringify(permissions) + ' ' + res.text);
      assert.strictEqual(res.body.error.id, 'invalid-request-structure', res.text);
    }
  });

  it('[ACDP2] two permissions on the same stream are refused at update', async function () {
    const created = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name: 'dup update', type: 'app', permissions: [{ streamId: 'acin', level: 'read' }] });
    assert.strictEqual(created.status, 201, created.text);
    for (const permissions of duplicates) {
      const res = await coreRequest.put('/' + username + '/accesses/' + created.body.access.id).set('Authorization', token)
        .send({ permissions });
      assert.strictEqual(res.status, 400, JSON.stringify(permissions) + ' ' + res.text);
      assert.strictEqual(res.body.error.id, 'invalid-request-structure', res.text);
    }
  });
});
