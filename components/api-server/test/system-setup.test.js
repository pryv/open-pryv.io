/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ADMS] platform setup, administrator sessions, roles and claim codes over
 * HTTP: each route's success, wrong, expired, replayed and rate-limited
 * cases, registration closed while setup is pending, the step-up, the origin
 * rule, a session issued by another core, the audit records, and no plain
 * code or token in the platform store.
 *
 * A second core is simulated by a session row whose home core is another
 * core, read from the same platform store (no two-core harness here).
 */

const { withInjectedConfig, injectTestConfigSnapshot } = require('test-helpers');
const setup = require('business/src/admin/setupState.ts');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const { KEYS } = require('business/src/admin/store.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const PASSWORD = 'adms-password-123';
const APP_ID = 'pryv-test-no-cors';
const MIN = 60 * 1000;
const MFA_ON = { services: { mfa: { active: true } } };

describe('[ADMS] setup, administrator sessions, roles and claim codes', function () {
  this.timeout(60000);

  let db, adminKey, coreId, audit, auditStorage, usersRepository, restoreConfig;
  const usedUsers = [];

  before(async function () {
    await initTests();
    await initCore();
    // MFA off unless a test turns it on (the cases with it inject MFA_ON).
    restoreConfig = injectTestConfigSnapshot({ services: { mfa: { active: false } } });
    const app = globalThis.app;
    if (!app.systemAPI.has('system.listUsers')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    if (!app.api.has('auth.delete')) await require('api-server/src/methods/auth/delete.ts').default(app.api);
    const config = await require('@pryv/boiler').getConfig();
    adminKey = config.get('auth:adminAccessKey');
    db = require('storages').platformDB;
    coreId = require('platform').platform.coreId;
    audit = config.get('audit:active') === true ? require('audit').default : null;
    auditStorage = require('storages').auditStorage;
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    await resetAdmin();
  });

  async function resetAdmin () {
    await db.deletePlatformKv(KEYS.setupState);
    for (const { key } of await db.listPlatformKvEntries(KEYS.rolePrefix)) await db.deletePlatformKv(key);
    for (let i = 0; i < 20; i++) await db.releaseWindowedCounter(KEYS.setupAttemptsPrefix + coreId);
  }

  afterEach(resetAdmin);

  after(async () => {
    restoreConfig?.();
    await resetAdmin();
    for (const id of usedUsers) {
      try { await usersRepository.deleteOne(id); } catch (_e) { /* best-effort */ }
    }
  });

  async function freshUser () {
    const username = ('adms' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD });
    usedUsers.push(fu.attrs.id);
    const login = await coreRequest.post('/' + username + '/auth/login').send({ username, password: PASSWORD, appId: APP_ID });
    assert.equal(login.status, 200, 'login: ' + JSON.stringify(login.body));
    return { username, userId: fu.attrs.id, token: login.body.token };
  }

  /** An app or shared access of the account (not a personal one). */
  async function appToken (user, type) {
    const res = await coreRequest.post('/' + user.username + '/accesses').set('authorization', user.token)
      .send({ type, name: 'adms-' + type + '-' + cuid().slice(-6), permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.access.token;
  }

  async function pending () {
    assert.equal(await setup.claimFreshPending(db, { coreId, now: Date.now() }), true);
    return await setup.mintSetupCode(db, { coreId, ttlMs: 60 * MIN, now: Date.now() });
  }

  async function ready () {
    await setup.recordLegacyReady(db, { coreId, now: Date.now() });
  }

  async function openSetupSession () {
    const code = await pending();
    const res = await coreRequest.post('/system/setup/session').send({ code: code.display });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { code, token: res.body.setupSession.token };
  }

  async function owner (user, mfaAt = Date.now()) {
    await roles.grantRole(db, user.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    return (await sessions.createAdminSession(db, { userId: user.userId, homeCore: coreId, mfaAt, now: Date.now(), ttlMs: 60 * MIN })).token;
  }

  const asSession = (token) => ({ authorization: 'AdminSession ' + token });
  const asSetup = (token) => ({ authorization: 'SetupSession ' + token });

  async function trail (userId, action) {
    const store = await auditStorage.forUser(userId);
    const rows = await store.getEvents({ query: [] });
    return rows.filter((e) => e.content?.action === action);
  }

  // --------------------- setup ----------------- //

  it('[ADMS1] GET /system/setup/status is public and tells the state', async () => {
    let res = await coreRequest.get('/system/setup/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.setup.state, 'ready');
    assert.equal(res.headers['cache-control'], 'no-store');
    await pending();
    res = await coreRequest.get('/system/setup/status');
    assert.equal(res.body.setup.state, 'pending');
    assert.equal(res.body.setup.codePending, true);
    assert.equal(typeof res.body.setup.codeExpiresAt, 'number');
  });

  it('[ADMS2] POST /system/setup/session: the code works once; a wrong, replayed or expired code, or no pending setup, answers 404', async () => {
    const code = await pending();
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ' })).status, 404);
    const ok = await coreRequest.post('/system/setup/session').send({ code: code.code.toLowerCase() });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.match(ok.body.setupSession.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: code.display })).status, 404, 'replayed');
    const short = await setup.mintSetupCode(db, { coreId, ttlMs: 1, now: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: short.display })).status, 404, 'expired');
    const live = await setup.mintSetupCode(db, { coreId, ttlMs: 60 * MIN, now: Date.now() });
    await setup.markReady(db, { by: 'admin-key', now: Date.now() });
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: live.display })).status, 404, 'not pending');
  });

  it('[ADMS3] POST /system/setup/session: past 10 tries in 15 minutes, 429; the pending code stays valid', async () => {
    const code = await pending();
    for (let i = 0; i < 10; i++) {
      assert.equal((await coreRequest.post('/system/setup/session').send({ code: 'wrong' })).status, 404);
    }
    const limited = await coreRequest.post('/system/setup/session').send({ code: code.display });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.notEqual((await setup.readSetupState(db)).codeKey, null, 'not withdrawn');
    for (let i = 0; i < 20; i++) await db.releaseWindowedCounter(KEYS.setupAttemptsPrefix + coreId);
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: code.display })).status, 201, 'the code still works once the wait is over');
  });

  it('[ADMS4] POST /system/setup/first-admin: the setup session and the person\'s token give the role owner; anything else answers 404', async () => {
    const { token } = await openSetupSession();
    const user = await freshUser();
    const body = { username: user.username, personalToken: user.token };
    assert.equal((await coreRequest.post('/system/setup/first-admin').set('authorization', adminKey).send(body)).status, 404, 'the admin key is not a setup session');
    assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup('A'.repeat(43))).send(body)).status, 404, 'unknown setup session');
    assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup(token)).send({ ...body, personalToken: 'nope' })).status, 404, 'wrong personal token');
    const expired = await sessions.createSetupSession(db, { coreId, now: Date.now(), ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup(expired.token)).send(body)).status, 404, 'expired setup session');
    const res = await coreRequest.post('/system/setup/first-admin').set(asSetup(token)).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.role.userId, user.userId);
    assert.deepEqual(res.body.role.grants.map((g) => [g.role, g.scope, g.via]), [['owner', 'platform', 'setup']]);
  });

  it('[ADMS5] registration is closed while setup is pending, except with the setup session or registrationWhilePending: open', async () => {
    const { token } = await openSetupSession();
    const body = (u) => ({ appId: APP_ID, username: u, password: PASSWORD, email: u + '@adms.example.com', insurancenumber: '12345', language: 'en' });
    const name = () => ('admr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const closed = await coreRequest.post('/users').send(body(name()));
    assert.equal(closed.status, 403, JSON.stringify(closed.body));
    const n1 = name();
    const withSetup = await coreRequest.post('/users').set(asSetup(token)).send(body(n1));
    assert.equal(withSetup.status, 201, JSON.stringify(withSetup.body));
    usedUsers.push(await usersRepository.getUserIdForUsername(n1));
    const n2 = name();
    await withInjectedConfig({ setup: { registrationWhilePending: 'open' } }, async () => {
      const open = await coreRequest.post('/users').send(body(n2));
      assert.equal(open.status, 201, JSON.stringify(open.body));
    });
    usedUsers.push(await usersRepository.getUserIdForUsername(n2));
  });

  it('[ADMS6] POST /system/setup/finish: needs a first administrator, then ready; the setup routes and the setup session stop', async () => {
    const { token } = await openSetupSession();
    const early = await coreRequest.post('/system/setup/finish').set(asSetup(token));
    assert.equal(early.status, 400, JSON.stringify(early.body));
    const user = await freshUser();
    assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup(token)).send({ username: user.username, personalToken: user.token })).status, 200);
    const res = await coreRequest.post('/system/setup/finish').set(asSetup(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.setup.state, 'ready');
    assert.equal((await setup.readSetupState(db)).readyBy, 'setup');
    assert.equal((await coreRequest.get('/system/setup/status')).body.setup.state, 'ready');
    assert.equal((await coreRequest.post('/system/setup/finish').set(asSetup(token))).status, 404, 'setup session ended');
    assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup(token)).send({ username: user.username, personalToken: user.token })).status, 404);
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: 'any' })).status, 404);
  });

  it('[ADMS22] POST /system/setup/finish with the admin key needs no first administrator (automated installs); registration then opens', async () => {
    await pending();
    const res = await coreRequest.post('/system/setup/finish').set('authorization', adminKey);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const state = await setup.readSetupState(db);
    assert.equal(state.state, 'ready');
    assert.equal(state.readyBy, 'admin-key');
    assert.equal((await roles.listRoleRows(db)).length, 0, 'no administrator yet: a claim code gives the first one');
    assert.equal((await coreRequest.post('/system/setup/finish').set('authorization', adminKey)).status, 400, 'not pending any more');
  });

  it('[ADMS7] POST /system/admin/setup/code: the admin key replaces the code (the old one stops working); 400 once ready', async () => {
    const old = await pending();
    const res = await coreRequest.post('/system/admin/setup/code').set('authorization', adminKey);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.setupCode.code, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/);
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: old.display })).status, 404, 'replaced');
    assert.equal((await coreRequest.post('/system/setup/session').send({ code: res.body.setupCode.code })).status, 201);
    assert.equal((await coreRequest.post('/system/admin/setup/code')).status, 404, 'no credential');
    await setup.markReady(db, { by: 'admin-key', now: Date.now() });
    assert.equal((await coreRequest.post('/system/admin/setup/code').set('authorization', adminKey)).status, 400);
  });

  // --------------------- administrator sessions ----------------- //

  it('[ADMS8] POST /system/admin/session: opened from a personal token of an administrator; GET reads it, it reaches an owner route, DELETE ends it', async () => {
    await ready();
    const user = await freshUser();
    assert.equal((await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username })).status, 404, 'no role');
    await roles.grantRole(db, user.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    assert.equal((await coreRequest.post('/system/admin/session').set('authorization', 'wrong').send({ username: user.username })).status, 404, 'wrong token');
    for (const type of ['app', 'shared']) {
      const other = await appToken(user, type);
      assert.equal((await coreRequest.post('/system/admin/session').set('authorization', other).send({ username: user.username })).status, 404, 'an ' + type + ' token of the administrator');
    }
    const res = await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const token = res.body.adminSession.token;
    assert.equal(res.body.adminSession.homeCore, coreId);
    assert.ok(res.body.adminSession.permissions.includes('users:read'));
    const read = await coreRequest.get('/system/admin/session').set(asSession(token));
    assert.equal(read.status, 200);
    assert.equal(read.body.adminSession.userId, user.userId);
    assert.equal(read.body.adminSession.grants[0].role, 'owner');
    const users = await coreRequest.get('/system/admin/users').set(asSession(token));
    assert.equal(users.status, 200, 'an existing route reached with the session');
    assert.equal((await coreRequest.delete('/system/admin/session').set(asSession(token))).status, 204);
    assert.equal((await coreRequest.get('/system/admin/session').set(asSession(token))).status, 404);
    assert.equal((await coreRequest.get('/system/admin/users').set(asSession(token))).status, 404);
    if (audit != null) {
      assert.equal((await trail(user.userId, 'admin.session.created')).length, 1, 'the administrator\'s own trail');
      assert.equal((await trail(user.userId, 'admin.session.deleted')).length, 1);
    }
  });

  it('[ADMS9] POST /system/admin/session: refused while setup is pending; with MFA on, needs the sign-in\'s second factor', async () => {
    await pending();
    const user = await freshUser();
    await roles.grantRole(db, user.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    assert.equal((await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username })).status, 400);
    await setup.markReady(db, { by: 'admin-key', now: Date.now() });
    await withInjectedConfig(MFA_ON, async () => {
      const refused = await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username });
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.error.data.mfaRequired, true);
      const kv = require('messages/src/cluster_kv.ts').clientFor();
      await sessions.recordMfaSignIn(kv, { token: user.token, userId: user.userId, now: Date.now(), ttlMs: 60 * MIN });
      const ok = await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.adminSession.stepUpFresh, true);
    });
  });

  it('[ADMS10] step-up: a sensitive act with an old second factor answers 403 step-up; a fresh sign-in renews it', async () => {
    await ready();
    const user = await freshUser();
    const token = await owner(user, Date.now() - 10 * MIN);
    const refused = await coreRequest.post('/system/admin/claim-codes').set(asSession(token)).send({});
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error.data.stepUp, true);
    await withInjectedConfig(MFA_ON, async () => {
      const noFactor = await coreRequest.post('/system/admin/session/step-up').set(asSession(token)).send({ personalToken: user.token });
      assert.equal(noFactor.status, 403, 'MFA on and no second factor for this sign-in');
    });
    assert.equal((await coreRequest.post('/system/admin/session/step-up').set(asSession(token)).send({ personalToken: 'wrong' })).status, 404);
    const up = await coreRequest.post('/system/admin/session/step-up').set(asSession(token)).send({ personalToken: user.token });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const minted = await coreRequest.post('/system/admin/claim-codes').set(asSession(token)).send({});
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    if (audit != null) assert.equal((await trail(user.userId, 'admin.session.updatedSecondFactor')).length, 1);
  });

  it('[ADMS11] renewal: extends the session with the personal token; an ended session cannot be renewed back', async () => {
    await ready();
    const user = await freshUser();
    const token = await owner(user);
    const before = (await coreRequest.get('/system/admin/session').set(asSession(token))).body.adminSession.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await coreRequest.post('/system/admin/session/renew').set(asSession(token)).send({ personalToken: user.token });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.ok(renewed.body.adminSession.expiresAt > before);
    const other = await freshUser();
    assert.equal((await coreRequest.post('/system/admin/session/renew').set(asSession(token)).send({ personalToken: other.token })).status, 404, 'another account\'s token');
    // A logout racing a renewal: the renewal's write lands after the end.
    await sessions.endAdminSession(db, token);
    await db.setAccessState(KEYS.adminSessionPrefix + require('business/src/admin/codes.ts').hashToken(token),
      { userId: user.userId, homeCore: coreId, mfaAt: Date.now(), createdAt: Date.now() }, Date.now() + 60 * MIN);
    assert.equal((await coreRequest.get('/system/admin/session').set(asSession(token))).status, 404);
    assert.equal((await coreRequest.post('/system/admin/session/renew').set(asSession(token)).send({ personalToken: user.token })).status, 404);
  });

  it('[ADMS12] a session issued by another core (same platform store) is accepted here; its renewal is sent to its home core', async () => {
    await ready();
    const user = await freshUser();
    await roles.grantRole(db, user.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    const { token } = await sessions.createAdminSession(db, { userId: user.userId, homeCore: 'core-other', mfaAt: Date.now(), now: Date.now(), ttlMs: 60 * MIN });
    assert.equal((await coreRequest.get('/system/admin/users').set(asSession(token))).status, 200);
    assert.equal((await coreRequest.get('/system/admin/cores').set(asSession(token))).status, 200);
    const renew = await coreRequest.post('/system/admin/session/renew').set(asSession(token)).send({ personalToken: user.token });
    assert.equal(renew.status, 400);
    assert.equal(typeof renew.body.error.data.homeCoreUrl, 'string');
  });

  // --------------------- claim codes and roles ----------------- //

  it('[ADMS13] claim codes: minted with the admin key, claimed once by a signed-in account; wrong, replayed and expired codes answer 404', async () => {
    await ready();
    const minted = await coreRequest.post('/system/admin/claim-codes').set('authorization', adminKey).send({ ttlMinutes: 10 });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    assert.equal(minted.body.claimCode.role, 'owner');
    assert.equal((await coreRequest.post('/system/admin/claim-codes').set('authorization', adminKey).send({ role: 'god' })).status, 400);
    assert.equal((await coreRequest.post('/system/admin/claim-codes').set('authorization', adminKey).send({ ttlMinutes: 2000 })).status, 400);
    const user = await freshUser();
    const claim = (code, u = user) => coreRequest.post('/system/admin/roles/claim').set('authorization', u.token).send({ username: u.username, code });
    assert.equal((await claim('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ')).status, 404, 'wrong');
    const appTok = await appToken(user, 'app');
    assert.equal((await coreRequest.post('/system/admin/roles/claim').set('authorization', appTok).send({ username: user.username, code: minted.body.claimCode.code })).status, 404, 'an app token');
    const ok = await claim(minted.body.claimCode.code);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.role.grants.map((g) => [g.role, g.via, g.grantedBy]), [['owner', 'claim-code', 'admin-key']]);
    assert.equal((await claim(minted.body.claimCode.code)).status, 404, 'replayed');
    const short = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now(), ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await claim(short.display)).status, 404, 'expired');
    assert.equal((await coreRequest.post('/system/admin/roles/claim').send({ username: user.username, code: minted.body.claimCode.code })).status, 404, 'no personal token');
    if (audit != null) assert.equal((await trail(user.userId, 'admin.role.claimed')).length, 1);
  });

  it('[ADMS14] claim codes: of two concurrent claims exactly one wins; past 10 tries an account gets 429; MFA on needs the second factor', async () => {
    await ready();
    const code = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now() });
    const a = await freshUser();
    const b = await freshUser();
    const results = await Promise.all([a, b].map((u) => coreRequest.post('/system/admin/roles/claim').set('authorization', u.token).send({ username: u.username, code: code.display })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
    const c = await freshUser();
    for (let i = 0; i < 10; i++) {
      assert.equal((await coreRequest.post('/system/admin/roles/claim').set('authorization', c.token).send({ username: c.username, code: 'wrong' })).status, 404);
    }
    const limited = await coreRequest.post('/system/admin/roles/claim').set('authorization', c.token).send({ username: c.username, code: 'wrong' });
    assert.equal(limited.status, 429);
    const d = await freshUser();
    const another = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now() });
    await withInjectedConfig(MFA_ON, async () => {
      const r = await coreRequest.post('/system/admin/roles/claim').set('authorization', d.token).send({ username: d.username, code: another.display });
      assert.equal(r.status, 403);
    });
    assert.ok(await db.getAccessState(KEYS.claimCodePrefix + require('business/src/admin/codes.ts').hashCode(another.code)) != null, 'a refused claim does not burn the code');
  });

  it('[ADMS15] roles: listed and revoked (admin key or session); a revoked administrator\'s session stops at once', async () => {
    await ready();
    const user = await freshUser();
    const token = await owner(user);
    const list = await coreRequest.get('/system/admin/roles').set('authorization', adminKey);
    assert.equal(list.status, 200);
    const mine = list.body.roles.find((r) => r.userId === user.userId);
    assert.equal(mine.username, user.username);
    assert.equal((await coreRequest.get('/system/admin/roles').set(asSession(token))).status, 200);
    assert.equal((await coreRequest.delete('/system/admin/roles/nobody-here').set('authorization', adminKey)).status, 404);
    const last = await coreRequest.delete('/system/admin/roles/' + user.userId).set('authorization', adminKey);
    assert.equal(last.status, 400, 'the last owner: ' + JSON.stringify(last.body));
    assert.equal(last.body.error.data.id, 'last-owner');
    assert.notEqual(await roles.readRoleRow(db, user.userId), null, 'kept');
    await roles.grantRole(db, 'adms-other-owner', { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    const revoked = await coreRequest.delete('/system/admin/roles/' + user.userId).set('authorization', adminKey);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal((await coreRequest.get('/system/admin/session').set(asSession(token))).status, 404);
    assert.equal((await coreRequest.get('/system/admin/users').set(asSession(token))).status, 404);
  });

  it('[ADMS23] a session opened before a revocation stays refused when the account gets a role again', async () => {
    await ready();
    const user = await freshUser();
    const token = await owner(user);
    await roles.grantRole(db, 'adms-other-owner', { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    assert.equal((await coreRequest.delete('/system/admin/roles/' + user.userId).set('authorization', adminKey)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const code = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now() });
    const claimed = await coreRequest.post('/system/admin/roles/claim').set('authorization', user.token).send({ username: user.username, code: code.display });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal((await coreRequest.get('/system/admin/session').set(asSession(token))).status, 404, 'the old session stays ended');
    const fresh = await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    assert.equal((await coreRequest.get('/system/admin/session').set(asSession(fresh.body.adminSession.token))).status, 200, 'a new one works');
  });

  it('[ADMS24] account deletion: the role row goes with the account and its sessions stop; its holder cannot delete the last owner\'s account', async () => {
    await ready();
    const last = await freshUser();
    await owner(last);
    await withInjectedConfig({ 'user-account': { delete: ['adminToken', 'personalToken'] } }, async () => {
      const refused = await coreRequest.delete('/users/' + last.username).set('authorization', last.token);
      assert.equal(refused.status, 400, 'the last owner\'s own deletion: ' + JSON.stringify(refused.body));
      assert.equal(refused.body.error.data.id, 'last-owner');
      assert.notEqual(await roles.readRoleRow(db, last.userId), null);
    });
    const user = await freshUser();
    const token = await owner(user);
    const deleted = await coreRequest.delete('/users/' + user.username).set('authorization', adminKey);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(await roles.readRoleRow(db, user.userId), null, 'the role row went with the account');
    assert.equal((await coreRequest.get('/system/admin/session').set(asSession(token))).status, 404);
  });

  it('[ADMS25] the master\'s "platform in use" test on the real storages: an account of this core makes it true', async () => {
    await freshUser();
    const { platformInUseOf } = require('business/src/admin/setupBoot.ts');
    const storages = require('storages');
    assert.equal(await platformInUseOf(storages, coreId)(), true);
  });

  it('[ADMS16] GET /system/admin/portal/context: the subject, the capabilities and the setup state', async () => {
    await ready();
    const user = await freshUser();
    const token = await owner(user);
    const asKey = await coreRequest.get('/system/admin/portal/context').set('authorization', adminKey);
    assert.equal(asKey.status, 200);
    assert.equal(asKey.body.portalContext.subject.kind, 'key');
    assert.ok(Array.isArray(asKey.body.portalContext.capabilities));
    const asAdmin = await coreRequest.get('/system/admin/portal/context').set(asSession(token));
    assert.equal(asAdmin.body.portalContext.subject.userId, user.userId);
    assert.equal(asAdmin.body.portalContext.setup.state, 'ready');
    assert.equal((await coreRequest.get('/system/admin/portal/context')).status, 404);
  });

  // --------------------- origin rule ----------------- //

  it('[ADMS17] origin rule: a session call from a foreign origin is refused without CORS; from the core\'s own origin it is answered with CORS for it; an admin-key call is unchanged', async () => {
    await ready();
    const user = await freshUser();
    const token = await owner(user);
    const foreign = await coreRequest.get('/system/admin/users').set(asSession(token)).set('origin', 'https://evil.example.net');
    assert.equal(foreign.status, 404);
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    const own = 'http://' + coreRequest.get('/').url.split('/')[2];
    const same = await coreRequest.get('/system/admin/users').set(asSession(token)).set('origin', own);
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.headers['access-control-allow-origin'], own);
    await withInjectedConfig({ portal: { cors: { allowedOrigins: ['https://ops.example.com'] } } }, async () => {
      const listed = await coreRequest.get('/system/admin/users').set(asSession(token)).set('origin', 'https://ops.example.com');
      assert.equal(listed.status, 200);
      assert.equal(listed.headers['access-control-allow-origin'], 'https://ops.example.com');
    });
    const key = await coreRequest.get('/system/admin/users').set('authorization', adminKey).set('origin', 'https://evil.example.net');
    assert.equal(key.status, 200);
    assert.equal(key.headers['access-control-allow-origin'], 'https://evil.example.net', 'the API-wide behaviour');
    const noOrigin = await coreRequest.get('/system/admin/users').set(asSession(token));
    assert.equal(noOrigin.status, 200);
  });

  // --------------------- audit, secrets ----------------- //

  it('[ADMS18] the acts are audited without a user (who acted, no code or token) and no plain code or token is in the platform store', async () => {
    const seen = [];
    const original = audit?.eventForUser;
    if (audit != null) {
      audit.eventForUser = async function (userId, event, ...rest) {
        seen.push({ userId, event: JSON.parse(JSON.stringify(event)) });
        return await original.call(this, userId, event, ...rest);
      };
    }
    const secrets = [];
    try {
      const { code, token: setupToken } = await openSetupSession();
      secrets.push(code.code, code.display, setupToken);
      const user = await freshUser();
      assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup(setupToken)).send({ username: user.username, personalToken: user.token })).status, 200);
      assert.equal((await coreRequest.post('/system/setup/finish').set(asSetup(setupToken))).status, 200);
      const opened = await coreRequest.post('/system/admin/session').set('authorization', user.token).send({ username: user.username });
      secrets.push(opened.body.adminSession.token);
      const minted = await coreRequest.post('/system/admin/claim-codes').set('authorization', adminKey).send({});
      secrets.push(minted.body.claimCode.code, minted.body.claimCode.code.replace(/-/g, ''));
      const store = JSON.stringify(await db.listAllPlatformKvEntries());
      for (const s of secrets) assert.ok(!store.includes(s), 'the platform store holds a plain code or token');
      if (audit == null) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const mint = seen.find((r) => r.event.content?.action === 'system.claimCodes.create');
      assert.ok(mint != null, 'the mint is audited');
      assert.equal(mint.userId, undefined, 'without a user');
      assert.equal(mint.event.content.record.subject.via, 'admin-key');
      const open = seen.find((r) => r.event.content?.action === 'system.adminSession.create');
      assert.equal(open.event.content.record.subject.userId, user.userId);
      for (const action of ['system.setup.createSession', 'system.setup.createFirstAdmin', 'system.setup.setReady']) {
        assert.ok(seen.some((r) => r.event.content?.action === action), action + ' audited');
      }
      assert.ok(seen.some((r) => r.userId === user.userId && r.event.content?.action === 'admin.role.created'), 'the new administrator\'s trail');
      const all = JSON.stringify(seen);
      for (const s of secrets) assert.ok(!all.includes(s), 'an audit record holds a plain code or token');
    } finally {
      if (audit != null) audit.eventForUser = original;
    }
  });

  // --------------------- built-in setup page ----------------- //

  const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

  it('[ADMS19] GET /system/setup/: the page, its script and style while pending, with the strict CSP and no-store; no inline script, no external resource; 404 once ready', async () => {
    await pending();
    const page = await coreRequest.get('/system/setup/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.equal(page.headers['content-security-policy'], PAGE_CSP);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    const html = page.text;
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler');
    assert.ok(!/<style/i.test(html) && !/\sstyle\s*=/i.test(html), 'no inline style');
    assert.ok(!/(src|href)\s*=\s*"(https?:)?\/\//i.test(html), 'no external resource');
    for (const [file, type] of [['setup.js', /^text\/javascript/], ['setup.css', /^text\/css/]]) {
      const res = await coreRequest.get('/system/setup/' + file);
      assert.equal(res.status, 200, file);
      assert.match(res.headers['content-type'], type);
      assert.equal(res.headers['content-security-policy'], PAGE_CSP);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    const bare = await coreRequest.get('/system/setup').redirects(0);
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, 'setup/');
    await setup.markReady(db, { by: 'admin-key', now: Date.now() });
    for (const p of ['/system/setup/', '/system/setup/setup.js', '/system/setup/setup.css']) {
      assert.equal((await coreRequest.get(p)).status, 404, p);
    }
  });

  it('[ADMS20] GET /system/setup/checks: the checks summary for the setup session or the admin key, nothing secret in it; 404 otherwise', async () => {
    const { token } = await openSetupSession();
    assert.equal((await coreRequest.get('/system/setup/checks')).status, 404);
    const res = await coreRequest.get('/system/setup/checks').set(asSetup(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    const ids = res.body.checks.map((c) => c.id);
    for (const id of ['config', 'topology', 'certificates', 'migrations', 'mfa', 'portal']) assert.ok(ids.includes(id), id);
    for (const c of res.body.checks) assert.ok(['ok', 'info', 'warn', 'blocking'].includes(c.status), c.id);
    assert.ok(!JSON.stringify(res.body).includes(adminKey), 'no admin key in the checks');
    assert.equal((await coreRequest.get('/system/setup/checks').set('authorization', adminKey)).status, 200);
  });

  it('[ADMS21] the setup page signs in with its app id from the core\'s own origin with a setup session only', async () => {
    const { token } = await openSetupSession();
    const user = await freshUser();
    const own = 'http://' + coreRequest.get('/').url.split('/')[2];
    const login = (headers) => {
      let r = coreRequest.post('/' + user.username + '/auth/login');
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send({ username: user.username, password: PASSWORD, appId: 'pryv-setup-page' });
    };
    assert.equal((await login({ origin: own })).status, 401, 'no setup session: the app id is not trusted');
    assert.equal((await login({ origin: 'https://evil.example.net', ...asSetup(token) })).status, 401, 'a foreign origin');
    assert.equal((await login({ origin: own, ...asSetup('A'.repeat(43)) })).status, 401, 'an unknown setup session');
    const ok = await login({ origin: own, ...asSetup(token) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(typeof ok.body.token, 'string');
    // the page's flow: that token makes the account the first administrator
    assert.equal((await coreRequest.post('/system/setup/first-admin').set(asSetup(token)).set('origin', own)
      .send({ username: user.username, personalToken: ok.body.token })).status, 200);
    await setup.markReady(db, { by: 'admin-key', now: Date.now() });
    assert.equal((await login({ origin: own, ...asSetup(token) })).status, 401, 'once ready');
  });
});
