/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ADMO] OAuth client and publisher review over HTTP: the lists, the reads
 * and the acts (approve with the digest seen, unvalidate, suspend, resume, a
 * publisher decision), the region rule on every route (reads included) over
 * the caller's replicated grants, local grants giving nothing, the admin key
 * in scope full only, no secret in any answer, and the records in the
 * platform trail, the actor's trail and the owner's or publisher's trail.
 */

const { withInjectedConfig } = require('test-helpers');
const setup = require('business/src/admin/setupState.ts');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const { KEYS } = require('business/src/admin/store.ts');
const storage = require('oauth2/src/storage.ts');
const cv = require('oauth2/src/clientValidation.ts');
const { persistClient, persistDeveloperClient } = require('oauth2/src/clientRegistry.ts');
const { PLATFORM_TRAIL_USER_ID } = require('storages/interfaces/auditStorage/AuditStorage.ts');
const timestamp = require('unix-timestamp');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const PASSWORD = 'admo-password-123';
const MIN = 60 * 1000;
const REDIRECT = 'https://app.admo.test/cb';
const AUD = 'https://resource.admo.test/x';
// Two regions; this core's hosting is in neither (a region grant of OAuth
// review counts on every core: the registries are platform-wide).
const HOSTINGS = {
  regions: {
    eu: { zones: { 'eu-z': { hostings: { 'h-eu': {} } } } },
    us: { zones: { 'us-z': { hostings: { 'h-us': {} } } } }
  }
};

describe('[ADMO] OAuth client and publisher review over HTTP', function () {
  this.timeout(60000);

  let db, adminKey, coreId, audit, auditStorage, usersRepository;
  const usedUsers = [];
  const ids = {
    eu: 'Admo.eu.' + cuid().slice(-8),
    us: 'Admo.us.' + cuid().slice(-8),
    both: 'Admo.eus.' + cuid().slice(-8),
    all: 'Admo.all.' + cuid().slice(-8),
    op: 'Admo.op.' + cuid().slice(-8)
  };
  const publishers = [];

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.setup.getStatus')) await require('api-server/src/methods/systemAdmin.ts').default(app.systemAPI);
    if (!app.systemAPI.has('system.oauthClients.list')) await require('api-server/src/methods/systemAdminOauth.ts').default(app.systemAPI);
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
    await setup.recordLegacyReady(db, { coreId, now: Date.now() });
  }

  afterEach(resetAdmin);

  after(async () => {
    await db.deletePlatformKv(KEYS.setupState);
    for (const { key } of await db.listPlatformKvEntries(KEYS.rolePrefix)) await db.deletePlatformKv(key);
    for (const id of Object.values(ids)) {
      try { await storage.deleteClient(db, id); } catch (_e) { /* best-effort */ }
    }
    for (const u of publishers) await db.deletePlatformKv('dev-publisher/' + u);
    for (const id of usedUsers) {
      try { await usersRepository.deleteOne(id); } catch (_e) { /* best-effort */ }
    }
  });

  async function freshUser () {
    const username = ('admo' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD });
    usedUsers.push(fu.attrs.id);
    return { username, userId: fu.attrs.id };
  }

  /** A session of an account holding `grants` ([role, scope]). */
  async function sessionOf (userId, grants) {
    const now = Date.now();
    for (const [role, scope] of grants) await roles.grantRole(db, userId, { role, scope, grantedBy: 'test', via: 'grant', now });
    return (await sessions.createAdminSession(db, { userId, homeCore: coreId, mfaAt: now, now: now + 1, ttlMs: 60 * MIN })).token;
  }

  const asSession = (token) => ({ authorization: 'AdminSession ' + token });
  const asKey = () => ({ authorization: adminKey });
  const get = (path, auth) => coreRequest.get('/system/admin/oauth' + path).set(auth);
  const post = (path, body, auth) => body == null
    ? coreRequest.post('/system/admin/oauth' + path).set(auth)
    : coreRequest.post('/system/admin/oauth' + path).set(auth).send(body);
  const put = (path, body, auth) => coreRequest.put('/system/admin/oauth' + path).set(auth).send(body);
  const inHostings = (fn) => withInjectedConfig({ hostings: HOSTINGS }, fn);

  const row = (extra = {}) => ({
    kind: 'registry',
    redirectUris: [REDIRECT],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
    allowedAudiences: [AUD],
    subjectType: 'public',
    scope: ['read/a'],
    clientName: 'Admo app',
    ...extra
  });

  async function seedClients (owner) {
    // Each test starts from fresh rows (a developer row keeps its owner).
    for (const id of Object.values(ids)) await storage.deleteClient(db, id);
    await persistDeveloperClient(db, owner, row({ clientId: ids.eu, regions: ['eu'] }));
    await persistDeveloperClient(db, owner, row({ clientId: ids.us, regions: ['us'] }));
    await persistDeveloperClient(db, owner, row({ clientId: ids.both, regions: ['eu', 'us'] }));
    await persistDeveloperClient(db, owner, row({ clientId: ids.all }));
    await persistClient(db, row({ clientId: ids.op, tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: 'scrypt$not-a-real-hash' }));
  }

  /** Records of `methodId` (or an action) in a trail since `since` (seconds). */
  async function trail (userId, action, since, atLeast = 1) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const store = await auditStorage.forUser(userId);
      const rows = (await store.getEvents({ query: [{ type: 'streamsQuery', content: [[{ any: ['action-' + action] }]] }] }))
        .filter((e) => e.time >= since);
      if (rows.length >= atLeast || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('[ADMO1] admin key: list and queue, a client as `show` prints it without secret hash, approve with the digest seen (409 when stale, nothing written), recorded in the platform and owner trails', async () => {
    const owner = await freshUser();
    await seedClients(owner.userId);
    const list = await get('/clients', asKey());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const mine = list.body.clients.filter((c) => Object.values(ids).includes(c.clientId));
    assert.equal(mine.length, 5);
    const queue = await get('/clients?queue=true&origin=developer', asKey());
    assert.deepEqual(queue.body.clients.filter((c) => Object.values(ids).includes(c.clientId)).map((c) => c.clientId).sort(),
      [ids.all, ids.both, ids.eu, ids.us].sort(), 'developer clients not reviewed');
    assert.equal((await get('/clients?queue=maybe', asKey())).status, 400);
    assert.equal((await get('/clients?origin=martian', asKey())).status, 400);
    assert.equal((await get('/clients?bogus=1', asKey())).status, 400);
    // Paging: without limit every row; limit / skip cut the same order.
    const allIds = list.body.clients.map((c) => c.clientId);
    const paged = await get('/clients?limit=2&skip=1', asKey());
    assert.deepEqual(paged.body.clients.map((c) => c.clientId), allIds.slice(1, 3));
    assert.equal((await get('/clients?limit=0', asKey())).status, 400);
    assert.equal((await get('/clients?skip=-1', asKey())).status, 400);

    const op = await get('/clients/' + ids.op, asKey());
    assert.equal(op.status, 200, JSON.stringify(op.body));
    assert.equal(op.body.client.clientSecretHash, '(set)');
    assert.ok(!JSON.stringify(op.body).includes('scrypt$'), 'no secret hash in the answer');
    assert.deepEqual([op.body.validation.level, op.body.inQueue], ['appValidated', false]);
    const one = await get('/clients/' + ids.eu, asKey());
    assert.deepEqual([one.body.validation.level, one.body.reviewStands, one.body.inQueue], ['nonValidated', false, true]);
    assert.equal(one.body.digest, cv.validationDigest(await storage.getClient(db, ids.eu)));
    assert.equal((await get('/clients/Admo-nobody', asKey())).status, 404);

    // Changed since the reviewer saw it: refused, unchanged.
    const stale = await post('/clients/' + ids.eu + '/approve', { digest: 'x'.repeat(43) }, asKey());
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.ok(!JSON.stringify(stale.body).includes(one.body.digest), 'the current digest is not handed back: the reviewer reads the client again');
    assert.equal((await storage.getClient(db, ids.eu)).validation, undefined);
    assert.equal((await post('/clients/' + ids.eu + '/approve', {}, asKey())).status, 400, 'digest required');
    assert.equal((await post('/clients/' + ids.eu + '/approve', { digest: one.body.digest, grade: 'A' }, asKey())).status, 400, 'unknown parameter');
    assert.equal((await post('/clients/' + ids.op + '/approve', { digest: op.body.digest }, asKey())).status, 400, 'an operator client: nothing to approve');

    const since = timestamp.now();
    const ok = await post('/clients/' + ids.eu + '/approve', { digest: one.body.digest, reason: 'reviewed the policy' }, asKey());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.validation.level, ok.body.reviewStands, ok.body.inQueue, ok.body.changed], ['appValidated', true, false, true]);
    const last = ok.body.client.statusLog.at(-1);
    assert.deepEqual([last.by, last.reason, last.note], ['admin-key', 'validate', 'reviewed the policy']);
    assert.equal(ok.body.client.validation.app.by, 'admin-key');
    if (audit != null) {
      // (The refusals above may fall in the same second: the record of the act done.)
      const rec = (await trail(PLATFORM_TRAIL_USER_ID, 'system.oauthClients.approve', since))
        .find((e) => e.content.record.target?.clientId === ids.eu && e.content.record.diff != null);
      assert.ok(rec != null, 'in the platform trail');
      assert.deepEqual(rec.content.record.subject, { via: 'admin-key' });
      assert.deepEqual(rec.content.record.target, { clientId: ids.eu });
      assert.deepEqual([rec.content.record.diff.from.level, rec.content.record.diff.to.level, rec.content.record.diff.digest], ['nonValidated', 'appValidated', one.body.digest]);
      const [own] = await trail(owner.userId, 'oauth.client.reviewed', since);
      assert.ok(own != null, 'in the owner\'s trail');
      assert.deepEqual([own.content.record.clientId, own.content.record.act, own.content.record.by, own.content.record.reason],
        [ids.eu, 'approve', 'platform-administrator', 'reviewed the policy']);
      assert.equal(own.content.record.digest, undefined);
    }
    // Under break-glass the key reaches none of them.
    await withInjectedConfig({ auth: { adminAccessKeyScope: 'break-glass' } }, async () => {
      assert.equal((await get('/clients', asKey())).status, 404);
      assert.equal((await post('/clients/' + ids.eu + '/suspend', { reason: 'x' }, asKey())).status, 404);
    });
  });

  it('[ADMO2] region rule on every route: a region:eu reviewer reads and acts on eu clients only; regionless or multi-region clients need platform; local grants and core scopes give nothing', async () => {
    const owner = await freshUser();
    await seedClients(owner.userId);
    await inHostings(async () => {
      const eu = await freshUser();
      const euToken = await sessionOf(eu.userId, [['app-reviewer', 'region:eu']]);
      const listed = (await get('/clients', asSession(euToken))).body.clients.map((c) => c.clientId).filter((id) => Object.values(ids).includes(id));
      assert.deepEqual(listed, [ids.eu], 'the list keeps to its region');
      assert.equal((await get('/clients/' + ids.eu, asSession(euToken))).status, 200);
      for (const id of [ids.us, ids.both, ids.all, ids.op]) {
        assert.equal((await get('/clients/' + id, asSession(euToken))).status, 404, 'read ' + id);
        assert.equal((await post('/clients/' + id + '/suspend', { reason: 'out of reach' }, asSession(euToken))).status, 404, 'suspend ' + id);
        assert.equal((await post('/clients/' + id + '/approve', { digest: 'x'.repeat(43) }, asSession(euToken))).status, 404, 'approve ' + id);
        assert.equal((await post('/clients/' + id + '/unvalidate', { reason: 'out of reach' }, asSession(euToken))).status, 404, 'unvalidate ' + id);
        assert.equal((await post('/clients/' + id + '/resume', null, asSession(euToken))).status, 404, 'resume ' + id);
      }
      assert.equal((await storage.getClient(db, ids.us)).status, undefined, 'nothing written out of reach');
      const s = await post('/clients/' + ids.eu + '/suspend', { reason: 'abuse report' }, asSession(euToken));
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.deepEqual([s.body.client.status, s.body.client.statusLog.at(-1).by, s.body.client.statusLog.at(-1).note], ['suspended', eu.userId, 'abuse report']);
      assert.equal((await post('/clients/' + ids.eu + '/suspend', {}, asSession(euToken))).status, 400, 'reason required');
      const r = await post('/clients/' + ids.eu + '/resume', null, asSession(euToken));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.client.status, 'active');

      // A reader at region:eu (viewer) reads its region, may not act (the gate).
      const viewer = await freshUser();
      const viewerToken = await sessionOf(viewer.userId, [['viewer', 'region:eu']]);
      assert.equal((await get('/clients/' + ids.eu, asSession(viewerToken))).status, 200);
      assert.equal((await post('/clients/' + ids.eu + '/suspend', { reason: 'x' }, asSession(viewerToken))).status, 404);

      // A reviewer at a core scope holds no review permission; nor does a local grant.
      const local = await freshUser();
      const localToken = await sessionOf(local.userId, [['viewer', 'core:' + coreId]]);
      await withInjectedConfig({ admin: { localPolicy: { localGrants: [{ userId: local.userId, role: 'app-reviewer' }] } } }, async () => {
        assert.equal((await get('/clients', asSession(localToken))).status, 404);
        assert.equal((await post('/clients/' + ids.eu + '/suspend', { reason: 'x' }, asSession(localToken))).status, 404);
      });

      // The platform scope reaches every client.
      const plat = await freshUser();
      const platToken = await sessionOf(plat.userId, [['app-reviewer', 'platform']]);
      const all = (await get('/clients', asSession(platToken))).body.clients.map((c) => c.clientId).filter((id) => Object.values(ids).includes(id));
      assert.equal(all.length, 5);
      const both = await get('/clients/' + ids.both, asSession(platToken));
      const since = timestamp.now();
      const a = await post('/clients/' + ids.both + '/approve', { digest: both.body.digest }, asSession(platToken));
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(a.body.client.validation.app.by, plat.userId);
      if (audit != null) {
        // The owner's own trail never names the reviewing account.
        const [own] = await trail(owner.userId, 'oauth.client.reviewed', since);
        assert.ok(own != null, 'in the owner\'s trail');
        assert.ok(!JSON.stringify(own.content).includes(plat.userId), JSON.stringify(own.content));
        assert.equal(own.content.record.by, 'platform-administrator');
      }
      // Unvalidate: back to the queue.
      const u = await post('/clients/' + ids.both + '/unvalidate', { reason: 'policy page gone' }, asSession(platToken));
      assert.deepEqual([u.status, u.body.validation.level, u.body.inQueue, u.body.client.statusLog.at(-1).reason], [200, 'nonValidated', true, 'unvalidate']);
    });
  });

  it('[ADMO3] a client under review: resume refused, approve sets it active with its app review; publishers: decisions with their trail, the region rule, the badge follows', async () => {
    const owner = await freshUser();
    publishers.push(owner.userId);
    await seedClients(owner.userId);
    const held = await storage.getClient(db, ids.us);
    await storage.setClient(db, { ...held, status: 'review', statusLog: [{ at: 1, by: 'cli:op', from: 'active', to: 'review', reason: 'review', fields: ['redirectUris'] }] });
    const resume = await post('/clients/' + ids.us + '/resume', null, asKey());
    assert.equal(resume.status, 400, JSON.stringify(resume.body));
    const shown = await get('/clients/' + ids.us, asKey());
    assert.equal(shown.body.inQueue, true);
    const approved = await post('/clients/' + ids.us + '/approve', { digest: shown.body.digest }, asKey());
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual([approved.body.client.status, approved.body.validation.level], ['active', 'appValidated']);
    assert.deepEqual(approved.body.client.statusLog.slice(1).map((e) => e.reason), ['approve', 'validate']);

    await inHostings(async () => {
      const eu = await freshUser();
      const euToken = await sessionOf(eu.userId, [['app-reviewer', 'region:eu']]);
      // A regional reviewer cannot create a publisher row (it counts for every
      // client of the account on every core), whatever regions it names: 404, nothing written.
      for (const body of [
        { status: 'validated', reason: 'KYC' },
        { status: 'validated', displayName: 'Trusted Co', regions: ['eu'], reason: 'KYC' },
        { status: 'great', regions: ['eu'], reason: 'KYC' }
      ]) {
        assert.equal((await put('/publishers/' + owner.userId, body, asSession(euToken))).status, 404, JSON.stringify(body));
      }
      assert.equal(await cv.readPublisher(db, owner.userId), null, 'nothing written');
      assert.equal((await get('/clients/' + ids.all, asKey())).body.validation.level, 'nonValidated', 'no effect on its clients');
      // A platform reviewer creates it and assigns it to eu; the eu reviewer then decides it.
      const plat = await freshUser();
      const platToken = await sessionOf(plat.userId, [['app-reviewer', 'platform']]);
      const created = await put('/publishers/' + owner.userId, { status: 'pending', regions: ['eu'], reason: 'request received' }, asSession(platToken));
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const since = timestamp.now();
      const set = await put('/publishers/' + owner.userId, { status: 'validated', displayName: 'Admo Co', reason: 'KYC done' }, asSession(euToken));
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual([set.body.publisher.status, set.body.publisher.displayName, set.body.publisher.regions], ['validated', 'Admo Co', ['eu']]);
      assert.deepEqual(set.body.publisher.statusLog.map((e) => [e.by, e.from, e.to, e.reason]),
        [[plat.userId, 'absent', 'pending', 'request received'], [eu.userId, 'pending', 'validated', 'KYC done']]);
      assert.equal((await put('/publishers/' + owner.userId, { status: 'validated', regions: ['us'], reason: 'KYC' }, asSession(euToken))).status, 400, 'not left in a region out of reach');
      // The badge of its apps follows (an unreviewed one becomes Publisher Validated).
      assert.deepEqual((await get('/clients/' + ids.all, asKey())).body.validation, { level: 'publisherValidated', publisher: { name: 'Admo Co', validated: true } });
      assert.equal((await get('/publishers/' + owner.userId, asSession(euToken))).status, 200);
      assert.ok((await get('/publishers', asSession(euToken))).body.publishers.some((p) => p.userId === owner.userId));
      if (audit != null) {
        const rec = (await trail(PLATFORM_TRAIL_USER_ID, 'system.publishers.set', since)).find((e) => e.content.record.diff != null);
        assert.deepEqual(rec.content.record.target, { publisherUserId: owner.userId });
        assert.deepEqual([rec.content.record.diff.from.status, rec.content.record.diff.to.status], ['pending', 'validated']);
        const owns = await trail(owner.userId, 'oauth.publisher.reviewed', since);
        const own = owns.find((e) => e.content.record.to?.status === 'validated');
        assert.ok(own != null, 'in the publisher\'s trail');
        assert.deepEqual([own.content.record.by, own.content.record.reason], ['platform-administrator', 'KYC done']);
        assert.ok(!JSON.stringify(own.content).includes(eu.userId), 'never the reviewing account');
        const [act] = await trail(eu.userId, 'admin.act', since);
        assert.equal(act.content.record.methodId, 'system.publishers.set');
      }
      // A us reviewer does not see it, nor decide about it.
      const us = await freshUser();
      const usToken = await sessionOf(us.userId, [['app-reviewer', 'region:us']]);
      assert.equal((await get('/publishers/' + owner.userId, asSession(usToken))).status, 404);
      assert.ok(!(await get('/publishers', asSession(usToken))).body.publishers.some((p) => p.userId === owner.userId));
      assert.equal((await put('/publishers/' + owner.userId, { status: 'suspended', regions: ['us'], reason: 'x' }, asSession(usToken))).status, 404);
      // The eu reviewer may not widen it to every region; suspending keeps name and regions.
      assert.equal((await put('/publishers/' + owner.userId, { status: 'validated', regions: null, reason: 'x' }, asSession(euToken))).status, 400);
      const sus = await put('/publishers/' + owner.userId, { status: 'suspended', reason: 'complaints' }, asSession(euToken));
      assert.deepEqual([sus.status, sus.body.publisher.displayName, sus.body.publisher.regions, sus.body.publisher.statusLog.length], [200, 'Admo Co', ['eu'], 3]);
      assert.equal((await get('/clients/' + ids.all, asKey())).body.validation.level, 'nonValidated');
      assert.equal((await put('/publishers/bad%2Fid', { status: 'validated', reason: 'x' }, asKey())).status, 400);
      assert.equal((await put('/publishers/' + owner.userId, { status: 'great', reason: 'x' }, asKey())).status, 400);
      assert.equal((await put('/publishers/' + owner.userId, { status: 'validated' }, asKey())).status, 400, 'reason required');
    });
  });
});
