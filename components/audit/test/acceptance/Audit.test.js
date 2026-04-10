/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, path, charlatan, cuid, audit, config, initTests, initCore, coreRequest, getNewFixture, addActionStreamIdPrefix, addAccessStreamIdPrefix, apiMethods, fakeAuditEvent, CONSTANTS, sinon, MethodContextUtils, CONSTANTS, AuditAccessIds */

const timestamp = require('unix-timestamp');

describe('[AUDT] Audit', function () {
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

  describe('[AT01] when making valid API calls', function () {
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
      assert.strictEqual(res.status, 200);
    });
    it('[UZEV] must return logs when queried', async function () {
      res = await coreRequest
        .get(auditPath)
        .set('Authorization', access.token);
      const logs = res.body.auditLogs;
      assert.ok(logs);
      assert.strictEqual(logs.length, 1);
      const log = logs[0];
      assert.deepEqual(log.streamIds, [addAccessStreamIdPrefix(access.id), addActionStreamIdPrefix('events.get')], 'stream Id of audit log is not access Id');
      assert.strictEqual(log.content.source.name, 'http', 'source name is wrong');
      assert.strictEqual(log.content.action, 'events.get', 'action is wrong');
      assert.ok(Math.abs(log.created - now) <= 0.5, 'created timestamp is off');
      assert.ok(Math.abs(log.modified - now) <= 0.5, 'modified timestamp is off');
      assert.deepEqual(log.content.query, query);
      assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_VALID);
    });

    describe('[AT02] when making a call that is not audited', function () {
      before(async function () {
        assert.strictEqual(apiMethods.AUDITED_METHODS_MAP['service.info'], undefined);
        resetSpies();
        now = timestamp.now();
        res = await coreRequest
          .get(createUserPath('/service/info'));
      });

      it('[NJFO] validates the response', function () {
        assert.strictEqual(res.status, 200, '[NJFO] must return 200');
        assert.strictEqual(sysLogSpy.calledOnce, false, '[V10L] must not log it in syslog');
        assert.strictEqual(storageSpy.calledOnce, false, '[9RWP] must not save it to storage');
      });
    });
    describe('[AT03] when making a call that has its own custom accessId', function () {
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

      it('[81O6] validates the response', function () {
        assert.strictEqual(res.status, 200, '[81O6] must return 200');
        assert.strictEqual(sysLogSpy.calledOnce, true, '[L92X] must log it in syslog');
      });
      it('[G7UV] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        log = entries[0];
        assert.ok(log.streamIds.includes(addAccessStreamIdPrefix(MethodContextUtils.AuditAccessIds.VALID_PASSWORD)), 'custom accessId saved to streamIds');
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_VALID);
      });
    });
    describe('[AT04] when making a call that has no userId', function () {
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

      it('[JU8F] validates the response', function () {
        assert.strictEqual(res.status, 201, '[JU8F] must return 201');
        assert.strictEqual(sysLogSpy.calledOnce, true, '[KPPH] must log it in syslog');
        assert.strictEqual(storageSpy.calledOnce, false, '[EI1U] must not log it to storage');
      });
    });
  });

  describe('[AT05] when making invalid API calls', function () {
    let res;
    describe('[AT51] for an unknown user', function () {
      before(async function () {
        resetSpies();
        res = await coreRequest
          .get('/unknown-username/events/')
          .set('Authorization', 'doesnt-matter');
      });
      it('[LFSW] validates the response', function () {
        assert.strictEqual(res.status, 404, '[LFSW] must return 404');
        assert.strictEqual(sysLogSpy.calledOnce, false, '[GM2Y] must not log it in syslog');
        assert.strictEqual(storageSpy.calledOnce, false, '[2IQO] must not save it to storage');
      });
    });
    describe('[AT52] with errorId "invalid-request-structure"', function () {
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
        assert.strictEqual(res.status, 400);
      });
      it('[N5OS] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        const log = entries[0];
        assert.strictEqual(log.content.id, 'invalid-request-structure');
        assert.deepEqual(log.content.query, query);
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('[AT53] with errorId "invalid-parameters-format"', function () {
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
        assert.strictEqual(res.status, 400);
      });
      it('[BZT8] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        const log = entries[0];
        assert.strictEqual(log.content.id, 'invalid-parameters-format');
        assert.deepEqual(log.content.query, query);
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('[AT54] with errorId "unknown-referenced-resource"', function () {
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
        assert.strictEqual(res.status, 400);
      });
      it('[OBQ8] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        const log = entries[0];
        assert.strictEqual(log.content.id, 'unknown-referenced-resource');
        assert.deepEqual(log.content.query, query);
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('[AT55] with errorId "invalid-access-token"', function () {
      let now;
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .get(eventsPath)
          .set('Authorization', 'invalid-token');
      });
      it('[ASLZ] must return 403', function () {
        assert.strictEqual(res.status, 403);
      });
      it('[6CZ0] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        const log = entries[0];
        assert.strictEqual(log.content.id, 'invalid-access-token');
        assert.deepEqual(log.streamIds, [addAccessStreamIdPrefix(AuditAccessIds.INVALID), addActionStreamIdPrefix('events.get')]);
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('[AT56] with errorId "forbidden"', function () {
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
        assert.strictEqual(res.status, 403);
      });
      it('[14LS] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        const log = entries[0];
        assert.strictEqual(log.content.id, 'forbidden');
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('[AT57] with errorId "unknown-resource"', function () {
      let now;
      before(async function () {
        now = timestamp.now();
        res = await coreRequest
          .post(eventsPath + 'does-not-exist')
          .set('Authorization', access.token);
      });
      it('[176G] must return 404', function () {
        assert.strictEqual(res.status, 404);
      });
      it('[7132] must return logs when queried', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 1);
        const log = entries[0];
        assert.strictEqual(log.content.id, 'unknown-resource');
        assert.strictEqual(log.type, CONSTANTS.EVENT_TYPE_ERROR);
      });
    });
    describe('[AT58] with a malformed request body', function () {
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
        assert.strictEqual(res.status, 400);
      });
      it('[ZNP4] must not record logs', async function () {
        res = await coreRequest
          .get(auditPath)
          .set('Authorization', access.token)
          .query({ fromTime: now });
        assert.strictEqual(res.status, 200);
        const entries = res.body.auditLogs;
        assert.ok(entries);
        assert.strictEqual(entries.length, 0);
      });
    });
  });

  describe('[AT06] Filtering', function () {
    describe('[AT61] when filtering by calledMethods', function () {
      after(async function () {
        config.injectTestConfig({});
        await audit.reloadConfig();
      });
      describe('[AT62] when including all', function () {
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
        it('[ADZL] validates logging and storage', function () {
          const numAudited = apiMethods.AUDITED_METHODS.length;
          const numStored = apiMethods.AUDITED_METHODS.length - apiMethods.WITHOUT_USER_METHODS.length;
          assert.strictEqual(sysLogSpy.callCount, numAudited, '[ADZL] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, numStored, '[5243] must save it to storage');
        });
      });
      describe('[AT63] when including all, but a few', function () {
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
        it('[Q2H9] validates logging and storage', function () {
          const logged = apiMethods.AUDITED_METHODS.filter(m => !exclude.includes(m));
          const stored = apiMethods.AUDITED_METHODS
            .filter(m => !apiMethods.WITHOUT_USER_METHODS.includes(m))
            .filter(m => !exclude.includes(m));
          assert.strictEqual(sysLogSpy.callCount, logged.length, '[Q2H9] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, stored.length, '[BGXC] must save it to storage');
        });
      });
      describe('[AT64] when only including a few', function () {
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
        it('[WDZ9] validates logging and storage', function () {
          const logged = apiMethods.AUDITED_METHODS.filter(m => include.includes(m));
          const stored = apiMethods.AUDITED_METHODS
            .filter(m => !apiMethods.WITHOUT_USER_METHODS.includes(m))
            .filter(m => include.includes(m));
          assert.strictEqual(sysLogSpy.callCount, logged.length, '[WDZ9] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, stored.length, '[E7S0] must save it to storage');
        });
      });
      describe('[AT65] when including nothing', function () {
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
        it('[NP6H] validates logging and storage', function () {
          assert.strictEqual(sysLogSpy.callCount, 0, '[NP6H] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, 0, '[LV1C] must save it to storage');
        });
      });
      describe('[AT66] when using a method aggregate (here "events.all")', function () {
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
        it('[L2KG] validates logging and storage', function () {
          assert.strictEqual(sysLogSpy.callCount, auditedMethods.length, '[L2KG] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, auditedMethods.length, '[HSQS] must save it to storage');
        });
      });
      describe('[AT67] when excluding a few', function () {
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
        it('[JBPZ] validates logging and storage', function () {
          assert.strictEqual(sysLogSpy.callCount, logged.length, '[JBPZ] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, stored.length, '[1ESH] must save it to storage');
        });
      });
      describe('[AT68] when including and excluding some - without intersection', function () {
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
        it('[6GVQ] validates logging and storage', function () {
          assert.strictEqual(sysLogSpy.callCount, logged.length, '[6GVQ] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, stored.length, '[R7BF] must save it to storage');
        });
      });
      describe('[AT69] when including and excluding some - with intersection', function () {
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
        it('[UK0K] validates logging and storage', function () {
          assert.strictEqual(sysLogSpy.callCount, logged.length, '[UK0K] must log it in syslog');
          assert.strictEqual(storageSpy.callCount, stored.length, '[UOFZ] must save it to storage');
        });
      });
    });
  });
});
