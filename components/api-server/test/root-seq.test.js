/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

const timestamp = require('unix-timestamp');
const _ = require('lodash');
const assert = require('node:assert');
const cuid = require('cuid');
const { promisify } = require('util');
const superagent = require('superagent'); // for basic auth

require('./test-helpers');
const helpers = require('./helpers');
const ErrorIds = require('errors').ErrorIds;
const methodsSchema = require('../src/schema/generalMethods');
const validation = helpers.validation;

const { databaseFixture } = require('test-helpers');
const { produceStorageConnection, context } = require('./test-helpers');
const { getConfig } = require('@pryv/boiler');
const { integrity } = require('business');

let isAuditActive = false;

describe('[ROOT] root', function () {
  let user, user2;

  before(async () => {
    const config = await getConfig();
    isAuditActive = config.get('audit:active');
  });

  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture(await produceStorageConnection());
    await mongoFixtures.context.cleanEverything();
  });
  after(async () => {
    await mongoFixtures.context.cleanEverything();
  });

  let username, personalAccess, personalAccessToken,
    appAccessToken1, appAccessId1,
    sharedAccessToken, sharedAccess,
    stream, streamId,
    stream2, streamId2,
    streamId3,
    username2, appAccess2Token;
  before(() => {
    username = cuid();
    personalAccessToken = cuid();
    appAccessToken1 = cuid();
    appAccessId1 = cuid();
    sharedAccessToken = cuid();
    appAccess2Token = cuid();
    streamId = cuid();
    streamId2 = cuid();
    streamId3 = cuid();
    username2 = '00000';
  });

  let server;
  before(async () => {
    server = await context.spawn();
  });
  after(() => {
    server.stop();
  });

  before(async function () {
    // delete all database before start
    user = await mongoFixtures.user(username, {});
    personalAccess = await user.access({
      type: 'personal', token: personalAccessToken
    });
    personalAccess = personalAccess.attrs;
    stream = await user.stream({ id: streamId });
    await stream.event();
    stream = stream.attrs;
    stream2 = await user.stream({ id: streamId2 });
    await user.stream({ id: streamId3 });
    await stream2.event();
    stream2 = stream.attrs;
    await user.access({
      id: appAccessId1,
      type: 'app',
      token: appAccessToken1,
      permissions: [{
        streamId: '*',
        level: 'manage'
      }]
    });
    sharedAccess = await user.access({
      token: sharedAccessToken,
      type: 'shared',
      permissions: [{
        streamId: stream.id,
        level: 'manage'
      }],
      clientData: 'This is a consent'
    });
    sharedAccess = sharedAccess.attrs;
    await user.session(personalAccessToken);
    user = user.attrs;

    user2 = await mongoFixtures.user(username2, {
      id: 'u_2',
      password: 't3st-Numb3r',
      email: '00001@test.com',
      language: 'en'
    });
    await user2.access({
      type: 'app',
      token: appAccess2Token,
      permissions: [{
        streamId: stream.id,
        defaultName: stream.name,
        level: 'read'
      }]
    });

    user2 = user2.attrs;
  });

  describe('[RT01] GET /', function () {
    it('[UA7B] should return basic server meta information as JSON when requested', async function () {
      const res = await server.request()
        .get('/')
        .set('Accept', 'application/json');
      assert.strictEqual(res.status, 200);
      assert.ok(res.header['content-type'].includes('application/json'));
      validation.checkMeta(res.body);
    });

    it('[TO50] should return basic server meta information as text otherwise', async function () {
      const res = await server.request()
        .get('/')
        .set('Accept', 'text/html');
      assert.strictEqual(res.status, 200);
      assert.ok(res.header['content-type'].includes('text/html'));
      assert.ok(/Pryv API/.test(res.text));
    });

    it('[TS3D] should return an error if trying to access an unknown user account', async function () {
      const res = await server.request()
        .get('/unknown_user/events');
      assert.strictEqual(res.status, 404); // 404 does not throw
    });
  });

  describe('[RT02] All requests:', function () {
    it('[TJHO] should return correct common HTTP headers + meta data in response body', async function () {
      const origin = 'https://test.pryv.io';
      const allowMethod = 'GET';
      const allowHeaders = 'Content-Type';
      const res = await server.request()
        .get('/' + username + '/events')
        .set('Origin', origin)
        .set('Authorization', appAccessToken1)
        .set('Access-Control-Request-Method', allowMethod)
        .set('Access-Control-Request-Headers', allowHeaders);
      assert.strictEqual(res.status, 200);
      validation.checkHeaders(res, [
        { name: 'Access-Control-Allow-Origin', value: origin },
        { name: 'Access-Control-Allow-Methods', value: allowMethod },
        { name: 'Access-Control-Allow-Headers', value: allowHeaders },
        { name: 'Access-Control-Expose-Headers', value: 'API-Version' },
        { name: 'Access-Control-Allow-Credentials', value: 'true' }
      ]);
      validation.checkMeta(res.body);

      assert.ok(
        /^\d+\.\d+\.\d+(-.*)?$/.test(res.headers['api-version']),
        'API-Version looks like 1.2.3-432-fag343da.'
      );
      assert.ok(res.headers['x-powered-by'] == null);
    });

    it('[OQ3G] should return meta data in response body for errors as well', async function () {
      const res = await server.request()
        .get('/' + username + '/bad-path');
      assert.strictEqual(res.status, 404);
      validation.checkMeta(res.body);
    });

    it('[P06Y] should properly translate the Host header\'s username (i.e. subdomain)', async function () {
      const res = await server.request()
        .get('/events')
        .set('Authorization', appAccessToken1)
        .set('Host', username + '.pryv.local');
      assert.strictEqual(res.status, 200);
    });

    it('[R3H5] should translate the username in subdomain also when it only contains numbers', async function () {
      const res = await server.request()
        .post('/' + username2 + '/auth/login')
        .send({
          username: username2,
          password: user2.password,
          appId: 'pryv-test'
        })
        .set('Host', user2.username + '.pryv.local')
        .set('Origin', 'http://test.pryv.local')
        .set('Authorization', appAccess2Token);

      assert.strictEqual(res.status, 200);
    });

    it('[5IQK] should support POSTing "urlencoded" content with _json and _auth fields', async function () {
      const res = await server.request()
        .post('/' + username + '/streams')
        .type('form')
        .send({ _auth: appAccessToken1 })
        .send({ _json: JSON.stringify({ name: 'New stream1' }) });
      assert.strictEqual(res.status, 201);
    });

    it('[2YEI] should support POSTing "urlencoded" content with _json, _method (PUT) and _auth fields', async function () {
      const res = await server.request()
        .post('/' + username + '/streams/' + streamId)
        .type('form')
        .send({ _auth: appAccessToken1 })
        .send({ _method: 'PUT' })
        .send({ _json: JSON.stringify({ name: 'Abrhackadabra' }) });
      assert.strictEqual(res.status, 200);
    });

    it('[VJTP] should support POSTing "urlencoded" content with _json, _method (DELETE) and _auth fields', async function () {
      const res = await server.request()
        .post('/' + username + '/streams/' + streamId3)
        .type('form')
        .query({ mergeEventsWithParent: false })
        .send({ _auth: appAccessToken1 })
        .send({ _method: 'DELETE' });
      assert.strictEqual(res.status, 200);
    });

    it('[6D5O] should properly handle JSON errors when POSTing "urlencoded" content with _json field', async function () {
      const res = await server.request()
        .post('/' + username + '/streams')
        .type('form')
        .unset('authorization')
        .send({ _auth: appAccessToken1 })
        .send({ _json: '{"name": "New stream"' }); // <- missing closing brace
      assert.strictEqual(res.status, 400);
    });

    it('[J2WP] trackingFunctions should update the access\'s "last used" time and *internal* request counters', async function () {
      const calledMethodKey = 'events:get';
      const findOneAsync = promisify((u, query, opts, cb) =>
        helpers.dependencies.storage.user.accesses.findOne(u, query, opts, cb));

      // checkOriginalAccess;
      let access = await findOneAsync(user, { token: personalAccessToken }, null);
      const originalCallCount =
        access.calls && access.calls[calledMethodKey]
          ? access.calls[calledMethodKey]
          : 0;

      // do request
      let res = await server.request()
        .get('/' + username + '/events')
        .set('Authorization', personalAccessToken);
      const expectedTime = timestamp.now();

      // checkUpdatedAccess
      access = await findOneAsync(user, { token: personalAccessToken }, null);
      assert.ok(access.lastUsed); //
      assert.ok(Math.abs(Math.round(access.lastUsed) - Math.round(expectedTime)) <= 5);

      assert.ok(access.calls);
      assert.ok(access.calls[calledMethodKey]);
      assert.strictEqual(access.calls[calledMethodKey],
        originalCallCount + 1,
        'number of calls'
      );

      // checkExposedAccess
      res = await server.request()
        .get('/' + username + '/accesses')
        .set('Authorization', personalAccessToken);
      const exposed = _.find(res.body.accesses, { token: personalAccessToken });
      assert.ok(exposed.calls == null);
    });
  });

  describe('[RT03] OPTIONS /', function () {
    it('[PDMA] should return OK', async function () {
      const res = await server.request()
        .options('/');
      assert.strictEqual(res.status, 200);
    });
  });

  describe('[RT04] GET /access-info', function () {
    it('[0MI8] must return current access information', async function () {
      const res = await server.request()
        .get('/' + username + '/access-info')
        .set('Authorization', sharedAccessToken);

      // Server adds default 'none' permission for system streams on non-personal accesses
      sharedAccess.permissions.unshift({
        streamId: ':_system:account',
        level: 'none'
      });
      // extend sharedAccess with audit rights
      if (isAuditActive) {
        sharedAccess.permissions.push({
          streamId: ':_audit:access-' + sharedAccess.id,
          level: 'read'
        });
      }

      validation.check(
        res,
        {
          status: 200,
          schema: methodsSchema.getAccessInfo.result,
          body: _.merge(
            sharedAccess,
            {
              user: {
                username
              }
            })
        }
      );
    });
  });

  describe('[RT05] Accept Basic Auth request', function () {
    let url;
    before(function () {
      url = server.baseUrl;
    });

    // I didn't manage to make these tests work with server.request() which returns
    // an instance of supertest, so I have used superagent instead.

    it('[0MI9] must accept the https://token@user.domain/ AUTH schema', async function () {
      const fullurl = url.replace('http://', 'http://' + sharedAccess.token + '@');
      const res = await superagent
        .get(fullurl + '/' + user.username + '/access-info');
      assert.strictEqual(res.status, 200);
    });

    it('[0MI0] must accept the https://token:anystring@user.domain/ AUTH schema', async function () {
      const fullurl = url.replace('http://', 'http://' + sharedAccess.token + ':anystring@');
      const res = await superagent
        .get(fullurl + '/' + user.username + '/access-info');
      assert.strictEqual(res.status, 200);
    });

    it('[3W3Y] must accept the https://token:@user.domain/ AUTH schema', async function () {
      const fullurl = url.replace('http://', 'http://' + sharedAccess.token + ':@');
      const res = await superagent
        .get(fullurl + '/' + user.username + '/access-info');
      assert.strictEqual(res.status, 200);
    });

    it('[M54U] must return a 401 error when basic auth is missing using https://@user.domain/', async function () {
      const fullurl = url.replace('http://', 'http://@');
      try {
        await superagent
          .get(fullurl + '/' + user.username + '/access-info');
        assert.fail('this should have thrown');
      } catch (e) {
        assert.strictEqual(e.response.status, 401);
      }
    });

    it('[TPH4] must return a 403 error when using https://:token@user.domain/', async function () {
      const fullurl = url.replace('http://', 'http://:' + sharedAccess.token + '@');
      try {
        await superagent
          .get(fullurl + '/' + user.username + '/access-info');
        assert.fail('this should have thrown');
      } catch (e) {
        assert.strictEqual(e.response.status, 403);
      }
    });
  });

  describe('[RT06] POST / (i.e. batch call)', function () {
    let eventsNotifCount;
    before(function () {
      eventsNotifCount = 0;

      server.on('test-events-changed', function () {
        eventsNotifCount++;
      });
    });

    const testType = 'test/test';

    // fixes #198
    it('[2IV3] must be able to create streams with non-star permissions access', async function () {
      const midParentId = 'sonofParent';
      const calls = [
        {
          method: 'streams.create',
          params: {
            parentId: stream.id,
            id: midParentId,
            name: 'Son of Parent'
          }
        },
        {
          method: 'streams.create',
          params: {
            parentId: midParentId,
            id: 'whatever-123',
            name: 'grand son stream'
          }
        }
      ];
      const res = await server.request()
        .post('/' + username)
        .set('Authorization', sharedAccessToken)
        .send(calls);
      assert.strictEqual(res.status, 200);
      const results = res.body.results;
      assert.ok(results);
      assert.ok(results[0].stream);
      assert.ok(results[1].stream);
    });

    it('[ORT3] must execute the given method calls and return the results', async function () {
      const calls = [
        {
          method: 'events.create',
          params: {
            streamIds: [streamId2],
            time: timestamp.now(),
            type: testType,
            description: 'valid event A'
          }
        },
        {
          method: 'events.create',
          params: {
            streamIds: [streamId2],
            time: timestamp.now('1h'),
            duration: timestamp.duration('1h'),
            type: testType,
            description: 'valid event B'
          }
        },
        {
          method: 'events.create',
          params: {
            time: timestamp.now('2h'),
            type: testType,
            streamIds: ['unknown'],
            description: 'invalid event C (unknown stream)'
          }
        }
      ];

      const res = await server.request()
        .post('/' + username)
        .set('authorization', appAccessToken1)
        .send(calls);
      validation.check(res, {
        status: 200,
        schema: methodsSchema.callBatch.result
      });

      const results = res.body.results;
      assert.strictEqual(results.length, calls.length, 'method call results');
      assert.ok(results[0].event);
      validation.checkObjectEquality(
        results[0].event,
        Object.assign({}, calls[0].params, {
          id: results[0].event.id,
          integrity: results[0].event.integrity
        }),
        integrity.events.isActive ? [] : ['integrity']
      );

      assert.ok(results[1].event);
      validation.checkObjectEquality(
        results[1].event,
        Object.assign({}, calls[1].params, {
          id: results[1].event.id,
          integrity: results[1].event.integrity
        }),
        integrity.events.isActive ? [] : ['integrity']
      );
      assert.ok(results[2].error);
      assert.strictEqual(results[2].error.id, ErrorIds.UnknownReferencedResource);
      assert.strictEqual(eventsNotifCount, 2, 'events notifications');
    });

    it('[TVPI] must execute the method calls containing events.get and ' +
        'return the results', async function () {
      const streamId = 'batch-call-streamId';
      const calls = [
        {
          method: 'streams.create',
          params: {
            id: streamId,
            name: 'batch call root stream'
          }
        },
        {
          method: 'events.create',
          params: {
            streamIds: [streamId],
            type: 'note/txt',
            content: 'Hi, i am an event in a batch call',
            time: timestamp.now()
          }
        },
        {
          method: 'events.get',
          params: { modifiedSince: -1000000, includeDeletions: true }
        }
      ];
      const res = await server
        .request()
        .post('/' + username)
        .send(calls)
        .set('authorization', appAccessToken1);
      validation.check(res, {
        status: 200,
        schema: methodsSchema.callBatch.result
      });

      validation.checkMeta(res.body);
      const results = res.body.results;
      assert.strictEqual(results.length, calls.length, 'method call results');
      assert.ok(results[0].stream);
      validation.checkObjectEquality(
        results[0].stream,
        Object.assign({}, calls[0].params, {
          parentId: null
        })
      );
      assert.ok(results[1].event);
      validation.checkObjectEquality(
        results[1].event,
        Object.assign({}, calls[1].params, {
          id: results[1].event.id,
          integrity: results[1].event.integrity
        }),
        integrity.events.isActive ? [] : ['integrity']
      );

      const getEventsResult = results[2];
      assert.ok(getEventsResult.events);
      assert.ok(getEventsResult.eventDeletions);
    });

    // fixes #222
    it('[U4RB] should not add a null meta field in the response', async function () {
      const streamId = 'batch-call-streamId-meta';
      const calls = [
        {
          method: 'streams.create',
          params: {
            id: streamId,
            name: 'i don\'t want meta !'
          }
        }
      ];
      const res = await server
        .request()
        .post('/' + username)
        .send(calls)
        .set('authorization', appAccessToken1);
      validation.check(res, {
        status: 200,
        schema: methodsSchema.callBatch.result
      });

      validation.checkMeta(res.body);
      const results = res.body.results;
      for (let i = 0; i < results.length; i++) {
        assert.ok(!Object.keys(results[i]).includes('meta'));
      }
    });

    it('[WGVY] must return an error if the sent data is badly formatted', async function () {
      const calls = [
        {
          method: 'events.create',
          badProperty: 'bad value'
        }
      ];
      const res = await server.request()
        .post('/' + username)
        .send(calls)
        .set('authorization', appAccessToken1);
      validation.checkErrorInvalidParams(res);
    });

    it('[TV17] streamed results such as stream.delete should be serialiazed', async function () {
      const calls = [
        {
          method: 'streams.create',
          params: {
            parentId: stream.id,
            id: 'blop',
            name: 'Blop'
          }
        },
        {
          method: 'events.create',
          params: {
            streamIds: ['blop'],
            type: 'actvity/plain'
          }
        },
        {
          method: 'streams.delete',
          params: {
            id: 'blop'
          }
        },
        {
          method: 'streams.delete',
          params: {
            mergeEventsWithParent: false,
            id: 'blop'
          }
        }
      ];
      const res = await server.request()
        .post('/' + username)
        .send(calls)
        .set('authorization', appAccessToken1);
      const deleteStreamResult = res.body?.results[3];
      assert.ok(deleteStreamResult?.updatedEvents);
      assert.ok(deleteStreamResult?.streamDeletion);
    });
  });
});
