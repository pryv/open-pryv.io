/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [EGVI] events.getOne by the storage id of a history version.
 *
 * With versioning on, each update stores the previous version as its own row,
 * under a storage id of its own, pointing at its head event. That id is never
 * returned by the API (history versions are listed under the head event's id),
 * and asking for it must answer unknown-resource on every storage engine, not
 * the stored version. Likewise the deletions listing holds head events only.
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');

describe('[EGVI] events.getOne with the storage id of a history version', function () {
  this.timeout(20000);

  let fixtures, username, personalToken, userId, localEvents, keepHistoryBefore;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    userId = user.attrs.id;
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 'egvi', name: 'EGVI' });
    // Versioning on for the local store (versioning.forceKeepHistory), restored after.
    const mall = await require('mall').getMall();
    localEvents = mall.storesById.get('local').events;
    keepHistoryBefore = localEvents.keepHistory;
    localEvents.keepHistory = true;
  });

  after(async function () {
    if (localEvents != null) localEvents.keepHistory = keepHistoryBefore;
    if (fixtures) await fixtures.context.cleanEverything();
  });

  /** Storage ids of the version rows of `eventId`, read from the engine itself. */
  async function versionRowIds (eventId) {
    return (await versionRows(eventId)).map((v) => v.id);
  }

  /** `{ id, deleted }` of the version rows of `eventId`, read from the engine itself. */
  async function versionRows (eventId) {
    if (process.env.STORAGE_ENGINE === 'sqlite') {
      const db = await localEvents.storage.forUser(userId);
      return db.db.prepare('SELECT eventid AS id, deleted FROM events WHERE headId = ?').all(eventId);
    }
    const res = await localEvents.db.query('SELECT id, deleted FROM events WHERE user_id = $1 AND head_id = $2', [userId, eventId]);
    return res.rows;
  }

  async function markVersionsDeleted (eventId, deleted) {
    if (process.env.STORAGE_ENGINE === 'sqlite') {
      const db = await localEvents.storage.forUser(userId);
      db.db.prepare('UPDATE events SET deleted = ? WHERE headId = ?').run(deleted, eventId);
      return;
    }
    await localEvents.db.query('UPDATE events SET deleted = $3 WHERE user_id = $1 AND head_id = $2', [userId, eventId, deleted]);
  }

  it('[EGVI1] answers unknown-resource for a history version id (read and update), and still serves the head event', async function () {
    const path = '/' + username + '/events';
    const created = await coreRequest.post(path).set('Authorization', personalToken)
      .send({ streamIds: ['egvi'], type: 'note/txt', content: 'first version' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const eventId = created.body.event.id;
    const updated = await coreRequest.put(path + '/' + eventId).set('Authorization', personalToken)
      .send({ content: 'second version' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const versionIds = await versionRowIds(eventId);
    assert.equal(versionIds.length, 1, 'premise: the update stored one history version');
    assert.notEqual(versionIds[0], eventId);

    const res = await coreRequest.get(path + '/' + versionIds[0]).set('Authorization', personalToken);
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error?.id, 'unknown-resource', JSON.stringify(res.body));
    const put = await coreRequest.put(path + '/' + versionIds[0]).set('Authorization', personalToken)
      .send({ content: 'rewritten history' });
    assert.equal(put.status, 404, JSON.stringify(put.body));

    const head = await coreRequest.get(path + '/' + eventId).set('Authorization', personalToken);
    assert.equal(head.status, 200, JSON.stringify(head.body));
    assert.equal(head.body.event.content, 'second version');
  });

  it('[EGVI2] the deletions listing holds head events only, even when a version row carries a deletion time', async function () {
    const deletionSettingsBefore = localEvents.deletionSettings;
    localEvents.deletionSettings = { mode: 'keep-everything', fields: ['integrity'], removeAttachments: false };
    let stampedEventId = null;
    try {
      const path = '/' + username + '/events';
      const since = Date.now() / 1000 - 1;
      const created = await coreRequest.post(path).set('Authorization', personalToken)
        .send({ streamIds: ['egvi'], type: 'note/txt', content: 'to delete' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const eventId = created.body.event.id;
      assert.equal((await coreRequest.put(path + '/' + eventId).set('Authorization', personalToken)
        .send({ content: 'updated' })).status, 200);
      assert.equal((await coreRequest.delete(path + '/' + eventId).set('Authorization', personalToken)).status, 200);
      assert.equal((await coreRequest.delete(path + '/' + eventId).set('Authorization', personalToken)).status, 200);

      // The API never stamps a version with a deletion time (a version is a
      // copy of the event before the change); stamp one directly, as a
      // restored or hand-edited store could hold.
      const versions = await versionRows(eventId);
      assert.ok(versions.length >= 1, 'premise: the event has history versions');
      assert.ok(versions.every((v) => v.deleted == null), 'premise: no version carries a deletion time: ' + JSON.stringify(versions));
      stampedEventId = eventId;
      await markVersionsDeleted(eventId, Date.now() / 1000);

      for (const query of [{ modifiedSince: since, includeDeletions: true }, { modifiedSince: since, includeDeletions: true, limit: 100 }]) {
        const res = await coreRequest.get(path).set('Authorization', personalToken).query(query);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const ids = (res.body.eventDeletions ?? []).map((d) => d.id);
        assert.ok(ids.includes(eventId), 'the deleted event is listed: ' + JSON.stringify(ids));
        for (const v of versions) {
          assert.ok(!ids.includes(v.id), 'a version row must not be listed as a deletion (query ' + JSON.stringify(query) + '): ' + JSON.stringify(res.body.eventDeletions));
        }
        assert.equal(ids.filter((id) => id === eventId).length, 1, 'the deleted event is listed once: ' + JSON.stringify(res.body.eventDeletions));
      }
    } finally {
      localEvents.deletionSettings = deletionSettingsBefore;
      // Back to the stored state, which the integrity check after each test verifies.
      if (stampedEventId != null) await markVersionsDeleted(stampedEventId, null);
    }
  });
});
