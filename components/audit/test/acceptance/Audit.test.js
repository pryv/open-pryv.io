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

/* global assert, path, charlatan, cuid, audit, config, initTests, initCore, coreRequest, getNewFixture, addActionStreamIdPrefix, addAccessStreamIdPrefix, apiMethods, fakeAuditEvent, CONSTANTS, sinon, MethodContextUtils, CONSTANTS, AuditAccessIds */

const timestamp = require('unix-timestamp');

describe('Audit', function () {
  let user, username, password, access, readAccess;
  let eventsPath, auditPath;

  let sysLogSpy, storageSpy;
  let mongoFixtures;

  before(async function () {
    await initTests();
    await initCore();
    password = cuid();
    mongoFixtures = getNewFixture();
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      password
    });
    sysLogSpy = sinon.spy(audit.syslog, 'eventForUser');
    storageSpy = sinon.spy(audit.storage, 'forUser');

    username = user.attrs.username;
    await user.stream({ id: 'yo', name: 'YO' });
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);
    readAccess = await user.access({
      type: 'app',
      token: cuid(),
      permissions: [{ streamId: 'yo', level: 'read' }]
    });
    readAccess = readAccess.attrs;
    user = user.attrs;
    eventsPath = '/' + username + '/events/';
    auditPath = '/' + username + '/audit/logs/';
  });

  function createUserPath (suffixPath) {
    return path.join('/', username, suffixPath);
  }

  function resetSpies () {
    sysLogSpy.resetHistory();
    storageSpy.resetHistory();
  }

  after(async function () {
    await mongoFixtures.clean();
  });

  describe('when making valid API calls', function () {
    let res, now;
    const query = { limit: '1' }; // casting to string as audit saves query before coercion
    before(async function () {
      now = timestamp.now();
      res = await coreRequest
        .get(eventsPath)
        .set('Authorization', access.token)
        .query(query);
    });

    it('[WTNL] must return 200', function () {
      assert.equal(res.status, 200);
    });
    it('[UZEV] must return logs when queried', async function () {
      res = await coreRequest
        .get(auditPath)
        .set('Authorization', access.token);
      const logs = res.body.auditLogs;
      assert.exists(logs);
      assert.equal(logs.length, 1);
      const log = logs[0];
      assert.deepEqual(log.streamIds, [addAccessStreamIdPrefix(access.id), addActionStreamIdPrefix('events.get')], 'stream Id of audit log is not access Id');
      assert.equal(log.content.source.name, 'http', 'source name is wrong');
      assert.equal(log.content.action, 'events.get', 'action is wrong');
      assert.approximately(log.created, now, 0.5, 'created timestamp is off');
      assert.approximately(log.modified, now, 0.5, 'modified timestamp is off');
      assert.deepEqual(log.content.query, query);
      assert.equal(log.type, CONSTANTS.EVENT_TYPE_VALID);
    });

    describe('when making a call that is not audited', function () {
      before(async function () {
        assert.isUndefined(apiMethods.AUDITED_METHODS_MAP['service.info']);
        resetSpies();
        now = timestamp.now();
        res = await coreRequest
          .get(createUserPath('/service/info'));
      });

      it('[NJFO] must return 200', function () {
        assert.equal(res.status, 200);
      });
      it('[V10L] must not log it in syslog', function () {
        assert.isFalse(sysLogSpy.calledOnce);
      });
      it('[9RWP] must not save it to storage', function () {
        assert.isFalse(storageSpy.calledOnce);
      });
    });
    describe('when making a call that has its own custom accessId', function () {
      let log;
      before(async function () {
        resetSpies();
        now = timestamp.now();
        res = await coreRequest
          .post(createUserPath('/auth/login'))
          .set('Origin', 'https://sw.backloop.dev')
          .send({
            username,
            password,
            appId: 'whatever'
          });
      });

      it('[81O6] must return 200', function () {
        assert.equal(res.status, 200);
      });
      it('[L92X] must log it in syslog', function () {
        assert.isTrue(sysLogSpy.calledOnce);
      });
      it('[G7UV] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        log = entries[0];
        assert.include(log.streamIds, addAccessStreamIdPrefix(MethodContextUtils.AuditAccessIds.VALID_PASSWORD), 'custom accessId saved to streamIds');
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_VALID);
      });
    });
    describe('when making a call that has no userId', function () {
      before(async function () {
        resetSpies();
        res = await coreRequest
          .post('/users')
          .send({
            username: cuid().substring(2, 26),
            password: cuid(),
            appId: 'whatever',
            email: cuid(),
            insurancenumber: '123'
          });
      });

      it('[JU8F] must return 201', function () {
        assert.equal(res.status, 201);
      });
      it('[KPPH] must log it in syslog', function () {
        assert.isTrue(sysLogSpy.calledOnce);
      });
      it('[EI1U] must not log it to storage', async function () {
        assert.isFalse(storageSpy.calledOnce);
      });
    });
  });

  describe('when making invalid API calls', function () {
    let res;
    describe('for an unknown user', function () {
      before(async function () {
        resetSpies();
        res = await coreRequest
          .get('/unknown-username/events/')
          .set('Authorization', 'doesnt-matter');
      });
      it('[LFSW] must return 400', function () {
        assert.equal(res.status, 404);
      });
      it('[GM2Y] must not log it in syslog', function () {
        assert.isFalse(sysLogSpy.calledOnce);
      });
      it('[2IQO] must not save it to storage', function () {
        assert.isFalse(storageSpy.calledOnce);
      });
    });
    describe('with errorId "invalid-request-structure"', function () {
      let now;
      const query = { streams: JSON.stringify({ any: ['A', 'Z', true] }) }; // copied from 30NV
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .get(eventsPath)
          .set('Authorization', access.token)
          .query(query);
      });
      it('[7SUK] must return 400', function () {
        assert.equal(res.status, 400);
      });
      it('[N5OS] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        const log = entries[0];
        assert.equal(log.content.id, 'invalid-request-structure');
        assert.deepEqual(log.content.query, query);
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('with errorId "invalid-parameters-format"', function () {
      let now;
      const query = { fromTime: 'yo' };
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .get(eventsPath)
          .set('Authorization', access.token)
          .query(query);
      });
      it('[XX4D] must return 400', function () {
        assert.equal(res.status, 400);
      });
      it('[BZT8] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        const log = entries[0];
        assert.equal(log.content.id, 'invalid-parameters-format');
        assert.deepEqual(log.content.query, query);
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('with errorId "unknown-referenced-resource"', function () {
      let now;
      const query = { streams: ['does-not-exist', 'neither'] };
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .get(eventsPath)
          .set('Authorization', access.token)
          .query(query);
      });
      it('[9ZGI] must return 400', function () {
        assert.equal(res.status, 400);
      });
      it('[OBQ8] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        const log = entries[0];
        assert.equal(log.content.id, 'unknown-referenced-resource');
        assert.deepEqual(log.content.query, query);
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('with errorId "invalid-access-token"', function () {
      let now;
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .get(eventsPath)
          .set('Authorization', 'invalid-token');
      });
      it('[ASLZ] must return 403', function () {
        assert.equal(res.status, 403);
      });
      it('[6CZ0] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        const log = entries[0];
        assert.equal(log.content.id, 'invalid-access-token');
        assert.deepEqual(log.streamIds, [addAccessStreamIdPrefix(AuditAccessIds.INVALID), addActionStreamIdPrefix('events.get')]);
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('with errorId "forbidden"', function () {
      let now;
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .post(eventsPath)
          .set('Authorization', readAccess.token)
          .send({
            streamIds: ['yo'],
            type: 'note/txt',
            content: 'yo'
          });
      });
      it('[WUUW] must return 403', function () {
        assert.equal(res.status, 403);
      });
      it('[14LS] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        const log = entries[0];
        assert.equal(log.content.id, 'forbidden');
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('with errorId "unknown-resource"', function () {
      let now;
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .post(eventsPath + 'does-not-exist')
          .set('Authorization', access.token);
      });
      it('[176G] must return 404', function () {
        assert.equal(res.status, 404);
      });
      it('[7132] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 1);
        const log = entries[0];
        assert.equal(log.content.id, 'unknown-resource');
        assert.equal(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('with a malformed request body', function () {
      let now;
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .post(eventsPath)
          .set('Authorization', access.token)
          .set('Content-Type', 'application/json')
          .send('{"i am malformed"}');
      });
      it('[DZDP] must return 400', function () {
        assert.equal(res.status, 400);
      });
      it('[ZNP4] must not record logs', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.equal(res.status, 200);
        const entries = res.body.auditLogs;
        assert.exists(entries);
        assert.equal(entries.length, 0);
      });
    });
  });

  describe('Filtering', function () {
    describe('when filtering by calledMethods', function () {
      after(async function () {
        config.injectTestConfig({});
        await audit.reloadConfig();
      });
      describe('when including all', function () {
        before(async function () {
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: ['all'], exclude: [] } } },
              storage: { filter: { methods: { include: ['all'], exclude: [] } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
        });
        it('[ADZL] must log it in syslog', function () {
          const numAudited = apiMethods.AUDITED_METHODS.length;
          assert.equal(sysLogSpy.callCount, numAudited);
        });
        it('[5243] must save it to storage', function () {
          const numStored = apiMethods.AUDITED_METHODS.length - apiMethods.WITHOUT_USER_METHODS.length;
          assert.equal(storageSpy.callCount, numStored);
        });
      });
      describe('when including all, but a few', function () {
        const exclude = ['events.get', 'auth.register', 'streams.create'];
        before(async function () {
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: [], exclude } } },
              storage: { filter: { methods: { include: [], exclude } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
        });
        it('[Q2H9] must log it in syslog', function () {
          const logged = apiMethods.AUDITED_METHODS.filter(m => !exclude.includes(m));
          assert.equal(sysLogSpy.callCount, logged.length);
        });
        it('[BGXC] must save it to storage', function () {
          const stored = apiMethods.AUDITED_METHODS
            .filter(m => !apiMethods.WITHOUT_USER_METHODS.includes(m))
            .filter(m => !exclude.includes(m));
          assert.equal(storageSpy.callCount, stored.length);
        });
      });
      describe('when only including a few', function () {
        const include = ['events.get', 'auth.register', 'streams.create'];
        before(async function () {
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include, exclude: [] } } },
              storage: { filter: { methods: { include, exclude: [] } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
        });
        it('[WDZ9] must log it in syslog', function () {
          const logged = apiMethods.AUDITED_METHODS.filter(m => include.includes(m));
          assert.equal(sysLogSpy.callCount, logged.length);
        });
        it('[E7S0] must save it to storage', function () {
          const stored = apiMethods.AUDITED_METHODS
            .filter(m => !apiMethods.WITHOUT_USER_METHODS.includes(m))
            .filter(m => include.includes(m));
          assert.equal(storageSpy.callCount, stored.length);
        });
      });
      describe('when including nothing', function () {
        before(async function () {
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: [], exclude: ['all'] } } },
              storage: { filter: { methods: { include: [], exclude: ['all'] } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
        });
        it('[NP6H] must log it in syslog', function () {
          assert.equal(sysLogSpy.callCount, 0);
        });
        it('[LV1C] must save it to storage', function () {
          assert.equal(storageSpy.callCount, 0);
        });
      });
      describe('when using a method aggregate (here "events.all")', function () {
        const auditedMethods = [];
        before(async function () {
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: ['events.all'], exclude: [] } } },
              storage: { filter: { methods: { include: ['events.all'], exclude: [] } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            if (method.startsWith('events.')) auditedMethods.push(method);
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
        });
        it('[L2KG] must log it in syslog', function () {
          assert.equal(sysLogSpy.callCount, auditedMethods.length);
        });
        it('[HSQS] must save it to storage', function () {
          assert.equal(storageSpy.callCount, auditedMethods.length);
        });
      });
      describe('when excluding a few', function () {
        let stored = [];
        let logged = [];
        before(async function () {
          const excluded = ['events.get', 'auth.login', 'auth.register'];
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: [], exclude: excluded } } },
              storage: { filter: { methods: { include: [], exclude: excluded } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
          stored = apiMethods.WITH_USER_METHODS.filter(m => !excluded.includes(m));
          logged = apiMethods.AUDITED_METHODS.filter(m => !excluded.includes(m));
        });
        it('[JBPZ] must log it in syslog', function () {
          assert.equal(sysLogSpy.callCount, logged.length);
        });
        it('[1ESH] must save it to storage', function () {
          assert.equal(storageSpy.callCount, stored.length);
        });
      });
      describe('when including and excluding some - without intersection', function () {
        let stored = [];
        let logged = [];
        before(async function () {
          const included = ['events.all', 'getAccessInfo'];
          const excluded = ['streams.all', 'auth.login', 'auth.register'];
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: included, exclude: excluded } } },
              storage: { filter: { methods: { include: included, exclude: excluded } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
          stored = apiMethods.WITH_USER_METHODS.filter(m => (m.startsWith('events.') || m === 'getAccessInfo'));
          logged = apiMethods.WITH_USER_METHODS.filter(m => (m.startsWith('events.') || m === 'getAccessInfo'));
        });
        it('[6GVQ] must log it in syslog', function () {
          assert.equal(sysLogSpy.callCount, logged.length);
        });
        it('[R7BF] must save it to storage', function () {
          assert.equal(storageSpy.callCount, stored.length);
        });
      });
      describe('when including and excluding some - with intersection', function () {
        let stored = [];
        let logged = [];
        before(async function () {
          const included = ['events.all'];
          const excluded = ['events.get'];
          config.injectTestConfig({
            audit: {
              syslog: { filter: { methods: { include: included, exclude: excluded } } },
              storage: { filter: { methods: { include: included, exclude: excluded } } }
            }
          });
          await audit.reloadConfig();
          resetSpies();
          apiMethods.ALL_METHODS.forEach(method => {
            audit.eventForUser(cuid(), fakeAuditEvent(method));
          });
          stored = apiMethods.WITH_USER_METHODS.filter(m => (m.startsWith('events.') && m !== 'events.get'));
          logged = apiMethods.WITH_USER_METHODS.filter(m => (m.startsWith('events.') && m !== 'events.get'));
        });
        it('[UK0K] must log it in syslog', function () {
          assert.equal(sysLogSpy.callCount, logged.length);
        });
        it('[UOFZ] must save it to storage', function () {
          assert.equal(storageSpy.callCount, stored.length);
        });
      });
    });
  });
});
