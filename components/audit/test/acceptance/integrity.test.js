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

/* global assert, cuid, initTests, initCore, coreRequest, getNewFixture, charlatan */

const { integrity } = require('business');
const timestamp = require('unix-timestamp');

describe('Audit events integrity', function () {
  let user, username, password, access, appAccess;
  let personalToken;
  let mongoFixtures;
  let eventsPath, accessesPath;
  let auditedEvent;

  const streamId = 'yo';
  const now = timestamp.now();

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

    const res = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access', token: 'app-token', permissions: [{ streamId, level: 'manage' }] });
    appAccess = res.body.access;
  });

  after(async function () {
    await mongoFixtures.clean();
  });

  function validPost (path) { return coreRequest.post(path).set('Authorization', appAccess.token); }

  before(async () => {
    auditedEvent = (await validPost(eventsPath).send({ streamIds: [streamId], type: 'count/generic', content: 2 })).body.event;
  });

  it('[XLEL] created access has integrity', async () => {
    assert.exists(appAccess.integrity);
  });

  it('[ZKVC] created event has integrity', async () => {
    assert.exists(auditedEvent.integrity);
  });

  it('[WNWM] must find event integrity key and record value in the audit log ', async () => {
    const res = await coreRequest
      .get(eventsPath)
      .set('Authorization', appAccess.token)
      .query({ fromTime: now, streams: ':_audit:' });

    assert.exists(res.body?.events);
    assert.equal(1, res.body.events.length);

    const auditEvent = res.body.events[0];
    assert.exists(auditEvent.content.record);
    assert.equal(auditedEvent.integrity, auditEvent.content.record.integrity);

    const computedIntegrity = integrity.events.compute(auditedEvent);
    assert.equal(computedIntegrity.integrity, auditEvent.content.record.integrity);
    assert.equal(computedIntegrity.key, auditEvent.content.record.key);
  });

  it('[U09J] must find access integrity key and record value in the audit log ', async () => {
    const res = await coreRequest
      .get(eventsPath)
      .set('Authorization', personalToken)
      .query({ fromTime: now, streams: ':_audit:action-accesses.create' });

    assert.equal(1, res?.body?.events?.length);

    const auditEvent = res.body.events[0];
    assert.exists(auditEvent.content.record);
    assert.equal(appAccess.integrity, auditEvent.content.record.integrity);

    const computedIntegrity = integrity.accesses.compute(appAccess);
    assert.equal(computedIntegrity.integrity, auditEvent.content.record.integrity);
    assert.equal(computedIntegrity.key, auditEvent.content.record.key);
  });
});
