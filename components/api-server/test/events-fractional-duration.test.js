/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * [EFRD] an event's integrity hash must verify on the event as it is read
 * back. Stores keep `endTime = time + duration` and rebuild
 * `duration = endTime - time` on read; with fractional values that float round
 * trip changes the duration (0.1 can come back as 0.0999999...), so a hash
 * computed over the duration as written would not verify.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { getMall } = require('mall');
const integrity = require('business/src/integrity/index.ts').default;

describe('[EFRD] events: integrity with a fractional duration', function () {
  let username, userId, token, basePath, streamId, mall;

  before(async function () {
    await initTests();
    await initCore();
    const fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    basePath = '/' + username + '/events';
    streamId = 'efrd-' + username;
    const user = await fixtures.user(username);
    userId = user.attrs.id;
    await user.stream({ id: streamId, name: 'Fractional durations' });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    mall = await getMall();
  });

  async function readBack (eventId) {
    const res = await coreRequest.get(basePath + '/' + eventId).set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.event;
  }

  function assertVerifies (event) {
    if (!integrity.events.isActive) return;
    assert.strictEqual(event.integrity, integrity.events.hash(event), 'integrity verifies on ' + JSON.stringify(event));
  }

  it('[EFRD1] events.create with a fractional time and duration', async function () {
    const res = await coreRequest.post(basePath).set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'a', time: 1700000000.123, duration: 0.1 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assertVerifies(res.body.event);
    assertVerifies(await readBack(res.body.event.id));
  });

  it('[EFRD2] events.update to a fractional duration', async function () {
    const created = await coreRequest.post(basePath).set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'b', time: 1700000100.7 });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const res = await coreRequest.put(basePath + '/' + created.body.event.id).set('Authorization', token)
      .send({ duration: 12.345 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assertVerifies(res.body.event);
    assertVerifies(await readBack(created.body.event.id));
  });

  it('[EFRD3] a server write through updateWithMerge with a fractional duration', async function () {
    const created = await coreRequest.post(basePath).set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'c', time: 1700000200.3 });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const fullId = created.body.event.id;
    await mall.events.updateWithMerge(userId, fullId, (stored) => ({ ...stored, duration: 0.3 }));
    assertVerifies(await readBack(fullId));
  });

  it('[EFRD4] a server write through update with a fractional duration', async function () {
    const created = await coreRequest.post(basePath).set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'd', time: 1700000300.9 });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const stored = await mall.events.getOne(userId, created.body.event.id);
    await mall.events.update(userId, { ...stored, duration: 4.2 });
    assertVerifies(await readBack(created.body.event.id));
  });

  it('[EFRD5] normaliseDurationToStored keeps what a store gives back', function () {
    const { normaliseDurationToStored } = require('mall/src/helpers/eventsUtils.ts');
    const t = 1700000000.123;
    const fractional = { time: t, duration: 0.1 };
    normaliseDurationToStored(fractional);
    assert.strictEqual(fractional.duration, (t + 0.1) - t);
    for (const duration of [0, 1e-12]) {
      const e = { time: t, duration };
      normaliseDurationToStored(e);
      assert.ok(!('duration' in e), duration + ' reads back as no duration');
    }
    const running = { time: t, duration: null };
    normaliseDurationToStored(running);
    assert.strictEqual(running.duration, null);
    const noTime = { duration: 0.1 };
    normaliseDurationToStored(noTime);
    assert.strictEqual(noTime.duration, 0.1);
  });
});
