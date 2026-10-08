/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Account events carry the times recorded when their field was set, not the
 * time of the read (Pattern C): time filters, `modifiedSince` and integrity
 * hashes behave as they do for ordinary events.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');

const LANGUAGE = ':_system:language';

describe('[ATMS] account events times', function () {
  this.timeout(30000);
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  after(async function () {
    await fixtures.clean();
  });

  async function makeUser () {
    const username = 'atm' + cuid().toLowerCase().slice(1, 12);
    const token = cuid();
    const user = await fixtures.user(username, { email: cuid() + '@atm.example.com' });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    return { username, token };
  }

  async function getLanguageEvents (u, query = {}) {
    const res = await coreRequest.get('/' + u.username + '/events').set('Authorization', u.token)
      .query(Object.assign({ streams: JSON.stringify([LANGUAGE]) }, query));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events;
  }

  async function setLanguage (u, language) {
    const res = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token)
      .send({ language });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  it('[ATM03] two reads return the same times and integrity, and time filters use the stored time', async function () {
    const u = await makeUser();
    const before = timestamp.now();
    await setLanguage(u, 'fr');
    const after = timestamp.now();

    const [first] = await getLanguageEvents(u);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [second] = await getLanguageEvents(u);
    assert.ok(first, 'language event expected');
    assert.strictEqual(first.content, 'fr');
    assert.strictEqual(second.time, first.time);
    assert.strictEqual(second.modified, first.modified);
    assert.strictEqual(typeof first.integrity, 'string', 'integrity is on in the test config');
    assert.strictEqual(second.integrity, first.integrity);
    assert.ok(first.time >= before - 1 && first.time <= after + 1, 'time is when the field was set');

    assert.strictEqual((await getLanguageEvents(u, { modifiedSince: after + 10 })).length, 0);
    assert.strictEqual((await getLanguageEvents(u, { modifiedSince: before - 10 })).length, 1);
    assert.strictEqual((await getLanguageEvents(u, { fromTime: after + 10, toTime: after + 20 })).length, 0);
    assert.strictEqual((await getLanguageEvents(u, { fromTime: before - 10, toTime: after + 10 })).length, 1);
  });

  it('[ATM04] account.update moves time and modified; created keeps the first time', async function () {
    const u = await makeUser();
    await setLanguage(u, 'fr');
    const [initial] = await getLanguageEvents(u);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setLanguage(u, 'de');
    const [updated] = await getLanguageEvents(u);
    assert.strictEqual(updated.content, 'de');
    assert.ok(updated.modified > initial.modified, 'modified moves on update');
    assert.ok(updated.time > initial.time, 'time follows the current value');
    assert.strictEqual(updated.created, initial.created, 'created is the first time');

    const one = await coreRequest.get('/' + u.username + '/events/' + encodeURIComponent(LANGUAGE))
      .set('Authorization', u.token);
    assert.strictEqual(one.status, 200, JSON.stringify(one.body));
    assert.strictEqual(one.body.event.time, updated.time);
    assert.strictEqual(one.body.event.created, updated.created);
  });
});
