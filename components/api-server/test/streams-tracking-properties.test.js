/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { getMall } from 'mall';
import ds from '@pryv/datastore';
import { getUsersRepository } from 'business/src/users/index.ts';
import * as container from 'business/src/emails/container.ts';
import * as cmc from 'cmc';
import * as delegation from 'delegation';
import * as sharedSecrets from 'shared-secrets';
import * as validation from './helpers/validation.js';
import * as methodsSchema from '../src/schema/streamsMethods.ts';

/**
 * Streams the server creates itself (the cross-account messaging namespace,
 * the emails container, ...) carry the tracking properties the published
 * stream schema requires (`created`, `createdBy`, `modified`, `modifiedBy`),
 * and streams stored without them (written before the server stamped them)
 * read with the datastore "unknown" defaults.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const dataStoreDefaults = ds.defaults;

const TRACKING = ['created', 'createdBy', 'modified', 'modifiedBy'];

function findInTree (streams, id) {
  for (const s of streams || []) {
    if (s.id === id) return s;
    const found = findInTree(s.children, id);
    if (found != null) return found;
  }
  return null;
}

describe('[STRK] stream tracking properties', function () {
  this.timeout(60_000);

  let mall, user, username, userId, personal, personalAccessId, basePath;
  const silentLogger = { info () {}, warn () {}, debug () {}, error () {} };

  before(async function () {
    await initTests();
    await initCore();
    const fixtures = getNewFixture();
    mall = await getMall();
    username = 'strk' + cuid().toLowerCase().slice(-10);
    personal = cuid();
    basePath = '/' + username + '/streams';
    user = await fixtures.user(username, { email: cuid() + '@strk.example.com' });
    personalAccessId = cuid();
    await user.access({ id: personalAccessId, token: personal, type: 'personal' });
    await user.session(personal);
    userId = await (await getUsersRepository()).getUserIdForUsername(username);
    // Server-side provisioning, as at registration (idempotent).
    await cmc.provisionUserStreams({ mall, userId, logger: silentLogger });
    await container.ensureContainerStream(userId);
  });

  const get = (query) => coreRequest.get(basePath).set('Authorization', personal).query(query);

  it('[STRK1] server-provisioned streams carry the tracking properties and pass the published schema', async function () {
    const before = Date.now() / 1000 - 3600;
    const res = await get({});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    validation.checkSchema(res.body, methodsSchema.get.result);
    // Hidden subtrees (store roots) and the provisioned parents are read through parentId too.
    const toOpen = [':_cmc:', ':_cmc:_internal', ':_emails:'];
    const collect = (streams) => {
      for (const s of streams || []) {
        if (s.childrenHidden === true) toOpen.push(s.id);
        collect(s.children);
      }
    };
    collect(res.body.streams);
    const opened = new Map();
    while (toOpen.length > 0) {
      const parentId = toOpen.shift();
      // `:faulty:` is the test store that fails every call.
      if (opened.has(parentId) || parentId === ':faulty:') continue;
      const sub = await get({ parentId });
      opened.set(parentId, sub);
      if (sub.status !== 200) continue;
      assert.doesNotThrow(() => validation.checkSchema(sub.body, methodsSchema.get.result), parentId);
      collect(sub.body.streams);
    }
    // Every subtree opened, none skipped; the provisioned parents hold their children.
    const notOk = [...opened].filter(([, r]) => r.status !== 200).map(([id, r]) => id + ' ' + r.status);
    assert.deepStrictEqual(notOk, []);
    assert.ok(findInTree(opened.get(':_cmc:').body.streams, ':_cmc:apps') != null, 'premise: :_cmc: subtree read');
    assert.ok(opened.has(':_audit:'), 'premise: a store root was opened: ' + [...opened.keys()]);
    // `:_cmc:_internal` answers with its subtree pruned (never listed), by design.
    const internal = opened.get(':_cmc:_internal').body.streams;
    assert.deepStrictEqual(internal.map((s) => s.id).filter((id) => id.startsWith(':_cmc:_internal')), []);
    for (const id of [':_cmc:', ':_cmc:apps', ':_cmc:inbox', ':_emails:']) {
      const stream = findInTree(res.body.streams, id);
      assert.ok(stream != null, 'premise: ' + id + ' is listed');
      for (const prop of TRACKING) {
        assert.ok(stream[prop] != null, id + ' carries ' + prop + ': ' + JSON.stringify(stream));
      }
      // Stamped at write time, not the read-side "unknown" fill.
      assert.ok(stream.created > before, id + ' created is a write time: ' + stream.created);
      assert.ok(stream.modified > before, id + ' modified is a write time: ' + stream.modified);
      assert.strictEqual(stream.createdBy, dataStoreDefaults.SystemAccessId, id);
      assert.strictEqual(stream.modifiedBy, dataStoreDefaults.SystemAccessId, id);
    }
  });

  it('[STRK2] a stream stored without the tracking properties reads with the datastore defaults', async function () {
    // Deliberately bypasses the mall: the store keeps what it is given, so this
    // writes rows without the tracking properties, as stored before the stamping.
    const localStore = mall.streams.streamsStores.get('local');
    const legacyId = 'strk-legacy-' + cuid().toLowerCase().slice(-8);
    const childId = legacyId + '-child';
    await localStore.create(userId, { id: legacyId, name: 'Legacy ' + legacyId, parentId: null });
    await localStore.create(userId, { id: childId, name: 'Legacy child', parentId: legacyId });

    const checkUnknown = (stream, label) => {
      assert.ok(stream != null, 'premise: ' + label + ' is listed');
      assert.strictEqual(stream.created, dataStoreDefaults.UnknownDate, label);
      assert.strictEqual(stream.modified, dataStoreDefaults.UnknownDate, label);
      assert.strictEqual(stream.createdBy, dataStoreDefaults.UnknownAccessId, label);
      assert.strictEqual(stream.modifiedBy, dataStoreDefaults.UnknownAccessId, label);
    };

    // whole tree
    const res = await get({});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    validation.checkSchema(res.body, methodsSchema.get.result);
    checkUnknown(findInTree(res.body.streams, legacyId), 'root legacy row');
    checkUnknown(findInTree(res.body.streams, childId), 'child legacy row');

    // one subtree
    const sub = await get({ parentId: legacyId });
    assert.strictEqual(sub.status, 200, JSON.stringify(sub.body));
    validation.checkSchema(sub.body, methodsSchema.get.result);
    checkUnknown(findInTree(sub.body.streams, childId), 'child legacy row (by parentId)');

    // an app access reading the tree (the per-permission copy of the accessible streams)
    const appToken = cuid();
    await user.access({ token: appToken, type: 'app', permissions: [{ streamId: legacyId, level: 'read' }] });
    const app = await coreRequest.get(basePath).set('Authorization', appToken);
    assert.strictEqual(app.status, 200, JSON.stringify(app.body));
    validation.checkSchema(app.body, methodsSchema.get.result);
    checkUnknown(findInTree(app.body.streams, legacyId), 'root legacy row (app access)');
    checkUnknown(findInTree(app.body.streams, childId), 'child legacy row (app access)');

    // update response: the creation stays unknown, the change is stamped
    const upd = await coreRequest.put(basePath + '/' + legacyId).set('Authorization', personal)
      .send({ name: 'Renamed ' + legacyId });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    assert.strictEqual(upd.body.stream.created, dataStoreDefaults.UnknownDate);
    assert.strictEqual(upd.body.stream.createdBy, dataStoreDefaults.UnknownAccessId);
    assert.ok(upd.body.stream.modified > dataStoreDefaults.UnknownDate);
    assert.strictEqual(upd.body.stream.modifiedBy, personalAccessId);

    // trash response (a legacy child, untouched so far)
    const trash = await coreRequest.delete(basePath + '/' + childId).set('Authorization', personal);
    assert.strictEqual(trash.status, 200, JSON.stringify(trash.body));
    assert.strictEqual(trash.body.stream.trashed, true);
    assert.strictEqual(trash.body.stream.created, dataStoreDefaults.UnknownDate);
    assert.strictEqual(trash.body.stream.createdBy, dataStoreDefaults.UnknownAccessId);
    assert.ok(trash.body.stream.modified > dataStoreDefaults.UnknownDate);
    assert.strictEqual(trash.body.stream.modifiedBy, personalAccessId);
  });

  it('[STRK3] a server-side update that does not stamp the change is recorded as a system write', async function () {
    // Deliberately bypasses the mall (see STRK2).
    const localStore = mall.streams.streamsStores.get('local');
    const legacyId = 'strk-upd-' + cuid().toLowerCase().slice(-8);
    await localStore.create(userId, { id: legacyId, name: 'Legacy ' + legacyId, parentId: null });
    const before = Date.now() / 1000 - 60;
    const updated = await mall.streams.update(userId, { id: legacyId, clientData: { strk: true } });
    assert.ok(updated.modified > before, 'modified is the write time: ' + updated.modified);
    assert.strictEqual(updated.modifiedBy, dataStoreDefaults.SystemAccessId);
    assert.strictEqual(updated.created, dataStoreDefaults.UnknownDate);

    const res = await get({});
    const stream = findInTree(res.body.streams, legacyId);
    assert.ok(stream.modified > before, 'stored modified: ' + JSON.stringify(stream));
    assert.strictEqual(stream.modifiedBy, dataStoreDefaults.SystemAccessId);
  });

  it('[STRK4] untrashing a stream for a new access permission stamps the change with the acting access', async function () {
    const id = 'strk-untrash-' + cuid().toLowerCase().slice(-8);
    const created = await coreRequest.post(basePath).set('Authorization', personal).send({ id, name: 'Untrash ' + id });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const trashed = await coreRequest.delete(basePath + '/' + id).set('Authorization', personal);
    assert.strictEqual(trashed.status, 200, JSON.stringify(trashed.body));
    assert.strictEqual(trashed.body.stream.trashed, true);

    // Make the stored stamp distinguishable from the access create's.
    await mall.streams.update(userId, { id, modified: dataStoreDefaults.UnknownDate, modifiedBy: 'strk-marker' });
    const acc = await coreRequest.post('/' + username + '/accesses').set('Authorization', personal)
      .send({ name: 'strk-' + cuid(), type: 'app', permissions: [{ streamId: id, level: 'read', defaultName: 'Untrash' }] });
    assert.strictEqual(acc.status, 201, JSON.stringify(acc.body));

    const res = await get({});
    const stream = findInTree(res.body.streams, id);
    assert.ok(stream != null && stream.trashed == null, 'premise: untrashed: ' + JSON.stringify(stream));
    assert.strictEqual(stream.modifiedBy, personalAccessId);
    assert.ok(stream.modified > dataStoreDefaults.UnknownDate + 1);
  });

  it('[STRK5] the delegation and shared-secrets namespaces are stored with the tracking properties', async function () {
    const before = Date.now() / 1000 - 3600;
    await delegation.store.ensureParents(mall, userId);
    await sharedSecrets.ensureStreams({ mall, userId, accessId: personalAccessId });
    // Read the store directly: the stored values, without the read-side fill.
    const localStore = mall.streams.streamsStores.get('local');
    const ids = [':_delegation:', ':_delegation:_internal', ':_shared-secrets:', sharedSecrets.streamIdForAccess(personalAccessId)];
    for (const id of ids) {
      const stored = await localStore.getOne(userId, id, { includeTrashed: true, childrenDepth: 0 });
      assert.ok(stored != null, 'premise: ' + id + ' is stored');
      assert.ok(stored.created > before, id + ' created: ' + JSON.stringify(stored));
      assert.ok(stored.modified > before, id + ' modified: ' + JSON.stringify(stored));
      assert.ok(typeof stored.createdBy === 'string' && stored.createdBy.length > 0, id + ' createdBy');
      assert.ok(typeof stored.modifiedBy === 'string' && stored.modifiedBy.length > 0, id + ' modifiedBy');
    }
    // Delegation passes no author (system); shared-secrets passes the access.
    const deleg = await localStore.getOne(userId, ':_delegation:', { includeTrashed: true, childrenDepth: 0 });
    assert.strictEqual(deleg.createdBy, dataStoreDefaults.SystemAccessId);
    const sub = await localStore.getOne(userId, sharedSecrets.streamIdForAccess(personalAccessId), { includeTrashed: true, childrenDepth: 0 });
    assert.strictEqual(sub.createdBy, personalAccessId);
  });

  it('[STRK6] untrashing a stream of another store for a new access permission leaves the local stream with the same id alone', async function () {
    const id = 'strk-store-' + cuid().toLowerCase().slice(-8);
    const created = await coreRequest.post(basePath).set('Authorization', personal).send({ id, name: 'Local ' + id });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const trashed = await coreRequest.delete(basePath + '/' + id).set('Authorization', personal);
    assert.strictEqual(trashed.status, 200, JSON.stringify(trashed.body));

    // The test store answers a trashed stream with the same item id, as a store
    // that supports trash would.
    const dummy = mall.streams.streamsStores.get('dummy');
    const origGetOne = dummy.getOne;
    const origUpdate = dummy.update;
    const updates = [];
    dummy.getOne = async (u, sid, q) => (sid === id
      ? { id, name: 'Store ' + id, parentId: null, trashed: true, children: [] }
      : origGetOne.call(dummy, u, sid, q));
    dummy.update = async (u, data) => { updates.push(data); return origUpdate.call(dummy, u, data); };
    let acc;
    try {
      acc = await coreRequest.post('/' + username + '/accesses').set('Authorization', personal)
        .send({ name: 'strk-' + cuid(), type: 'app', permissions: [{ streamId: ':dummy:' + id, level: 'read', defaultName: 'Store' }] });
    } finally {
      dummy.getOne = origGetOne;
      dummy.update = origUpdate;
    }
    assert.strictEqual(acc.status, 201, JSON.stringify(acc.body));
    // The untrash went to the store that holds the stream.
    assert.strictEqual(updates.length, 1, JSON.stringify(updates));
    assert.strictEqual(updates[0].id, id);
    assert.strictEqual(updates[0].trashed, false);
    assert.strictEqual(updates[0].modifiedBy, personalAccessId);
    // The local stream is untouched.
    const local = await mall.streams.streamsStores.get('local').getOne(userId, id, { includeTrashed: true, childrenDepth: 0 });
    assert.ok(local != null, 'premise: the local stream is stored');
    assert.strictEqual(local.trashed, true, 'local stream: ' + JSON.stringify(local));
  });
});
