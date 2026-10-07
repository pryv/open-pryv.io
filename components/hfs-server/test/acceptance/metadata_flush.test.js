/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const cuid = require('cuid');
const { produceStorageConnection } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');
const { getMall } = require('mall');
const { integrity } = require('business');
const { flush } = require('../../src/metadata_updater.ts');

/**
 * [HFDU] The series metadata flush writes the event's duration in seconds:
 * the data extent it receives is in the series store's nanoseconds.
 */
describe('[HFDU] series metadata flush: duration', function () {
  this.timeout(30_000);
  let pryv, mall, userId, eventId;

  before(async function () {
    const database = await produceStorageConnection();
    pryv = databaseFixture(database);
    mall = await getMall();
    userId = cuid();
    eventId = cuid();
    const streamId = cuid();
    const user = await pryv.user(userId, {});
    await user.stream({ id: streamId });
    await user.event({ id: eventId, type: 'series:mass/kg', streamIds: [streamId], time: 1791362385.939, duration: 0 });
  });

  after(async function () {
    await pryv.clean();
  });

  it('[HFDU1] points up to deltaTime 1 s give a duration of 1 s, with a valid integrity', async function () {
    const accessId = cuid();
    await flush({ request: { userId, eventId, author: accessId, timestamp: 1791362386, dataExtent: { from: 0, to: 1e9 } } });
    const event = await mall.events.getOne(userId, eventId);
    assert.strictEqual(event.duration, 1);
    assert.strictEqual(event.modifiedBy, accessId);
    if (integrity.events.isActive) {
      assert.strictEqual(integrity.events.compute(event).integrity, event.integrity);
    }
  });

  it('[HFDU2] a shorter extent keeps the stored duration; a longer one extends it', async function () {
    const accessId = cuid();
    await flush({ request: { userId, eventId, author: accessId, timestamp: 1791362387, dataExtent: { from: 0, to: 5e8 } } });
    assert.strictEqual((await mall.events.getOne(userId, eventId)).duration, 1);
    await flush({ request: { userId, eventId, author: accessId, timestamp: 1791362388, dataExtent: { from: 0, to: 2e9 } } });
    assert.strictEqual((await mall.events.getOne(userId, eventId)).duration, 2);
  });
});
