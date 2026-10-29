/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');

// events.get input semantics: what a stream query, a time bound or a paging
// parameter means is the same on every engine, and a malformed one is refused
// instead of silently widened, narrowed or answered with an internal error.
describe('[QSEM] events.get query semantics', function () {
  this.timeout(60_000);

  let fixtures, user, username, token, appToken;
  const ids = {};

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'qsem-' + cuid().slice(-8);
    token = cuid();
    appToken = cuid();
    user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.access({ token: appToken, type: 'app', permissions: [{ streamId: '*', level: 'read' }] });
    await user.stream({ id: 'qa', name: 'qa' });
    await user.stream({ id: 'qb', name: 'qb' });
    // a stream id written before such names were refused at creation
    await user.stream({ id: 'constructor', name: 'constructor' });
    const now = timestamp.now();
    ids.a = cuid();
    ids.ab = cuid();
    ids.ctor = cuid();
    await user.event({ id: ids.a, streamIds: ['qa'], type: 'note/txt', content: 'a', time: now - 30 });
    await user.event({ id: ids.ab, streamIds: ['qa', 'qb'], type: 'note/txt', content: 'ab', time: now - 20 });
    await user.event({ id: ids.ctor, streamIds: ['constructor'], type: 'note/txt', content: 'c', time: now - 10 });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function get (query, auth = token) {
    return coreRequest.get('/' + username + '/events').set('Authorization', auth).query(query);
  }

  function streamsQuery (q) {
    return { streams: JSON.stringify(q) };
  }

  describe('[QALL] an `all` clause that resolves to no stream', function () {
    it('[QALL1] a missing stream in `all` makes the query match nothing', async function () {
      const sane = await get(streamsQuery([{ any: ['qa'], all: ['qb'] }]));
      assert.strictEqual(sane.status, 200, JSON.stringify(sane.body));
      assert.deepStrictEqual(sane.body.events.map((e) => e.id), [ids.ab]);

      const res = await get(streamsQuery([{ any: ['qa'], all: ['qsem-missing'] }]));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.events, []);
    });

    it('[QALL2] an `all` stream also excluded by `not` makes the query match nothing', async function () {
      const res = await get(streamsQuery([{ any: ['qa'], all: ['qb'], not: ['qb'] }]));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.events, []);
    });

    it('[QALL3] a notification scope with such a clause matches no event', async function () {
      const { MethodContext } = require('business');
      const storageLayer = await require('storage').getStorageLayer();
      const { prepareScopeQuery } = require('../src/methods/helpers/scopeQueryUtils.ts');
      const { eventMatchesQuery } = require('utils/src/eventMatchQuery.ts');
      const context = new MethodContext({ name: 'test', ip: '127.0.0.1' }, username, token, null, {}, {}, null);
      await context.init();
      await context.retrieveExpandedAccess(storageLayer);
      const missing = await prepareScopeQuery(context, { streams: [{ any: ['qa'], all: ['qsem-missing'] }] });
      assert.strictEqual(eventMatchesQuery({ streamIds: ['qa'], type: 'note/txt' }, missing), false);
      assert.strictEqual(eventMatchesQuery({ streamIds: ['qa', 'qb'], type: 'note/txt' }, missing), false);
      const sane = await prepareScopeQuery(context, { streams: [{ any: ['qa'], all: ['qb'] }] });
      assert.strictEqual(eventMatchesQuery({ streamIds: ['qa'], type: 'note/txt' }, sane), false);
      assert.strictEqual(eventMatchesQuery({ streamIds: ['qa', 'qb'], type: 'note/txt' }, sane), true);
    });
  });

  describe('[QTYP] a `class/*` type filter', function () {
    it('[QTYP1] a notification scope matches the events events.get returns for it', async function () {
      const { MethodContext } = require('business');
      const storageLayer = await require('storage').getStorageLayer();
      const { prepareScopeQuery } = require('../src/methods/helpers/scopeQueryUtils.ts');
      const { eventMatchesQuery } = require('utils/src/eventMatchQuery.ts');
      await user.stream({ id: 'qt', name: 'qt' });
      const now = timestamp.now();
      const kg = { id: cuid(), streamIds: ['qt'], type: 'mass/kg', content: 70, time: now - 5 };
      const lb = { id: cuid(), streamIds: ['qt'], type: 'mass/lb', content: 150, time: now - 4 };
      const other = { id: cuid(), streamIds: ['qt'], type: 'massive/kg', content: 1, time: now - 3 };
      for (const e of [kg, lb, other]) await user.event(e);

      const res = await get({ streams: ['qt'], types: ['mass/*'] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.events.map((e) => e.id).sort(), [kg.id, lb.id].sort());

      const context = new MethodContext({ name: 'test', ip: '127.0.0.1' }, username, token, null, {}, {}, null);
      await context.init();
      await context.retrieveExpandedAccess(storageLayer);
      const scope = await prepareScopeQuery(context, { streams: ['qt'], types: ['mass/*'] });
      assert.strictEqual(eventMatchesQuery(kg, scope), true, 'mass/kg');
      assert.strictEqual(eventMatchesQuery(lb, scope), true, 'mass/lb');
      assert.strictEqual(eventMatchesQuery(other, scope), false, 'massive/kg');
    });
  });

  describe('[QNUM] time bounds and paging', function () {
    it('[QFIN1] a time bound or modifiedSince that is not a finite number is refused', async function () {
      for (const query of [{ fromTime: '1e999' }, { toTime: '-1e999' }, { modifiedSince: 'Infinity' }]) {
        const res = await get(query);
        assert.strictEqual(res.status, 400, JSON.stringify(query) + ' ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
      }
    });

    it('[QSKP1] `skip` without `limit` pages a time range', async function () {
      const all = await get({ fromTime: 0, toTime: timestamp.now() + 10, streams: ['qa', 'qb'] });
      assert.strictEqual(all.status, 200, JSON.stringify(all.body));
      assert.strictEqual(all.body.events.length, 2);
      const res = await get({ fromTime: 0, toTime: timestamp.now() + 10, streams: ['qa', 'qb'], skip: 1 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.events.map((e) => e.id), [all.body.events[1].id]);
    });

    it('[QLIM0] `limit=0` returns no event', async function () {
      const res = await get({ fromTime: 0, toTime: timestamp.now() + 10, limit: 0 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.events, []);
    });

    it('[QDEL1] deletions follow `limit`, `skip` and the sort order', async function () {
      const since = timestamp.now() - 1;
      const deleted = [];
      for (let i = 0; i < 3; i++) {
        const created = await coreRequest.post('/' + username + '/events').set('Authorization', token)
          .send({ streamIds: ['qb'], type: 'note/txt', content: 'del-' + i });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        const eventId = created.body.event.id;
        for (let pass = 0; pass < 2; pass++) { // trash, then delete
          const del = await coreRequest.delete('/' + username + '/events/' + eventId).set('Authorization', token);
          assert.strictEqual(del.status, 200, JSON.stringify(del.body));
        }
        deleted.push(eventId);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      const allDeletions = await get({ modifiedSince: since, includeDeletions: true, limit: 10 });
      assert.strictEqual(allDeletions.status, 200, JSON.stringify(allDeletions.body));
      assert.deepStrictEqual(allDeletions.body.eventDeletions.map((d) => d.id), deleted.slice().reverse());

      const one = await get({ modifiedSince: since, includeDeletions: true, limit: 1 });
      assert.deepStrictEqual(one.body.eventDeletions.map((d) => d.id), [deleted[2]]);

      const ascending = await get({ modifiedSince: since, includeDeletions: true, limit: 2, skip: 1, sortAscending: true });
      assert.deepStrictEqual(ascending.body.eventDeletions.map((d) => d.id), [deleted[1], deleted[2]]);
    });

    it('[QDEL2] a deletion made exactly at `modifiedSince` is not returned (the bound is strict, as for events)', async function () {
      const created = await coreRequest.post('/' + username + '/events').set('Authorization', token)
        .send({ streamIds: ['qb'], type: 'note/txt', content: 'del-bound' });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const eventId = created.body.event.id;
      for (let pass = 0; pass < 2; pass++) { // trash, then delete
        const del = await coreRequest.delete('/' + username + '/events/' + eventId).set('Authorization', token);
        assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      }
      const all = await get({ modifiedSince: timestamp.now() - 60, includeDeletions: true, limit: 100 });
      const deletion = all.body.eventDeletions.find((d) => d.id === eventId);
      assert.ok(deletion != null && typeof deletion.deleted === 'number', JSON.stringify(all.body.eventDeletions));
      const atBound = await get({ modifiedSince: deletion.deleted, includeDeletions: true, limit: 100 });
      assert.strictEqual(atBound.status, 200, JSON.stringify(atBound.body));
      assert.ok(!atBound.body.eventDeletions.some((d) => d.id === eventId), JSON.stringify(atBound.body.eventDeletions));
    });
  });

  describe('[QSTR] stream id spelling', function () {
    it('[QRT1] a store root (`:local:`) follows the `*` rules', async function () {
      for (const q of [[{ any: [':local:', 'qa'] }], [{ any: ['qa'], all: [':local:'] }], [{ any: ['qa'], not: [':local:'] }]]) {
        const res = await get(streamsQuery(q));
        assert.strictEqual(res.status, 400, JSON.stringify(q) + ' ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
      }
      const alone = await get(streamsQuery([{ any: [':local:'] }]));
      assert.strictEqual(alone.status, 200, JSON.stringify(alone.body));
    });

    it('[QMAL1] a malformed store prefix is refused', async function () {
      for (const id of [':abc', '::x', ':']) {
        const res = await get({ streams: [id] });
        assert.strictEqual(res.status, 400, id + ' ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
      }
    });

    it('[PRTO1] a stream id that names a built-in object property is refused at creation', async function () {
      for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'prototype']) {
        const res = await coreRequest.post('/' + username + '/streams').set('Authorization', token)
          .send({ id, name: 'proto ' + id });
        assert.strictEqual(res.status, 400, id + ' ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-item-id');
      }
    });

    it('[PRTO2] an existing stream with such an id keeps the permissions of its grants', async function () {
      const res = await get({ streams: ['constructor'] }, appToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.events.map((e) => e.id), [ids.ctor]);
      const one = await coreRequest.get('/' + username + '/events/' + ids.ctor).set('Authorization', appToken);
      assert.strictEqual(one.status, 200, JSON.stringify(one.body));
    });
  });

  describe('[QPRT] client-chosen keys named like built-in properties', function () {
    function ownValue (object, key) {
      return Object.getOwnPropertyDescriptor(object, key)?.value;
    }

    it('[PRTO3] a `__proto__` key of the private profile is kept as an entry', async function () {
      const res = await coreRequest.put('/' + username + '/profile/private').set('Authorization', token)
        .set('Content-Type', 'application/json').send('{"__proto__":"kept","plain":1}');
      assert.strictEqual(res.status, 200, res.text);
      const got = await coreRequest.get('/' + username + '/profile/private').set('Authorization', token);
      assert.strictEqual(got.status, 200, got.text);
      const profile = JSON.parse(got.text).profile;
      assert.strictEqual(ownValue(profile, '__proto__'), 'kept', got.text);
      assert.strictEqual(profile.plain, 1);
    });

    it('[PRTO4] a `__proto__` key of an event clientData update is kept as an entry', async function () {
      const created = await coreRequest.post('/' + username + '/events').set('Authorization', token)
        .send({ streamIds: ['qa'], type: 'note/txt', content: 'cd', clientData: { a: 1 } });
      assert.strictEqual(created.status, 201, created.text);
      const eventId = created.body.event.id;
      const updated = await coreRequest.put('/' + username + '/events/' + eventId).set('Authorization', token)
        .set('Content-Type', 'application/json').send('{"clientData":{"__proto__":"kept"}}');
      assert.strictEqual(updated.status, 200, updated.text);
      const got = await coreRequest.get('/' + username + '/events/' + eventId).set('Authorization', token);
      const clientData = JSON.parse(got.text).event.clientData;
      assert.strictEqual(ownValue(clientData, '__proto__'), 'kept', got.text);
      assert.strictEqual(clientData.a, 1);
    });
  });

  describe('[QAUT] credentials', function () {
    it('[GAN4] an `auth` query parameter that is not a string is answered as a missing token', async function () {
      const res = await coreRequest.get('/' + username + '/events?auth[$ne]=x');
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-access-token');
    });
  });
});
