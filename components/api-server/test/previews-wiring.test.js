/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const async = require('async');
const superagent = require('superagent');
const helpers = require('./helpers');

const server = helpers.dependencies.instanceManager;
const testData = helpers.dynData({ prefix: 'pvw' });

/**
 * The previews dispatcher is wired into the api-server's request chain.
 *
 * A test instance's `http.previewsPort` is its own port (a test-harness
 * shortcut), so a preview URL sent to it is dispatched back to the same
 * instance as `/{user}/events/{id}`: the event's JSON proves the dispatcher
 * ran. Without it, the preview URL is an unknown route (404).
 */
describe('[PVW1] previews dispatcher wired into the api-server', function () {
  this.timeout(30_000);
  const user = structuredClone(testData.users[0]);
  let token;

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams,
      testData.resetEvents,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        const request = helpers.request(server.url);
        request.login(user, (err) => {
          token = request.token;
          stepDone(err);
        });
      }
    ], done);
  });

  it('[PVW2] /{user}/previews/events/{id} is dispatched to /{user}/events/{id}', async function () {
    const event = testData.events[0];
    const res = await superagent.get(`${server.url}/${user.username}/previews/events/${event.id}`)
      .query({ auth: token })
      .ok(() => true);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.event?.id, event.id);
  });
});
