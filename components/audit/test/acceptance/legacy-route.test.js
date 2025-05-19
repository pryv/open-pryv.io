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

/* global assert, cuid, initTests, initCore, charlatan, coreRequest, getNewFixture, addActionStreamIdPrefix, addAccessStreamIdPrefix, CONSTANTS */

const timestamp = require('unix-timestamp');

describe('Audit legacy route', function () {
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
    assert.exists(appAccess);
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
    assert.equal(res.status, 200);
    const logs = res.body.auditLogs;
    assert.isAtLeast(logs.length, 2);
    for (const event of logs) {
      assert.isAtLeast(event.time, start);
      assert.isAtMost(event.time, stop);
    }
    validateResults(logs, appAccess.id);
  });

  it('[4FB8] must retrieve logs by action', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token)
      .query({ streams: [':_audit:action-events.get'] });
    assert.equal(res.status, 200);
    const logs = res.body.auditLogs;
    assert.isAtLeast(logs.length, 1);
    for (const event of logs) {
      assert.exists(event.content);
      assert.equal(event.content.action, 'events.get');
    }
    validateResults(logs, appAccess.id);
  });

  it('[U9HQ] personal token must retrieve all audit logs', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', personalToken);
    assert.strictEqual(res.status, 200);
    const logs = res.body.auditLogs;
    assert.isAtLeast(logs.length, 5);
    validateResults(res.body.auditLogs);
  });

  it('[6RP3] appAccess must retrieve only audit logs for this access (from auth token then converted by service-core)', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token);
    assert.strictEqual(res.status, 200);
    const logs = res.body.auditLogs;
    assert.isAtLeast(logs.length, 1);
    validateResults(logs, appAccess.id);
  });

  it('[R1ZF] Invalid token should return an error', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', 'invalid');
    assert.strictEqual(res.status, 403);
    assert.exists(res.body.error);
    assert.equal(res.body.error.id, 'invalid-access-token');
  });

  it('[RQUA] StreamId not starting with ":audit:"  should return an error', async () => {
    const res = await coreRequest
      .get(auditPath)
      .set('Authorization', appAccess.token)
      .query({ streams: ['toto'] });
    assert.strictEqual(res.status, 400);
    assert.exists(res.body.error);
    assert.equal(res.body.error.id, 'invalid-request-structure');
    assert.equal(res.body.error.message, 'Invalid "streams" parameter. It should be an array of streamIds starting with Audit store prefix: ":_audit:"');
  });
});

function validateResults (auditLogs, expectedAccessId, expectedErrorId) {
  assert.isArray(auditLogs);

  auditLogs.forEach(event => {
    assert.isTrue([CONSTANTS.EVENT_TYPE_VALID, CONSTANTS.EVENT_TYPE_ERROR].includes(event.type));
    assert.isString(event.id);
    assert.isNumber(event.time);

    assert.isDefined(event.content.query);
    assert.isString(event.content.action);
    assert.include(event.streamIds, addActionStreamIdPrefix(event.content.action), 'missing Action StreamId');

    assert.isDefined(event.content.source);
    assert.isString(event.content.source.name);
    assert.isString(event.content.source.ip);

    if (expectedAccessId) {
      assert.include(event.streamIds, addAccessStreamIdPrefix(expectedAccessId), 'missing Access StreamId');
    }

    if (expectedErrorId) {
      assert.isDefined(event.content.error);
      assert.strictEqual(event.content.error.id, expectedErrorId);
      assert.isString(event.content.error.message);
    }
  });
}
