/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert, audit, cuid, initTests, fakeAuditEvent, CONSTANTS, AuditFilter */

/**
 * [APTR] The platform trail: the stored copy of a record without an account
 * (`WITHOUT_USER_METHODS`) goes to the reserved id when the audit storage
 * keeps it, following `audit.storage.filter`; the reserved id, and no other,
 * is exempted from the erased-account checks; it is never an account.
 */

const storages = require('storages');
const { userLocalDirectory } = require('storage');
const { Audit } = require('audit/src/Audit.ts');

describe('[APTR] platform trail', function () {
  const PT = CONSTANTS.PLATFORM_TRAIL_USER_ID;

  before(async function () {
    await initTests();
    await userLocalDirectory.init();
  });

  async function trailHas (eventId, auditInstance = audit) {
    return (await (await auditInstance.storage.forUser(PT)).getOneEvent(eventId)) != null;
  }

  it('[APTR1] a record without a user is stored under the reserved id and read back; the syslog copy is unchanged', async function () {
    assert.equal(PT, 'platform-trail');
    assert.equal(audit.storage.acceptsPlatformTrail(), true, 'both base engines keep the trail');
    const event = fakeAuditEvent('system.createUser');
    await audit.eventForUser(undefined, event, 'system.createUser');
    assert.ok(event.id != null);
    assert.ok(await trailHas(event.id), 'in the platform trail');
  });

  it('[APTR2] a method with a user is never stored in the platform trail; a method without one follows the storage filter', async function () {
    const withUser = fakeAuditEvent('events.get');
    const userId = 'aptr' + cuid();
    await audit.eventForUser(userId, withUser, 'events.get');
    assert.equal(await trailHas(withUser.id), false, 'not in the trail');
    assert.ok((await (await audit.storage.forUser(userId)).getOneEvent(withUser.id)) != null, 'in the account\'s trail');

    const filter = new AuditFilter({
      syslogFilter: { methods: { include: ['all'], exclude: [] } },
      storageFilter: { methods: { include: [], exclude: ['system.createUser'] } }
    });
    assert.deepEqual(filter.isAudited('system.createUser'), { syslog: true });
    assert.deepEqual(filter.isAudited('system.deactivateMfa'), { syslog: true, platformTrail: true });
    assert.deepEqual(filter.isAudited('events.get'), { syslog: true, storage: true });
    assert.equal(filter.isAudited('system.listCores'), false, 'a read declared not audited');
    const saved = audit.filter;
    audit.filter = filter;
    try {
      const excluded = fakeAuditEvent('system.createUser');
      await audit.eventForUser(undefined, excluded, 'system.createUser');
      assert.equal(await trailHas(excluded.id), false, 'excluded by the storage filter');
    } finally {
      audit.filter = saved;
    }
  });

  it('[APTR3] a storage that does not keep the trail: syslog only, as before', async function () {
    const auditStorage = storages.auditStorage;
    const local = new Audit();
    auditStorage.acceptsPlatformTrail = () => false; // shadows the engine's method
    try {
      await local.init();
    } finally {
      delete auditStorage.acceptsPlatformTrail;
    }
    assert.equal(auditStorage.acceptsPlatformTrail(), true, 'the engine\'s method again');
    const asked = [];
    const forUser = auditStorage.forUser;
    auditStorage.forUser = function (id) { asked.push(id); return forUser.call(this, id); };
    try {
      const event = fakeAuditEvent('system.createUser');
      await local.eventForUser(undefined, event, 'system.createUser');
    } finally {
      auditStorage.forUser = forUser;
    }
    assert.deepEqual(asked, [], 'nothing stored');
  });

  it('[APTR4] where erased marks are checked (users index elsewhere), the reserved id is exempted, and only it', async function () {
    const auditStorage = storages.auditStorage;
    const hadRefuse = Object.prototype.hasOwnProperty.call(auditStorage, 'refuseUnindexedUsers');
    const previousRefuse = auditStorage.refuseUnindexedUsers;
    auditStorage.refuseUnindexedUsers = () => false; // asked to refuse, cannot: the erased mark is checked instead
    const local = new Audit();
    try {
      await local.init();
    } finally {
      if (hadRefuse) auditStorage.refuseUnindexedUsers = previousRefuse; else delete auditStorage.refuseUnindexedUsers;
    }
    const near = PT + '-x';
    // The records in PostgreSQL (the pairing where marks are checked): the
    // reserved id marked erased with no directory is still written. A SQLite
    // audit file lives in a directory, which the users path never re-creates
    // for a marked id; no erasure can mark this id (it is no account).
    const inDirectories = typeof local.storage.existingPathForUser === 'function';
    try {
      for (const id of inDirectories ? [near] : [PT, near]) await userLocalDirectory.deleteUserDirectory(id, [], { erased: true });
      if (!inDirectories) {
        assert.equal(await userLocalDirectory.isErasedAndGone(PT), true, 'the reserved id marked erased, no directory');
        const toTrail = fakeAuditEvent('system.createUser');
        await local.eventForUser(undefined, toTrail, 'system.createUser');
        assert.ok(await trailHas(toTrail.id, local), 'still written: the reserved id is not an account');
      }

      const toNear = fakeAuditEvent('events.get');
      await local.eventForUser(near, toNear, 'events.get');
      userLocalDirectory.forgetErasedTestOnly(near);
      const nearDb = await local.storage.forUser(near);
      assert.equal(await nearDb.getOneEvent(toNear.id), null, 'an erased ordinary id is still refused');
    } finally {
      userLocalDirectory.forgetErasedTestOnly(PT);
      userLocalDirectory.forgetErasedTestOnly(near);
    }
  });

  it('[APTR5] the reserved id is not an account: no users-index entry, never deleted as one', async function () {
    const { getUsersLocalIndex } = require('storage');
    const index = await getUsersLocalIndex();
    const all = await index.getAllByUsername();
    assert.ok(!Object.values(all).includes(PT), 'not in the users index');
    await assert.rejects(audit.storage.deleteUser(PT), (err) => err.code === 'PLATFORM_TRAIL_NOT_AN_ACCOUNT');
  });
});
