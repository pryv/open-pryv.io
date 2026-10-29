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
 * the stored version.
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
    if (process.env.STORAGE_ENGINE === 'sqlite') {
      const db = await localEvents.storage.forUser(userId);
      return db.db.prepare('SELECT eventid FROM events WHERE headId = ?').all(eventId).map((r) => r.eventid);
    }
    const res = await localEvents.db.query('SELECT id FROM events WHERE user_id = $1 AND head_id = $2', [userId, eventId]);
    return res.rows.map((r) => r.id);
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
});
