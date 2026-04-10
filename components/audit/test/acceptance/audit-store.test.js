/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, cuid, initTests, initCore, coreRequest, getNewFixture, addActionStreamIdPrefix, addAccessStreamIdPrefix, charlatan */

const timestamp = require('unix-timestamp');

describe('[ASTE] Audit Streams and Events', function () {
  let user, username, password, access, appAccess, anotherAppAccess;
  let personalToken;
  let eventsPath, streamsPath, accessesPath;
  let mongoFixtures;

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
    streamsPath = '/' + username + '/streams/';
    appAccess = await createAppAccess(personalToken, 'app-access');
    anotherAppAccess = await createAppAccess(personalToken, 'another-app-access');
  });

  after(async function () {
    await mongoFixtures.clean();
  });

  async function createAppAccess (personalToken, token) {
    const res = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({
        type: 'app',
        name: 'app ' + token,
        token,
        permissions: [{ streamId, level: 'manage' }]
      });
    const access = res.body.access;
    assert.ok(access);
    return access;
  }
  function validGet (path, access) { return coreRequest.get(path).set('Authorization', access.token); }
  function validPost (path, access) { return coreRequest.post(path).set('Authorization', access.token); }

  let start, stop;
  before(async () => {
    start = timestamp.now();
    await validGet(eventsPath, appAccess);
    await validPost(eventsPath, appAccess)
      .send({ streamIds: [streamId], type: 'count/generic', content: 2 });
    stop = timestamp.now();
    await validGet(eventsPath, appAccess);
    await validGet(eventsPath, appAccess).query({ streams: ['other'] });
    await validGet(eventsPath, anotherAppAccess);
  });

  describe('[AS01] streams.get', () => {
    it('[U2PV] must retrieve access and actions substreams ', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({})
        .set('Authorization', appAccess.token);

      const expectedStreamids = ['yo', ':_audit:access-' + appAccess.id];
      assert.ok(res.body.streams);
      assert.strictEqual(res.body.streams.length, expectedStreamids.length);
      for (const stream of res.body.streams) {
        assert.ok(expectedStreamids.includes(stream.id));
      }
    });

    it('[D7WV] forbid listing of all accesses', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:accesses' })
        .set('Authorization', appAccess.token);
      assert.strictEqual(res.status, 403);
      assert.ok(res.body.error);
    });

    it('[7SGO] must allow listing one accesses (stream) with appAccess', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ id: ':_audit:access-' + appAccess.id })
        .set('Authorization', appAccess.token);
      assert.strictEqual(res.body.streams.length, 1);
      assert.strictEqual(res.body.streams[0].id, ':_audit:access-' + appAccess.id);
    });

    it('[XP27] must retrieve all available streams with a personal token', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:accesses' })
        .set('Authorization', personalToken);
      assert.ok(res.body.streams.length >= 2);
    });

    it('[WOIG] appToken must not retrieve list of available actions', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:actions' })
        .set('Authorization', appAccess.token);
      assert.strictEqual(res.status, 403);
      assert.ok(res.body.error);
    });

    it('[TFZL] personalToken must retrieve list of available actions', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:actions' })
        .set('Authorization', personalToken);
      assert.ok(res.body.streams);
      assert.ok(res.body.streams.length >= 1);
      for (const stream of res.body.streams) {
        assert.strictEqual(stream.id.startsWith(':_audit:action-'), true, 'StreamId should starts With ":_audit:actions-", found: "' + stream.id + '"');
      }
    });
  });

  describe('[AS02] events.get', () => {
    it('[TJ8S] must retrieve logs by time range', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', appAccess.token)
        .query({ streams: [':_audit:access-' + appAccess.id], fromTime: start, toTime: stop });
      assert.strictEqual(res.status, 200);
      const logs = res.body.events;
      assert.ok(logs.length >= 2);
      for (const event of logs) {
        assert.ok(event.time >= start);
        assert.ok(event.time <= stop);
      }
      validateResults(logs, appAccess.id);
    });

    it('[8AFA]  must retrieve logs by action', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', appAccess.token)
        .query({ streams: JSON.stringify([{ any: [':_audit:access-' + appAccess.id], all: [':_audit:action-events.get'] }]) });

      assert.strictEqual(res.status, 200);
      const logs = res.body.events;
      assert.ok(logs.length >= 1);
      for (const event of logs) {
        assert.ok(event.content);
        assert.strictEqual(event.content.action, 'events.get');
      }
      validateResults(logs, appAccess.id);
    });

    it('[0XRA]  personal token must retrieve all audit logs', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:'] });
      assert.strictEqual(res.status, 200);
      const logs = res.body.events;

      assert.ok(logs.length >= 5);
      validateResults(logs);
    });

    it('[31FM]  appAccess must retrieve only audit logs for this access (from auth token then converted by service-core)', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', appAccess.token)
        .query({ streams: [':_audit:access-' + appAccess.id] });
      assert.strictEqual(res.status, 200);
      const logs = res.body.events;
      assert.ok(logs.length >= 1);
      validateResults(logs, appAccess.id);
    });

    it('[BLR4]  Invalid token should return an error', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', 'invalid');
      assert.strictEqual(res.status, 403);
      assert.ok(res.body.error);
      assert.strictEqual(res.body.error.id, 'invalid-access-token');
    });
  });
});

function validateResults (auditLogs, expectedAccessId, expectedErrorId) {
  assert.ok(Array.isArray(auditLogs));

  auditLogs.forEach(event => {
    assert.ok(['audit-log/pryv-api', 'audit-log/pryv-api-error'].includes(event.type), 'wrong event type');

    assert.strictEqual(typeof event.id, 'string');
    assert.strictEqual(typeof event.time, 'number');

    assert.ok(event.content.query !== undefined);
    assert.strictEqual(typeof event.content.action, 'string');
    assert.ok(event.streamIds.includes(addActionStreamIdPrefix(event.content.action)), 'missing Action StreamId');

    assert.ok(event.content.source !== undefined);
    assert.strictEqual(typeof event.content.source.name, 'string');
    assert.strictEqual(typeof event.content.source.ip, 'string');

    if (expectedAccessId) {
      assert.ok(event.streamIds.includes(addAccessStreamIdPrefix(expectedAccessId)), '<< missing Access StreamId >>');
    }

    if (event.type === 'audit-log/pryv-api-error') {
      if (expectedErrorId) {
        assert.strictEqual(event.content.id, expectedErrorId);
      } else {
        assert.strictEqual(typeof event.content.id, 'string');
      }
      assert.strictEqual(typeof event.content.message, 'string');
    }
  });
}
