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

const { getConfig } = require('@pryv/boiler');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('api-server/test/test-helpers');
const charlatan = require('charlatan');
const cuid = require('cuid');
const { assert } = require('chai');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

describe('[AUDI] Audit logs events', () => {
  let config;
  let mongoFixtures;
  let server;
  let username;
  let auditToken, actionsToken, personalToken;
  let streamId;
  before(async function () {
    config = await getConfig();
    await SystemStreamsSerializer.init();
    if (!config.get('audit:active')) this.skip();

    mongoFixtures = databaseFixture(await produceMongoConnection());

    username = cuid();
    auditToken = 'audit-token';
    actionsToken = 'actions-token';
    personalToken = cuid();
    streamId = cuid();
    const user = await mongoFixtures.user(username);
    const stream = await user.stream({ id: streamId, name: charlatan.Lorem.word() });
    await stream.event({
      type: 'language/iso-639-1',
      content: charlatan.Lorem.characters(2)
    });
    await user.access({
      permissions: [
        {
          streamId: '*', level: 'manage'
        },
        {
          streamId: ':_system:account', level: 'read'
        }
      ],
      token: actionsToken,
      type: 'app'
    });
    await user.access({
      permissions: [{
        streamId: ':_audit:',
        level: 'read'
      }],
      token: auditToken,
      type: 'app'
    });
    await user.access({
      type: 'personal',
      token: personalToken
    });
    await user.session(personalToken);

    server = await context.spawn({
      dnsLess: { isActive: true }, // so updating account streams does not notify register
      audit: {
        active: true,
        storage: {
          filter: {
            methods: {
              include: ['all'],
              exclude: []
            }
          }
        }
      },
      syslog: {
        filter: {
          methods: {
            exclude: ['all'],
            include: []
          }
        }
      }
    });

    await post('/events', { streamIds: [stream.attrs.id], type: 'note/txt', content: charlatan.Lorem.text() }, {}, actionsToken);
    await get('/events', { trashed: false }, actionsToken);
  });

  after(async () => {
    if (config.get('openSource:isActive')) return;
    await server.stop();
    await mongoFixtures.clean();
    config.injectTestConfig({});
  });

  async function post (path, payload, query, token = auditToken) {
    return await server.request()
      .post('/' + username + path)
      .set('Authorization', token)
      .set('Content-Type', 'application/json')
      .send(payload);
  }
  async function get (path, query, token = auditToken) {
    if (token != null) {
      return await server.request()
        .get('/' + username + path)
        .set('Authorization', token)
        .query(query);
    } else { // to allow passing token in query
      return await server.request()
        .get('/' + username + path)
        .query(query);
    }
  }

  describe('GET /events', () => {
    it('[0BK7] must not return null values or trashed=false', async () => {
      const res = await get('/events', { streams: [':_audit:action-events.get'] }, personalToken);
      const events = res.body.events;
      assert.isNotNull(events[0]);
      const event = events[0];
      for (const [key, val] of Object.entries(event)) {
        assert.isNotNull(val, `"null" property ${key} of event is present.`);
      }
      if (event.trashed != null && event.trashed === false) assert.fail('trashed=false is present.');
    });
    it('[VBV0] must not return "auth" in "content:query"', async () => {
      await get('/events', { auth: actionsToken }, null);
      const res = await get('/events', { streams: [':_audit:action-events.get'] }, personalToken);
      const event = res.body.events[0];
      assert.notProperty(event.content.query, 'auth', 'token provided in query is present.');
    });
    it('[R8MS] must escape special characters', async () => {
      // it made the server crash
      const res = await get('/events', { streams: [':_system:username"'] }, personalToken); // trailing " (quote) in streamId parameter
      assert.equal(res.status, 400, 'status should be 400');
    });
  });

  describe('GET /audit/logs', () => {
    it('[RV4W] must return a valid id field', async () => {
      const res = await get('/audit/logs', {}, personalToken);
      const logs = res.body.auditLogs;
      for (const log of logs) {
        assert.notEqual(log.id.substring(':_audit:'.length), 'undefined');
      }
    });
  });
});
