/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, cuid, initTests, initCore, charlatan, coreRequest, getNewFixture, addActionStreamIdPrefix, addAccessStreamIdPrefix, CONSTANTS */

const timestamp = require('unix-timestamp');

describe('[ALGR] Audit legacy route', function () {
  let user, username, password, access, appAccess;
  let personalToken;
  let mongoFixtures;
  let eventsPath, accessesPath, auditPath;

  const streamId = 'yo';
  before(async function () {
    await initTests();
    await initCore();
    password = cuid();
    mongoFixtures = getNewFixture();
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      password
    });

    username = user.attrs.username;
    await user.stream({ id: streamId, name: 'YO' });
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    personalToken = access.attrs.token;
    await user.session(personalToken);
    user = user.attrs;
    accessesPath = '/' + username + '/accesses/';
    eventsPath = '/' + username + '/events/';
    auditPath = '/' + username + '/audit/logs/';

    const res = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access', token: 'app-token', permissions: [{ streamId, level: 'manage' }] });
    appAccess = res.body.access;
    assert.ok(appAccess);
  });

  after(async function () {
    await mongoFixtures.clean();
  });

  function validGet (path) { return coreRequest.get(path).set('Authorization', appAccess.token); }
  function validPost (path) { return coreRequest.post(path).set('Authorization', appAccess.token); }

  let start, stop;
  before(async () => {
    start = timestamp.now();
    await validGet(eventsPath);
    await validPost(eventsPath)
      .send({ streamIds: [streamId], type: 'count/generic', content: 2 });
    stop = timestamp.now();
    await validGet(eventsPath);
    await validGet(eventsPath)
      .query({ streams: ['other'] });
  });

  it('[QXCH] must retrieve logs by time range', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token)
      .query({ fromTime: start, toTime: stop });
    assert.strictEqual(res.status, 200);
    const logs = res.body.auditLogs;
    assert.ok(logs.length >= 2);
    for (const event of logs) {
      assert.ok(event.time >= start);
      assert.ok(event.time <= stop);
    }
    validateResults(logs, appAccess.id);
  });

  it('[4FB8] must retrieve logs by action', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token)
      .query({ streams: [':_audit:action-events.get'] });
    assert.strictEqual(res.status, 200);
    const logs = res.body.auditLogs;
    assert.ok(logs.length >= 1);
    for (const event of logs) {
      assert.ok(event.content);
      assert.strictEqual(event.content.action, 'events.get');
    }
    validateResults(logs, appAccess.id);
  });

  it('[U9HQ] personal token must retrieve all audit logs', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', personalToken);
    assert.strictEqual(res.status, 200);
    const logs = res.body.auditLogs;
    assert.ok(logs.length >= 5);
    validateResults(res.body.auditLogs);
  });

  it('[6RP3] appAccess must retrieve only audit logs for this access (from auth token then converted by service-core)', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token);
    assert.strictEqual(res.status, 200);
    const logs = res.body.auditLogs;
    assert.ok(logs.length >= 1);
    validateResults(logs, appAccess.id);
  });

  it('[R1ZF] Invalid token should return an error', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', 'invalid');
    assert.strictEqual(res.status, 403);
    assert.ok(res.body.error);
    assert.strictEqual(res.body.error.id, 'invalid-access-token');
  });

  it('[RQUA] StreamId not starting with ":audit:"  should return an error', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token)
      .query({ streams: ['toto'] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
    assert.strictEqual(res.body.error.id, 'invalid-request-structure');
    assert.strictEqual(res.body.error.message, 'Invalid "streams" parameter. It should be an array of streamIds starting with Audit store prefix: ":_audit:"');
  });
});

function validateResults (auditLogs, expectedAccessId, expectedErrorId) {
  assert.ok(Array.isArray(auditLogs));

  auditLogs.forEach(event => {
    assert.strictEqual([CONSTANTS.EVENT_TYPE_VALID, CONSTANTS.EVENT_TYPE_ERROR].includes(event.type), true);
    assert.strictEqual(typeof event.id, 'string');
    assert.strictEqual(typeof event.time, 'number');

    assert.ok(event.content.query !== undefined);
    assert.strictEqual(typeof event.content.action, 'string');
    assert.ok(event.streamIds.includes(addActionStreamIdPrefix(event.content.action)), 'missing Action StreamId');

    assert.ok(event.content.source !== undefined);
    assert.strictEqual(typeof event.content.source.name, 'string');
    assert.strictEqual(typeof event.content.source.ip, 'string');

    if (expectedAccessId) {
      assert.ok(event.streamIds.includes(addAccessStreamIdPrefix(expectedAccessId)), 'missing Access StreamId');
    }

    if (expectedErrorId) {
      assert.ok(event.content.error !== undefined);
      assert.strictEqual(event.content.error.id, expectedErrorId);
      assert.strictEqual(typeof event.content.error.message, 'string');
    }
  });
}
