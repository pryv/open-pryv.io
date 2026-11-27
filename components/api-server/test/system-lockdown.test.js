/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [SYLK] this core's lockdown (`admin.lockdown`) over HTTP: a locked
 * capability answers 403 to the admin key and to an owner's session on its
 * writes while its reads work; the portal context shows the lockdown and
 * leaves hidden capabilities out; with every lockable capability locked,
 * reads, the session routes, setup, role revocation and claim codes still
 * work. The read-only platform configuration keys are covered by the
 * middleware unit tests and the platform configuration routes' own tests.
 */

const { withInjectedConfig } = require('test-helpers');
const setup = require('business/src/admin/setupState.ts');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const { KEYS } = require('business/src/admin/store.ts');
const { CAPABILITY_NAMES } = require('business/src/admin/capabilities.ts');
const { NEVER_LOCKED_CAPABILITIES } = require('business/src/admin/lockdown.ts');

/* global initTests, initCore, coreRequest, assert, cuid */

const MIN = 60 * 1000;

/** Every capability this release can lock, read-only. */
const EVERYTHING = { capabilities: Object.fromEntries(CAPABILITY_NAMES.filter((n) => !NEVER_LOCKED_CAPABILITIES.has(n)).map((n) => [n, 'readonly'])) };

describe('[SYLK] /system lockdown', function () {
  this.timeout(60000);

  let db, adminKey, coreId;
  const namespaces = [];

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.listUsers')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    const config = await require('@pryv/boiler').getConfig();
    adminKey = config.get('auth:adminAccessKey');
    db = require('storages').platformDB;
    coreId = require('platform').platform.coreId;
    await resetAdmin();
  });

  async function resetAdmin () {
    await db.deletePlatformKv(KEYS.setupState);
    for (const { key } of await db.listPlatformKvEntries(KEYS.rolePrefix)) await db.deletePlatformKv(key);
  }

  afterEach(resetAdmin);

  after(async () => {
    await resetAdmin();
    for (const ns of namespaces) await coreRequest.delete('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey);
  });

  async function ready () {
    await setup.recordLegacyReady(db, { coreId, now: Date.now() });
  }

  /** An owner's session (account ids of their own: no account is needed for the role row). */
  async function owner () {
    const userId = 'sylk' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12);
    await roles.grantRole(db, userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    const token = (await sessions.createAdminSession(db, { userId, homeCore: coreId, mfaAt: Date.now(), now: Date.now(), ttlMs: 60 * MIN })).token;
    return { userId, headers: { authorization: 'AdminSession ' + token } };
  }

  function newNamespace () {
    const ns = 'sylk-' + cuid().slice(-8).toLowerCase();
    namespaces.push(ns);
    return ns;
  }

  const asKey = () => ({ authorization: adminKey });

  it('[SL01] without a lockdown block, writes work (baseline)', async () => {
    await ready();
    const res = await coreRequest.put('/system/admin/ext-id-ns/' + newNamespace()).set(asKey()).send({ label: 'Lockdown baseline' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  for (const state of ['readonly', 'hidden']) {
    it(`[SL0${state === 'readonly' ? 2 : 3}] a ${state} capability answers 403 to the admin key and to an owner's session on its writes; its reads work`, async () => {
      await ready();
      const ns = newNamespace();
      assert.equal((await coreRequest.put('/system/admin/ext-id-ns/' + ns).set(asKey()).send({ label: 'Before the lock' })).status, 201);
      const own = await owner();
      await withInjectedConfig({ admin: { lockdown: { capabilities: { extId: state } } } }, async () => {
        for (const [who, headers] of [['admin key', asKey()], ['owner session', own.headers]]) {
          const put = await coreRequest.put('/system/admin/ext-id-ns/' + ns).set(headers).send({ label: 'Changed' });
          assert.equal(put.status, 403, who + ' ' + JSON.stringify(put.body));
          assert.equal(put.body.error.id, 'admin-lockdown-capability', who);
          assert.deepEqual(put.body.error.data, { capability: 'extId' }, who);
          const del = await coreRequest.delete('/system/admin/ext-id-ns/' + ns).set(headers);
          assert.equal(del.status, 403, who);
          const list = await coreRequest.get('/system/admin/ext-id-ns').set(headers);
          assert.equal(list.status, 200, who + ' ' + JSON.stringify(list.body));
          const one = await coreRequest.get('/system/admin/ext-id-ns/' + ns).set(headers);
          assert.equal(one.status, 200, who);
          assert.equal(one.body.namespace.label, 'Before the lock', who);
        }
      });
    });
  }

  it('[SL04] a caller the gate refuses still gets 404, not the lockdown answer', async () => {
    await withInjectedConfig({ admin: { lockdown: { capabilities: { extId: 'readonly' } } } }, async () => {
      assert.equal((await coreRequest.put('/system/admin/ext-id-ns/' + newNamespace()).send({ label: 'x' })).status, 404);
      assert.equal((await coreRequest.put('/system/admin/ext-id-ns/' + newNamespace()).set({ authorization: 'not-the-key' }).send({ label: 'x' })).status, 404);
    });
  });

  it('[SL05] the portal context shows the lockdown and leaves hidden capabilities out', async () => {
    await ready();
    const own = await owner();
    const lockdown = { capabilities: { extId: 'hidden', users: 'readonly' } };
    await withInjectedConfig({ admin: { lockdown } }, async () => {
      for (const headers of [asKey(), own.headers]) {
        const res = await coreRequest.get('/system/admin/portal/context').set(headers);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const ctx = res.body.portalContext;
        assert.deepEqual(ctx.lockdown, { capabilities: { extId: 'hidden', users: 'readonly' }, platformConfig: { readonly: [] } });
        assert.ok(!ctx.capabilities.includes('extId'), 'a hidden capability is not offered');
        assert.ok(ctx.capabilities.includes('users'), 'a read-only capability is still offered');
      }
    });
    const res = await coreRequest.get('/system/admin/portal/context').set(asKey());
    assert.equal(res.body.portalContext.lockdown, undefined, 'no lockdown block: no field');
    assert.ok(res.body.portalContext.capabilities.includes('extId'));
  });

  describe('with every lockable capability locked', function () {
    it('[SL06] reads still work', async () => {
      await ready();
      const own = await owner();
      await withInjectedConfig({ admin: { lockdown: EVERYTHING } }, async () => {
        for (const headers of [asKey(), own.headers]) {
          for (const path of ['/system/admin/users', '/system/admin/ext-id-ns', '/system/admin/config/effective', '/system/admin/roles', '/system/admin/cores']) {
            const res = await coreRequest.get(path).set(headers);
            assert.equal(res.status, 200, path + ' ' + JSON.stringify(res.body).slice(0, 300));
          }
          const lookup = await coreRequest.post('/system/admin/erasures/lookup').set(headers).send({ username: 'nobody-' + cuid().slice(-6) });
          assert.notEqual(lookup.body.error?.id, 'admin-lockdown-capability', 'a POST read');
        }
        // A write of a locked capability is refused, so the block applies.
        assert.equal((await coreRequest.put('/system/admin/ext-id-ns/' + newNamespace()).set(asKey()).send({ label: 'x' })).status, 403);
      });
    });

    it('[SL07] the session routes still work', async () => {
      await ready();
      const own = await owner();
      await withInjectedConfig({ admin: { lockdown: EVERYTHING } }, async () => {
        assert.equal((await coreRequest.get('/system/admin/session').set(own.headers)).status, 200);
        // No personal token sent: the renewal answers for itself (not the lockdown step).
        const renew = await coreRequest.post('/system/admin/session/renew').set(own.headers).send({});
        assert.notEqual(renew.status, 403, JSON.stringify(renew.body));
        const stepUp = await coreRequest.post('/system/admin/session/step-up').set(own.headers).send({});
        assert.notEqual(stepUp.status, 403, JSON.stringify(stepUp.body));
        assert.equal((await coreRequest.delete('/system/admin/session').set(own.headers)).status, 204);
      });
    });

    it('[SL08] setup still works (setup code replacement, setup session)', async () => {
      assert.equal(await setup.claimFreshPending(db, { coreId, now: Date.now() }), true);
      await withInjectedConfig({ admin: { lockdown: EVERYTHING } }, async () => {
        const replaced = await coreRequest.post('/system/admin/setup/code').set(asKey()).send({});
        assert.ok(replaced.status < 300, JSON.stringify(replaced.body));
        const session = await coreRequest.post('/system/setup/session').send({ code: replaced.body.setupCode.code });
        assert.equal(session.status, 201, JSON.stringify(session.body));
        const checks = await coreRequest.get('/system/setup/checks').set({ authorization: 'SetupSession ' + session.body.setupSession.token });
        assert.equal(checks.status, 200);
      });
    });

    it('[SL09] role revocation still works, for the admin key and for an owner', async () => {
      await ready();
      const a = await owner();
      const b = await owner();
      const c = await owner();
      await withInjectedConfig({ admin: { lockdown: EVERYTHING } }, async () => {
        const byKey = await coreRequest.delete('/system/admin/roles/' + b.userId).set(asKey());
        assert.equal(byKey.status, 200, JSON.stringify(byKey.body));
        const byOwner = await coreRequest.delete('/system/admin/roles/' + c.userId).set(a.headers);
        assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
      });
    });

    it('[SL10] claim codes can still be minted, by the admin key and by an owner', async () => {
      await ready();
      const own = await owner();
      await withInjectedConfig({ admin: { lockdown: EVERYTHING } }, async () => {
        for (const headers of [asKey(), own.headers]) {
          const minted = await coreRequest.post('/system/admin/claim-codes').set(headers).send({});
          assert.equal(minted.status, 201, JSON.stringify(minted.body));
        }
      });
    });
  });
});
