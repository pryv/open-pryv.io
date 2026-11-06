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
 * [OPAL] the account's address aliases: the owner creates (the server mints
 * the name), lists and deletes them with a personal token, within a budget;
 * an address alias is an address of the account (the platform routes it, the
 * embedded DNS answers it) that no access holds until an OAuth consent bound
 * to it adopts it (see the per-user audience tests).
 */

const dns = require('node:dns');
const { createDnsServer } = require('dns-server/src/index.ts');

const DOMAIN = 'opal.test';
const CORE_IP = '10.9.8.6';
const PASSWORD = 'test-password-1';
const APP_ID = 'pryv-test-no-cors';
const SHAPE = /^a-[a-z0-9]{8}$/;

describe('[OPAL] account address aliases', function () {
  this.timeout(60000);
  let platform, usersRepository, dnsServer, resolver;

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
    platform = usersRepository.platform;
    const dnsPlatform = {
      getUserCore: (name) => platform.getUserCore(name),
      getCoreInfo: async (coreId) => coreId === platform.coreId ? { id: coreId, ip: CORE_IP } : null,
      getAllCoreInfos: async () => [{ id: platform.coreId, ip: CORE_IP }]
    };
    const store = {
      'dns:domain': DOMAIN,
      'dns:active': true,
      'dns:defaultTTL': 5,
      'dns:staticEntries': {},
      'dns:records:root': { a: [CORE_IP] },
      'core:id': platform.coreId
    };
    dnsServer = createDnsServer({
      config: { get: (key) => store[key] },
      platform: dnsPlatform,
      logger: { info () {}, warn () {}, error (msg) { console.error('[dns:error]', msg); } },
      platformRefreshIntervalMs: 0
    });
    await dnsServer.start({ port: 0, ip: '127.0.0.1', ip6: null });
    resolver = new dns.promises.Resolver();
    resolver.setServers([`127.0.0.1:${dnsServer._getAddresses().udp.port}`]);
  });

  after(async function () {
    if (dnsServer) await dnsServer.stop();
  });

  async function resolves (name) {
    try {
      return await resolver.resolve4(`${name}.${DOMAIN}`);
    } catch (err) {
      if (err.code === 'ENOTFOUND') return null;
      throw err;
    }
  }

  function freshName (prefix) {
    return (prefix + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  }

  async function freshUser (prefix) {
    const uname = freshName(prefix);
    const fu = await getNewFixture().user(uname, { password: PASSWORD });
    await platform.setUserCore(uname, platform.coreId);
    const login = await coreRequest.post('/' + uname + '/auth/login').send({ username: uname, password: PASSWORD, appId: APP_ID });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const appToken = cuid();
    await fu.access({ token: appToken, type: 'app', name: 'opal app ' + uname, permissions: [{ streamId: '*', level: 'manage' }] });
    return { uname, userId: fu.attrs.id, token: login.body.token, appToken };
  }

  const create = (who, token = who.token, body = {}) => coreRequest.post('/' + who.uname + '/account/address-aliases').set('Authorization', token).send(body);
  const list = (who, token = who.token) => coreRequest.get('/' + who.uname + '/account/address-aliases').set('Authorization', token);
  const remove = (who, alias, token = who.token) => coreRequest.delete('/' + who.uname + '/account/address-aliases/' + alias).set('Authorization', token);

  it('[OPAL1] create, list and delete within the budget of 10: the 11th is refused, a deleted one frees its place, an unknown one is 404', async function () {
    const alice = await freshUser('opa');
    const minted = [];
    for (let i = 0; i < 10; i++) {
      const res = await create(alice);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const { alias, apiEndpoint, heldBy } = res.body.addressAlias;
      assert.match(alias, SHAPE);
      assert.ok(apiEndpoint.includes(alias), apiEndpoint);
      assert.ok(!apiEndpoint.includes(alice.uname), 'the endpoint does not name the username');
      assert.equal(heldBy, null);
      minted.push(alias);
    }
    assert.equal(new Set(minted).size, 10);
    const eleventh = await create(alice);
    assert.equal(eleventh.status, 400, JSON.stringify(eleventh.body));
    assert.equal(eleventh.body.error.id, 'invalid-operation');
    assert.equal(eleventh.body.error.data.addressAliasesLimit, 10);
    const listed = await list(alice);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.addressAliasesLimit, 10);
    assert.deepEqual(listed.body.addressAliases.map((a) => a.alias).sort(), [...minted].sort());
    assert.ok(listed.body.addressAliases.every((a) => a.heldBy === null));

    const del = await remove(alice, minted[0]);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual([del.body.addressAliasDeletion, del.body.relatedDeletions], [{ alias: minted[0] }, []]);
    assert.ok(!(await usersRepository.getAliasesForUserId(alice.userId)).includes(minted[0]), 'released from the index');
    assert.equal((await list(alice)).body.addressAliases.length, 9);
    assert.equal((await create(alice)).status, 201, 'a deleted alias frees its place');

    const again = await remove(alice, minted[0]);
    assert.equal(again.status, 404, JSON.stringify(again.body));
    assert.equal(again.body.error.id, 'unknown-resource');
    // Another account's alias, or an access's alias, is not one to delete here.
    const bob = await freshUser('opb');
    const bobs = (await create(bob)).body.addressAlias.alias;
    assert.equal((await remove(alice, bobs)).status, 404);
    assert.ok((await usersRepository.getAliasesForUserId(bob.userId)).includes(bobs), 'bob keeps it');
    const aliased = await coreRequest.post('/' + bob.uname + '/accesses').set('Authorization', bob.token)
      .send({ name: 'opal1 aliased', type: 'shared', randomAlias: true, permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(aliased.status, 201, JSON.stringify(aliased.body));
    assert.equal((await remove(bob, aliased.body.access.alias)).status, 404);
    assert.ok(!(await list(bob)).body.addressAliases.some((a) => a.alias === aliased.body.access.alias), 'an access alias is not listed');
  });

  it('[OPAL2] personal token only; the name is minted, never chosen; its shape is refused as a username; signing in at it is refused', async function () {
    const alice = await freshUser('opc');
    for (const res of [await create(alice, alice.appToken), await list(alice, alice.appToken)]) {
      assert.equal(res.status, 403, JSON.stringify(res.body));
    }
    const chosen = await create(alice, alice.token, { alias: 'a-chosen23' });
    assert.equal(chosen.status, 400, JSON.stringify(chosen.body));
    assert.equal(chosen.body.error.id, 'invalid-parameters-format');
    const { alias } = (await create(alice)).body.addressAlias;
    assert.equal((await remove(alice, alias, alice.appToken)).status, 403);

    const check = await coreRequest.get('/reg/a-abcdefgh/check_username');
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.strictEqual(check.body.reserved, true, 'the address-alias shape is reserved');
    const renamed = await coreRequest.post('/' + alice.uname + '/account/change-username').set('Authorization', alice.token).send({ newUsername: 'a-abcdefgh' });
    assert.equal(renamed.status, 400, JSON.stringify(renamed.body));
    assert.equal(renamed.body.error.id, 'invalid-operation');

    // Addressed at the alias: a sign-in is refused like a wrong username, the
    // owner's personal token is served, a token without an alias is not.
    const login = await coreRequest.post('/' + alias + '/auth/login').send({ username: alice.uname, password: PASSWORD, appId: APP_ID });
    assert.equal(login.status, 400, JSON.stringify(login.body));
    assert.equal((await coreRequest.get('/' + alias + '/access-info').set('Authorization', alice.token)).status, 200);
    const asApp = await coreRequest.get('/' + alias + '/access-info').set('Authorization', alice.appToken);
    assert.equal(asApp.status, 403, JSON.stringify(asApp.body));
  });

  it('[OPAL3] an address alias routes to the home core and answers in the embedded DNS; deleted, it routes nowhere', async function () {
    const alice = await freshUser('opd');
    const { alias } = (await create(alice)).body.addressAlias;
    assert.strictEqual(await platform.getUserCore(alias), platform.coreId);
    assert.deepStrictEqual(await resolves(alias), [CORE_IP]);
    assert.equal((await remove(alice, alias)).status, 200);
    assert.strictEqual(await platform.getUserCore(alias), null);
    assert.strictEqual(await resolves(alias), null);
  });
});
