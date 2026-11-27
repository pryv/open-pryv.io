/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ADMR] role management over HTTP: granting a role at a scope (admin key or
 * a platform owner's session, with the step-up), reading one account's grants
 * by id or by username (home core only), the scope state of each grant, the
 * last-owner guard under scoped and expiring grants, the records in the actor's
 * and the grantee's trails; administrator sessions of accounts whose grants
 * give nothing on this core, and what a session answers about the permissions
 * it does not hold here.
 */

const { withInjectedConfig, injectTestConfigSnapshot } = require('test-helpers');
const setup = require('business/src/admin/setupState.ts');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const { KEYS } = require('business/src/admin/store.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const PASSWORD = 'admr-password-123';
const APP_ID = 'pryv-test-no-cors';
const MIN = 60 * 1000;

describe('[ADMR] role management', function () {
  this.timeout(60000);

  let db, adminKey, coreId, audit, auditStorage, usersRepository, restoreConfig, platform;
  const usedUsers = [];

  before(async function () {
    await initTests();
    await initCore();
    restoreConfig = injectTestConfigSnapshot({ services: { mfa: { active: false } } });
    const app = globalThis.app;
    if (!app.systemAPI.has('system.listUsers')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    if (!app.systemAPI.has('system.roles.set')) await require('api-server/src/methods/systemAdminRoles.ts').default(app.systemAPI);
    const config = await require('@pryv/boiler').getConfig();
    adminKey = config.get('auth:adminAccessKey');
    db = require('storages').platformDB;
    platform = require('platform').platform;
    coreId = platform.coreId;
    audit = config.get('audit:active') === true ? require('audit').default : null;
    auditStorage = require('storages').auditStorage;
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    await resetAdmin();
  });

  async function resetAdmin () {
    await db.deletePlatformKv(KEYS.setupState);
    for (const { key } of await db.listPlatformKvEntries(KEYS.rolePrefix)) await db.deletePlatformKv(key);
    await setup.recordLegacyReady(db, { coreId, now: Date.now() });
  }

  afterEach(resetAdmin);

  after(async () => {
    restoreConfig?.();
    await db.deletePlatformKv(KEYS.setupState);
    for (const { key } of await db.listPlatformKvEntries(KEYS.rolePrefix)) await db.deletePlatformKv(key);
    for (const id of usedUsers) {
      try { await usersRepository.deleteOne(id); } catch (_e) { /* best-effort */ }
    }
  });

  async function freshUser () {
    const username = ('admr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD });
    usedUsers.push(fu.attrs.id);
    const login = await coreRequest.post('/' + username + '/auth/login').send({ username, password: PASSWORD, appId: APP_ID });
    assert.equal(login.status, 200, 'login: ' + JSON.stringify(login.body));
    return { username, userId: fu.attrs.id, token: login.body.token };
  }

  /** A session of an account holding `grants` ([role, scope]); `mfaAt` decides the step-up. */
  async function sessionOf (userId, grants, mfaAt = Date.now()) {
    const now = Date.now();
    for (const [role, scope] of grants) await roles.grantRole(db, userId, { role, scope, grantedBy: 'test', via: 'grant', now });
    return (await sessions.createAdminSession(db, { userId, homeCore: coreId, mfaAt, now: now + 1, ttlMs: 60 * MIN })).token;
  }

  const asSession = (token) => ({ authorization: 'AdminSession ' + token });
  const put = (userId, body, auth) => coreRequest.put('/system/admin/roles/' + userId).set(auth).send(body);
  const asKey = () => ({ authorization: adminKey });

  async function trail (userId, action) {
    const store = await auditStorage.forUser(userId);
    const rows = await store.getEvents({ query: [] });
    return rows.filter((e) => e.content?.action === action);
  }

  it('[ADMR1] PUT /system/admin/roles/:userId with the admin key: grants a role at a scope with its expiry; bad role, scope, expiry, id or parameter answers 400', async () => {
    const userId = 'admr-' + cuid().slice(-10).toLowerCase();
    const expiresAt = Date.now() + 2 * 3600 * 1000;
    const res = await put(userId, { role: 'support', scope: 'core:' + coreId, expiresAt }, asKey());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.role.userId, userId);
    assert.deepEqual(res.body.role.grants.map((g) => [g.role, g.scope, g.via, g.grantedBy, g.expiresAt, g.scopeState]),
      [['support', 'core:' + coreId, 'admin-key', 'admin-key', expiresAt, 'ok']]);
    // The same role and scope again replaces that grant; another scope adds one.
    assert.equal((await put(userId, { role: 'support', scope: 'core:' + coreId }, asKey())).status, 200);
    const orphan = await put(userId, { role: 'viewer', scope: 'core:no-such-core' }, asKey());
    assert.equal(orphan.status, 200, JSON.stringify(orphan.body));
    const byScope = Object.fromEntries(orphan.body.role.grants.map((g) => [g.scope, g]));
    assert.equal(byScope['core:' + coreId].expiresAt, undefined, 'replaced, without expiry now');
    assert.equal(byScope['core:no-such-core'].scopeState, 'orphan');
    const one = await coreRequest.get('/system/admin/roles/' + userId).set(asKey());
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.role.grants.length, 2);
    assert.equal(one.body.role.username, null, 'not an account of this core');
    const list = await coreRequest.get('/system/admin/roles').set(asKey());
    const listed = list.body.roles.find((r) => r.userId === userId);
    assert.deepEqual(listed.grants.map((g) => g.scopeState).sort(), ['ok', 'orphan']);
    assert.equal((await coreRequest.get('/system/admin/roles/admr-nobody').set(asKey())).status, 404);

    const god = await put(userId, { role: 'god', scope: 'platform' }, asKey());
    assert.equal(god.status, 400);
    assert.match(god.body.error.message, /owner, operator, support, auditor, app-reviewer, viewer/);
    const badScope = await put(userId, { role: 'viewer', scope: 'continent:eu' }, asKey());
    assert.equal(badScope.status, 400);
    assert.match(badScope.body.error.message, /region:<id>, zone:<id>, hosting:<id> or core:<id>/);
    assert.equal((await put(userId, { role: 'viewer', scope: 'platform', expiresAt: Date.now() - 1000 }, asKey())).status, 400, 'past expiry');
    assert.equal((await put(userId, { role: 'viewer', scope: 'platform', expiresAt: 'tomorrow' }, asKey())).status, 400, 'expiry not a number');
    assert.equal((await put(userId, { role: 'viewer', scope: 'platform', grantedBy: 'me' }, asKey())).status, 400, 'unknown parameter');
    assert.equal((await put('bad%20id', { role: 'viewer', scope: 'platform' }, asKey())).status, 400, 'malformed user id');
    assert.equal((await coreRequest.get('/system/admin/roles/' + userId).set(asKey())).body.role.grants.length, 2, 'nothing written on a refusal');
  });

  it('[ADMR2] PUT by a session: a platform owner with a recent second factor; 403 step-up when old; an owner scoped to a core cannot (404); the key under break-glass cannot; recorded in both trails', async () => {
    const actor = await freshUser();
    const grantee = await freshUser();
    const old = await sessionOf(actor.userId, [['owner', 'platform']], Date.now() - 10 * MIN);
    const stale = await put(grantee.userId, { role: 'auditor', scope: 'platform' }, asSession(old));
    assert.equal(stale.status, 403, JSON.stringify(stale.body));
    assert.equal(stale.body.error.data.stepUp, true);
    const fresh = await sessions.createAdminSession(db, { userId: actor.userId, homeCore: coreId, mfaAt: Date.now(), now: Date.now(), ttlMs: 60 * MIN });
    const ok = await put(grantee.userId, { role: 'auditor', scope: 'platform' }, asSession(fresh.token));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.role.grants.map((g) => [g.role, g.via, g.grantedBy]), [['auditor', 'grant', actor.userId]]);
    assert.equal(ok.body.role.username, grantee.username);
    if (audit != null) {
      const created = await trail(actor.userId, 'admin.role.created');
      assert.equal(created.length, 1, 'the actor\'s trail');
      assert.equal(created[0].content.record.target, grantee.userId);
      const granted = await trail(grantee.userId, 'admin.role.granted');
      assert.equal(granted.length, 1, 'the grantee\'s trail');
      assert.equal(granted[0].content.record.role, 'auditor');
      assert.equal(granted[0].content.record.grantedBy, actor.userId);
    }
    // Role management needs a grant at scope platform.
    const scopedOwner = 'admr-scoped-' + cuid().slice(-8).toLowerCase();
    const scoped = await sessionOf(scopedOwner, [['owner', 'core:' + coreId]]);
    assert.equal((await put(grantee.userId, { role: 'viewer', scope: 'core:' + coreId }, asSession(scoped))).status, 404);
    assert.equal((await coreRequest.get('/system/admin/roles/' + grantee.userId).set(asSession(scoped))).status, 200, 'it reads roles on its core');
    // An auditor reads, does not grant.
    const auditorToken = await sessions.createAdminSession(db, { userId: grantee.userId, homeCore: coreId, mfaAt: Date.now(), now: Date.now() + 1, ttlMs: 60 * MIN });
    assert.equal((await put(actor.userId, { role: 'viewer', scope: 'platform' }, asSession(auditorToken.token))).status, 404);
    await withInjectedConfig({ auth: { adminAccessKeyScope: 'break-glass' } }, async () => {
      assert.equal((await put(grantee.userId, { role: 'viewer', scope: 'platform' }, asKey())).status, 404, 'not break-glass');
      assert.equal((await coreRequest.get('/system/admin/roles/' + grantee.userId).set(asKey())).status, 200, 'the read is');
      assert.equal((await coreRequest.get('/system/admin/roles/by-username/' + grantee.username).set(asKey())).status, 404, 'the by-username read is not');
    });
  });

  it('[ADMR3] last owner: expiring and scoped owner grants do not count; replacing the last lasting grant by an expiring one, or revoking it, answers 400 last-owner', async () => {
    const a = await freshUser();
    const now = Date.now();
    await roles.grantRole(db, a.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now });
    const b = 'admr-b-' + cuid().slice(-8).toLowerCase();
    await roles.grantRole(db, b, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now, expiresAt: now + 3600 * 1000 });
    await roles.grantRole(db, b, { role: 'owner', scope: 'core:' + coreId, grantedBy: 'test', via: 'grant', now });
    const revoke = await coreRequest.delete('/system/admin/roles/' + a.userId).set(asKey());
    assert.equal(revoke.status, 400, JSON.stringify(revoke.body));
    assert.equal(revoke.body.error.data.id, 'last-owner');
    const expiring = await put(a.userId, { role: 'owner', scope: 'platform', expiresAt: now + 3600 * 1000 }, asKey());
    assert.equal(expiring.status, 400, JSON.stringify(expiring.body));
    assert.equal(expiring.body.error.data.id, 'last-owner');
    assert.equal((await roles.readRoleRow(db, a.userId)).grants[0].expiresAt, undefined, 'unchanged');
    // Another lasting owner, then the revocation goes through and lands in the grantee's trail.
    assert.equal((await put(b, { role: 'owner', scope: 'platform' }, asKey())).status, 200);
    const done = await coreRequest.delete('/system/admin/roles/' + a.userId + '?role=owner&scope=platform').set(asKey());
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(await roles.readRoleRow(db, a.userId), null);
    if (audit != null) {
      const revoked = await trail(a.userId, 'admin.role.revoked');
      assert.equal(revoked.length, 1);
      assert.deepEqual([revoked[0].content.record.role, revoked[0].content.record.scope, revoked[0].content.record.revokedBy], ['owner', 'platform', 'admin-key']);
    }
  });

  it('[ADMR4] GET /system/admin/roles/by-username/:username: the account id and its grants on its home core; another core\'s account answers its home core\'s URL', async () => {
    const user = await freshUser();
    const none = await coreRequest.get('/system/admin/roles/by-username/' + user.username.toUpperCase()).set(asKey());
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual([none.body.role.userId, none.body.role.username, none.body.role.grants], [user.userId, user.username, []]);
    await roles.grantRole(db, user.userId, { role: 'viewer', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    const some = await coreRequest.get('/system/admin/roles/by-username/' + user.username).set(asKey());
    assert.deepEqual(some.body.role.grants.map((g) => [g.role, g.scopeState]), [['viewer', 'ok']]);
    assert.equal((await coreRequest.get('/system/admin/roles/by-username/admrnobodyhere').set(asKey())).status, 404);
    // Another core holds the account.
    Object.defineProperty(platform, 'isSingleCore', { value: false, configurable: true });
    platform.getUserCore = async () => 'core-other';
    try {
      const elsewhere = await coreRequest.get('/system/admin/roles/by-username/' + user.username).set(asKey());
      assert.equal(elsewhere.status, 400, JSON.stringify(elsewhere.body));
      assert.equal(typeof elsewhere.body.error.data.homeCoreUrl, 'string');
    } finally {
      delete platform.isSingleCore;
      delete platform.getUserCore;
    }
  });

  it('[ADMR5] a session opens on any active grant, also one giving nothing here; it answers the permissions held here and the refused ones with their reason; the local policy is shown', async () => {
    const user = await freshUser();
    await roles.grantRole(db, user.userId, { role: 'support', scope: 'core:another-core', grantedBy: 'test', via: 'grant', now: Date.now() });
    const opened = await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.deepEqual(opened.body.adminSession.permissions, []);
    assert.ok(opened.body.adminSession.denied.some((d) => d.permission === 'users:read' && d.reason === 'scope'));
    const token = opened.body.adminSession.token;
    const read = await coreRequest.get('/system/admin/session').set(asSession(token));
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.adminSession.permissions, []);
    assert.ok(read.body.adminSession.denied.length > 0);
    assert.equal(read.body.adminSession.grants[0].scopeState, 'orphan');
    assert.equal(read.body.adminSession.localPolicy, undefined, 'default policy: nothing to show');
    const ctx = await coreRequest.get('/system/admin/portal/context').set(asSession(token));
    assert.ok(ctx.body.portalContext.subject.denied.some((d) => d.permission === 'users:read'));
    assert.equal((await coreRequest.get('/system/admin/users').set(asSession(token))).status, 404, 'nothing held here');

    // A platform owner on a core that keeps users:read to its local grants.
    const owner = await freshUser();
    await roles.grantRole(db, owner.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    await withInjectedConfig({ admin: { localPolicy: { requireLocalScope: ['users:read'] } } }, async () => {
      const s = await coreRequest.post('/system/admin/session').set('authorization', owner.token).send({ username: owner.username });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      assert.ok(!s.body.adminSession.permissions.includes('users:read'));
      assert.deepEqual(s.body.adminSession.denied, [{ permission: 'users:read', reason: 'local-policy' }]);
      const r = await coreRequest.get('/system/admin/session').set(asSession(s.body.adminSession.token));
      assert.deepEqual(r.body.adminSession.localPolicy, { acceptReplicatedGrants: true, requireLocalScope: ['users:read'], localRoles: [] });
    });
    // No active grant: no session.
    const expired = await freshUser();
    await roles.grantRole(db, expired.userId, { role: 'viewer', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() - 2000, expiresAt: Date.now() - 1000 });
    assert.equal((await coreRequest.post('/system/admin/session').set('authorization', expired.token).send({ username: expired.username })).status, 404);
  });

  it('[ADMR6] claim codes: any role at any scope of the grammar; the messages list the roles and the scope grammar', async () => {
    const minted = await coreRequest.post('/system/admin/claim-codes').set(asKey()).send({ role: 'app-reviewer', scope: 'region:eu' });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    assert.deepEqual([minted.body.claimCode.role, minted.body.claimCode.scope], ['app-reviewer', 'region:eu']);
    const user = await freshUser();
    const claimed = await coreRequest.post('/system/admin/roles/claim').set('authorization', user.token).send({ username: user.username, code: minted.body.claimCode.code });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.deepEqual(claimed.body.role.grants.map((g) => [g.role, g.scope, g.via]), [['app-reviewer', 'region:eu', 'claim-code']]);
    const god = await coreRequest.post('/system/admin/claim-codes').set(asKey()).send({ role: 'god' });
    assert.match(god.body.error.message, /owner, operator, support, auditor, app-reviewer, viewer/);
    const scope = await coreRequest.post('/system/admin/claim-codes').set(asKey()).send({ scope: 'everywhere' });
    assert.equal(scope.status, 400);
    assert.match(scope.body.error.message, /region:<id>/);
  });
});
