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

describe('permissions forcedStreams', function () {
  describe('GET /events with forcedStreams', function () {
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
    after(async () => {
      await mongoFixtures.clean();
    });

    it('[SO2E] must not see events  on "B" when querying *', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenForcedB)
        .query({ });
      assert.exists(res.body.events);
      const events = res.body.events;
      events.forEach(e => {
        let ebFound = false;
        for (const eb of ['E', 'B']) {
          if (e.streamIds.includes(eb)) ebFound = true;
        }
        assert.isFalse(ebFound);
      });
    });

    it('[ELFF] must refuse querying C', async function () {
      const res = await server.request()
        .get(basePathEvent)
        .set('Authorization', tokenForcedB)
        .query({ streams: ['C'] });
      assert.exists(res.body.events);
      const events = res.body.events;
      events.forEach(e => {
        assert.include(e.streamIds, 'C');
        let ebFound = false;
        for (const eb of ['E', 'B']) {
          if (e.streamIds.includes(eb)) ebFound = true;
        }
        assert.isFalse(ebFound);
      });
    });
  });
});
