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

const cuid = require('cuid');
const { assert } = require('chai');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');

const eventsQueryUtils = require('mall/src/helpers/eventsQueryUtils');
const streamsQueryUtils = require('../src/methods/helpers/streamsQueryUtils');
const { storeDataUtils } = require('mall');

/**
 * Structures
 * A-----ad-a
 *  |-B--be-b
 *  |-C--fc-c
 *
 * D-----ad-d
 *  |-E--be-e
 *  |-F--fc-f
 *
 * T--t (trashed stream)
 *
 * .account
 *  |.account-email
 *
 * A,D => ad, be, fc, a, b, c, d, e, f
 * A,E => ad, be, fc, a, b, c, e
 * A,&B => be, b
 * A,&E => be
 * T => t
 */

const STREAMS = {
  A: {},
  B: { parentId: 'A' },
  C: { parentId: 'A' },
  D: {},
  E: { parentId: 'D' },
  F: { parentId: 'D' },
  T: { trashed: true },
  '.account': {},
  '.account-email': { parentId: '.account' }
};
const EVENTS = {
  ad: { streamIds: ['A', 'D'] },
  be: { streamIds: ['B', 'E'] },
  fc: { streamIds: ['F', 'C'] },
  a: { streamIds: ['A'] },
  b: { streamIds: ['B'] },
  c: { streamIds: ['C'] },
  d: { streamIds: ['D'] },
  e: { streamIds: ['E'] },
  f: { streamIds: ['F'] },
  t: { streamIds: ['T'] }
};
const EVENT4ID = {};

const ALL_ACCESSIBLE_STREAMS_LOCAL = [];
const ALL_ACCESSIBLE_ROOT_STREAMS_LOCAL = [];
const ALL_AUTHORIZED_STREAMS = Object.keys(STREAMS);

// add childrens to STREAMS, fill ALL_ACCESSIBLE_STREAMS;
ALL_AUTHORIZED_STREAMS.forEach((streamId) => {
  const parentId = STREAMS[streamId].parentId;
  if (parentId) {
    if (!STREAMS[parentId].childrens) STREAMS[parentId].childrens = [];
    STREAMS[parentId].childrens.push(streamId);
  }
  if (STREAMS[streamId].trashed !== true) {
    if (storeDataUtils.parseStoreIdAndStoreItemId(streamId)[0] === 'local') {
      ALL_ACCESSIBLE_STREAMS_LOCAL.push(streamId);
      if (STREAMS[streamId].parentId == null) { ALL_ACCESSIBLE_ROOT_STREAMS_LOCAL.push(streamId); }
    }
  }
});

/**
 * Mimics treeUtils.expandIds()
 * Different because we store STREAMS in a different format here
 * @param excludedIds  children of excludedIds should be excludded too
 */
function customExpand (streamId, storeId = 'local', excludedIds = []) {
  const res = [];
  if (streamId === '*') {
    for (const sId of ALL_ACCESSIBLE_ROOT_STREAMS_LOCAL) {
      if (!excludedIds.includes(sId)) {
        const expanded = customExpand(sId, streamId, excludedIds);
        res.push(...expanded);
      }
    }
    return res;
  }
  if (!STREAMS[streamId]) return [];
  res.push(streamId);
  if (STREAMS[streamId].childrens && (!excludedIds.includes(streamId))) { // eventually exclude childrens
    STREAMS[streamId].childrens.forEach((childId) => {
      const expanded = customExpand(childId, streamId, excludedIds);
      res.push(...expanded);
    });
  }
  return res;
}

describe('[EGSQ] events.get streams query', function () {
  describe('Internal query helpers', function () {
    async function validateQuery (query) {
      if (!Array.isArray(query)) query = [query];
      query = streamsQueryUtils.transformArrayOfStringsToStreamsQuery(query);
      streamsQueryUtils.validateStreamsQueriesAndSetStore(query);
      const expandedQuery = await streamsQueryUtils.expandAndTransformStreamQueries(query, customExpand);
      return expandedQuery;
    }

    describe('when transforming streams parameters', function () {
      it('[D2B5] must convert strings array to expanded array inside [{any: []}]', async function () {
        const res = await validateQuery(['A', 'B']);
        assert.deepEqual(res, [{ any: ['A', 'B', 'C'], storeId: 'local' }]);
      });

      it('[JZWE] must convert single string "B" to [{any: ["B"]}]', async function () {
        const res = await validateQuery('B');
        assert.deepEqual(res, [{ any: ['B'], storeId: 'local' }]);
      });

      it('[8VV4] must convert streams query with only "any" property to expanded streams query inside array [{any: []}])', async function () {
        const res = await validateQuery({ any: ['A', 'B'] });
        assert.deepEqual(res, [{ any: ['A', 'B', 'C'], storeId: 'local' }]);
      });

      it('[HFT2] must convert streams query property "all" to "and: [{any..}, {any..}]) with each containing expanded streamIds', async function () {
        const res = await validateQuery({ any: ['A'], all: ['D', 'F'] });
        assert.deepEqual(res, [
          {
            any: ['A', 'B', 'C'],
            and: [
              { any: ['D', 'E', 'F'] },
              { any: ['F'] }
            ],
            storeId: 'local'
          }]);
      });

      it('[PLMO] must convert streams query property "all" to "and: [{any..}]) with each containing expanded streamIds', async function () {
        const res = await validateQuery({ any: ['A'], all: ['F'] });
        assert.deepEqual(res, [
          {
            any: ['A', 'B', 'C'],
            and: [
              { any: ['F'] }
            ],
            storeId: 'local'
          }]);
      });

      it('[JYUR] must convert streams query property "all" and "not" to "and: [{any..}] not:) with each containing expanded streamIds', async function () {
        const res = await validateQuery({ any: ['A'], all: ['F'], not: ['D', 'E'] });
        assert.deepEqual(res, [
          {
            storeId: 'local',
            any: ['A', 'B', 'C'],
            and: [{ any: ['F'] }, { not: ['D', 'E', 'F'] }]
          }]);
      });

      it('[2W2K] must accept two streams queries expanding them', async function () {
        const res = await validateQuery([{ any: ['A'] }, { any: ['D'] }]);
        assert.deepEqual(res, [{ any: ['A', 'B', 'C'], storeId: 'local' }, { any: ['D', 'E', 'F'], storeId: 'local' }]);
      });

      it('[2EF9] must convert streams query {any: ["*"]} to [{any: [all accessible streams]}]', async function () {
        const res = await validateQuery({ any: ['*'] });
        assert.deepEqual(res, [{ any: ['A', 'B', 'C', 'D', 'E', 'F', '.account', '.account-email'], storeId: 'local' }]);
      });

      it('[TUZT] must convert streams query {any: [*], not: ["A"]} to [{any: [all accessible streams], [expanded "A"]}]', async function () {
        const res = await validateQuery({ any: ['*'], not: ['A'] });
        assert.deepEqual(res, [{ any: ['D', 'E', 'F', '.account', '.account-email'], and: [{ not: ['A', 'B', 'C'] }], storeId: 'local' }]);
      });

      it('[NHGF] not accept any: "*" query mixed with "all" query. like: {any: [*], all: ["D"], not: ["A"]}', async function () {
        try {
          await validateQuery({ any: ['*'], all: ['D'], not: ['A'] });
          assert(false);
        } catch (e) {
          assert.include(e.message, '\'*\'} cannot be mixed with \'all\'');
        }
      });

      it('[U0FA] not accept any: "*", "B" mix. like: {any: ["*2, "D"], not: ["A"]}', async function () {
        try {
          await validateQuery({ any: ['*', 'D'], not: ['A'] });
          assert(false);
        } catch (e) {
          assert.include(e.message, '\'*\' cannot be mixed with other streamIds in \'any\'');
        }
      });

      it('[N3Q6] must convert {any: "*", not: ["A"]} to [{any: [all accessible streams], not: [expanded "A"]}]', async function () {
        const res = await validateQuery({ any: ['*'], not: ['A'] });
        assert.deepEqual(res, [{ any: ['D', 'E', 'F', '.account', '.account-email'], and: [{ not: ['A', 'B', 'C'] }], storeId: 'local' }]);
      });

      describe('with multiple stores', function () {
        it('[U6GS] group query streamIds per store', async function () {
          const res = streamsQueryUtils.transformArrayOfStringsToStreamsQuery(['A', ':_audit:test']);
          assert.deepEqual(res, [{ any: ['A'] }, { any: [':_audit:test'] }]);
        });

        it('[I7GF] should throw an error if two different store are mixed in a query item', async function () {
          try {
            await validateQuery([{ any: ['A', ':_audit:test'] }]);
            assert(false);
          } catch (e) {
            assert.include(e.message, 'queries must me grouped by store');
          }
        });

        it.skip('[ZUTR] should expand queries from differnt store', async function () {
          await validateQuery([{ any: ['A'] }, { any: [':_audit:test'] }]);
          // todo
        });
      });
    });

    describe('exception and errors', function () {
      it('[IOLA] must throw on malformed expressions', async function () {
        const malformed = {
          'streams queries and streamIds cannot be mixed': [
            ['A', { any: ['A', 'B'] }]
          ],
          'must contain at least one of \'any\'': [
            { not: ['A', 'B'] }
          ],
          'unknown property': [
            { any: ['A', 'B'], zz: ['A'] }
          ],
          'must be an array': [
            // only array strings (streamIds)
            { any: { all: 'B' } },
            { any: true },
            { any: '*', not: 'B' }
          ],
          'must be streamIds': [
            // only array strings (streamIds)
            { any: ['A', 'B', { all: 'Z' }] },
            { any: ['A', 'B', true] },
            { any: ['*'], not: ['A', 'B', ['A']] }
          ]
        };

        for (const [error, streamsQueries] of Object.entries(malformed)) {
          await Promise.all(streamsQueries.map(async (streamsQuery) => {
            let hasThrown = false;
            try {
              await validateQuery(streamsQuery);
            } catch (e) {
              hasThrown = true;
              assert.include(e.message, error);
            }
            if (!hasThrown) throw new Error('checkPermissionsAndApplyToScope was expected to throw [' + error + '] with query: <<' + JSON.stringify(streamsQuery) + '>>');
          }));
        }
      });
    });

    describe('toMongoQuery()', function () {
      it('[KKIH] must convert to MongoDB including expansion', async function () {
        const clean = await validateQuery(['A', 'B']);
        const storeQuery = eventsQueryUtils.normalizeStreamQuery(clean);
        const mongo = streamsQueryUtils.toMongoDBQuery(storeQuery);
        assert.deepEqual(mongo, { streamIds: { $in: ['A', 'B', 'C'] } });
      });

      it('[4QMR] must convert to MongoDB including with "ALL"', async function () {
        const clean = await validateQuery({ any: ['A', 'B'], all: ['E'] });
        const storeQuery = eventsQueryUtils.normalizeStreamQuery(clean);
        const mongo = streamsQueryUtils.toMongoDBQuery(storeQuery);
        assert.deepEqual(mongo, { $and: [{ streamIds: { $in: ['A', 'B', 'C'] } }, { streamIds: { $eq: 'E' } }] });
      });

      it('[NG7F] must convert to MongoDB including expansion with "NOT"', async function () {
        const clean = await validateQuery({ any: ['A', 'B'], not: ['E'] });
        const storeQuery = eventsQueryUtils.normalizeStreamQuery(clean);
        const mongo = streamsQueryUtils.toMongoDBQuery(storeQuery);
        assert.deepEqual(mongo, {
          $and: [{ streamIds: { $in: ['A', 'B', 'C'] } }, { streamIds: { $ne: 'E' } }]
        });
      });

      it('[HC6X] must convert to MongoDB including expansion with "ALL" and "NOT"', async function () {
        const clean = await validateQuery({ any: ['A', 'E'], all: ['D', 'C'], not: ['D', 'F'] });
        const mongo = streamsQueryUtils.toMongoDBQuery(eventsQueryUtils.normalizeStreamQuery(clean));
        assert.deepEqual(mongo, {
          $and: [
            { streamIds: { $in: ['A', 'B', 'C', 'E'] } },
            { streamIds: { $eq: 'C' } },
            { streamIds: { $nin: ['D', 'E', 'F'] } }
          ]
        });
      });

      it('[0RNW] must handle array of queries', async function () {
        const clean = await validateQuery([{ any: ['B'] }, { any: ['D'], not: ['E'] }]);
        const mongo = streamsQueryUtils.toMongoDBQuery(eventsQueryUtils.normalizeStreamQuery(clean));
        const expected = {
          $or: [
            { streamIds: { $eq: 'B' } },
            {
              $and: [{ streamIds: { $in: ['D', 'E', 'F'] } }, { streamIds: { $ne: 'E' } }]
            }
          ]
        };
        assert.deepEqual(mongo, expected);
      });
    });
  });

  describe('GET /events with streams queries', function () {
    let server;
    before(async () => {
      server = await context.spawn();
    });
    after(() => {
      server.stop();
    });

    let mongoFixtures;
    before(async function () {
      mongoFixtures = databaseFixture(await produceMongoConnection());
    });

    let user,
      username,
      tokenRead,
      basePathEvent,
      basePath;

    before(async function () {
      username = cuid();
      tokenRead = cuid();
      basePath = `/${username}`;
      basePathEvent = `${basePath}/events/`;

      user = await mongoFixtures.user(username, {});

      for (const [streamId, streamData] of Object.entries(STREAMS)) {
        const stream = {
          id: streamId,
          name: 'stream ' + streamId,
          parentId: streamData.parentId,
          trashed: streamData.trashed
        };
        await user.stream(stream);
      }

      await user.access({
        type: 'app',
        token: tokenRead,
        permissions: [
          {
            streamId: '*',
            level: 'read'
          }
        ]
      });
      for (const [key, event] of Object.entries(EVENTS)) {
        event.type = 'note/txt';
        event.content = key;
        event.id = cuid();
        EVENT4ID[event.id] = key;
        await user.event(event);
      }
    });
    after(async () => {
      await mongoFixtures.clean();
    });

    it('[NKH8] must accept a simple string', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: ['A'] });

      assert.exists(res.body.events);
      const events = res.body.events;
      assert.equal(events.length, 6);
      events.forEach(e => {
        let isFound = false;
        customExpand('A').forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isTrue(isFound);
      });
    });

    it('[BW6Z] must accept array of strings', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: ['A', 'D'] });
      assert.exists(res.body.events);
      const events = res.body.events;
      assert.equal(events.length, 9);
      events.forEach(e => {
        let isFound = false;
        const streamIds = customExpand('A').concat(customExpand('D'));
        streamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isTrue(isFound);
      });
    });

    it('[HFA2] must accept * (star) with a not without including items in trashed streams', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: JSON.stringify({ any: ['*'], not: ['D'] }) });
      const events = res.body.events;
      assert.equal(events.length, 3);
      events.forEach(e => {
        let isFound = false;
        const streamIds = customExpand('A');
        streamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isTrue(isFound);
        isFound = false;
        const badStreamIds = customExpand('D').concat('T');
        badStreamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isFalse(isFound);
      });
    });

    it('[MMB0] must accept * (star) with !B && !E without including items in trashed streams', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: JSON.stringify({ any: ['*'], not: ['B', 'E'] }) });
      assert.exists(res.body.events);
      const events = res.body.events;
      assert.equal(events.length, 6);
      events.forEach(e => {
        let isFound = false;
        const streamIds = ['A', 'C', 'D', 'F'];
        streamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isTrue(isFound);
        isFound = false;
        const badStreamIds = ['B', 'E', 'T'];
        badStreamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isFalse(isFound);
      });
    });

    it('[VUER] must return events in A && E', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: JSON.stringify({ any: ['A'], all: ['E'] }) });
      assert.exists(res.body.events);
      const events = res.body.events;
      assert.equal(events.length, 1);
      events.forEach(e => {
        let isFoundA = false;
        const streamIds = customExpand('A');
        streamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFoundA = true;
        });
        assert.isTrue(isFoundA);
        assert.isTrue(e.streamIds.includes('E'));
      });
    });

    it('[CBP2] must return events in A && !B', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: JSON.stringify({ any: ['A'], not: ['B'] }) });

      assert.exists(res.body.events);
      const events = res.body.events;
      assert.equal(events.length, 4);
      events.forEach(e => {
        let isFound = false;
        const streamIds = ['A', 'C'];
        streamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isTrue(isFound);
        assert.isFalse(e.streamIds.includes('B'));
      });
    });

    it('[I19H] must return events in A && !D', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: JSON.stringify({ any: ['A'], not: ['D'] }) });

      assert.exists(res.body.events);
      const events = res.body.events;
      const expectedEvents = ['b', 'a', 'c'];
      assert.equal(events.length, expectedEvents.length);
      events.forEach((e) => {
        assert.exists(EVENT4ID[e.id]);
        assert.include(expectedEvents, EVENT4ID[e.id]);
      });
    });

    it('[55HB] must return events in A && NOT-EQUAL D', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({ streams: JSON.stringify({ any: ['A'], not: ['D!'] }) });
      assert.exists(res.body.events);
      const events = res.body.events;
      const expectedEvents = ['a', 'b', 'fc', 'c', 'be'];
      assert.equal(events.length, expectedEvents.length);
      events.forEach(e => {
        assert.exists(EVENT4ID[e.id]);
        assert.include(expectedEvents, EVENT4ID[e.id]);
      });
    });

    it('[O4DJ] must return all events in B || (D && !E)', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenRead)
        .query({
          streams: JSON.stringify([{ any: ['B'] }, { any: ['D'], not: ['E'] }])
        });
      assert.exists(res.body.events);
      const events = res.body.events;

      assert.equal(events.length, 6);

      events.forEach(e => {
        if (e.streamIds.includes('B')) return;

        let isFound = false;
        const streamIds = ['D', 'F'];
        streamIds.forEach(streamId => {
          if (e.streamIds.includes(streamId)) isFound = true;
        });
        assert.isTrue(isFound);
        assert.isFalse(e.streamIds.includes('E'));
      });
    });

    it('[UJSB] must accept an object in a batch call (instead of a stringified one)', async function () {
      const res = await server.request()
        .post(basePath)
        .set('Authorization', tokenRead)
        .send([
          {
            method: 'events.get',
            params: {
              streams: { any: ['D'], not: ['E'] }
            }
          }
        ]);
      assert.exists(res.body.results);
      assert.exists(res.body.results[0].events);
      const events = res.body.results[0].events;
      assert.equal(events.length, 4);
    });

    it('[ENFE] must accept a stringified object in a batch call', async function () {
      const res = await server.request()
        .post(basePath)
        .set('Authorization', tokenRead)
        .send([
          {
            method: 'events.get',
            params: {
              streams: JSON.stringify({ any: ['D'], not: ['E'] })
            }
          }
        ]);
      assert.exists(res.body.results);
      assert.exists(res.body.results[0].events);
      const events = res.body.results[0].events;
      assert.equal(events.length, 4);
    });

    describe('edge cases', () => {
      it('[X8B1] must return an error on non-existing stream', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenRead)
          .query({ streams: JSON.stringify({ any: ['A', 'Z', 'B'] }) });
        assert.exists(res.body.error);
        assert.equal(res.body.error.id, 'unknown-referenced-resource');
      });

      it('[WRVU] must return error when there is no "any"', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenRead)
          .query({ streams: JSON.stringify({ all: ['A', 'Z'] }) });
        assert.exists(res.body.error);
        assert.equal(res.body.error.id, 'invalid-request-structure');
      });

      it('[30NV] must return error when provided a boolean instead of a string', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenRead)
          .query({ streams: JSON.stringify({ any: ['A', 'Z', true] }) });
        assert.exists(res.body.error);
        assert.equal(res.body.error.id, 'invalid-request-structure');
      });

      it('[YOJ9] must return error when provided a null instead of a stream query', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenRead)
          .query({ streams: JSON.stringify([null, { any: ['A', 'Z'] }]) });
        assert.exists(res.body.error);
        assert.equal(res.body.error.id, 'invalid-request-structure');
      });

      it('[8NNP] must return an error when providing a non-stringified stream query', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenRead)
          .query({ streams: [{ any: ['A', 'Z'] }] });
        assert.exists(res.body.error);
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.include(res.body.error.message, 'should be an array of streamIds or JSON logical query');
      });

      it('[3X9I] must return an empty list when provided a trashed streamId', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenRead)
          .query({ streams: ['T'] });
        assert.equal(res.body.events.length, 0);
      });
    });
  });
});
