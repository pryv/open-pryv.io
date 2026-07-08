/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[ALIA] access aliases (randomAlias)', function () {
  let username;
  let fixtureUser;
  let stream0;
  let masterToken;

  before(async function () {
    await initTests();
    await initCore();

    username = cuid();

    fixtureUser = await fixtures().user(username);
    stream0 = await fixtureUser.stream({ id: `s0_${username}`, name: 'S0' });
    // App access with manage-all rights: can create sub-accesses, delete them
    // and call access-info (session-less, unlike a personal token).
    masterToken = cuid();
    await fixtureUser.access({
      id: `master_${username}`,
      token: masterToken,
      name: 'master app',
      type: 'app',
      permissions: [{ streamId: '*', level: 'manage' }]
    });
  });

  function fixtures () { return getNewFixture(); }

  function createAccess (body, token = masterToken) {
    return coreRequest
      .post('/' + username + '/accesses')
      .set('Authorization', token)
      .send(body);
  }

  it('[AL01] creates a shared access with a routable r- alias and hides the username in the apiEndpoint', async function () {
    const res = await createAccess({
      name: 'aliased shared',
      randomAlias: true,
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const access = res.body.access;
    assert.ok(access.alias, 'alias should be set');
    assert.match(access.alias, /^r-[a-z0-9]{8}$/, 'alias is r- + 8 unambiguous chars');
    assert.doesNotMatch(access.alias, /[0o1li]/, 'alias avoids ambiguous chars');
    // The apiEndpoint must carry the alias, never the real username.
    assert.ok(access.apiEndpoint.includes(access.alias), 'apiEndpoint carries the alias');
    assert.ok(!access.apiEndpoint.includes(username), 'apiEndpoint must not leak the username');
    // randomAlias is input-only and must not be echoed back.
    assert.strictEqual(access.randomAlias, undefined);
  });

  it('[AL02] access-info via the alias endpoint reports the alias as username, not the real one', async function () {
    const created = await createAccess({
      name: 'aliased shared 2',
      randomAlias: true,
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });
    const { alias, token } = created.body.access;

    // Address the user by the ALIAS (routing) using the aliased access token.
    const res = await coreRequest
      .get('/' + alias + '/access-info')
      .set('Authorization', token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.username, alias, 'reports the alias');
    assert.notEqual(res.body.user.username, username, 'never the real username');
    assert.equal(res.body.alias, alias);
  });

  it('[AL03] a non-aliased access reports the real (canonical) username even when addressed via an alias', async function () {
    // Mint an alias on one access, then call access-info with a DIFFERENT,
    // non-aliased token while addressing the user by the alias path.
    const aliased = await createAccess({
      name: 'aliased shared 3',
      randomAlias: true,
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });
    const alias = aliased.body.access.alias;
    const res = await coreRequest
      .get('/' + alias + '/access-info')
      .set('Authorization', masterToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.username, username, 'non-aliased access -> canonical username');
  });

  it('[AL04] mints unique aliases across many accesses (no collision)', async function () {
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const r = await createAccess({
        name: 'bulk ' + i,
        randomAlias: true,
        permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
      });
      assert.equal(r.status, 201);
      const a = r.body.access.alias;
      assert.ok(!seen.has(a), 'alias must be unique: ' + a);
      seen.add(a);
    }
  });

  it('[AL05] releasing the access (delete) makes the alias no longer resolve', async function () {
    const created = await createAccess({
      name: 'to delete',
      randomAlias: true,
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });
    const { id, alias, token } = created.body.access;

    // resolves before delete
    const before = await coreRequest.get('/' + alias + '/access-info').set('Authorization', token);
    assert.equal(before.status, 200);

    const del = await coreRequest
      .delete('/' + username + '/accesses/' + id)
      .set('Authorization', masterToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));

    // alias no longer routes to a user -> unknown resource
    const after = await coreRequest.get('/' + alias + '/access-info').set('Authorization', token);
    assert.equal(after.status, 404, 'alias should no longer resolve');
  });
});
