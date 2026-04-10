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

describe('[PNON] permissions none', function () {
  describe('[PN01] GET /events with none permissions', function () {
    let mongoFixtures;
    before(async function () {
      await initTests();
      await initCore();
      mongoFixtures = getNewFixture();
    });
    after(async () => {
      await mongoFixtures.clean();
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

    it('[VVOA] must not see event in "none" level stream', async function () {
      const res = await coreRequest
        .get(basePathEvent)
        .set('Authorization', tokenForcedB)
        .query({ });
      assert.ok(res.body.events != null);
      const events = res.body.events;
      events.forEach(e => {
        let ebFound = false;
        for (const eb of ['E', 'B']) {
          if (e.streamIds.includes(eb)) ebFound = true;
        }
        assert.strictEqual(ebFound, false);
      });
    });
  });
});
