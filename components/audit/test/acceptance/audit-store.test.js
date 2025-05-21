/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

/* global assert, cuid, initTests, initCore, coreRequest, getNewFixture, addActionStreamIdPrefix, addAccessStreamIdPrefix, charlatan */

const timestamp = require('unix-timestamp');

describe('Audit Streams and Events', function () {
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
    assert.exists(access);
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

  describe('streams.get', () => {
    it('[U2PV] must retrieve access and actions substreams ', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({})
        .set('Authorization', appAccess.token);

      const expectedStreamids = ['yo', ':_audit:access-' + appAccess.id];
      assert.exists(res.body.streams);
      assert.equal(res.body.streams.length, expectedStreamids.length);
      for (const stream of res.body.streams) {
        assert.include(expectedStreamids, stream.id);
      }
    });

    it('[D7WV] forbid listing of all accesses', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:accesses' })
        .set('Authorization', appAccess.token);
      assert.equal(res.status, 403);
      assert.exists(res.body.error);
    });

    it('[7SGO] must allow listing one accesses (stream) with appAccess', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ id: ':_audit:access-' + appAccess.id })
        .set('Authorization', appAccess.token);
      assert.equal(res.body.streams.length, 1);
      assert.equal(res.body.streams[0].id, ':_audit:access-' + appAccess.id);
    });

    it('[XP27] must retrieve all available streams with a personal token', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:accesses' })
        .set('Authorization', personalToken);
      assert.isAtLeast(res.body.streams.length, 2);
    });

    it('[WOIG] appToken must not retrieve list of available actions', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:actions' })
        .set('Authorization', appAccess.token);
      assert.equal(res.status, 403);
      assert.exists(res.body.error);
    });

    it('[TFZL] personalToken must retrieve list of available actions', async () => {
      const res = await coreRequest
        .get(streamsPath)
        .query({ parentId: ':_audit:actions' })
        .set('Authorization', personalToken);
      assert.exists(res.body.streams);
      assert.isAtLeast(res.body.streams.length, 1);
      for (const stream of res.body.streams) {
        assert.isTrue(stream.id.startsWith(':_audit:action-'), 'StreamId should starts With ":_audit:actions-", found: "' + stream.id + '"');
      }
    });
  });

  describe('events.get', () => {
    it('[TJ8S] must retrieve logs by time range', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', appAccess.token)
        .query({ streams: [':_audit:access-' + appAccess.id], fromTime: start, toTime: stop });
      assert.equal(res.status, 200);
      const logs = res.body.events;
      assert.isAtLeast(logs.length, 2);
      for (const event of logs) {
        assert.isAtLeast(event.time, start);
        assert.isAtMost(event.time, stop);
      }
      validateResults(logs, appAccess.id);
    });

    it('[8AFA]  must retrieve logs by action', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', appAccess.token)
        .query({ streams: JSON.stringify([{ any: [':_audit:access-' + appAccess.id], all: [':_audit:action-events.get'] }]) });

      assert.equal(res.status, 200);
      const logs = res.body.events;
      assert.isAtLeast(logs.length, 1);
      for (const event of logs) {
        assert.exists(event.content);
        assert.equal(event.content.action, 'events.get');
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

      assert.isAtLeast(logs.length, 5);
      validateResults(logs);
    });

    it('[31FM]  appAccess must retrieve only audit logs for this access (from auth token then converted by service-core)', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', appAccess.token)
        .query({ streams: [':_audit:access-' + appAccess.id] });
      assert.strictEqual(res.status, 200);
      const logs = res.body.events;
      assert.isAtLeast(logs.length, 1);
      validateResults(logs, appAccess.id);
    });

    it('[BLR4]  Invalid token should return an error', async () => {
      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', 'invalid');
      assert.strictEqual(res.status, 403);
      assert.exists(res.body.error);
      assert.equal(res.body.error.id, 'invalid-access-token');
    });
  });
});

function validateResults (auditLogs, expectedAccessId, expectedErrorId) {
  assert.isArray(auditLogs);

  auditLogs.forEach(event => {
    assert.include(['audit-log/pryv-api', 'audit-log/pryv-api-error'], event.type, 'wrong event type');

    assert.isString(event.id);
    assert.isNumber(event.time);

    assert.isDefined(event.content.query);
    assert.isString(event.content.action);
    assert.include(event.streamIds, addActionStreamIdPrefix(event.content.action), 'missing Action StreamId');

    assert.isDefined(event.content.source);
    assert.isString(event.content.source.name);
    assert.isString(event.content.source.ip);

    if (expectedAccessId) {
      assert.include(event.streamIds, addAccessStreamIdPrefix(expectedAccessId), '<< missing Access StreamId >>');
    }

    if (event.type === 'audit-log/pryv-api-error') {
      if (expectedErrorId) {
        assert.strictEqual(event.content.id, expectedErrorId);
      } else {
        assert.isString(event.content.id);
      }
      assert.isString(event.content.message);
    }
  });
}
