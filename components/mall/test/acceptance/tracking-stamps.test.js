/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert, initTests, initCore, getNewFixture, charlatan, cuid */

require('test-helpers/src/api-server-tests-config.ts');
const { getMall } = require('mall');
const { integrity } = require('business');

/**
 * [MSTP] mall.events.create fills the missing tracking properties of an event
 * written outside the events API (`system` as the author), keeps the given
 * ones, and stores a raw load as given.
 */
describe('[MSTP] mall: tracking properties on create', function () {
  let mall, fixtures, userId, streamId;

  before(async function () {
    await initTests();
    await initCore();
    mall = await getMall();
    fixtures = getNewFixture();
    const user = await fixtures.user(charlatan.Lorem.characters(7), {});
    userId = user.attrs.id;
    streamId = cuid();
    await user.stream({ id: streamId, name: 'stamps' });
  });

  after(async function () {
    await fixtures.clean();
  });

  // The row as the store holds it (what the integrity check reads).
  async function storedRow (eventId) {
    return await mall.events.eventsStores.get('local').getOne(userId, eventId);
  }

  function assertIntegrity (row) {
    if (!integrity.events.isActive) return;
    assert.strictEqual(row.integrity, integrity.events.compute({ ...row }).integrity, 'integrity matches the stored row');
  }

  it('[MSTP1] an event created without stamps gets created = modified = now and system as author', async function () {
    const before = Date.now() / 1000;
    const created = await mall.events.create(userId, { streamIds: [streamId], type: 'note/txt', content: 'a', time: before });
    const after = Date.now() / 1000;
    const row = await storedRow(created.id);
    assert.strictEqual(typeof row.created, 'number');
    assert.ok(row.created >= before && row.created <= after, 'created is the write time');
    assert.strictEqual(row.modified, row.created);
    assert.strictEqual(row.createdBy, 'system');
    assert.strictEqual(row.modifiedBy, 'system');
    const read = await mall.events.getOne(userId, created.id);
    assert.strictEqual(read.created, row.created);
    assert.strictEqual(read.modifiedBy, 'system');
    assertIntegrity(row);
  });

  it('[MSTP2] given stamps are kept', async function () {
    const created = await mall.events.create(userId, {
      streamIds: [streamId],
      type: 'note/txt',
      content: 'b',
      time: 1000,
      created: 1001,
      createdBy: 'a1',
      modified: 1002,
      modifiedBy: 'a2'
    });
    const row = await storedRow(created.id);
    assert.strictEqual(row.created, 1001);
    assert.strictEqual(row.createdBy, 'a1');
    assert.strictEqual(row.modified, 1002);
    assert.strictEqual(row.modifiedBy, 'a2');
    assertIntegrity(row);
  });

  it('[MSTP3] a raw load (doNotOverrideIntegrity) is stored without stamps', async function () {
    const id = cuid();
    await mall.events.create(userId, { id, streamIds: [streamId], type: 'note/txt', content: 'c', time: 1000 }, null, true);
    const row = await storedRow(id);
    for (const field of ['created', 'createdBy', 'modified', 'modifiedBy']) {
      assert.strictEqual(row[field], undefined, field + ' stays absent');
    }
    assertIntegrity(row);
  });

  it('[MSTP4] partial stamps: the missing times are filled, modifiedBy defaults to the given createdBy', async function () {
    const created = await mall.events.create(userId, { streamIds: [streamId], type: 'note/txt', content: 'd', time: 1000, createdBy: 'a3' });
    const row = await storedRow(created.id);
    assert.strictEqual(typeof row.created, 'number');
    assert.strictEqual(row.modified, row.created);
    assert.strictEqual(row.createdBy, 'a3');
    assert.strictEqual(row.modifiedBy, 'a3');
    assertIntegrity(row);
  });
});
