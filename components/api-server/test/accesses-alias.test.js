/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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

  it('[AL06] an alias chosen by the client is refused at creation', async function () {
    const res = await createAccess({
      name: 'chosen alias',
      alias: 'r-' + cuid.slug(),
      permissions: [{ streamId: stream0.attrs.id, level: 'read' }]
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('[AL08] an aliased access allowed to read the account streams does not learn the username from them', async function () {
    const personalToken = cuid();
    await fixtureUser.access({ type: 'personal', token: personalToken });
    await fixtureUser.session(personalToken);
    const created = await createAccess({
      name: 'aliased account reader',
      type: 'shared',
      randomAlias: true,
      permissions: [{ streamId: ':_system:account', level: 'read' }]
    }, personalToken);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { alias, token } = created.body.access;
    // (`/streams` is not checked: fixture streams name the user id, which
    // fixtures set to the username, as their author.)
    for (const path of ['/events?streams[]=:_system:account&limit=1000&state=all', '/access-info']) {
      const res = await coreRequest.get('/' + alias + path).set('Authorization', token);
      assert.equal(res.status, 200, path + ': ' + JSON.stringify(res.body));
      assert.ok(!JSON.stringify(res.body).includes(username), path + ' must not carry the username: ' + JSON.stringify(res.body));
    }
    // The username is no account stream: nothing to grant.
    const direct = await createAccess({
      name: 'aliased username reader',
      type: 'shared',
      randomAlias: true,
      permissions: [{ streamId: ':_system:username', level: 'read' }]
    }, personalToken);
    assert.notEqual(direct.status, 201, JSON.stringify(direct.body));
  });

  it('[AL09] a request addressed by the username reads no canonical name from storage, one addressed by an alias still reports the username', async function () {
    const usersIndex = await require('storage').getUsersLocalIndex();
    const aliased = await createAccess({ name: 'al09', randomAlias: true, permissions: [{ streamId: stream0.attrs.id, level: 'read' }] });
    assert.equal(aliased.status, 201, JSON.stringify(aliased.body));
    const original = usersIndex.db.getNameForId;
    let reads = 0;
    usersIndex.db.getNameForId = async function (...args) { reads++; return await original.apply(this, args); };
    try {
      for (let i = 0; i < 3; i++) {
        const res = await coreRequest.get('/' + username + '/access-info').set('Authorization', masterToken);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.user.username, username);
      }
      assert.strictEqual(reads, 0, 'no canonical-name read when addressed by the username');
      const viaAlias = await coreRequest.get('/' + aliased.body.access.alias + '/access-info').set('Authorization', masterToken);
      assert.equal(viaAlias.status, 200, JSON.stringify(viaAlias.body));
      assert.equal(viaAlias.body.user.username, username, 'the canonical name, read for an alias');
    } finally {
      usersIndex.db.getNameForId = original;
    }
  });

  it('[AL10] a create refused before the insert (negative expireAfter, unknown account stream) reserves no alias', async function () {
    const usersIndex = await require('storage').getUsersLocalIndex();
    const userId = fixtureUser.attrs.id;
    const before = await usersIndex.getAliasesForId(userId);
    for (const body of [
      { name: 'al10 expiry', randomAlias: true, expireAfter: -1, permissions: [{ streamId: stream0.attrs.id, level: 'read' }] },
      { name: 'al10 stream', randomAlias: true, permissions: [{ streamId: ':_system:no-such-field', level: 'read' }] }
    ]) {
      const res = await createAccess(body);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
    }
    assert.deepStrictEqual((await usersIndex.getAliasesForId(userId)).sort(), before.sort(), 'no alias left behind');
  });

  it('[AL11] a create refused by the insert (token already used) gives its minted alias back', async function () {
    const usersIndex = await require('storage').getUsersLocalIndex();
    const userId = fixtureUser.attrs.id;
    const token = cuid();
    const first = await createAccess({ name: 'al11 first', token, permissions: [{ streamId: stream0.attrs.id, level: 'read' }] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const before = await usersIndex.getAliasesForId(userId);
    const res = await createAccess({ name: 'al11 second', token, randomAlias: true, permissions: [{ streamId: stream0.attrs.id, level: 'read' }] });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const after = await usersIndex.getAliasesForId(userId);
    assert.deepStrictEqual(after.sort(), before.sort(), 'the minted alias was given back');
  });

  it('[AL07] deleting an access whose stored alias is another user\'s releases nothing of that user', async function () {
    // The other user owns a minted alias.
    const otherName = cuid();
    const otherUser = await fixtures().user(otherName);
    const otherToken = cuid();
    await otherUser.access({ token: otherToken, type: 'app', permissions: [{ streamId: '*', level: 'manage' }] });
    const minted = await coreRequest.post('/' + otherName + '/accesses').set('Authorization', otherToken)
      .send({ name: 'minted', randomAlias: true, permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const { alias, token: aliasedToken } = minted.body.access;

    // An access of this user stored with that alias and with the other
    // user's username (as written before aliases were server-only).
    for (const name of [alias, otherName]) {
      const id = cuid();
      await fixtureUser.access({ id, token: cuid(), name: 'planted ' + name, type: 'shared', alias: name, createdBy: `master_${username}`, permissions: [{ streamId: stream0.attrs.id, level: 'read' }] });
      const del = await coreRequest.delete('/' + username + '/accesses/' + id).set('Authorization', masterToken);
      assert.equal(del.status, 200, JSON.stringify(del.body));
    }

    const viaAlias = await coreRequest.get('/' + alias + '/access-info').set('Authorization', aliasedToken);
    assert.equal(viaAlias.status, 200, 'the other user\'s alias still resolves: ' + JSON.stringify(viaAlias.body));
    const viaName = await coreRequest.get('/' + otherName + '/access-info').set('Authorization', otherToken);
    assert.equal(viaName.status, 200, 'the other user\'s username still resolves');
  });
});
