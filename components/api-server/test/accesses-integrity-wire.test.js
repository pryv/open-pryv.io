/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * The `integrity` of an access verifies, with the bare published library, on
 * the object the API returns: after updates too (composite `id` and
 * `modifiedBy`, history rows, deletion records). Hashes stored in the
 * previous (row) form are recomputed once at upgrade, on both engines.
 */

const fs = require('node:fs');
const path = require('node:path');
const stableRepresentation = require('@pryv/stable-object-representation');
const storage = require('storage');
const { integrity } = require('business');
const IntegrityCheck = require('business/src/integrity/IntegrityCheck.ts').default;

describe('[AIWA] access integrity verifies on the wire form', function () {
  this.timeout(30000);

  let fixtures;
  let accessStorage;
  let isPG;

  before(async function () {
    await initTests();
    await initCore();
    if (!integrity.accesses.isActive) return this.skip();
    fixtures = getNewFixture();
    const storageLayer = await storage.getStorageLayer();
    accessStorage = storageLayer.accesses;
    isPG = accessStorage.constructor.name === 'AccessesPG';
  });

  /** A fresh account: personal, app (manages stream0) and a shared access it created. */
  async function newAccount () {
    const username = cuid();
    const user = await fixtures.user(username);
    const stream0 = await user.stream({ id: 's0_' + username, name: 'Stream 0' });
    const child = await stream0.stream({ id: 's0c_' + username, name: 'Stream 0 child' });
    const s = {
      username,
      user: { id: username },
      personalToken: cuid(),
      appId: 'app_' + username,
      appToken: cuid(),
      sharedId: 'shared_' + username,
      sharedToken: cuid()
    };
    await user.access({ type: 'personal', token: s.personalToken });
    await user.session(s.personalToken);
    await user.access({
      id: s.appId,
      token: s.appToken,
      name: 'App',
      type: 'app',
      permissions: [{ streamId: stream0.attrs.id, level: 'manage' }]
    });
    await user.access({
      id: s.sharedId,
      token: s.sharedToken,
      name: 'Shared',
      type: 'shared',
      permissions: [{ streamId: child.attrs.id, level: 'read' }],
      createdBy: s.appId,
      modifiedBy: s.appId
    });
    return s;
  }

  function url (s, id) { return '/' + s.username + '/accesses' + (id != null ? '/' + id : ''); }

  async function update (s, id, data, token) {
    const res = await coreRequest.put(url(s, id)).set('Authorization', token || s.personalToken).send(data);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.access;
  }

  function assertVerifies (access, label) {
    assert.ok(access?.integrity, label + ': carries integrity');
    assert.equal(stableRepresentation.access.hash(access, integrity.algorithm), access.integrity,
      label + ': verifies with the bare library');
  }

  async function allRows (user) {
    return await new Promise((resolve, reject) => {
      accessStorage.findAll(user, {}, (err, rows) => err ? reject(err) : resolve(rows.filter((r) => r != null)));
    });
  }

  function isVersioned (row) {
    return row.headId != null || row.serial != null || row.modifiedBySerial != null || row.createdBySerial != null;
  }

  // ---- API responses ----

  it('[AIWF] the accesses.update response verifies', async function () {
    const s = await newAccount();
    const updated = await update(s, s.sharedId, { name: 'Renamed' });
    assert.equal(updated.id, s.sharedId + ':1');
    assertVerifies(updated, 'update response');
  });

  it('[AIWG] accesses.get: an updated entry verifies; a never-updated one hashes as its storage row', async function () {
    const s = await newAccount();
    await update(s, s.sharedId, { name: 'Renamed' });
    const res = await coreRequest.get(url(s)).set('Authorization', s.personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const shared = res.body.accesses.find((a) => a.id === s.sharedId + ':1');
    assertVerifies(shared, 'updated entry');
    const app = res.body.accesses.find((a) => a.id === s.appId);
    assertVerifies(app, 'never-updated entry');
    const row = (await allRows(s.user)).find((r) => r.id === s.appId);
    assert.equal(app.integrity, stableRepresentation.access.hash(row, integrity.algorithm),
      'row form and wire form hash alike for a never-updated access');
  });

  it('[AIWH] a never-updated access keeps the integrity it was created with', async function () {
    const s = await newAccount();
    const create = await coreRequest.post(url(s)).set('Authorization', s.personalToken)
      .send({ name: 'aiwh-created', type: 'app', permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const created = create.body.access;
    assertVerifies(created, 'create response');
    await update(s, s.sharedId, { name: 'Renamed' });
    const res = await coreRequest.get(url(s, created.id)).set('Authorization', s.personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.access.integrity, created.integrity);
  });

  it('[AIWK] accesses.getOne: the head after two updates verifies', async function () {
    const s = await newAccount();
    await update(s, s.sharedId, { name: 'rev-1' });
    await update(s, s.sharedId + ':1', { name: 'rev-2' });
    const res = await coreRequest.get(url(s, s.sharedId + ':2')).set('Authorization', s.personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.access.id, s.sharedId + ':2');
    assertVerifies(res.body.access, 'head');
  });

  it('[AIWL] accesses.getOne: an older version verifies', async function () {
    const s = await newAccount();
    await update(s, s.sharedId, { name: 'rev-1' });
    await update(s, s.sharedId + ':1', { name: 'rev-2' });
    const res = await coreRequest.get(url(s, s.sharedId + ':1')).set('Authorization', s.personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.current, s.sharedId + ':2');
    assert.equal(res.body.access.id, s.sharedId + ':1');
    assertVerifies(res.body.access, 'older version');
  });

  it('[AIWM] includeHistory: every version verifies, the original with its create-time integrity', async function () {
    const s = await newAccount();
    const create = await coreRequest.post(url(s)).set('Authorization', s.personalToken)
      .send({ name: 'aiwm-created', type: 'app', permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const created = create.body.access;
    await update(s, created.id, { name: 'rev-1' });
    await update(s, created.id + ':1', { name: 'rev-2' });
    const res = await coreRequest.get(url(s, created.id)).set('Authorization', s.personalToken)
      .query({ includeHistory: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertVerifies(res.body.access, 'head');
    assert.equal(res.body.history.length, 2);
    res.body.history.forEach((h, i) => assertVerifies(h, 'history[' + i + ']'));
    assert.equal(res.body.history[0].id, created.id);
    assert.equal(res.body.history[0].integrity, created.integrity, 'the original version matches the create-time record');
  });

  it('[AIWN] accessDeletions: the entry keeps its integrity, verifiable once the token is restored', async function () {
    const s = await newAccount();
    await update(s, s.sharedId, { name: 'Renamed' });
    const del = await coreRequest.delete(url(s, s.sharedId + ':1')).set('Authorization', s.personalToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const res = await coreRequest.get(url(s)).set('Authorization', s.personalToken).query({ includeDeletions: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entry = res.body.accessDeletions.find((d) => d.id === s.sharedId + ':1');
    assert.ok(entry?.integrity, 'the deletion entry carries integrity');
    assert.equal(entry.token, undefined, 'returned without its token');
    assert.notEqual(stableRepresentation.access.hash(entry, integrity.algorithm), entry.integrity);
    assertVerifies(Object.assign({}, entry, { token: s.sharedToken }), 'deletion entry with its token');
  });

  it('[AIWP] an update made by an updated app access verifies, with a composite modifiedBy', async function () {
    const s = await newAccount();
    await update(s, s.appId, { name: 'App renamed' });
    const updated = await update(s, s.sharedId, { name: 'by the app' }, s.appToken);
    assert.equal(updated.modifiedBy, s.appId + ':1');
    assertVerifies(updated, 'update by an updated app');
  });

  // ---- stored hashes recomputed at upgrade ----

  /** Writes `value` as the stored integrity of one row, behind the engine's back. */
  async function writeStoredIntegrity (userId, rowId, value) {
    if (isPG) {
      await require('storages').databasePG.query(
        'UPDATE accesses SET integrity = $1 WHERE user_id = $2 AND id = $3', [value, userId, rowId]);
      return;
    }
    const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
    const udb = await UserBaseStorageDb.forUser(userId);
    udb.db.prepare('UPDATE accesses SET data = json_set(data, \'$.integrity\', ?) WHERE id = ?').run(value, rowId);
  }

  /** An account with versioned rows whose stored hashes are in the previous (row) form. */
  async function accountWithLegacyHashes () {
    const s = await newAccount();
    await update(s, s.appId, { name: 'App rev-1' });
    await update(s, s.sharedId, { name: 'rev-1' });
    await update(s, s.sharedId + ':1', { name: 'rev-2' }, s.appToken);
    const versioned = (await allRows(s.user)).filter(isVersioned);
    assert.ok(versioned.length >= 4, 'head and history rows of both accesses');
    for (const row of versioned) {
      const legacy = integrity.accesses.rowFormHash(row);
      assert.notEqual(legacy, row.integrity);
      await writeStoredIntegrity(s.user.id, row.id, legacy);
    }
    return { s, versioned };
  }

  async function assertRowsVerify (user) {
    for (const row of await allRows(user)) {
      assert.equal(row.integrity, integrity.accesses.hash(row), 'row ' + row.id + ' holds the wire-form hash');
    }
  }

  /** The engine's own upgrade vehicle: the PostgreSQL migration, the SQLite one-shot. */
  async function runUpgradeRecompute () {
    if (isPG) {
      const migration = require('storages/engines/postgresql/migrations/20261112_120000_access_integrity_wire_form.js');
      return await migration.up({ db: require('storages').databasePG });
    }
    const { recomputeAccessesIntegrityOnce, INTEGRITY_WIRE_FORM_MARKER } = require('storages/engines/sqlite/src/user/AccessesSQLite.ts');
    const marker = path.join(storage.userLocalDirectory.getBasePath(), INTEGRITY_WIRE_FORM_MARKER);
    fs.rmSync(marker, { force: true });
    const res = await recomputeAccessesIntegrityOnce(accessStorage);
    assert.ok(fs.existsSync(marker), 'the marker is written once the recompute completed');
    assert.equal(await recomputeAccessesIntegrityOnce(accessStorage), null, 'a second start does nothing');
    return res;
  }

  it('[AIWR] PostgreSQL: the migration rewrites the row-form hashes of versioned rows', async function () {
    if (!isPG) return this.skip();
    const { s, versioned } = await accountWithLegacyHashes();
    const res = await runUpgradeRecompute();
    assert.ok(res.rewritten >= versioned.length, JSON.stringify(res));
    await assertRowsVerify(s.user);
  });

  it('[AIWS] SQLite: the one-shot pass rewrites them once, recorded by a marker file', async function () {
    if (isPG) return this.skip();
    const { s, versioned } = await accountWithLegacyHashes();
    const res = await runUpgradeRecompute();
    assert.ok(res.rewritten >= versioned.length, JSON.stringify(res));
    await assertRowsVerify(s.user);
  });

  it('[AIWT] the recompute is idempotent and leaves unversioned rows untouched', async function () {
    const { s } = await accountWithLegacyHashes();
    const before = (await allRows(s.user)).filter((r) => !isVersioned(r));
    assert.ok(before.length >= 1);
    const first = await accessStorage.recomputeIntegrityOfVersionedRows();
    assert.ok(first.rewritten >= 1, JSON.stringify(first));
    const second = await accessStorage.recomputeIntegrityOfVersionedRows();
    assert.equal(second.rewritten, 0, JSON.stringify(second));
    const after = await allRows(s.user);
    for (const row of before) {
      assert.equal(after.find((r) => r.id === row.id).integrity, row.integrity, 'unversioned row ' + row.id);
    }
    await assertRowsVerify(s.user);
  });

  it('[AIWU] the integrity check flags row-form hashes and reports none after the recompute', async function () {
    const { s, versioned } = await accountWithLegacyHashes();
    const checker = await new IntegrityCheck().init();
    const beforeReport = await checker.checkUser(s.user.id);
    assert.equal(beforeReport.accesses.errors.length, versioned.length, JSON.stringify(beforeReport.accesses));
    await runUpgradeRecompute();
    const afterReport = await checker.checkUser(s.user.id);
    assert.equal(afterReport.accesses.status, 'checked');
    assert.deepEqual(afterReport.accesses.errors, []);
  });

  it('[AIWX] a stored value that is neither form is left for the integrity check to report', async function () {
    const s = await newAccount();
    await update(s, s.sharedId, { name: 'rev-1' });
    const head = (await allRows(s.user)).find((r) => r.id === s.sharedId);
    const good = head.integrity;
    const bogus = 'ACCESS:0:sha256-' + Buffer.from('not the hash of this access').toString('base64');
    await writeStoredIntegrity(s.user.id, head.id, bogus);
    try {
      const res = await accessStorage.recomputeIntegrityOfVersionedRows();
      assert.ok(res.unverified >= 1, JSON.stringify(res));
      const stored = (await allRows(s.user)).find((r) => r.id === s.sharedId).integrity;
      assert.equal(stored, bogus, 'never replaced');
    } finally {
      await writeStoredIntegrity(s.user.id, head.id, good);
    }
  });
});
