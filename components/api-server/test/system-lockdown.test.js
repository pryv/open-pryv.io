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
 * work; the admin-key writes outside /system (DNS records, server rename,
 * invitations, account deletion) are bound too; the classification of every
 * entry of the real route table; method, path and key variants through the
 * real matcher. The platform configuration routes' own tests cover the
 * read-only keys over HTTP.
 */

const { withInjectedConfig } = require('test-helpers');
const { SYSTEM_ROUTES, routeMatcher } = require('api-server/src/routes/system-permissions.ts');
const { capabilityOf } = require('business/src/admin/permissions.ts');
const adminLockdown = require('middleware/src/adminLockdown.ts').default;
const setup = require('business/src/admin/setupState.ts');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const { KEYS } = require('business/src/admin/store.ts');
const { CAPABILITY_NAMES } = require('business/src/admin/capabilities.ts');
const { NEVER_LOCKED_CAPABILITIES } = require('business/src/admin/lockdown.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

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
    if (!app.api.has('auth.delete')) await require('api-server/src/methods/auth/delete.ts').default(app.api);
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

  const fixtureSets = [];
  after(async () => {
    await resetAdmin();
    for (const ns of namespaces) await coreRequest.delete('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey);
    for (const fixtures of fixtureSets) await fixtures.clean();
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

  describe('admin-key writes outside /system', function () {
    const locked = (capability) => ({ admin: { lockdown: { capabilities: { [capability]: 'readonly' } } } });

    function assertLocked (res, capability, what) {
      assert.equal(res.status, 403, what + ' ' + JSON.stringify(res.body));
      assert.equal(res.body.error.id, 'admin-lockdown-capability', what);
      assert.deepEqual(res.body.error.data, { capability }, what);
    }

    it('[SL11] POST /reg/records (dns): 403 when dns is locked, nothing stored; works when not', async () => {
      const platform = await require('platform').getPlatform();
      const sub = '_lockdown-' + cuid().slice(-8).toLowerCase();
      const body = { subdomain: sub, records: { txt: ['lockdown-token'] } };
      await withInjectedConfig(locked('dns'), async () => {
        assertLocked(await coreRequest.post('/reg/records').set(asKey()).send(body), 'dns', 'POST');
      });
      assert.equal(await platform.getDnsRecord(sub), null, 'nothing stored');
      await withInjectedConfig(locked('mail'), async () => {
        const res = await coreRequest.post('/reg/records').set(asKey()).send(body);
        assert.equal(res.status, 200, JSON.stringify(res.body));
      });
      await platform.deleteDnsRecord(sub);
    });

    it('[SL12] DELETE /reg/records/:subdomain (dns): 403 when dns is locked, the record stays; works when not', async () => {
      const platform = await require('platform').getPlatform();
      const sub = '_lockdown-' + cuid().slice(-8).toLowerCase();
      await platform.setDnsRecord(sub, { txt: ['lockdown-token'] });
      await withInjectedConfig(locked('dns'), async () => {
        assertLocked(await coreRequest.delete('/reg/records/' + sub).set(asKey()), 'dns', 'DELETE');
      });
      assert.deepEqual(await platform.getDnsRecord(sub), { txt: ['lockdown-token'] }, 'the record stays');
      const res = await coreRequest.delete('/reg/records/' + sub).set(asKey());
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('[SL13] GET /reg/admin/servers/:src/rename/:dst (cores): 403 when cores is locked; reaches the handler when not', async () => {
      await withInjectedConfig(locked('cores'), async () => {
        assertLocked(await coreRequest.get('/reg/admin/servers/no-such-core/rename/Bad_Core').set(asKey()), 'cores', 'rename');
      });
      // Unlocked: the handler answers (an invalid destination core id).
      const res = await coreRequest.get('/reg/admin/servers/no-such-core/rename/Bad_Core').set(asKey());
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    it('[SL14] GET /reg/admin/invitations/post (invitations): 403 when invitations is locked; the list still reads; works when not', async () => {
      await withInjectedConfig(locked('invitations'), async () => {
        assertLocked(await coreRequest.get('/reg/admin/invitations/post?count=1').set(asKey()), 'invitations', 'mint');
        assert.equal((await coreRequest.get('/reg/admin/invitations').set(asKey())).status, 200, 'the list is a read');
      });
      const before = new Set((await db.getAllInvitationTokens()).map((t) => t.id));
      try {
        const res = await coreRequest.get('/reg/admin/invitations/post?count=1&message=lockdown-test').set(asKey());
        assert.equal(res.status, 200, JSON.stringify(res.body));
      } finally {
        // Any stored invitation token makes registration require one: leave none behind.
        for (const t of await db.getAllInvitationTokens()) {
          if (!before.has(t.id)) await db.deleteInvitationToken(t.id);
        }
      }
    });

    it('[SL15] DELETE /users/:username by the admin key (users): 403 when users is locked; the account\'s own token is never locked', async () => {
      const fixtures = getNewFixture();
      fixtureSets.push(fixtures);
      const deletable = { 'user-account': { delete: ['adminToken', 'personalToken'] } };
      const makeUser = async () => {
        const username = ('sylk' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
        const user = await fixtures.user(username);
        const token = cuid();
        await user.access({ token, type: 'personal' });
        await user.session(token);
        return { username, token };
      };
      const a = await makeUser();
      const b = await makeUser();
      await withInjectedConfig({ ...deletable, ...locked('users') }, async () => {
        assertLocked(await coreRequest.delete('/users/' + a.username).set(asKey()), 'users', 'admin key');
        const own = await coreRequest.delete('/users/' + a.username).set('authorization', a.token);
        assert.equal(own.status, 200, 'own token: ' + JSON.stringify(own.body));
      });
      await withInjectedConfig(deletable, async () => {
        const res = await coreRequest.delete('/users/' + b.username).set(asKey());
        assert.equal(res.status, 200, JSON.stringify(res.body));
      });
    });
  });

  describe('fail closed on an invalid lockdown', function () {
    it('[SL16] an invalid admin.lockdown under a running process refuses lockable writes (500), outside /system too', async () => {
      // A mistyped state must not leave that capability editable.
      await withInjectedConfig({ admin: { lockdown: { capabilities: { dns: 'readonyl', mail: 'readonly' } } } }, async () => {
        const res = await coreRequest.post('/reg/records').set(asKey()).send({ subdomain: '_lockdown-x', records: { txt: ['x'] } });
        assert.equal(res.status, 500, JSON.stringify(res.body));
        assert.equal(res.body.error.id, 'admin-lockdown-invalid');
      });
    });
  });

  describe('classification of the real route table', function () {
    const nonGet = SYSTEM_ROUTES.filter((e) => e.method !== 'GET' && e.rule.auth === 'admin');
    const name = (e) => e.method + ' ' + e.path;

    it('[SL17] the non-GET routes whose permission is a read are exactly the known POST reads', () => {
      assert.deepEqual(nonGet.filter((e) => e.rule.permission?.endsWith(':read')).map(name).sort(), [
        'POST /system/admin/erasures/lookup',
        'POST /system/ext-id/holds'
      ], 'a new write must not carry a :read permission (lockdown never refuses those); a real POST read goes in this list');
    });

    it('[SL18] the non-GET routes without a permission are exactly the session routes', () => {
      assert.deepEqual(nonGet.filter((e) => e.rule.permission == null).map(name).sort(), [
        'DELETE /system/admin/session',
        'POST /system/admin/session/renew',
        'POST /system/admin/session/step-up'
      ], 'a new write must carry a permission (lockdown never refuses a route without one)');
    });

    it('[SL19] no GET route carries a write permission, and every permission names a capability', () => {
      for (const e of SYSTEM_ROUTES) {
        if (e.rule.auth !== 'admin' || e.rule.permission == null) continue;
        assert.ok(CAPABILITY_NAMES.includes(capabilityOf(e.rule.permission)), name(e) + ': ' + e.rule.permission);
        if (e.method === 'GET') assert.ok(e.rule.permission.endsWith(':read'), name(e) + ' is a GET with ' + e.rule.permission + ' (lockdown never refuses a GET)');
      }
    });

    it('[SL20] with every lockable capability locked, the step refuses each remaining write, and only those', async () => {
      const step = adminLockdown({ rule: (m, p) => routeMatcher()(m, p)?.rule ?? null, config: { get: (k) => (k === 'admin:lockdown' ? EVERYTHING : undefined) } });
      for (const e of nonGet) {
        const path = e.path.replace(/:[A-Za-z]+/g, 'x1');
        const err = await new Promise((resolve) => step({ method: e.method, path, headers: {} }, {}, resolve));
        const p = e.rule.permission;
        const exempt = p == null || p.endsWith(':read') || NEVER_LOCKED_CAPABILITIES.has(capabilityOf(p));
        if (exempt) assert.equal(err, undefined, name(e) + ' must pass');
        else assert.equal(err?.id, 'admin-lockdown-capability', name(e) + ' must be refused');
      }
    });
  });

  describe('variants through the real matcher', function () {
    it('[SL21] case, trailing slash, doubled slash, HEAD and PATCH on a locked write path never change anything', async () => {
      await ready();
      const ns = newNamespace();
      assert.equal((await coreRequest.put('/system/admin/ext-id-ns/' + ns).set(asKey()).send({ label: 'Before the lock' })).status, 201);
      const own = await owner();
      await withInjectedConfig({ admin: { lockdown: { capabilities: { extId: 'readonly' } } } }, async () => {
        for (const headers of [asKey(), own.headers]) {
          for (const [method, path] of [
            ['put', '/system/admin/EXT-ID-NS/' + ns],
            ['put', '/system/ADMIN/ext-id-ns/' + ns],
            ['put', '/system/admin/ext-id-ns/' + ns + '/'],
            ['put', '/system/admin//ext-id-ns/' + ns],
            ['patch', '/system/admin/ext-id-ns/' + ns],
            ['delete', '/system/admin/Ext-Id-Ns/' + ns + '/']
          ]) {
            const res = await coreRequest[method](path).set(headers).send({ label: 'Changed' });
            assert.ok([403, 404].includes(res.status), `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
          }
          const head = await coreRequest.head('/system/admin/ext-id-ns/' + ns).set(headers);
          assert.ok(head.status < 500, 'HEAD is the GET handler');
        }
      });
      const one = await coreRequest.get('/system/admin/ext-id-ns/' + ns).set(asKey());
      assert.equal(one.body.namespace.label, 'Before the lock', 'nothing changed');
    });

    it('[SL22] platform configuration key variants: each form Express decodes to a read-only key is refused', async () => {
      // The platform configuration routes as the module contract names them (appended
      // when this branch's table does not hold them yet; the first match wins).
      const entries = [
        ...SYSTEM_ROUTES,
        { method: 'PUT', path: '/system/admin/platform-config/:key', methodId: null, rule: { auth: 'admin', permission: 'config:write' } },
        { method: 'DELETE', path: '/system/admin/platform-config/:key', methodId: null, rule: { auth: 'admin', permission: 'config:write' } },
        { method: 'GET', path: '/system/admin/platform-config/:key', methodId: null, rule: { auth: 'admin', permission: 'config:read' } }
      ];
      const match = routeMatcher(entries);
      const step = adminLockdown({ rule: (m, p) => match(m, p)?.rule ?? null, config: { get: (k) => (k === 'admin:lockdown' ? { platformConfig: { readonly: ['service.name'] } } : undefined) } });
      const run = (method, path) => new Promise((resolve) => step({ method, path, headers: {} }, {}, resolve));
      for (const [method, path] of [
        ['PUT', '/system/admin/platform-config/service.name'],
        ['DELETE', '/system/admin/platform-config/service.name'],
        ['PUT', '/system/admin/PLATFORM-CONFIG/service.name'],
        ['PUT', '/system/admin/platform-config/service.name/'],
        ['PUT', '/system/admin/platform-config/service%2Ename'],
        ['PUT', '/system/admin/platform-config/service%2ename']
      ]) {
        assert.equal((await run(method, path))?.id, 'admin-lockdown-key', method + ' ' + path);
      }
      // Not the read-only key once decoded as Express does (one decoding,
      // case kept): the route answers for itself (unknown key, or 400 for a bad escape).
      for (const path of ['/system/admin/platform-config/service%252Ename', '/system/admin/platform-config/Service.Name', '/system/admin/platform-config/service.home', '/system/admin/platform-config/%E0%A4%A']) {
        assert.equal(await run('PUT', path), undefined, path);
      }
      assert.equal(await run('HEAD', '/system/admin/platform-config/service.name'), undefined, 'HEAD is a read');
      assert.equal(await run('GET', '/system/admin/platform-config/service.name'), undefined, 'GET is a read');
    });
  });
});
