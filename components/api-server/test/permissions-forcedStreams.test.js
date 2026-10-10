/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * Structure
 * A-----ab-ac-a
 *  |-B--bc-ab-b
 *  | |-E-ea
 *  |
 *  |-C--bc-ac-c
 */

const STREAMS = {
  A: {}, B: { parentId: 'A' }, C: { parentId: 'A' }, E: { parentId: 'B' }
};
const EVENTS = {
  ab: { streamIds: ['A', 'B'] },
  ac: { streamIds: ['A', 'C'] },
  bc: { streamIds: ['B', 'C'] },
  ea: { streamIds: ['E', 'A'] },
  a: { streamIds: ['A'] },
  b: { streamIds: ['B'] },
  c: { streamIds: ['C'] }
};
const EVENT4ID = {}; // will be filled by fixtures

describe('[PFRC] permissions forcedStreams', function () {
  describe('[PF01] GET /events with forcedStreams', function () {
    let fixtures;
    before(async function () {
      await initTests();
      await initCore();
      fixtures = getNewFixture();
    });
    after(async () => {
      await fixtures.clean();
    });

    let user,
      username,
      tokenForcedB,
      basePathEvent,
      basePath;

    before(async function () {
      username = cuid();
      tokenForcedB = cuid();
      basePath = `/${username}`;
      basePathEvent = `${basePath}/events/`;

      user = await fixtures.user(username, {});

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
        token: tokenForcedB,
        permissions: [
          {
            streamId: '*',
            level: 'read'
          },
          {
            streamId: 'B',
            level: 'none'
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

    it('[SO2E] must not see events  on "B" when querying *', async function () {
      const res = await coreRequest
        .get(basePathEvent)
        .set('Authorization', tokenForcedB)
        .query({ });
      assert.ok(res.body.events);
      const events = res.body.events;
      events.forEach(e => {
        let ebFound = false;
        for (const eb of ['E', 'B']) {
          if (e.streamIds.includes(eb)) ebFound = true;
        }
        assert.strictEqual(ebFound, false);
      });
    });

    it('[ELFF] must refuse querying C', async function () {
      const res = await coreRequest
        .get(basePathEvent)
        .set('Authorization', tokenForcedB)
        .query({ streams: ['C'] });
      assert.ok(res.body.events);
      const events = res.body.events;
      events.forEach(e => {
        assert.ok(e.streamIds.includes('C'));
        let ebFound = false;
        for (const eb of ['E', 'B']) {
          if (e.streamIds.includes(eb)) ebFound = true;
        }
        assert.strictEqual(ebFound, false);
      });
    });
  });

  /**
   * Structure (B, D and K are trashed after the events are created)
   * A
   * |-B        none for tokenNone
   * |-C        none for tokenNone
   * | |-D
   * |-K        create-only for tokenCreateOnly
   */
  describe('[PF02] GET /events when an excluded stream is trashed', function () {
    let fixtures, username, basePath, personalToken, tokenNone, tokenCreateOnly;

    const LIVE_EVENTS = {
      inA: ['A'], inAB: ['A', 'B'], inAD: ['A', 'D'], inAK: ['A', 'K']
    };
    const TRASHED_EVENTS = {
      tInA: ['A'], tInAB: ['A', 'B'], tInAD: ['A', 'D'], tInAK: ['A', 'K']
    };

    before(async function () {
      await initTests();
      await initCore();
      fixtures = getNewFixture();
      username = cuid();
      basePath = `/${username}`;
      personalToken = cuid();
      tokenNone = cuid();
      tokenCreateOnly = cuid();
      const user = await fixtures.user(username, {});
      await user.access({ type: 'personal', token: personalToken });
      await user.session(personalToken);
      for (const [id, parentId] of [['A', null], ['B', 'A'], ['C', 'A'], ['D', 'C'], ['K', 'A']]) {
        await user.stream({ id, name: 'stream ' + id, parentId });
      }
      await user.access({
        type: 'app',
        token: tokenNone,
        permissions: [
          { streamId: 'A', level: 'read' },
          { streamId: 'B', level: 'none' },
          { streamId: 'C', level: 'none' }
        ]
      });
      await user.access({
        type: 'app',
        token: tokenCreateOnly,
        permissions: [
          { streamId: 'A', level: 'read' },
          { streamId: 'K', level: 'create-only' }
        ]
      });
      for (const [content, streamIds] of Object.entries(LIVE_EVENTS)) {
        await user.event({ id: cuid(), type: 'note/txt', content, streamIds });
      }
      for (const [content, streamIds] of Object.entries(TRASHED_EVENTS)) {
        await user.event({ id: cuid(), type: 'note/txt', content, streamIds, trashed: true });
      }
      for (const streamId of ['B', 'D', 'K']) {
        const res = await coreRequest.delete(`${basePath}/streams/${streamId}`).set('Authorization', personalToken);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.stream.trashed, true);
      }
    });
    after(async () => {
      await fixtures.clean();
    });

    async function contentsFor (token, query) {
      const res = await coreRequest.get(`${basePath}/events`).set('Authorization', token).query(query);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body.events.map(e => e.content);
    }

    function assertSeen (contents, expected, hidden) {
      for (const c of expected) assert.ok(contents.includes(c), `expected "${c}" in ${JSON.stringify(contents)}`);
      for (const c of hidden) assert.ok(!contents.includes(c), `"${c}" must stay hidden, got ${JSON.stringify(contents)}`);
    }

    it('[TRX1] fixture: the owner sees every event with state=all', async function () {
      const contents = await contentsFor(personalToken, { state: 'all' });
      assertSeen(contents, [...Object.keys(LIVE_EVENTS), ...Object.keys(TRASHED_EVENTS)], []);
    });

    it('[TRX2] a trashed "none" stream (or trashed descendant) stays excluded with the default state', async function () {
      assertSeen(await contentsFor(tokenNone, {}), ['inA'], ['inAB', 'inAD', 'tInA']);
      assertSeen(await contentsFor(tokenNone, { streams: ['A'] }), ['inA'], ['inAB', 'inAD']);
    });

    it('[TRX3] a trashed "none" stream (or trashed descendant) stays excluded with state=all', async function () {
      assertSeen(await contentsFor(tokenNone, { state: 'all' }), ['inA', 'tInA'], ['inAB', 'inAD', 'tInAB', 'tInAD']);
      assertSeen(await contentsFor(tokenNone, { state: 'all', streams: ['A'] }), ['inA', 'tInA'], ['inAB', 'inAD', 'tInAB', 'tInAD']);
    });

    it('[TRX4] a trashed "none" stream (or trashed descendant) stays excluded with state=trashed', async function () {
      assertSeen(await contentsFor(tokenNone, { state: 'trashed' }), ['tInA'], ['inA', 'tInAB', 'tInAD']);
    });

    it('[TRX5] a trashed "create-only" stream stays excluded whatever the state', async function () {
      assertSeen(await contentsFor(tokenCreateOnly, {}), ['inA'], ['inAK']);
      assertSeen(await contentsFor(tokenCreateOnly, { streams: ['A'] }), ['inA'], ['inAK']);
      assertSeen(await contentsFor(tokenCreateOnly, { state: 'all' }), ['inA', 'tInA'], ['inAK', 'tInAK']);
      assertSeen(await contentsFor(tokenCreateOnly, { state: 'trashed' }), ['tInA'], ['tInAK']);
    });
  });
});
