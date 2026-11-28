/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [SYPM] the route table of /system (routes/system-permissions.ts): one entry
 * per Express route and no stale entry, the method ids it names, every gated
 * route refusing (404) a request without credential, the admin key unchanged
 * with `auth.adminAccessKeyScope: full`, and `break-glass`; administrator
 * sessions under scoped grants and this core's local policy.
 */

const { withInjectedConfig } = require('test-helpers');
const { SYSTEM_ROUTES, routeMatcher } = require('api-server/src/routes/system-permissions.ts');
const { isPermission, PLATFORM_ONLY_WRITES } = require('business/src/admin/permissions.ts');
const { grantRole, revokeRole } = require('business/src/admin/roles.ts');
const { createAdminSession } = require('business/src/admin/sessions.ts');
const { coreContext } = require('business/src/admin/scopes.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[SYPM] /system route table and admin-key scope', function () {
  this.timeout(60000);
  let adminKey, app;
  // The users are created with random names, so nothing else removes them: a
  // later run that wipes the platform store would find them in the repository
  // without their platform rows.
  const fixtureSets = [];
  function newFixture () {
    const fixtures = getNewFixture();
    fixtureSets.push(fixtures);
    return fixtures;
  }

  after(async function () {
    for (const fixtures of fixtureSets) await fixtures.clean();
  });

  before(async function () {
    await initTests();
    await initCore();
    app = globalThis.app;
    if (!app.systemAPI.has('system.listUsers')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    if (!app.api.has('auth.delete')) await require('api-server/src/methods/auth/delete.ts').default(app.api);
    adminKey = (await require('@pryv/boiler').getConfig()).get('auth:adminAccessKey');
  });

  /** Every route Express serves under /system: `METHOD path` → its method id (or null). */
  function expressSystemRoutes () {
    const out = new Map();
    for (const layer of app.expressApp._router.stack) {
      const route = layer.route;
      if (route == null || typeof route.path !== 'string' || !route.path.startsWith('/system/')) continue;
      if (route.path === '/system/*') continue; // the gate itself
      let methodId = null;
      for (const l of route.stack) {
        if (l.handle.name === 'setMethodId') {
          const fakeReq = {};
          l.handle(fakeReq, { on () {} }, () => {});
          methodId = fakeReq.context?.methodId ?? null;
        }
      }
      for (const m of Object.keys(route.methods)) out.set(m.toUpperCase() + ' ' + route.path, methodId);
    }
    return out;
  }

  const examplePath = (path) => path.replace(/:[A-Za-z]+/g, 'x');

  it('[SYPM1] every /system route has exactly one entry, with its method id, and every entry a route', () => {
    const routes = expressSystemRoutes();
    assert.ok(routes.size > 30, 'routes found: ' + routes.size);
    const entries = new Map(SYSTEM_ROUTES.map((e) => [e.method + ' ' + e.path, e]));
    assert.equal(entries.size, SYSTEM_ROUTES.length, 'no duplicate entry');
    const missing = [...routes.keys()].filter((k) => !entries.has(k));
    assert.deepEqual(missing, [], 'routes without an entry in system-permissions.ts');
    const stale = [...entries.keys()].filter((k) => !routes.has(k));
    assert.deepEqual(stale, [], 'entries without a route');
    for (const [k, methodId] of routes) assert.equal(entries.get(k).methodId, methodId, 'method id of ' + k);
    const match = routeMatcher();
    for (const e of SYSTEM_ROUTES) {
      assert.equal(match(e.method, examplePath(e.path)), e, 'matcher finds ' + e.method + ' ' + e.path);
      if (e.rule.auth === 'admin' && e.rule.permission != null) assert.ok(isPermission(e.rule.permission), e.rule.permission);
    }
    assert.equal(match('GET', '/SYSTEM/Admin/Users/'), entries.get('GET /system/admin/users'), 'case and trailing slash, as Express');
    assert.equal(match('HEAD', '/system/admin/users'), entries.get('GET /system/admin/users'));
    // Nothing serves /system but plain routes with a string path (a Router or
    // an array path would escape this enumeration).
    for (const layer of app.expressApp._router.stack) {
      const route = layer.route;
      if (route != null) {
        if (typeof route.path !== 'string') {
          const paths = [].concat(route.path).map(String);
          assert.ok(!paths.some((p) => /^\/?system/i.test(p)), 'a /system route with a non-string path: ' + paths.join(','));
        }
        continue;
      }
      if (layer.name === 'router') {
        // A mounted Router: none of its routes may be under /system, nor may it be mounted there.
        assert.ok(!/^\^\\\/system/i.test(String(layer.regexp)), 'a Router mounted on /system: ' + layer.regexp);
        for (const inner of layer.handle?.stack ?? []) {
          const p = inner.route?.path;
          assert.ok(p == null || ![].concat(p).map(String).some((x) => /^\/?system/i.test(x)), 'a Router serving a /system path: ' + p);
        }
      }
    }
  });

  it('[SYPM2] every gated route answers 404 without a credential, and with a wrong one', async () => {
    for (const e of SYSTEM_ROUTES.filter((x) => x.rule.auth === 'admin' || x.rule.auth === 'personal')) {
      const path = examplePath(e.path);
      for (const authorization of [null, 'not-the-key', 'AdminSession ' + 'A'.repeat(43), 'SetupSession ' + 'B'.repeat(43)]) {
        let req = coreRequest[e.method.toLowerCase()](path);
        if (authorization != null) req = req.set('authorization', authorization);
        if (e.method !== 'GET' && e.method !== 'DELETE') req = req.set('content-type', 'application/json').send({});
        const res = await req;
        assert.equal(res.status, 404, e.method + ' ' + e.path + ' with ' + String(authorization).slice(0, 12) + ': ' + res.status);
      }
    }
  });

  it('[SYPM3] scope full (default): the admin key reaches the existing routes as before', async () => {
    const username = ('sypm' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    await newFixture().user(username, {});
    for (const path of ['/system/admin/users', '/system/admin/cores', '/system/admin/mail/templates', '/system/check-platform-integrity',
      '/system/migrations-status', '/system/admin/ext-id-ns', '/system/admin/roles', '/system/user-info/' + username]) {
      const res = await coreRequest.get(path).set('authorization', adminKey);
      assert.equal(res.status, 200, path + ': ' + JSON.stringify(res.body).slice(0, 200));
    }
    assert.equal((await coreRequest.get('/system/user-info/' + username).set('authorization', 'Bearer ' + adminKey)).status, 404, 'the key is sent bare, as before');
  });

  it('[SYPM4] scope break-glass: the key is refused (404) on normal routes and accepted on claim codes, roles, core to core and status', async () => {
    await withInjectedConfig({ auth: { adminAccessKeyScope: 'break-glass' } }, async () => {
      for (const path of ['/system/admin/users', '/system/admin/mail/templates', '/system/admin/config/effective', '/system/admin/erasures']) {
        assert.equal((await coreRequest.get(path).set('authorization', adminKey)).status, 404, path);
      }
      assert.equal((await coreRequest.post('/system/create-user').set('authorization', adminKey).send({})).status, 404);
      const minted = await coreRequest.post('/system/admin/claim-codes').set('authorization', adminKey).send({});
      assert.equal(minted.status, 201, JSON.stringify(minted.body));
      for (const path of ['/system/admin/roles', '/system/migrations-status', '/system/admin/cores', '/system/admin/portal/context']) {
        assert.equal((await coreRequest.get(path).set('authorization', adminKey)).status, 200, path);
      }
      const holds = await coreRequest.post('/system/ext-id/holds').set('authorization', adminKey).send({});
      assert.notEqual(holds.status, 404, 'core to core: reaches the route (' + holds.status + ')');
    });
    assert.equal((await coreRequest.get('/system/admin/users').set('authorization', adminKey)).status, 200, 'full again');
  });

  it('[SYPM5] scope break-glass outside /system: the key no longer deletes accounts nor reaches /reg/records and /reg/admin; as before under full', async () => {
    const username = ('sypm' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    await newFixture().user(username, {});
    await withInjectedConfig({ auth: { adminAccessKeyScope: 'break-glass' } }, async () => {
      const del = await coreRequest.delete('/users/' + username).set('authorization', adminKey);
      assert.notEqual(del.status, 200, 'account deletion refused: ' + del.status);
      assert.equal((await coreRequest.post('/reg/records').set('authorization', adminKey).send({})).status, 404, '/reg/records');
      assert.equal((await coreRequest.get('/reg/admin/servers').set('authorization', adminKey)).status, 404, '/reg/admin/servers');
    });
    assert.notEqual((await coreRequest.post('/reg/records').set('authorization', adminKey).send({})).status, 404, '/reg/records under full');
    assert.notEqual((await coreRequest.get('/reg/admin/servers').set('authorization', adminKey)).status, 404, '/reg/admin/servers under full');
    const del = await coreRequest.delete('/users/' + username).set('authorization', adminKey);
    assert.equal(del.status, 200, 'account deletion under full: ' + JSON.stringify(del.body));
  });

  describe('administrator sessions: scopes and the local policy', function () {
    const roleRows = [];
    after(async function () {
      for (const userId of roleRows) await revokeRole(platformDB(), userId, { now: Date.now(), force: true });
    });
    function platformDB () { return require('storages').platformDB; }
    /** An administrator session whose role row holds `grants` ([role, scope]). No account is needed for the gate. */
    async function sessionWith (grants) {
      const userId = 'sypm' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      roleRows.push(userId);
      const now = Date.now();
      for (const [role, scope] of grants) await grantRole(platformDB(), userId, { role, scope, grantedBy: 'admin-key', via: 'admin-key', now });
      const { token } = await createAdminSession(platformDB(), { userId, homeCore: 'elsewhere', mfaAt: now, now: now + 1, ttlMs: 3600 * 1000 });
      return { userId, authorization: 'AdminSession ' + token };
    }
    async function thisCoreId () { return coreContext(await require('@pryv/boiler').getConfig()).coreId; }

    it('[SYPM6] an owner scoped to this core is refused (404) every platform-wide write route, reaches its core-local ones', async () => {
      const { authorization } = await sessionWith([['owner', 'core:' + await thisCoreId()]]);
      assert.equal((await coreRequest.get('/system/admin/users').set('authorization', authorization)).status, 200, 'control: users:read on this core');
      assert.equal((await coreRequest.get('/system/admin/session').set('authorization', authorization)).status, 200, 'control: its session');
      const platformWide = SYSTEM_ROUTES.filter((e) => e.rule.auth === 'admin' && e.rule.permission != null &&
        PLATFORM_ONLY_WRITES.has(e.rule.permission) && (e.rule.accepts ?? ['key', 'session']).includes('session'));
      assert.ok(platformWide.length >= 8, 'platform-wide write routes found: ' + platformWide.length);
      for (const e of platformWide) {
        let req = coreRequest[e.method.toLowerCase()](examplePath(e.path)).set('authorization', authorization);
        if (e.method !== 'GET' && e.method !== 'DELETE') req = req.set('content-type', 'application/json').send({});
        assert.equal((await req).status, 404, e.method + ' ' + e.path);
      }
      // The same role at another core's scope reaches nothing here.
      const other = await sessionWith([['owner', 'core:another-core']]);
      assert.equal((await coreRequest.get('/system/admin/users').set('authorization', other.authorization)).status, 404);
      assert.equal((await coreRequest.get('/system/admin/session').set('authorization', other.authorization)).status, 200, 'its session still resolves');
    });

    it('[SYPM7] requireLocalScope refuses a platform owner, localGrants gives it back, on this core only', async () => {
      const { userId, authorization } = await sessionWith([['owner', 'platform']]);
      const users = async () => (await coreRequest.get('/system/admin/users').set('authorization', authorization)).status;
      assert.equal(await users(), 200, 'default policy');
      await withInjectedConfig({ admin: { localPolicy: { requireLocalScope: ['users:read'] } } }, async () => {
        assert.equal(await users(), 404, 'required local scope');
        const ctx = await coreRequest.get('/system/admin/portal/context').set('authorization', authorization);
        assert.equal(ctx.status, 200, 'the session itself is not blocked');
      });
      await withInjectedConfig({ admin: { localPolicy: { requireLocalScope: ['users:read'], localGrants: [{ userId, role: 'support' }] } } }, async () => {
        assert.equal(await users(), 200, 'given back by a local grant');
      });
      await withInjectedConfig({ admin: { localPolicy: { acceptReplicatedGrants: false } } }, async () => {
        assert.equal(await users(), 404, 'replicated grants refused');
        assert.equal((await coreRequest.get('/system/admin/users').set('authorization', adminKey)).status, 200, 'the admin key is not bound by the policy');
      });
      assert.equal(await users(), 200, 'default again');
    });
  });
});
