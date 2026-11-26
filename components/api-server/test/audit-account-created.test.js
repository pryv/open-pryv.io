/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { withInjectedConfig, pollUntil } = require('test-helpers');
const { fromCallback } = require('utils');

// The account's creation is the first record of its own trail, on the core
// that created it, whichever way it was created. The call itself
// (auth.register, system.createUser) is audited without a user; the record is
// written by the server once the account exists.
describe('[AACR] audit record of an account creation', function () {
  this.timeout(60_000);

  let fixtures, config, adminKey, audit, auditStorage, originalForUser, storageLayer, usersRepository, usersIndex, lossCounter;
  const PASSWORD = 'aacr-passw0rd';
  const APP_ID = 'test-aacr-app';

  before(async function () {
    await initTests();
    await initCore();
    config = await require('@pryv/boiler').getConfig();
    if (config.get('audit:active') !== true) this.skip();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.createUser')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.api.has('delegations.createAccount')) await require('api-server/src/methods/delegations.ts').default(app.api);
    adminKey = config.get('auth:adminAccessKey');
    fixtures = getNewFixture();
    audit = require('audit').default;
    auditStorage = require('storages').auditStorage;
    originalForUser = auditStorage.forUser;
    storageLayer = await require('storage').getStorageLayer();
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    usersIndex = await require('storage').getUsersLocalIndex();
    lossCounter = require('audit/src/lossCounter.ts');
  });

  afterEach(function () { if (auditStorage != null) auditStorage.forUser = originalForUser; });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.context.cleanEverything(); } catch (_e) { /* best-effort */ }
    }
  });

  function newName () {
    return 'aacr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12);
  }

  function registrationBody (username, extra = {}) {
    return {
      appId: APP_ID,
      username,
      password: PASSWORD,
      email: username + '@aacr.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en',
      ...extra
    };
  }

  function register (username, extra = {}, path = '/users') {
    return coreRequest.post(path).send(registrationBody(username, extra));
  }

  async function userIdOf (username) {
    const userId = await usersRepository.getUserIdForUsername(username);
    assert.ok(userId != null, 'no account ' + username);
    return userId;
  }

  async function rows (userId) {
    const db = await originalForUser.call(auditStorage, userId);
    return await db.getEvents({ query: [] });
  }

  async function creationRecords (userId) {
    return (await rows(userId)).filter((e) => e.content?.action === 'account.created');
  }

  async function accessOfToken (userId, token) {
    return await fromCallback((cb) => storageLayer.accesses.findOne({ id: userId }, { token }, null, cb));
  }

  async function personalAccesses (userId) {
    const all = await fromCallback((cb) => storageLayer.accesses.find({ id: userId }, {}, null, cb));
    return (all || []).filter((a) => a.type === 'personal');
  }

  function tokenOf (apiEndpoint) {
    return new URL(apiEndpoint).username;
  }

  /** The `source` of the next call row of `accessId`, written after the answer. */
  async function callSourceOf (userId, username, token, accessId) {
    const before = new Set((await rows(userId)).map((e) => e.id));
    const res = await coreRequest.get('/' + username + '/access-info').set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const found = await pollUntil(async () => (await rows(userId)).filter((e) => !before.has(e.id) && e.content?.action === 'getAccessInfo'),
      (list) => list.length > 0, { timeoutMs: 5000 });
    assert.strictEqual(found.length, 1, 'the call row');
    assert.ok(found[0].streamIds.includes('access-' + accessId), JSON.stringify(found[0].streamIds));
    return found[0].content.source;
  }

  function assertNoneOf (record, values) {
    const serialized = JSON.stringify(record);
    for (const value of values) {
      if (value == null || value === '') continue;
      assert.ok(!serialized.includes(value), 'the record holds ' + JSON.stringify(value) + ': ' + serialized);
    }
  }

  /** A self-registration through `path`: one record, the access's stream, the client address of its calls. */
  async function assertSelfRegistration (path, body) {
    const res = await coreRequest.post(path).send(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const username = body.username;
    const userId = await userIdOf(username);
    const token = tokenOf(res.body.apiEndpoint);
    const access = await accessOfToken(userId, token);
    assert.ok(access != null && access.type === 'personal', JSON.stringify(access));
    const found = await creationRecords(userId);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    const record = found[0];
    assert.strictEqual(record.type, 'audit-log/account');
    assert.deepStrictEqual([...record.streamIds].sort(), ['access-' + access.id, 'action-account.created'].sort());
    assert.deepStrictEqual(record.content.record, { accessId: access.id, accessType: 'personal' });
    assert.strictEqual(record.content.source.name, 'registration');
    assert.deepStrictEqual(Object.keys(record.content.source).sort(), ['ip', 'name']);
    assert.ok(typeof record.content.source.ip === 'string' && record.content.source.ip.length > 0, JSON.stringify(record.content.source));
    // The same address, in the same form, as on the account's call rows.
    const callSource = await callSourceOf(userId, username, token, access.id);
    assert.strictEqual(record.content.source.ip, callSource.ip);
    assert.deepStrictEqual(Object.keys(record.content).sort(), ['action', 'record', 'source']);
    // (not the custom field: five random digits could occur in a timestamp or an id)
    assertNoneOf(record, [username, body.email, body.password, token, body.appId ?? body.appid, body.referer]);
    return { userId, username, token, access, record };
  }

  it('[AACR1] a registration (POST /users) writes one record in the new account\'s trail: its first access, the client address, nothing else', async function () {
    await assertSelfRegistration('/users', registrationBody(newName(), { referer: 'aacr-referer-' + cuid().slice(-8) }));
  });

  it('[AACR2] the same record for the /reg/users alias and the legacy /reg/user route', async function () {
    await assertSelfRegistration('/reg/users', registrationBody(newName()));
    const { appId: _a, ...legacy } = registrationBody(newName());
    await assertSelfRegistration('/reg/user', { ...legacy, appid: APP_ID });
  });

  it('[AACR3] system.createUser: source "system", never the address; the access only when one was made', async function () {
    const passwordHash = await require('utils').encryption.hash(PASSWORD);
    const create = async (extra = {}) => {
      const username = newName();
      const res = await coreRequest.post('/system/create-user').set('authorization', adminKey)
        .send({ username, passwordHash, email: username + '@aacr.example.com', language: 'en', ...extra });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const userId = await userIdOf(username);
      const found = await creationRecords(userId);
      assert.strictEqual(found.length, 1, JSON.stringify(found));
      assertNoneOf(found[0], [username, username + '@aacr.example.com', passwordHash, adminKey, extra.appId]);
      return { userId, record: found[0] };
    };

    const bare = await create();
    assert.deepStrictEqual(await personalAccesses(bare.userId), [], 'no access without an app id');
    assert.strictEqual(bare.record.type, 'audit-log/account');
    assert.deepStrictEqual(bare.record.streamIds, ['action-account.created']);
    assert.deepStrictEqual(bare.record.content.source, { name: 'system' });
    assert.deepStrictEqual(bare.record.content.record, {});

    const withApp = await create({ appId: APP_ID });
    const personal = await personalAccesses(withApp.userId);
    assert.strictEqual(personal.length, 1, JSON.stringify(personal));
    assert.deepStrictEqual([...withApp.record.streamIds].sort(), ['access-' + personal[0].id, 'action-account.created'].sort());
    assert.deepStrictEqual(withApp.record.content.source, { name: 'system' });
    assert.deepStrictEqual(withApp.record.content.record, { accessId: personal[0].id, accessType: 'personal' });
    assertNoneOf(withApp.record, [personal[0].token]);
  });

  it('[AACR4] delegations.createAccount: source "delegation", no address, no access, nothing naming the delegate', async function () {
    const parentName = newName();
    const parentToken = cuid();
    const parent = await fixtures.user(parentName);
    const parentAccess = await parent.access({ token: parentToken, type: 'personal' });
    await parent.session(parentToken);
    const kidName = newName();
    const res = await coreRequest.post('/' + parentName + '/delegations/controlled').set('Authorization', parentToken).send({ username: kidName });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const kidId = await userIdOf(kidName);
    const found = await creationRecords(kidId);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].type, 'audit-log/account');
    assert.deepStrictEqual(found[0].streamIds, ['action-account.created']);
    assert.deepStrictEqual(found[0].content.source, { name: 'delegation' });
    assert.deepStrictEqual(found[0].content.record, {});
    assertNoneOf(found[0], [kidName, parentName, parentToken, parentAccess.attrs.id, await userIdOf(parentName)]);
  });

  it('[AACR5] a refused registration writes no record and opens no audit storage for an id that is not an account', async function () {
    const opened = [];
    auditStorage.forUser = async function (userId) {
      opened.push(userId);
      return await originalForUser.call(auditStorage, userId);
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    // name taken: the account's own trail keeps its single record
    const taken = newName();
    assert.strictEqual((await register(taken)).status, 201);
    const takenId = await userIdOf(taken);
    const again = await register(taken);
    assert.ok(again.status >= 400 && again.status < 500, JSON.stringify(again.body));
    await settle();
    assert.strictEqual((await creationRecords(takenId)).length, 1);

    // invitation refused (by the configured list, or by the platform's own tokens)
    const invited = newName();
    const badInvitation = await withInjectedConfig({ invitationTokens: ['aacr-good-' + cuid()] },
      () => register(invited, { invitationToken: 'aacr-bad-' + cuid() }));
    assert.ok(badInvitation.status >= 400 && badInvitation.status < 500, JSON.stringify(badInvitation.body));
    await settle();

    // password rule
    const weak = newName();
    const badPassword = await withInjectedConfig({ auth: { passwordComplexityMinLength: 64 } }, () => register(weak));
    assert.ok(badPassword.status >= 400 && badPassword.status < 500, JSON.stringify(badPassword.body));
    await settle();

    for (const username of [invited, weak]) {
      assert.ok(!(await usersRepository.usernameExists(username)), username + ' exists');
    }
    for (const userId of opened) {
      assert.ok((await usersIndex.getUsername(userId)) != null, 'audit storage opened for ' + userId + ', not an account');
    }
  });

  it('[AACR6] a record that cannot be written changes nothing for the registration, and is counted once', async function () {
    const username = newName();
    const before = lossCounter.snapshot().lost.total;
    auditStorage.forUser = async () => { throw new Error('staged: no audit storage'); };
    let res;
    try {
      res = await register(username);
    } finally {
      auditStorage.forUser = originalForUser;
    }
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.apiEndpoint, JSON.stringify(res.body));
    const userId = await userIdOf(username);
    assert.ok(await usersRepository.usernameExists(username));
    assert.strictEqual(lossCounter.snapshot().lost.total, before + 1);
    assert.deepStrictEqual(await creationRecords(userId), []);
  });

  it('[AACR7] the storage filter selects it with "account.all", drops it from a list without it; audit off writes none', async function () {
    const withFilter = async (include, body) => {
      const restore = require('test-helpers').injectTestConfigSnapshot({ audit: { storage: { filter: { methods: { include, exclude: [] } } } } });
      try {
        await audit.reloadConfig();
        return await body();
      } finally {
        restore();
        await audit.reloadConfig();
      }
    };
    const recorded = async () => {
      const username = newName();
      const res = await register(username);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return (await creationRecords(await userIdOf(username))).length;
    };
    assert.strictEqual(await withFilter(['account.all'], recorded), 1, 'account.all');
    assert.strictEqual(await withFilter(['auth.login', 'accesses.created', 'account.update'], recorded), 0, 'a one-by-one list without it');
    assert.strictEqual(await withFilter(['auth.login', 'account.created'], recorded), 1, 'a list with it');
    assert.strictEqual(await withInjectedConfig({ audit: { active: false } }, recorded), 0, 'audit off');
  });

  it('[AACR8] the breach-scope report of the first access lists the creation and counts only the calls', async function () {
    const { localStorePrepareQuery, localStorePrepareOptions } = require('storage/src/localStoreEventQueries.ts');
    const { buildReport } = require('audit/src/breachScopeReport.ts');
    const username = newName();
    const res = await register(username);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const userId = await userIdOf(username);
    const token = tokenOf(res.body.apiEndpoint);
    const access = await accessOfToken(userId, token);
    for (let i = 0; i < 2; i++) {
      const call = await coreRequest.get('/' + username + '/access-info').set('Authorization', token);
      assert.strictEqual(call.status, 200, JSON.stringify(call.body));
    }
    const read = async () => {
      const db = await originalForUser.call(auditStorage, userId);
      const query = localStorePrepareQuery({ state: 'all', streams: [[{ any: ['access-' + access.id] }]], fromTime: 0, toTime: Date.now() / 1000 + 60 });
      return await db.getEvents({ query, options: localStorePrepareOptions({ sortAscending: true }) });
    };
    // the call rows are written after the answers
    const auditRows = await pollUntil(read, (list) => list.length >= 3, { timeoutMs: 5000 });
    const report = buildReport(auditRows, access, { accessId: access.id, type: 'personal' }, {
      generatedAt: new Date().toISOString(),
      toolName: 'test',
      toolVersion: '0',
      coreUrl: 'http://core.example',
      coreId: 'single',
      piiMode: 'cleartext',
      username,
      userId,
      accessIdAsPasted: access.id,
      baseAccessId: access.id,
      since: '',
      until: '',
      sinceTs: 0,
      untilTs: Date.now() / 1000 + 60,
      auditFilterConfig: { storage: null, syslog: null }
    });
    assert.strictEqual(report.activity.totalCalls, 2, JSON.stringify(report.activity));
    assert.deepStrictEqual(report.activity.byAction['account.created'], { valid: 1, error: 0 });
    assert.deepStrictEqual(report.activity.byAction.getAccessInfo, { valid: 2, error: 0 });
  });

  it('[AACR9] the audit summary counts the creation as a write of the first access', async function () {
    const startTime = Date.now() / 1000 - 60;
    const username = newName();
    const res = await register(username);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const userId = await userIdOf(username);
    const token = tokenOf(res.body.apiEndpoint);
    const access = await accessOfToken(userId, token);
    const summary = await coreRequest.get('/' + username + '/audit/summary').set('Authorization', token)
      .query({ fromTime: startTime, toTime: Date.now() / 1000 + 60, bucket: 'day', accessIds: [access.id] });
    assert.strictEqual(summary.status, 200, JSON.stringify(summary.body));
    const totals = { total: 0, reads: 0, writes: 0, session: 0, other: 0, errors: 0 };
    for (const b of summary.body.summary.buckets) for (const k of Object.keys(totals)) totals[k] += b[k];
    // Nothing but the creation is in the trail before this first call.
    assert.deepStrictEqual(totals, { total: 1, reads: 0, writes: 1, session: 0, other: 0, errors: 0 }, JSON.stringify(totals));
  });

  it('[AACRC] a registration sent to another core is recorded there, not on the landing core', async function () {
    const { recordAccountCreatedStep } = require('api-server/src/methods/helpers/accountCreationAudit.ts');
    const fixtureName = newName();
    await fixtures.user(fixtureName);
    const fixtureId = await userIdOf(fixtureName);
    const step = recordAccountCreatedStep('registration');
    for (const result of [{ forwarded: true }, { redirect: 'https://other.example.com/' }]) {
      let nexted = false;
      await step({ newUser: { id: fixtureId, accessId: 'x' }, source: { ip: '203.0.113.7' } }, {}, result, () => { nexted = true; });
      assert.ok(nexted);
    }
    assert.deepStrictEqual(await creationRecords(fixtureId), [], 'nothing on the landing core');
  });

  it('[AACRD] a forwarded registration created here records the client address the landing core signed', async function () {
    const { REGISTRATION_FORWARD_HEADER, signRegistrationForward } = require('business/src/auth/registrationForward.ts');
    const username = newName();
    const body = JSON.stringify(registrationBody(username));
    const client = '203.0.113.' + (Math.floor(Math.random() * 200) + 1);
    const res = await coreRequest.post('/users')
      .set('content-type', 'application/json')
      .set(REGISTRATION_FORWARD_HEADER, signRegistrationForward(adminKey, 'aacr-landing-core', client, body))
      .send(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const found = await creationRecords(await userIdOf(username));
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(found[0].content.source, { name: 'registration', ip: client });
  });

  it('[AACRE] a forwarded registration whose landing core knew no client address records none (never the other core\'s)', async function () {
    const { REGISTRATION_FORWARD_HEADER, signRegistrationForward } = require('business/src/auth/registrationForward.ts');
    const username = newName();
    const body = JSON.stringify(registrationBody(username));
    const res = await coreRequest.post('/users')
      .set('content-type', 'application/json')
      .set(REGISTRATION_FORWARD_HEADER, signRegistrationForward(adminKey, 'aacr-landing-core', '', body))
      .send(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const found = await creationRecords(await userIdOf(username));
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(found[0].content.source, { name: 'registration' });
  });
});
