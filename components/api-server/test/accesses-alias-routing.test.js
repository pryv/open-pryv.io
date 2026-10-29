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
 * [ALRT] the names an account is reached by (its aliases, and its username
 * after a change) route on a single core too: the embedded DNS answers them
 * through the same name -> core rows as on a multi-core platform.
 */

const dns = require('node:dns');
const { createDnsServer } = require('dns-server/src/index.ts');

const DOMAIN = 'alrt.test';
const CORE_IP = '10.9.8.7';
const PASSWORD = 'test-password-1';
const APP_ID = 'pryv-test-no-cors';

describe('[ALRT] alias and renamed-name routing on a single core', function () {
  let platform, usersRepository, dnsServer, resolver;

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
    platform = usersRepository.platform;
    assert.strictEqual(platform.isSingleCore, true, 'these cases run on a single core');

    // The embedded DNS over the real name -> core rows; only the core's
    // address is fixed here.
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
    // The row registration writes (fixtures do not register).
    await platform.setUserCore(uname, platform.coreId);
    const token = cuid();
    await fu.access({ token, type: 'app', name: 'manager ' + uname, permissions: [{ streamId: '*', level: 'manage' }] });
    return { uname, userId: fu.attrs.id, token };
  }

  it('[ALRT1] a minted alias answers in the embedded DNS, and no longer once released', async function () {
    const { uname, token } = await freshUser('ra');
    assert.deepStrictEqual(await resolves(uname), [CORE_IP], 'the username answers');
    const res = await coreRequest.post('/' + uname + '/accesses').set('Authorization', token)
      .send({ name: 'aliased', type: 'shared', randomAlias: true, permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { alias, id } = res.body.access;
    assert.strictEqual(await platform.getUserCore(alias), platform.coreId);
    assert.deepStrictEqual(await resolves(alias), [CORE_IP], 'the alias answers');

    const del = await coreRequest.delete('/' + uname + '/accesses/' + id).set('Authorization', token);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(await platform.getUserCore(alias), null, 'the released alias routes nowhere');
    assert.strictEqual(await resolves(alias), null);
  });

  it('[ALRT2] after a username change both the new and the former name answer', async function () {
    const { uname } = await freshUser('rb');
    const login = await coreRequest.post('/' + uname + '/auth/login').send({ username: uname, password: PASSWORD, appId: APP_ID });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const newName = freshName('rc');
    const res = await coreRequest.post('/' + uname + '/account/change-username')
      .set('Authorization', login.body.token).send({ newUsername: newName });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await resolves(newName), [CORE_IP], 'the new name answers');
    assert.deepStrictEqual(await resolves(uname), [CORE_IP], 'the former name still answers');
  });

  it('[ALRT3] reconcile (single core) gives back the rows of aliases and changed names written without them, idempotently', async function () {
    const { uname, userId, token } = await freshUser('rd');
    const res = await coreRequest.post('/' + uname + '/accesses').set('Authorization', token)
      .send({ name: 'aliased', type: 'shared', randomAlias: true, permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const alias = res.body.access.alias;
    const newName = freshName('re');
    await usersRepository.changeUsername(userId, uname, newName, 'system');
    // A single core of an earlier release: no row for the alias, the new name
    // or the former name (now an alias).
    for (const name of [alias, newName, uname]) await platform.deleteUserCore(name);
    for (const name of [alias, newName, uname]) assert.strictEqual(await resolves(name), null, name + ' answers nothing');

    const dry = await usersRepository.reconcileUserCoreMap(true);
    for (const name of [alias, newName, uname]) {
      assert.ok(dry.healed.includes(platform.hashFor('username', name)), name + ' reported by the dry run');
      assert.strictEqual(await platform.getUserCore(name), null, 'the dry run writes nothing');
    }

    await usersRepository.reconcileUserCoreMap();
    for (const name of [alias, newName, uname]) {
      assert.strictEqual(await platform.getUserCore(name), platform.coreId, name + ' routes here again');
      assert.deepStrictEqual(await resolves(name), [CORE_IP], name + ' answers');
    }
    const again = await usersRepository.reconcileUserCoreMap();
    for (const name of [alias, newName, uname]) {
      assert.ok(!again.healed.includes(platform.hashFor('username', name)), name + ': nothing left to heal');
    }
  });
});
