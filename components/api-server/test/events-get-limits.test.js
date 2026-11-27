/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [EGLM] events.get paging parameters and result streaming: an explicit
 * `limit` / `skip` is an integer from 0 to 100000 (400 otherwise), a time
 * range without `limit` stays unbounded, and on PostgreSQL the rows are read
 * through a server-side cursor rather than loaded whole.
 */

const { getConfigUnsafe } = require('@pryv/boiler');

const MAX = 100000;

describe('[EGLM] events.get limit, skip and streaming', function () {
  this.timeout(60000);
  let fixtures, username, token, streamId;
  const EVENTS = 25;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = ('eglm' + cuid.slug()).toLowerCase();
    token = cuid();
    streamId = 'eglm-' + cuid.slug();
    const user = await fixtures.user(username, {});
    await user.access({ type: 'personal', token });
    await user.session(token);
    await user.stream({ id: streamId, name: streamId });
    for (let i = 0; i < EVENTS; i++) {
      const res = await coreRequest.post(`/${username}/events`).set('Authorization', token)
        .send({ streamIds: [streamId], type: 'note/txt', content: 'e' + i, time: 1000 + i });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    }
  });

  after(async function () {
    await fixtures.clean();
  });

  function getEvents (query) {
    return coreRequest.get(`/${username}/events`).set('Authorization', token).query(query);
  }

  describe('[EGLV] parameter bounds', function () {
    for (const [title, query] of [
      ['a negative limit', { limit: -1 }],
      ['a negative skip', { skip: -1 }],
      ['a fractional limit', { limit: 1.5 }],
      ['a limit over the maximum', { limit: MAX + 1 }],
      ['a skip over the maximum', { skip: MAX + 1 }]
    ]) {
      it('[EGLV1] ' + title + ' answers 400', async function () {
        const res = await getEvents(query);
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
      });
    }

    it('[EGLV2] limit 0, the maximum, and skip 0 are accepted', async function () {
      assert.strictEqual((await getEvents({ limit: 0 })).status, 200);
      const max = await getEvents({ limit: MAX, skip: 0, streams: [streamId] });
      assert.strictEqual(max.status, 200, JSON.stringify(max.body));
      assert.strictEqual(max.body.events.length, EVENTS);
    });

    it('[EGLV3] the same bounds apply inside a batch call', async function () {
      const res = await coreRequest.post('/' + username).set('Authorization', token)
        .send([{ method: 'events.get', params: { limit: -1 } }, { method: 'events.get', params: { limit: 2 } }]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.results[0].error?.id, 'invalid-parameters-format', JSON.stringify(res.body.results[0]));
      assert.strictEqual(res.body.results[1].events.length, 2);
    });

    it('[EGLV4] a time range without limit is not capped', async function () {
      const res = await getEvents({ fromTime: 0, streams: [streamId] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.events.length, EVENTS);
    });
  });

  describe('[EGLT] events sharing a time', function () {
    const TIED = 24;
    let tieStreamId;

    before(async function () {
      // SQLite: equal times come back in a stable order whatever the plan.
      // PostgreSQL has no tie-breaker yet (one without an index on
      // (user_id, time, id) slows restricted pages down): not asserted there.
      if (getConfigUnsafe().get('storages:base:engine') === 'postgresql') this.skip();
      tieStreamId = 'eglt-' + cuid.slug();
      await coreRequest.post(`/${username}/streams`).set('Authorization', token).send({ id: tieStreamId, name: tieStreamId });
      // 6 times, 4 events each.
      for (let i = 0; i < TIED; i++) {
        const res = await coreRequest.post(`/${username}/events`).set('Authorization', token)
          .send({ streamIds: [tieStreamId], type: 'note/txt', content: 't' + i, time: 2000 + Math.floor(i / 4) });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      }
    });

    for (const sortAscending of [false, true]) {
      it(`[EGLT1] pages read with skip neither repeat nor miss an event (${sortAscending ? 'oldest' : 'newest'} first)`, async function () {
        const all = await getEvents({ streams: [tieStreamId], limit: TIED, sortAscending });
        assert.strictEqual(all.status, 200, JSON.stringify(all.body));
        const expected = all.body.events.map((e) => e.id);
        assert.strictEqual(new Set(expected).size, TIED);
        for (const limit of [3, 5, 7]) {
          const paged = [];
          for (let skip = 0; skip < TIED; skip += limit) {
            const res = await getEvents({ streams: [tieStreamId], limit, skip, sortAscending });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            paged.push(...res.body.events.map((e) => e.id));
          }
          assert.deepStrictEqual(paged, expected, 'limit ' + limit);
        }
      });
    }
  });

  describe('[EGLC] PostgreSQL cursor', function () {
    let DatabasePG, original;
    const opened = [];

    before(function () {
      if (getConfigUnsafe().get('storages:base:engine') !== 'postgresql') this.skip();
      ({ DatabasePG } = require('storages/engines/postgresql/src/DatabasePG.ts'));
      original = DatabasePG.prototype.queryIterable;
      DatabasePG.prototype.queryIterable = async function * (text, ...rest) {
        const entry = { text, closed: false };
        opened.push(entry);
        try {
          yield * original.call(this, text, ...rest);
        } finally {
          entry.closed = true;
        }
      };
    });

    after(function () {
      if (original != null) DatabasePG.prototype.queryIterable = original;
    });

    beforeEach(function () { opened.length = 0; });

    function eventQueries () {
      return opened.filter((e) => /FROM events/.test(e.text));
    }

    it('[EGLC1] events.get over a time range is read through the cursor, which is closed after the response', async function () {
      const res = await getEvents({ fromTime: 0, streams: [streamId] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.events.length, EVENTS);
      const used = eventQueries();
      assert.ok(used.length >= 1, 'the events query went through the cursor');
      assert.ok(used.every((e) => e.closed), 'every cursor was closed');
    });

    it('[EGLC2] deletions requested with modifiedSince are read through the cursor too', async function () {
      const res = await getEvents({ modifiedSince: 0, includeDeletions: true, streams: [streamId] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(Array.isArray(res.body.eventDeletions), JSON.stringify(res.body));
      const used = eventQueries();
      assert.ok(used.some((e) => /deleted >/.test(e.text)), 'the deletions query went through the cursor');
      assert.ok(used.every((e) => e.closed), 'every cursor was closed');
    });
  });
});
