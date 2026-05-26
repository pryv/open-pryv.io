/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { ErrorIds } = require('errors');
const { getConfig } = require('@pryv/boiler');
const storage = require('storage');
const { pubsub } = require('messages');

describe('[ACUP] accesses.update (Plan 66)', function () {
  let username;
  let fixtureUser;
  let stream0, stream1, stream0Child;
  let personalToken;
  let appAccessId, appAccessToken;
  let sharedAccessId, sharedAccessToken;
  let basePath;
  let fixtures;
  let accessStorage;
  let user;

  function path (id) {
    return basePath + '/' + id;
  }

  before(async function () {
    await initTests();
    await initCore();
    await getConfig();

    fixtures = getNewFixture();
    username = cuid();
    basePath = '/' + username + '/accesses';

    const storageLayer = await storage.getStorageLayer();
    accessStorage = storageLayer.accesses;
    user = { id: username };

    fixtureUser = await fixtures.user(username);

    stream0 = await fixtureUser.stream({ id: `stream0_${username}`, name: 'Stream 0' });
    stream0Child = await stream0.stream({ id: `stream0child_${username}`, name: 'Stream 0 child' });
    stream1 = await fixtureUser.stream({ id: `stream1_${username}`, name: 'Stream 1' });

    personalToken = cuid();
    appAccessToken = cuid();
    sharedAccessToken = cuid();
    appAccessId = `app_${username}`;
    sharedAccessId = `shared_${username}`;
  });

  async function resetAccesses () {
    await new Promise((resolve) => { accessStorage.removeAll(user, () => resolve()); });
    await fixtureUser.access({
      type: 'personal',
      token: personalToken
    });
    await fixtureUser.session(personalToken);
    await fixtureUser.access({
      id: appAccessId,
      token: appAccessToken,
      name: 'App access',
      type: 'app',
      permissions: [
        { streamId: stream0.attrs.id, level: 'manage' },
        { streamId: stream1.attrs.id, level: 'contribute' }
      ]
    });
    await fixtureUser.access({
      id: sharedAccessId,
      token: sharedAccessToken,
      name: 'Shared access',
      type: 'shared',
      permissions: [{ streamId: stream0Child.attrs.id, level: 'read' }],
      createdBy: appAccessId,
      modifiedBy: appAccessId
    });
  }

  describe('[ACUP01] composite id basics', function () {
    beforeEach(resetAccesses);

    it('[CB01] bare id on a never-updated access updates and returns composite id', async function () {
      const res = await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'Renamed shared' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.access);
      assert.strictEqual(res.body.access.id, sharedAccessId + ':1');
      assert.strictEqual(res.body.access.name, 'Renamed shared');
      // Internal serial fields stay off the wire.
      assert.strictEqual(res.body.access.serial, undefined);
      assert.strictEqual(res.body.access.createdBySerial, undefined);
      assert.strictEqual(res.body.access.modifiedBySerial, undefined);
    });

    it('[CB02] stale bare id on a versioned access returns 409 stale-resource', async function () {
      await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'first' });
      // Caller forgets to refetch — sends the bare id again.
      const res = await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'second' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.id, ErrorIds.StaleResource);
      assert.strictEqual(res.body.error.data.currentSerial, 1);
    });

    it('[CB03] matching composite id updates and bumps to next serial', async function () {
      await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'first' });
      const res = await coreRequest
        .put(path(sharedAccessId + ':1'))
        .set('Authorization', personalToken)
        .send({ name: 'second' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.access.id, sharedAccessId + ':2');
      assert.strictEqual(res.body.access.name, 'second');
    });
  });

  describe('[ACUP02] caller-vs-target matrix', function () {
    beforeEach(resetAccesses);

    it('[CV01] personal accesses cannot be updated (any caller)', async function () {
      const accesses = (await coreRequest
        .get(basePath)
        .set('Authorization', personalToken)).body.accesses;
      const personalAccess = accesses.find((a) => a.type === 'personal');
      assert.ok(personalAccess, 'personal access should be listed');
      const res = await coreRequest
        .put(path(personalAccess.id))
        .set('Authorization', personalToken)
        .send({ name: 'attempt rename' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
    });

    it('[CV02] app access cannot update itself (no self-update)', async function () {
      const res = await coreRequest
        .put(path(appAccessId))
        .set('Authorization', appAccessToken)
        .send({ name: 'self-rename' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
    });

    it('[CV03] app can update a shared access it manages', async function () {
      const res = await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', appAccessToken)
        .send({ name: 'app-renamed-shared' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.access.name, 'app-renamed-shared');
    });
  });

  describe('[ACUP03] chain rules A, B, D', function () {
    beforeEach(resetAccesses);

    it('[CR01] Rule A: shared cannot gain permissions outside managing app', async function () {
      const res = await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', appAccessToken)
        .send({
          permissions: [{ streamId: stream1.attrs.id, level: 'manage' }]
        });
      // stream1 isn't manage'd by the app — app's perm is contribute. Reject.
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
    });

    it('[CR02] Rule B: narrowing app rejects with offendingChildren', async function () {
      // Shared depends on stream0Child (which inherits from stream0:manage).
      // Narrow the app to NOT include stream0 → shared falls outside scope.
      const res = await coreRequest
        .put(path(appAccessId))
        .set('Authorization', personalToken)
        .send({
          permissions: [{ streamId: stream1.attrs.id, level: 'contribute' }]
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
      assert.ok(Array.isArray(res.body.error.data.offendingChildren));
      assert.ok(res.body.error.data.offendingChildren.includes(sharedAccessId));
    });

    it('[CR03] Rule D: shared expires cannot exceed managing app expires', async function () {
      // Set app expiry via expireAfter (1h). The schema only accepts
      // `expires: null` (clear) or `expireAfter: <seconds>` (set) on
      // update — there's no absolute-`expires` setter.
      await coreRequest
        .put(path(appAccessId))
        .set('Authorization', personalToken)
        .send({ expireAfter: 3600 });
      // The shared access serial is now 1 because we didn't update it,
      // but the app's update bumped its own row's serial — not the
      // shared's. Now extend shared to 2h via expireAfter.
      const res = await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ expireAfter: 7200 });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
    });

    it('[CR04] Rule D retrofitted on create: cannot create shared with longer expiry than parent', async function () {
      // First narrow the app's expiry via expireAfter.
      await coreRequest
        .put(path(appAccessId))
        .set('Authorization', personalToken)
        .send({ expireAfter: 3600 });
      // App tries to create a shared with longer expiry. The token
      // is unaffected by versioning — only the id carries the serial.
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', appAccessToken)
        .send({
          name: 'too-long-shared',
          type: 'shared',
          permissions: [{ streamId: stream0Child.attrs.id, level: 'read' }],
          expireAfter: 7200 // 2h > app's 1h
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
    });
  });

  describe('[ACUP04] soft-deleted handling', function () {
    beforeEach(resetAccesses);

    it('[SD01] update on a soft-deleted access returns unknown-resource', async function () {
      await coreRequest
        .delete(path(sharedAccessId))
        .set('Authorization', personalToken);
      const res = await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'updated after delete' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });
  });

  describe('[ACUP05] accesses.getOne + history', function () {
    beforeEach(resetAccesses);

    it('[GO01] getOne bare returns current head with composite id when versioned', async function () {
      await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'rev-1' });
      const res = await coreRequest
        .get(path(sharedAccessId))
        .set('Authorization', personalToken);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.access.id, sharedAccessId + ':1');
      assert.strictEqual(res.body.access.name, 'rev-1');
      assert.strictEqual(res.body.current, undefined,
        'no `current` hint when caller asks for the head');
    });

    it('[GO02] getOne with obsolete composite returns history snapshot + current hint', async function () {
      await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'rev-1' });
      await coreRequest
        .put(path(sharedAccessId + ':1'))
        .set('Authorization', personalToken)
        .send({ name: 'rev-2' });
      // Fetch the original (pre-any-update) snapshot via bare composite
      // — serial is null on the original snapshot. The bare id targets
      // the current head, so use the composite-with-serial-1 to ask for
      // the version after the first update.
      const res = await coreRequest
        .get(path(sharedAccessId + ':1'))
        .set('Authorization', personalToken);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.access.name, 'rev-1');
      assert.strictEqual(res.body.current, sharedAccessId + ':2');
    });

    it('[GO03] getOne ?includeHistory=true returns chronological history', async function () {
      await coreRequest
        .put(path(sharedAccessId))
        .set('Authorization', personalToken)
        .send({ name: 'rev-1' });
      await coreRequest
        .put(path(sharedAccessId + ':1'))
        .set('Authorization', personalToken)
        .send({ name: 'rev-2' });
      const res = await coreRequest
        .get(path(sharedAccessId) + '?includeHistory=true')
        .set('Authorization', personalToken);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.history));
      assert.strictEqual(res.body.history.length, 2);
      // Oldest first — first history row was the pre-update original
      // (serial: null on the snapshot, wire-id = bare base).
      assert.strictEqual(res.body.history[0].id, sharedAccessId);
      // Second history row is the snapshot of the version-1 head taken
      // before the second update — wire-id is the composite with the
      // FROZEN serial 1.
      assert.strictEqual(res.body.history[1].id, sharedAccessId + ':1');
    });

    it('[GO04] getOne on unknown id returns 404', async function () {
      const res = await coreRequest
        .get(path('nonexistent'))
        .set('Authorization', personalToken);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });
  });

  describe('[ACUP06] notifications', function () {
    beforeEach(resetAccesses);

    it('[NT01] update fires both accesses-changed AND access-updated on pubsub', async function () {
      const received = [];
      const remove = pubsub.notifications.onAndGetRemovable(username, (payload) => {
        received.push(payload);
      });
      try {
        const res = await coreRequest
          .put(path(sharedAccessId))
          .set('Authorization', personalToken)
          .send({ name: 'notified' });
        assert.strictEqual(res.status, 200);
      } finally {
        remove();
      }
      assert.ok(received.includes(pubsub.USERNAME_BASED_ACCESSES_CHANGED),
        'should emit USERNAME_BASED_ACCESSES_CHANGED');
      const fine = received.find((p) => p && typeof p === 'object' && p.type === pubsub.ACCESS_UPDATED);
      assert.ok(fine, 'should emit ACCESS_UPDATED structured payload');
      assert.strictEqual(fine.accessId, sharedAccessId + ':1');
      assert.strictEqual(fine.serial, 1);
    });
  });

  describe('[ACUP-SYM] accesses.update accepts the same permission shape as accesses.create (B-2026-05-14-4)', function () {
    beforeEach(resetAccesses);

    it('[SYM01] accesses.update accepts a permission carrying defaultName + name (does not 400 OBJECT_ADDITIONAL_PROPERTIES)', async function () {
      // Pre-fix: this PUT body was rejected because UPDATE's permissions
      // schema was strict on additionalProperties. Now matches CREATE.
      // `appAccessId` is provisioned by resetAccesses().
      const res = await coreRequest
        .put(path(appAccessId))
        .set('Authorization', personalToken)
        .send({
          permissions: [{
            streamId: stream0.attrs.id,
            level: 'manage',
            defaultName: 'Stream 0',
            name: 'Stream 0'
          }]
        });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      // The extras must be stripped before persistence (mirror of the
      // existing CREATE-side cleanupPermissions behaviour). Locate by
      // streamId since the stored permissions array may include
      // system-stream entries auto-injected by the server.
      const stored = res.body.access.permissions.find((p) => p.streamId === stream0.attrs.id);
      assert.ok(stored, `expected to find permission for ${stream0.attrs.id} in ${JSON.stringify(res.body.access.permissions)}`);
      assert.strictEqual(stored.defaultName, undefined,
        'defaultName must not be persisted on update (cleanupUpdatePermissions)');
      assert.strictEqual(stored.name, undefined,
        'name must not be persisted on update (cleanupUpdatePermissions)');
      assert.strictEqual(stored.level, 'manage');
    });

    it('[SYM02] checkApp → update round-trip: result.checkedPermissions can be sent straight back to accesses.update', async function () {
      // Reproduces the scenario from the bug entry: a caller pipes
      // checkApp.checkedPermissions into accesses.update without manually
      // stripping {defaultName, name}. Uses the resetAccesses-provisioned
      // `appAccessId` as the update target.
      // checkApp returns checkedPermissions including the extras.
      const checkRes = await coreRequest
        .post(basePath + '/check-app')
        .set('Authorization', personalToken)
        .send({
          requestingAppId: 'App access',
          requestedPermissions: [{
            streamId: stream0.attrs.id,
            level: 'manage',
            defaultName: 'Stream 0'
          }]
        });
      assert.strictEqual(checkRes.status, 200);
      assert.ok(Array.isArray(checkRes.body.checkedPermissions),
        'expected checkedPermissions array');
      // Pipe straight into update — pre-fix this would 400 with
      // invalid-parameters-format (OBJECT_ADDITIONAL_PROPERTIES).
      const updateRes = await coreRequest
        .put(path(appAccessId))
        .set('Authorization', personalToken)
        .send({ permissions: checkRes.body.checkedPermissions });
      assert.strictEqual(updateRes.status, 200,
        `update should accept checkApp output verbatim, got ${updateRes.status}: ${JSON.stringify(updateRes.body)}`);
    });
  });

  describe('[ACUP07] checkApp head-only', function () {
    beforeEach(resetAccesses);

    it('[CA01] checkApp matches the current head; narrowed perms do not silently re-grant from history', async function () {
      // Create an app with stream0 manage perms; narrow it; then call
      // checkApp asking for the original wider perms — should NOT
      // resolve to a matching access (history is invisible to checkApp).
      const appWideToken = cuid();
      await fixtureUser.access({
        id: `appwide_${username}`,
        token: appWideToken,
        type: 'app',
        name: 'app-wide',
        permissions: [{ streamId: stream0.attrs.id, level: 'manage' }]
      });
      // Narrow the wide app.
      await coreRequest
        .put(path(`appwide_${username}`))
        .set('Authorization', personalToken)
        .send({ permissions: [{ streamId: stream0.attrs.id, level: 'read' }] });
      // Ask checkApp for the original wider perms by app name.
      const res = await coreRequest
        .post(basePath + '/check-app')
        .set('Authorization', personalToken)
        .send({
          requestingAppId: 'app-wide',
          requestedPermissions: [{
            streamId: stream0.attrs.id,
            level: 'manage',
            defaultName: 'Stream 0'
          }]
        });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.matchingAccess, undefined,
        'no match — narrowed head should not be silently re-granted to wider perms');
    });
  });
});
