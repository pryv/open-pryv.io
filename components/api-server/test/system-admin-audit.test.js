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
  /** A username as the trail names it: its keyed hash (the erasure ledger's key). */
  const nameHashOf = (name) => {
    const { ledgerKey, usernameHash } = require('business/src/erasureLedger/index.ts');
    return usernameHash(ledgerKey(require('@pryv/boiler').getConfigSync()), name);
  };
  /** The id of the key the hashes are made with, recorded next to them. */
  const hashKeyId = () => require('business/src/erasureLedger/index.ts').ledgerKey(require('@pryv/boiler').getConfigSync()).keyId;

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
    assert.deepEqual(rec.content.record.target, { userId: target.userId, usernameHash: nameHashOf(target.username), hashKeyId: hashKeyId() }, 'the account id and the keyed hash of its name (with its key id), never the name');

    since = now();
    assert.equal((await coreRequest.get('/system/user-info/' + target.username).set(asSession(token))).status, 200);
    // The first call's record may be written after `since`: the session's one is picked by its access.
    for (let i = 0; i < 100; i++) {
      [rec] = (await trail(PLATFORM_TRAIL_USER_ID, 'system.getUserInfo', since)).filter((e) => e.streamIds.includes('access-admin-session'));
      if (rec != null) break;
      await pause(50);
    }
    assert.ok(rec != null, 'the session\'s call is in the platform trail');
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
    // No username in clear either (the names the calls give).
    const secrets = ['syau-secret@example.com', 'syau-invitation-secret', 'syau-unique@example.com', 'syau-update@example.com', 'syau-capability-secret', 'syau-password-secret', 'syau-join-secret', 'Syau_X!', 'syau-nobody'];
    for (const [methodId, call] of calls) {
      const since = now();
      // A record names the method: the handler was reached (a gate refusal records nothing).
      const res = await call();
      if (methodId === 'system.cores.ack') {
        // Anyone can call it: its refusal is a log line, never a stored record.
        assert.ok(res.status >= 400, 'refused: ' + res.status);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal((await trail(PLATFORM_TRAIL_USER_ID, methodId, since, 0)).length, 0, 'a refused join token is not stored');
        continue;
      }
      const rows = await trail(PLATFORM_TRAIL_USER_ID, methodId, since);
      assert.equal(rows.length, 1, methodId + ': one record (' + res.status + ')');
      const rec = rows[0];
      assert.deepEqual(rec.content.record.subject, { via: 'admin-key' }, methodId);
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
    const nobody = 'syau-nobody-' + cuid().slice(-6).toLowerCase();
    const res = await coreRequest.delete('/system/users/' + nobody + '/mfa').set(asSession(token));
    assert.equal(res.status, 404);
    const [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.deactivateMfa', since);
    assert.ok(rec != null);
    assert.equal(rec.type, 'audit-log/pryv-api-error');
    assert.equal(rec.content.record.subject.userId, admin.userId);
    // No account of that name: no id, the keyed hash of the name only.
    assert.deepEqual(rec.content.record.target, { usernameHash: nameHashOf(nobody), hashKeyId: hashKeyId() });
    assert.ok(!JSON.stringify(rec).includes(nobody), 'the name is not in the record');
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
    let res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.userId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.auditEvents.length, 2);
    assert.ok(res.body.auditEvents[0].time >= res.body.auditEvents[1].time, 'most recent first');
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, subject: admin.userId });
    assert.equal(res.body.auditEvents.length, 1);
    assert.equal(res.body.auditEvents[0].content.record.subject.userId, admin.userId);
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, subject: 'admin-key', target: target.userId });
    assert.equal(res.body.auditEvents.length, 1);
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.userId, limit: 1, skip: 1 });
    assert.equal(res.body.auditEvents.length, 1);
    assert.equal(res.body.limit, 1);
    assert.equal(res.body.hasMore, false, 'the last matching record');
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.userId, limit: 1 });
    assert.equal(res.body.hasMore, true);
    // The filter applies before the page is cut: records of another target in
    // front of the matching one do not make a filtered page empty.
    const other = await freshUser();
    for (let i = 0; i < 3; i++) await coreRequest.get('/system/user-info/' + other.username).set('authorization', adminKey);
    await trail(PLATFORM_TRAIL_USER_ID, 'system.getUserInfo', since, 5);
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, subject: admin.userId, limit: 1 });
    assert.deepEqual([res.body.auditEvents.length, res.body.hasMore], [1, false], JSON.stringify(res.body).slice(0, 300));
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, limit: 1, skip: 4 });
    assert.deepEqual([res.body.auditEvents.length, res.body.hasMore], [1, false], 'unfiltered paging: 5 records');
    assert.equal((await read({ skip: 10001 })).status, 400, 'skip is bounded');
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, target: target.userId }, 'AdminSession ' + token);
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

  it('[SYAU8] by default the platform trail keeps administration acts only: public traffic and refused setup codes stay in syslog unless audit.platformTrail.filter names them', async () => {
    const audit = require('audit').default;
    const publicCalls = async () => {
      assert.ok((await coreRequest.post('/users').send({})).status >= 400, 'a refused registration');
      assert.equal((await coreRequest.post('/system/setup/session').send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ' })).status, 404, 'a refused setup code');
    };
    let since = now();
    await publicCalls();
    // An administration act after them: once it is in, the earlier records would be too.
    assert.equal((await coreRequest.get('/system/admin/users').set('authorization', adminKey).query({ search: 'syauprefix' })).status, 200);
    const [listed] = await trail(PLATFORM_TRAIL_USER_ID, 'system.listUsers', since);
    assert.ok(listed != null, 'an administration act is kept');
    assert.ok(!JSON.stringify(listed).includes('syauprefix'), 'a username prefix is not kept in clear');
    if (listed.content.query != null) {
      assert.equal(listed.content.query.search, true, 'a search was used, nothing of it is kept');
      assert.equal(listed.content.query.searchHash, undefined);
    }
    assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'auth.register', since, 0)).length, 0, 'public traffic: syslog only');
    assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'system.setup.createSession', since, 0)).length, 0, 'a refused setup code: syslog only');
    // Opt in.
    const optIn = { audit: { platformTrail: { filter: { methods: { include: ['admin-acts', 'auth.register', 'system.setup.createSession'], exclude: [] } } } } };
    try {
      await withInjectedConfig(optIn, async () => {
        await audit.reloadConfig();
        since = now();
        await publicCalls();
        assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'auth.register', since)).length, 1, 'named: kept');
        assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'system.setup.createSession', since)).length, 1, 'named: its refusals kept');
      });
    } finally {
      await audit.reloadConfig();
    }
  });

  const slug = () => cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('[SYAU9] an account erased with the admin key is in the platform trail by default, named by its id and keyed hash; a refused anonymous deletion is not', async () => {
    const app = globalThis.app;
    if (!app.api.has('auth.delete')) await require('api-server/src/methods/auth/delete.ts').default(app.api);
    const target = await freshUser('syaudel');
    let since = now();
    const res = await coreRequest.delete('/users/' + target.username).set('authorization', adminKey);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await trail(PLATFORM_TRAIL_USER_ID, 'auth.delete', since);
    assert.equal(rows.length, 1);
    const [rec] = rows;
    assert.ok(rec.streamIds.includes('access-admin'), JSON.stringify(rec.streamIds));
    assert.deepEqual(rec.content.record, { subject: { via: 'admin-key' }, target: { userId: target.userId, usernameHash: nameHashOf(target.username), hashKeyId: hashKeyId() } });
    // (A test fixture may give the account its name as id: that one occurrence is the id.)
    const occurrences = JSON.stringify(rec).split(target.username).length - 1;
    assert.equal(occurrences, target.userId === target.username ? 1 : 0, 'never the name: ' + JSON.stringify(rec));
    since = now();
    const nobody = 'syaunodel' + slug();
    assert.ok((await coreRequest.delete('/users/' + nobody)).status >= 400, 'refused without a credential');
    await pause(200);
    assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'auth.delete', since, 0)).length, 0, 'a refusal anyone can cause: syslog only');
  });

  it('[SYAU10] registrations opted in: a refused registration of a taken username, or of a taken email, stores neither in the platform trail', async () => {
    const audit = require('audit').default;
    const takenName = ('syautk' + slug()).slice(0, 20);
    const takenEmail = takenName + '@syau.example.com';
    const fu = await getNewFixture().user(takenName, { password: PASSWORD, email: takenEmail });
    usedUsers.push(fu.attrs.id);
    const fresh = 'syaunw' + slug();
    const body = (username, email) => ({ appId: 'syau-app', username, password: PASSWORD, email, insurancenumber: '12345', language: 'en' });
    const optIn = { audit: { platformTrail: { filter: { methods: { include: ['admin-acts', 'auth.register'], exclude: [] } } } } };
    try {
      await withInjectedConfig(optIn, async () => {
        await audit.reloadConfig();
        const since = now();
        const byName = await coreRequest.post('/users').send(body(takenName, fresh + '@syau.example.com'));
        assert.ok(byName.status >= 400 && byName.status < 500, 'taken username refused: ' + byName.status);
        const byEmail = await coreRequest.post('/users').send(body(fresh, takenEmail));
        assert.ok(byEmail.status >= 400 && byEmail.status < 500, 'taken email refused: ' + byEmail.status);
        const rows = await trail(PLATFORM_TRAIL_USER_ID, 'auth.register', since, 2);
        assert.equal(rows.length, 2, 'both refusals kept (the filter names the id)');
        const text = JSON.stringify(rows);
        for (const s of [takenName, takenEmail, fresh]) assert.ok(!text.includes(s), s + ' in ' + text);
        for (const r of rows) assert.equal(r.content.message, undefined, 'the message, which quotes the input, is not stored');
      });
    } finally {
      await audit.reloadConfig();
    }
  });

  it('[SYAU11] a filtered read stopped by the scan limit answers the time it reached (scannedToTime); continuing from it finds the match further down', async () => {
    const { readPlatformTrail, AUDIT_READ_SCAN_MAX } = require('api-server/src/methods/systemAdminAudit.ts');
    const total = AUDIT_READ_SCAN_MAX + 500;
    // Most recent first; one record of the target, past the scan limit.
    const all = Array.from({ length: total }, (_, i) => ({ id: 'syau-r' + i, time: 1e9 - i, content: { record: { subject: { via: 'admin-key' }, target: { userId: i === total - 10 ? 'syau-far' : 'syau-other' } } } }));
    const storage = {
      forUser: async () => ({
        getEvents: async ({ query, options }) => {
          const upTo = query.find((q) => q.type === 'lowerOrEqual' && q.content.field === 'time');
          const rows = upTo != null ? all.filter((e) => e.time <= upTo.content.value) : all;
          return rows.slice(options.skip, options.skip + options.limit);
        }
      })
    };
    const first = await readPlatformTrail(storage, { target: 'syau-far', limit: 10, skip: 0 });
    assert.deepEqual(first.events, []);
    assert.equal(first.hasMore, true);
    assert.equal(first.scanLimitReached, true);
    assert.equal(first.scannedToTime, all[AUDIT_READ_SCAN_MAX - 1].time, 'the time of the last record scanned');
    const next = await readPlatformTrail(storage, { target: 'syau-far', toTime: first.scannedToTime, limit: 10, skip: 0 });
    assert.deepEqual(next.events.map((e) => e.id), ['syau-r' + (total - 10)]);
    assert.equal(next.hasMore, false);
    assert.equal(next.scanLimitReached, undefined);
  });

  it('[SYAU12] admin-key writes under /reg (invitations, DNS records, core rename) are administration acts in the platform trail, done or refused, never a token; an unauthorized call is not recorded', async () => {
    let since = now();
    // Invitation tokens close registration to anyone without one: removed at the end.
    const tokensBefore = new Set((await db.getAllInvitationTokens()).map((t) => t.id));
    const inv = await coreRequest.get('/reg/admin/invitations/post?count=2&message=syau-free-text').set('authorization', adminKey);
    try {
      assert.equal(inv.status, 200, JSON.stringify(inv.body));
    } finally {
      for (const t of await db.getAllInvitationTokens()) if (!tokensBefore.has(t.id)) await db.deleteInvitationToken(t.id);
    }
    let [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.invitations.create', since);
    assert.ok(rec != null, 'invitations recorded');
    assert.deepEqual(rec.content.record.subject, { via: 'admin-key' });
    assert.equal(rec.content.record.diff.count, 2);
    const text = JSON.stringify(rec);
    for (const t of inv.body.data) assert.ok(!text.includes(t.id), 'no invitation token');
    assert.ok(!text.includes('syau-free-text'), 'not the free-text description');

    const sub = '_syau-' + slug();
    since = now();
    assert.equal((await coreRequest.post('/reg/records').set('authorization', adminKey).send({ subdomain: sub, records: { txt: ['syau-txt-value'] } })).status, 200);
    [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.records.set', since);
    assert.ok(rec != null, 'DNS record set recorded');
    assert.deepEqual(rec.content.record.target, { subdomain: sub });
    assert.deepEqual(rec.content.record.diff, { recordTypes: ['txt'] });
    assert.ok(!JSON.stringify(rec).includes('syau-txt-value'), 'the kinds of record, not their values');
    since = now();
    assert.equal((await coreRequest.delete('/reg/records/' + sub).set('authorization', adminKey)).status, 200);
    [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.records.delete', since);
    assert.ok(rec != null && rec.content.record.target.subdomain === sub, 'DNS record delete recorded');

    since = now();
    const rename = await coreRequest.get('/reg/admin/servers/syau-src/rename/syau-unknown-core').set('authorization', adminKey);
    assert.equal(rename.status, 400, JSON.stringify(rename.body));
    [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.servers.rename', since);
    assert.ok(rec != null, 'a refused rename is recorded');
    assert.equal(rec.type, 'audit-log/pryv-api-error');
    assert.deepEqual(rec.content.record.target, { srcCore: 'syau-src', dstCore: 'syau-unknown-core' });

    since = now();
    assert.equal((await coreRequest.get('/reg/admin/invitations/post?count=1').set('authorization', 'syau-not-the-key')).status, 404);
    assert.equal((await coreRequest.post('/reg/records').send({ subdomain: sub, records: { txt: ['x'] } })).status, 404);
    await pause(200);
    for (const m of ['system.reg.invitations.create', 'system.reg.records.set']) {
      assert.equal((await trail(PLATFORM_TRAIL_USER_ID, m, since, 0)).length, 0, m + ': an unauthorized call is not recorded');
    }
  });

  it('[SYAU13] admin-key reads of account data under /reg (an account\'s details, the names of a core\'s accounts) are recorded, never with a name in clear; the account\'s own trail has the read', async () => {
    const target = await freshUser('syaureg');
    let since = now();
    const one = await coreRequest.get('/reg/admin/users/' + target.username).set('authorization', adminKey);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    let [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.users.get', since);
    assert.ok(rec != null, 'the read of an account is recorded');
    assert.deepEqual(rec.content.record.subject, { via: 'admin-key' });
    assert.deepEqual(rec.content.record.target, { userId: target.userId, usernameHash: nameHashOf(target.username), hashKeyId: hashKeyId() });
    const occurrences = JSON.stringify(rec).split(target.username).length - 1;
    assert.equal(occurrences, target.userId === target.username ? 1 : 0, 'never the name: ' + JSON.stringify(rec));
    const [read] = await trail(target.userId, 'account.readByAdmin', since);
    assert.ok(read != null, 'the read account\'s own trail');
    assert.equal(read.content.record.methodId, 'system.reg.users.get');

    since = now();
    const listed = await coreRequest.get('/reg/admin/servers/' + coreId + '/users').set('authorization', adminKey);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.servers.users.list', since);
    assert.ok(rec != null, 'the list of a core\'s accounts is recorded');
    assert.deepEqual(rec.content.record.target, { core: coreId });
    assert.equal(rec.content.record.result.count, listed.body.users.length);
    for (const u of listed.body.users) assert.ok(!JSON.stringify(rec).includes('"' + u.username + '"'), 'no account name');

    // A refused read keeps its target with the account id; an unauthorized one is not recorded.
    since = now();
    const nobody = 'syauregno' + slug();
    assert.equal((await coreRequest.get('/reg/admin/users/' + nobody).set('authorization', adminKey)).status, 404);
    [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.users.get', since);
    assert.ok(rec != null && String(rec.type).includes('error'), 'a refused read is recorded');
    assert.deepEqual(rec.content.record.target, { usernameHash: nameHashOf(nobody), hashKeyId: hashKeyId() });
    since = now();
    assert.equal((await coreRequest.get('/reg/admin/users/' + target.username).set('authorization', 'syau-not-the-key')).status, 404);
    await pause(200);
    assert.equal((await trail(PLATFORM_TRAIL_USER_ID, 'system.reg.users.get', since, 0)).length, 0, 'an unauthorized call is not recorded');
  });

  it('[SYAU14] GET /system/admin/audit?targetUsername finds the acts on an account by the keyed hash of its name, never answers the name', async () => {
    const target = await freshUser('syaunm');
    const other = await freshUser('syaunm');
    const since = now();
    await coreRequest.get('/system/user-info/' + target.username).set('authorization', adminKey);
    await coreRequest.get('/system/user-info/' + other.username).set('authorization', adminKey);
    await coreRequest.get('/system/user-info/' + target.username.toUpperCase()).set('authorization', adminKey);
    await trail(PLATFORM_TRAIL_USER_ID, 'system.getUserInfo', since, 3);
    const read = (query) => coreRequest.get('/system/admin/audit').set('authorization', adminKey).query(query);
    let res = await read({ methodId: 'system.getUserInfo', fromTime: since, targetUsername: target.username });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.auditEvents.length, 2, 'the name in any case');
    for (const e of res.body.auditEvents) assert.equal(e.content.record.target.usernameHash, nameHashOf(target.username));
    // (A test fixture may give the account its name as id: that id is not the name answered.)
    assert.ok(!JSON.stringify(res.body).split(target.userId).join('').toLowerCase().includes(target.username), 'the name is not answered');
    res = await read({ methodId: 'system.getUserInfo', fromTime: since, targetUsername: 'syaunobody' + slug() });
    assert.deepEqual([res.status, res.body.auditEvents.length], [200, 0]);
    res = await read({ targetUsername: 'x'.repeat(257) });
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.body).includes('x'.repeat(257)), 'a refused name is not echoed');
  });

  it('[SYAU16] a handler route refused through the error answer names its account by id too, as a done act does', async () => {
    const target = await freshUser('syaurf');
    const since = now();
    assert.equal((await coreRequest.delete('/system/users/' + target.username).set('authorization', adminKey)).status, 400, 'refused without onlyReg');
    const [rec] = await trail(PLATFORM_TRAIL_USER_ID, 'system.users.delete', since);
    assert.ok(rec != null && String(rec.type).includes('error'), 'the refusal is recorded');
    assert.deepEqual(rec.content.record.target, { userId: target.userId, usernameHash: nameHashOf(target.username), hashKeyId: hashKeyId() });
  });

  it('[SYAU17] the whole public traffic opted in: a refused MFA recovery stores no account name', async () => {
    const audit = require('audit').default;
    const target = await freshUser('syaumfa');
    const optIn = { audit: { platformTrail: { filter: { methods: { include: ['all'], exclude: [] } } } } };
    try {
      await withInjectedConfig(optIn, async () => {
        await audit.reloadConfig();
        const since = now();
        const res = await coreRequest.post('/' + target.username + '/mfa/recover').send({ username: target.username, password: 'syau-wrong-password', recoveryCode: 'syau-recovery-code' });
        assert.ok(res.status >= 400, 'refused: ' + res.status);
        const rows = await trail(PLATFORM_TRAIL_USER_ID, 'mfa.recover', since);
        assert.ok(rows.length >= 1, 'the refusal is kept (opted in)');
        const text = JSON.stringify(rows).split(target.userId).join('');
        for (const s of [target.username, 'syau-wrong-password', 'syau-recovery-code']) assert.ok(!text.includes(s), s + ' in ' + text);
      });
    } finally {
      await audit.reloadConfig();
    }
  });

  it('[SYAU15] a filtered read keeps a record once when a write between two batches shifts it into the next one', async () => {
    const { readPlatformTrail } = require('api-server/src/methods/systemAdminAudit.ts');
    // 1500 records, most recent first; after the first batch a new record arrives at the top.
    let all = Array.from({ length: 1500 }, (_, i) => ({ id: 'syau-d' + i, time: 1e9 - i, content: { record: { subject: { via: 'admin-key' }, target: { userId: 'syau-dup' } } } }));
    let reads = 0;
    const storage = {
      forUser: async () => ({
        getEvents: async ({ options }) => {
          const rows = all.slice(options.skip, options.skip + options.limit);
          if (++reads === 1) all = [{ id: 'syau-new', time: 1e9 + 1, content: { record: { subject: { via: 'admin-key' }, target: { userId: 'syau-other' } } } }, ...all];
          return rows;
        }
      })
    };
    const page = await readPlatformTrail(storage, { target: 'syau-dup', limit: 1000, skip: 500 });
    const ids = page.events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'no record twice');
    assert.equal(ids.length, 1000);
    assert.equal(ids[0], 'syau-d500');
    assert.equal(ids[999], 'syau-d1499');
  });

  describe('[SYAS] an administrator session acts on this core\'s accounts only; the admin key as before', function () {
    let platform;
    const SLUG = cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);
    const foreign = 'syaufr' + SLUG;
    const OTHER_CORE = 'syau-other-' + SLUG;
    // Platform rows of names with no account here: removed within each test,
    // before the integrity check of the next one.
    let cleanups = [];

    before(function () {
      platform = require('platform').platform;
    });

    afterEach(async function () {
      for (const fn of cleanups.reverse()) {
        try { await fn(); } catch (_e) { /* best-effort */ }
      }
      cleanups = [];
    });

    it('[SYAS1] PUT /system/users: 404 for a name with no account on this core (its platform rows untouched); the key still writes; a local account is changed', async () => {
      const email = 'syau-' + SLUG + '@example.com';
      assert.ok(await platform.setUserUniqueFieldIfNotExists(foreign, 'email', email), 'a row of an account elsewhere');
      cleanups.push(() => platform.deleteUser(foreign, null));
      const token = await ownerSession(await freshUser('syaus'));
      const res = await coreRequest.put('/system/users').set(asSession(token)).send({ username: foreign, fieldsToDelete: { email } });
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(await platform.getUsersUniqueField('email', email), platform.hashFor('username', foreign), 'the row is untouched');
      const byKey = await coreRequest.put('/system/users').set('authorization', adminKey).send({ username: foreign, user: {} });
      assert.equal(byKey.status, 200, 'the admin key keeps the platform-wide write: ' + JSON.stringify(byKey.body));
      const local = await freshUser('syaul');
      const ok = await coreRequest.put('/system/users').set(asSession(token)).send({ username: local.username, user: {} });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });

    it('[SYAS2] POST /system/users/validate: a session naming another core is refused before anything is reserved', async () => {
      const token = await ownerSession(await freshUser('syauv'));
      const name = 'syauvl' + SLUG;
      const res = await coreRequest.post('/system/users/validate').set(asSession(token)).send({ username: name, core: OTHER_CORE, uniqueFields: {} });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.reservation, false);
      assert.equal(res.body.error.id, 'invalid-parameters-format');
      assert.equal(await platform.getUsersUniqueField('username', name), null, 'nothing reserved');
      assert.equal(await platform.getUserCore(name), null, 'no routing row');
    });

    it('[SYAS3] GET /system/accesses/:id: on a multi-core platform a session reads only the accesses of this core\'s accounts; the key reads any', async () => {
      const accessIndex = require('platform/src/accessIndex.ts');
      const holder = 'syauax' + SLUG;
      const aid = 'syauacc' + cuid();
      await accessIndex.putAccessIndex(platform, holder, { id: aid, type: 'app', expires: null, created: 1700000000, modified: 1700000100 });
      cleanups.push(() => platform.deletePlatformKv('access-index/' + aid));
      await platform.setUserCore(holder, OTHER_CORE);
      cleanups.push(() => platform.deleteUserCore(holder));
      const token = await ownerSession(await freshUser('syaua'));
      Object.defineProperty(platform, 'isSingleCore', { configurable: true, get: () => false });
      try {
        assert.equal((await coreRequest.get('/system/accesses/' + aid).set(asSession(token))).status, 404, 'held on another core');
        assert.equal((await coreRequest.get('/system/accesses/' + aid).set('authorization', adminKey)).status, 200, 'the key reads it');
        await platform.setUserCore(holder, platform.coreId);
        assert.equal((await coreRequest.get('/system/accesses/' + aid).set(asSession(token))).status, 200, 'held on this core');
      } finally {
        delete platform.isSingleCore;
      }
      assert.equal(platform.isSingleCore, true, 'single-core again');
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
