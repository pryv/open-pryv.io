/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [SYAU] the platform trail of the /system routes: who acted (the admin key,
 * an administrator session with its grant), on what, never a secret; every
 * route has a method id and every audited one writes a record; the reads
 * of account data also land in the account's trail; the trail read
 * (GET /system/admin/audit); the paging of GET /system/admin/users.
 */

const { withInjectedConfig } = require('test-helpers');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const { KEYS } = require('business/src/admin/store.ts');
const { SYSTEM_ROUTES } = require('api-server/src/routes/system-permissions.ts');
const apiMethods = require('audit/src/ApiMethods.ts');
const { PLATFORM_TRAIL_USER_ID } = require('storages/interfaces/auditStorage/AuditStorage.ts');
const timestamp = require('unix-timestamp');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const PASSWORD = 'syau-password-123';
const MIN = 60 * 1000;

describe('[SYAU] platform trail, attribution, trail read and users paging', function () {
  this.timeout(60000);

  let db, adminKey, coreId, auditStorage, usersRepository;
  const usedUsers = [];
  const roleRows = [];

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.listUsers')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    if (!app.systemAPI.has('system.audit.get')) await require('api-server/src/methods/systemAdminAudit.ts').default(app.systemAPI);
    const config = await require('@pryv/boiler').getConfig();
    if (config.get('audit:active') !== true) return this.skip();
    adminKey = config.get('auth:adminAccessKey');
    db = require('storages').platformDB;
    coreId = require('platform').platform.coreId;
    auditStorage = require('storages').auditStorage;
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    // Platform rows an earlier version of [SYAU3] reserved (a valid username).
    await require('platform').platform.deleteUser('syau-x', null);
  });

  after(async () => {
    for (const userId of roleRows) await db.deletePlatformKv(KEYS.rolePrefix + userId);
    for (const id of usedUsers) {
      try { await usersRepository.deleteOne(id); } catch (_e) { /* best-effort */ }
    }
  });

  async function freshUser (prefix = 'syau') {
    const username = (prefix + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD });
    usedUsers.push(fu.attrs.id);
    return { username, userId: fu.attrs.id };
  }

  async function ownerSession (user) {
    await roles.grantRole(db, user.userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
    roleRows.push(user.userId);
    return (await sessions.createAdminSession(db, { userId: user.userId, homeCore: coreId, mfaAt: Date.now(), now: Date.now(), ttlMs: 60 * MIN })).token;
  }
  const asSession = (token) => ({ authorization: 'AdminSession ' + token });

  /** Records of `methodId` in a trail since `since` (seconds), waiting for the ones written after the answer. */
  async function trail (userId, methodId, since, atLeast = 1) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const store = await auditStorage.forUser(userId);
      const rows = (await store.getEvents({ query: [{ type: 'streamsQuery', content: [[{ any: ['action-' + methodId] }]] }] }))
        .filter((e) => e.time >= since);
      if (rows.length >= atLeast || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // A record of a later call is timed after this (written after its answer).
  const now = () => timestamp.now();

  it('[SYAU1] a call made with the admin key is recorded under `admin`, one made with an administrator session under `admin-session` with the account, its grant and the actor\'s own trail', async () => {
    const target = await freshUser();
    const admin = await freshUser('syauadm');
    const token = await ownerSession(admin);
    let since = now();
    assert.equal((await coreRequest.get('/system/user-info/' + target.username).set('authorization', adminKey)).status, 200);
    let [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.getUserInfo', since);
    assert.ok(rec != null, 'in the platform trail');
    assert.ok(rec.streamIds.includes('access-admin'), JSON.stringify(rec.streamIds));
    assert.deepEqual(rec.content.record.subject, { via: 'admin-key' });
    assert.deepEqual(rec.content.record.target, { username: target.username });

    since = now();
    assert.equal((await coreRequest.get('/system/user-info/' + target.username).set(asSession(token))).status, 200);
    [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.getUserInfo', since);
    assert.ok(rec.streamIds.includes('access-admin-session'), JSON.stringify(rec.streamIds));
    const subject = rec.content.record.subject;
    assert.equal(subject.via, 'session');
    assert.equal(subject.userId, admin.userId);
    assert.equal(subject.role, 'owner');
    assert.equal(subject.scope, 'platform');
    assert.equal(typeof subject.sessionId, 'string');
    assert.equal(subject.sessionId.length, 16, 'a short session id, never the token');
    assert.ok(!JSON.stringify(rec).includes(token), 'no token in the record');
    const [own] = await trail(admin.userId, 'admin.act', since);
    assert.ok(own != null, 'the acting administrator\'s trail');
    assert.equal(own.content.record.methodId, 'system.getUserInfo');
    const [read] = await trail(target.userId, 'account.readByAdmin', since);
    assert.ok(read != null, 'the read account\'s own trail');
    assert.equal(read.content.record.subject.userId, admin.userId);
  });

  it('[SYAU2] every /system route has a method id, declared for the audit; an audited one is recorded without a user, a read declared not audited is not', () => {
    for (const e of SYSTEM_ROUTES) {
      const label = e.method + ' ' + e.path;
      if (e.methodId == null) {
        assert.ok(e.rule.auth === 'public' && /^\/system\/setup\/(setup\.(js|css))?$/.test(e.path), label + ' has no method id');
        continue;
      }
      assert.ok(apiMethods.ALL_METHODS_MAP[e.methodId], label + ': ' + e.methodId + ' declared');
      if (apiMethods.AUDITED_METHODS_MAP[e.methodId]) {
        assert.ok(apiMethods.WITHOUT_USER_METHODS_MAP[e.methodId], label + ': ' + e.methodId + ' is recorded without a user (platform trail)');
      }
    }
  });

  it('[SYAU3] each route served by a handler records its act, done or refused, with the subject and never the body', async () => {
    // A minimal call per route; most are refused (400), which is recorded too.
    const calls = [
      ['system.certs.renew', () => coreRequest.post('/system/admin/certs/force-renew').set('authorization', adminKey).send({ hostname: 'syau.example.com' })],
      ['system.mailTemplates.set', () => coreRequest.put('/system/admin/mail/templates/syau/en/subject').set('authorization', adminKey).send({ notPug: 1 })],
      ['system.mailTemplates.delete', () => coreRequest.delete('/system/admin/mail/templates/syau/en/subject').set('authorization', adminKey)],
      ['system.mail.sendTest', () => coreRequest.post('/system/admin/mail/send-test').set('authorization', adminKey).send({ recipient: 'syau-secret@example.com' })],
      // A username creation refuses: refused before anything is reserved.
      ['system.users.validate', () => coreRequest.post('/system/users/validate').set('authorization', adminKey).send({ username: 'Syau_X!', invitationToken: 'syau-invitation-secret', uniqueFields: { email: 'syau-unique@example.com' } })],
      ['system.users.update', () => coreRequest.put('/system/users').set('authorization', adminKey).send({ user: { email: 'syau-update@example.com' } })],
      ['system.users.delete', () => coreRequest.delete('/system/users/syau-nobody').set('authorization', adminKey)],
      ['system.delegation.invite', () => coreRequest.post('/system/delegation/invite').set('authorization', adminKey).send({ relId: 'syau-rel', capabilityUrl: 'https://syau-capability-secret' })],
      ['system.delegation.createAccount', () => coreRequest.post('/system/delegation/create-account').set('authorization', adminKey).send({ relId: 'syau-rel', password: 'syau-password-secret' })],
      ['system.cores.ack', () => coreRequest.post('/system/admin/cores/ack').send({ coreId: 'syau-core', token: 'syau-join-secret' })]
    ];
    const secrets = ['syau-secret@example.com', 'syau-invitation-secret', 'syau-unique@example.com', 'syau-update@example.com', 'syau-capability-secret', 'syau-password-secret', 'syau-join-secret'];
    for (const [methodId, call] of calls) {
      const since = now();
      // A record names the method: the handler was reached (a gate refusal records nothing).
      const res = await call();
      const rows = await trail(PLATFORM_TRAIL_USER_ID, methodId, since);
      assert.equal(rows.length, 1, methodId + ': one record (' + res.status + ')');
      const rec = rows[0];
      if (methodId === 'system.cores.ack') {
        assert.deepEqual(rec.content.record.subject, {}, 'the join token is the credential: no subject');
        assert.deepEqual(rec.content.record.target, { coreId: 'syau-core' });
      } else {
        assert.deepEqual(rec.content.record.subject, { via: 'admin-key' }, methodId);
      }
      const all = JSON.stringify(rec);
      for (const s of secrets) assert.ok(!all.includes(s), methodId + ' records ' + s);
    }
    // Reads declared not audited write nothing.
    const since = now();
    assert.equal((await coreRequest.get('/system/admin/mail/templates').set('authorization', adminKey)).status, 200);
    assert.equal((await coreRequest.get('/system/admin/certs').set('authorization', adminKey)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const methodId of ['system.mailTemplates.list', 'system.certs.list']) {
      assert.equal((await trail(PLATFORM_TRAIL_USER_ID, methodId, since, 0)).length, 0, methodId);
    }
  });

  it('[SYAU4] a mail template is recorded by size and digest, never as text', async () => {
    const pug = '| syau template body ' + cuid();
    const since = now();
    const res = await coreRequest.put('/system/admin/mail/templates/welcome-email/en/subject').set('authorization', adminKey).send({ pug });
    try {
      assert.ok(res.status === 204 || res.status === 503, JSON.stringify(res.body));
      const [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.mailTemplates.set', since);
      assert.ok(rec != null);
      assert.deepEqual(rec.content.record.target, { type: 'welcome-email', lang: 'en', part: 'subject' });
      assert.equal(rec.content.record.diff.pug.length, pug.length);
      assert.match(rec.content.record.diff.pug.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(rec).includes(pug), 'the body is not in the record');
    } finally {
      await coreRequest.delete('/system/admin/mail/templates/welcome-email/en/subject').set('authorization', adminKey);
    }
  });

  it('[SYAU5] a refused act keeps who tried it and on what', async () => {
    const admin = await freshUser('syauref');
    const token = await ownerSession(admin);
    const since = now();
    const res = await coreRequest.delete('/system/users/syau-nobody-' + cuid().slice(-6) + '/mfa').set(asSession(token));
    assert.equal(res.status, 404);
    const [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.deactivateMfa', since);
    assert.ok(rec != null);
    assert.equal(rec.type, 'audit-log/pryv-api-error');
    assert.equal(rec.content.record.subject.userId, admin.userId);
    assert.match(rec.content.record.target.username, /^syau-nobody-/);
  });

  it('[SYAU6] GET /system/admin/audit reads the trail: filters, paging, refusals', async () => {
    const target = await freshUser();
    const admin = await freshUser('syaurd');
    const token = await ownerSession(admin);
    const since = now();
    await coreRequest.get('/system/user-info/' + target.username).set('authorization', adminKey);
    await coreRequest.get('/system/user-info/' + target.username).set(asSession(token));
    await trail(PLATFORM_TRAIL_USER_ID, 'system.getUserInfo', since, 2);
    const read = (query, auth = adminKey) => coreRequest.get('/system/admin/audit').set('authorization', auth).query(query);
    let res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.username });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.auditEvents.length, 2);
    assert.ok(res.body.auditEvents[0].time >= res.body.auditEvents[1].time, 'most recent first');
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, subject: admin.userId });
    assert.equal(res.body.auditEvents.length, 1);
    assert.equal(res.body.auditEvents[0].content.record.subject.userId, admin.userId);
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, subject: 'admin-key', target: target.username });
    assert.equal(res.body.auditEvents.length, 1);
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.username, limit: 1, skip: 1 });
    assert.equal(res.body.auditEvents.length, 1);
    assert.equal(res.body.limit, 1);
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.username }, 'AdminSession ' + token);
    assert.equal(res.status, 200, 'an owner session reads it');
    // the read is not itself recorded
    assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'system.audit.get', since, 0)).length, 0);
    for (const bad of [{ limit: 0 }, { limit: 1001 }, { skip: -1 }, { fromTime: 'x' }, { methodId: 'a b' }, { other: 1 }, { subject: '' }]) {
      assert.equal((await read(bad)).status, 400, JSON.stringify(bad));
    }
    await withInjectedConfig({ auth: { adminAccessKeyScope: 'break-glass' } }, async () => {
      assert.equal((await read({})).status, 404, 'not a break-glass route');
    });
  });

  it('[SYAU7] GET /system/admin/users: unchanged without paging (plus total), paged by limit, skip and username prefix', async () => {
    const prefix = 'syaupg' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-5);
    const created = [];
    for (let i = 0; i < 3; i++) created.push(await freshUser(prefix + i));
    const names = created.map((u) => u.username).sort();
    let res = await coreRequest.get('/system/admin/users').set('authorization', adminKey);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, res.body.users.length, 'every user, and their count');
    for (const n of names) assert.ok(res.body.users.some((u) => u.username === n), n);
    res = await coreRequest.get('/system/admin/users').set('authorization', adminKey).query({ search: prefix });
    assert.equal(res.body.total, 3);
    assert.deepEqual(res.body.users.map((u) => u.username), names, 'in username order');
    res = await coreRequest.get('/system/admin/users').set('authorization', adminKey).query({ search: prefix.toUpperCase(), limit: 1, skip: 1 });
    assert.equal(res.body.total, 3);
    assert.deepEqual(res.body.users.map((u) => u.username), [names[1]]);
    assert.ok(!res.body.users.some((u) => u.id === PLATFORM_TRAIL_USER_ID || u.username === PLATFORM_TRAIL_USER_ID), 'the platform trail is no account');
    for (const bad of [{ limit: 0 }, { limit: 1001 }, { limit: 'x' }, { skip: -1 }, { search: 'x'.repeat(65) }]) {
      assert.equal((await coreRequest.get('/system/admin/users').set('authorization', adminKey).query(bad)).status, 400, JSON.stringify(bad));
    }
  });
});
