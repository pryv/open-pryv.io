/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [AUG] per-access usage for the account owner: a personal caller reads each
 * access's approximate lifetime call counts as `usage` on accesses.get (its
 * deletion records included) and on the accesses.getOne head; app and shared
 * callers never do; nothing is reported with access tracking off.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const validation = require('./helpers/validation');
const methodsSchema = require('../src/schema/accessesMethods.ts');
const { withInjectedConfig } = require('test-helpers');
const { getStorageLayer } = require('storage');
const { integrity } = require('business');
const { ALL_METHODS } = require('audit/src/ApiMethods.ts');
const { classifyMethod, usageFromCalls } = require('business/src/accesses/methodClasses.ts');

const USAGE_KEYS = ['byMethod', 'other', 'reads', 'session', 'total', 'writes'];

// The shared fixture: the account app pins the same table.
const SHARED_FIXTURE = {
  'events.get': 'read',
  'events.getOne': 'read',
  'events.getAttachment': 'read',
  'streams.get': 'read',
  'accesses.checkApp': 'read',
  'service.info': 'read',
  'account.usernameChanges': 'read',
  'delegations.listControlled': 'read',
  'sharedSecrets.retrieve': 'read',
  getAccessInfo: 'read',
  'events.create': 'write',
  'events.update': 'write',
  'events.deleteAttachment': 'write',
  'accesses.delete': 'write',
  'account.changePassword': 'write',
  'account.externalIds.claim': 'write',
  'delegations.acceptAttach': 'write',
  'webhooks.test': 'write',
  'account.requestPasswordReset': 'write',
  'account.transferClaim': 'write',
  'auth.login': 'session',
  'auth.logout': 'session',
  'mfa.verify': 'session',
  'auth.hostings': 'session',
  callBatch: 'batch'
};

describe('[AUG] accesses usage for the owner', function () {
  this.timeout(30000);

  let username, personalToken, appToken, sharedToken, fixtureUser, appAccess, streamId, storageLayer;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await getStorageLayer();
    username = ('aug' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    personalToken = cuid();
    appToken = cuid();
    sharedToken = cuid();
    fixtureUser = await getNewFixture().user(username);
    streamId = 'augs_' + username;
    await fixtureUser.stream({ id: streamId, name: 'AUG stream' });
    await fixtureUser.access({ type: 'personal', token: personalToken });
    await fixtureUser.session(personalToken);
    appAccess = await fixtureUser.access({
      type: 'app',
      name: 'aug-app',
      token: appToken,
      permissions: [{ streamId, level: 'manage' }]
    });
    await fixtureUser.access({
      type: 'shared',
      name: 'aug-shared',
      token: sharedToken,
      permissions: [{ streamId, level: 'read' }]
    });
  });

  function getAccesses (token, query = {}) {
    return coreRequest.get('/' + username + '/accesses').query(query).set('Authorization', token);
  }

  async function usageOf (accessId) {
    const res = await getAccesses(personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses.find((a) => a.id === accessId)?.usage;
  }

  // The storage update the per-call tracker makes after a direct call.
  function countDirectCalls (accessId, storedKey, n) {
    return new Promise((resolve, reject) => storageLayer.accesses.updateOne(
      { id: fixtureUser.attrs.id, username }, { id: accessId },
      { lastUsed: Date.now() / 1000, $inc: { ['calls.' + storedKey]: n } },
      (err) => (err ? reject(err) : resolve())));
  }

  // The counters are written after the reply: wait until they show.
  async function waitForUsage (accessId, predicate) {
    let usage;
    for (let i = 0; i < 40; i++) {
      usage = await usageOf(accessId);
      if (usage != null && predicate(usage)) return usage;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return usage;
  }

  it('[AUG1] a personal caller gets `usage` on every access, and the body validates', async function () {
    const res = await getAccesses(personalToken);
    validation.check(res, { status: 200, schema: methodsSchema.get.result });
    assert.ok(res.body.accesses.length >= 3);
    for (const a of res.body.accesses) {
      assert.deepEqual(Object.keys(a.usage).sort(), USAGE_KEYS, 'usage keys of ' + a.name);
      assert.equal(a.calls, undefined, 'raw counters never on the wire');
      // `usage` changes with every call: it is not part of the integrity.
      if (integrity.accesses.isActive && a.integrity != null) {
        assert.equal(integrity.accesses.hash(a), a.integrity, 'integrity of ' + a.name);
      }
    }
  });

  it('[AUG2] seeded direct counters plus a real batch are reported per method and by class; a batch counts its inner calls, not itself', async function () {
    // Two direct calls, as the tracker records them (the in-process test core
    // does not register the per-call tracker; a batch flushes its own stats).
    await countDirectCalls(appAccess.attrs.id, 'events:get', 2);
    const batch = await coreRequest.post('/' + username).set('Authorization', appToken).send([
      { method: 'events.get', params: {} },
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: 'aug' } },
      { method: 'streams.get', params: {} }
    ]);
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const usage = await waitForUsage(appAccess.attrs.id, (u) => u.total >= 5);
    assert.equal(usage.byMethod['events.get'], 3, JSON.stringify(usage));
    assert.equal(usage.byMethod['events.create'], 1);
    assert.equal(usage.byMethod['streams.get'], 1);
    assert.equal(usage.byMethod.callBatch, undefined, 'the batch envelope is not counted');
    assert.equal(usage.reads, 4);
    assert.equal(usage.writes, 1);
    assert.equal(usage.total, 5);
    assert.equal(usage.session + usage.other, 0);
  });

  it('[AUG3] app and shared callers never receive `usage`', async function () {
    const asApp = await getAccesses(appToken);
    assert.equal(asApp.status, 200, JSON.stringify(asApp.body));
    for (const a of asApp.body.accesses) assert.equal(a.usage, undefined, 'app caller, ' + a.name);
    const created = await coreRequest.post('/' + username + '/accesses').set('Authorization', appToken)
      .send({ type: 'shared', name: 'aug-child-' + cuid().slice(-6), permissions: [{ streamId, level: 'read' }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.access.usage, undefined);
    const again = await getAccesses(appToken);
    const child = again.body.accesses.find((a) => a.id === created.body.access.id);
    assert.ok(child != null, 'the app lists the access it created');
    assert.equal(child.usage, undefined);
    const one = await coreRequest.get('/' + username + '/accesses/' + created.body.access.id).set('Authorization', appToken);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.access.usage, undefined);
    // A shared access may not read accesses at all: no list, no usage.
    const asShared = await getAccesses(sharedToken);
    assert.equal(asShared.status, 403, JSON.stringify(asShared.body));
    const oneShared = await coreRequest.get('/' + username + '/accesses/' + created.body.access.id).set('Authorization', sharedToken);
    assert.equal(oneShared.status, 403, JSON.stringify(oneShared.body));
  });

  it('[AUG4] a deletion record carries the counters of the revoked access', async function () {
    // Created by the app, so the app lists its deletion record too.
    const created = await coreRequest.post('/' + username + '/accesses').set('Authorization', appToken)
      .send({ type: 'shared', name: 'aug-revoked-' + cuid().slice(-6), permissions: [{ streamId, level: 'read' }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const victimId = created.body.access.id;
    await countDirectCalls(victimId, 'events:get', 1);
    const del = await coreRequest.delete('/' + username + '/accesses/' + victimId).set('Authorization', personalToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const res = await getAccesses(personalToken, { includeDeletions: true });
    validation.check(res, { status: 200, schema: methodsSchema.get.result });
    const record = res.body.accessDeletions.find((d) => d.id === victimId);
    assert.ok(record != null, 'deletion record listed');
    assert.ok(record.usage != null, 'deletion record carries usage');
    assert.equal(record.usage.byMethod['events.get'], 1);
    assert.equal(record.calls, undefined);
    const asApp = await getAccesses(appToken, { includeDeletions: true });
    assert.equal(asApp.status, 200, JSON.stringify(asApp.body));
    const appRecord = (asApp.body.accessDeletions || []).find((d) => d.id === victimId);
    assert.ok(appRecord != null, 'the app lists the deletion record of the access it created');
    assert.equal(appRecord.usage, undefined, 'no usage for the app');
    assert.equal(appRecord.calls, undefined);
  });

  it('[AUG5] accesses.getOne: the head carries `usage`, history snapshots do not', async function () {
    const token = cuid();
    const target = await fixtureUser.access({ type: 'app', name: 'aug-versioned-' + cuid().slice(-6), token, permissions: [{ streamId, level: 'read' }] });
    await countDirectCalls(target.attrs.id, 'events:get', 5);
    const upd = await coreRequest.put('/' + username + '/accesses/' + target.attrs.id).set('Authorization', personalToken)
      .send({ clientData: { note: 'aug5' } });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const res = await coreRequest.get('/' + username + '/accesses/' + target.attrs.id)
      .query({ includeHistory: true }).set('Authorization', personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Schema only: an updated access's integrity is checked elsewhere.
    validation.checkSchema(res.body, methodsSchema.getOne.result);
    assert.ok(res.body.access.usage != null, 'head carries usage');
    assert.equal(res.body.access.usage.total, 5, 'counters kept across an update');
    assert.ok(Array.isArray(res.body.history) && res.body.history.length >= 1, 'history listed');
    for (const h of res.body.history) {
      assert.equal(h.usage, undefined, 'no usage on a snapshot');
      assert.equal(h.calls, undefined, 'no raw counters on a snapshot');
    }
  });

  it('[AUG6] with access tracking off, no `usage` is reported', async function () {
    await withInjectedConfig({ accessTracking: { isActive: false } }, async () => {
      const res = await getAccesses(personalToken, { includeDeletions: true });
      validation.check(res, { status: 200, schema: methodsSchema.get.result });
      for (const a of res.body.accesses) assert.equal(a.usage, undefined);
      for (const d of res.body.accessDeletions || []) assert.equal(d.usage, undefined);
    });
  });

  it('[AUG7] a method id with several dots comes back under its dotted id', function () {
    const usage = usageFromCalls({ 'account:externalIds:list': 2, 'events:get': 1, callBatch: 4 });
    assert.deepEqual(usage.byMethod, { 'account.externalIds.list': 2, 'events.get': 1 });
    assert.equal(usage.reads, 3);
    assert.equal(usage.total, 3);
  });

  it('[AUGS] a stored counter of a method no longer registered is reported under `other`', async function () {
    const token = cuid();
    const acc = await fixtureUser.access({ type: 'app', name: 'aug-retired-' + cuid().slice(-6), token, permissions: [{ streamId, level: 'read' }] });
    await countDirectCalls(acc.attrs.id, 'retired:method', 3);
    const usage = await usageOf(acc.attrs.id);
    assert.equal(usage.byMethod['retired.method'], 3);
    assert.equal(usage.other, 3);
  });

  it('[AUG8] every declared method classifies, none falls to `other`', function () {
    const others = ALL_METHODS.filter((m) => classifyMethod(m) === 'other');
    assert.deepEqual(others, [], 'classify these on purpose: ' + others.join(', '));
  });

  it('[AUGC] the shared method-class fixture', function () {
    for (const [methodId, expected] of Object.entries(SHARED_FIXTURE)) {
      assert.equal(classifyMethod(methodId), expected, methodId);
    }
  });
});
