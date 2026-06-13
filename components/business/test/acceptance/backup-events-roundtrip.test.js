/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { createId: cuid } = require('@paralleldrive/cuid2');
const { fromCallback } = require('utils');

/**
 * Live round-trip of the engine's `storageLayer.events` store — the path
 * `bin/backup.js` (BackupOrchestrator/RestoreOrchestrator) and the
 * IntegrityCheck events pass rely on.
 *
 * Pins two production crashes / silent data losses:
 *  - PG: a raw `pg` query result ({command,rowCount,oid,rows,fields})
 *    forwarded instead of `.rows` crashed every full-platform backup on
 *    the first user ("Backup export shape mismatch … from \"events\"").
 *  - SQLite: events.exportAll was absent and events.importAll a no-op, so
 *    backups silently contained zero events and restores dropped them;
 *    iterateAllEvents read an `events` table in the wrong per-user file
 *    (baseStorage-*.sqlite instead of local-*.sqlite), so the teardown
 *    integrity pass silently covered zero events.
 */
describe('[BKEV] backup events store round-trip (storageLayer.events)', function () {
  let storageLayer, eventsStore, usersIndex;
  const userId = cuid();
  const username = 'bkev-' + userId.substring(0, 12);
  const user = { id: userId };

  const evNote = {
    id: cuid(),
    streamIds: ['bkev-stream-one'],
    type: 'note/txt',
    content: "don't lose me — quotes included",
    time: 1391880600.5,
    created: 1391880600.5,
    createdBy: 'bkev-test',
    modified: 1391880600.5,
    modifiedBy: 'bkev-test'
  };
  const evCount = {
    id: cuid(),
    streamIds: ['bkev-stream-two'],
    type: 'count/generic',
    content: 2,
    time: 1391880700.5,
    created: 1391880700.5,
    createdBy: 'bkev-test',
    modified: 1391880700.5,
    modifiedBy: 'bkev-test'
  };

  before(async function () {
    const storages = require('storages');
    storageLayer = storages.storageLayer;
    eventsStore = storageLayer?.events;
    // Register the user in the local index so per-user-file engines'
    // iterateAllEvents (which walks known users) can see the fixture.
    const { getUsersLocalIndex } = require('storage');
    usersIndex = await getUsersLocalIndex();
    await usersIndex.addUser(username, userId);
  });

  after(async function () {
    // Remove every trace: leftover events or a dangling index row would
    // trip the matrix-wide platform-vs-repository integrity hooks.
    if (eventsStore?.clearAll) {
      await fromCallback((cb) => eventsStore.clearAll(user, cb));
    }
    if (usersIndex) await usersIndex.deleteById(userId);
  });

  it('[BKEV-01] the engine exposes events exportAll/importAll/clearAll', function () {
    assert.ok(eventsStore, 'storageLayer.events store missing');
    for (const m of ['exportAll', 'importAll', 'clearAll']) {
      assert.strictEqual(typeof eventsStore[m], 'function', `events.${m} missing`);
    }
  });

  it('[BKEV-02] exportAll returns a bare array for a user with no events (not a result-object wrapper)', async function () {
    const out = await fromCallback((cb) => eventsStore.exportAll(user, cb));
    assert.ok(Array.isArray(out),
      `expected array, got ${typeof out} keys=[${Object.keys(out || {}).slice(0, 5).join(',')}]`);
    assert.strictEqual(out.length, 0);
  });

  it('[BKEV-03] importAll → exportAll round-trips canonical (camelCase) events', async function () {
    await fromCallback((cb) => eventsStore.importAll(user, [evNote, evCount], cb));
    const out = await fromCallback((cb) => eventsStore.exportAll(user, cb));
    assert.ok(Array.isArray(out), 'exportAll must return an array');
    assert.strictEqual(out.length, 2);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    for (const src of [evNote, evCount]) {
      const got = byId[src.id];
      assert.ok(got, `event ${src.id} missing from export`);
      assert.deepStrictEqual(got.streamIds, src.streamIds, 'streamIds must round-trip');
      assert.strictEqual(got.type, src.type);
      assert.deepStrictEqual(got.content, src.content, 'content must round-trip');
      assert.strictEqual(got.modified, src.modified);
      assert.strictEqual(got.createdBy, src.createdBy);
      assert.ok(got.userId === undefined && got.user_id === undefined,
        'engine-private user column must not leak into the canonical event');
    }
  });

  it('[BKEV-04] iterateAllEvents (integrity final-check path) sees the imported events', async function () {
    if (typeof storageLayer.iterateAllEvents !== 'function') this.skip();
    // Key on event ids (cuid-unique): the yielded shape is engine-flavoured
    // (PG events carry no user marker; per-user-file engines add one) and
    // the integrity-final-check consumer doesn't rely on it either.
    const seen = {};
    for await (const event of storageLayer.iterateAllEvents()) {
      if (event.id === evNote.id || event.id === evCount.id) seen[event.id] = event;
    }
    assert.ok(seen[evNote.id], 'iterateAllEvents must yield the note event');
    assert.ok(seen[evCount.id], 'iterateAllEvents must yield the count event');
  });

  it('[BKEV-05] clearAll empties the user events', async function () {
    await fromCallback((cb) => eventsStore.clearAll(user, cb));
    const out = await fromCallback((cb) => eventsStore.exportAll(user, cb));
    assert.ok(Array.isArray(out));
    assert.strictEqual(out.length, 0);
  });
});
