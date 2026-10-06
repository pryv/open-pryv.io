/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * A server-side write to an event (a stamp) that lands between a client
 * request's read of the event and its write must survive the client write:
 * the client's change is applied onto the event as stored at write time.
 *
 * The stamp is injected deterministically: the request's read of the event
 * (mall.events.getOne) is wrapped once so that, right after the read returns,
 * the stamp is written through the mall like the real server writers do.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');
const { getMall } = require('mall');

describe('[ESR] events: a server stamp written during a client update is kept', function () {
  let username, token, basePath, streamId, mall;

  before(async function () {
    await initTests();
    await initCore();
    const fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    basePath = '/' + username + '/events';
    streamId = 'esr-' + username;
    const user = await fixtures.user(username);
    await user.stream({ id: streamId, name: 'Stamp race' });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    mall = await getMall();
  });

  async function createNote (content = 'original') {
    const res = await coreRequest.post(basePath).set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }

  /** Runs `request` with the first read of `eventId` followed by `stamp(event)`, written through the mall. */
  async function withStampAfterRead (eventId, stamp, request) {
    const original = mall.events.getOne;
    let stamped = false;
    mall.events.getOne = async function (userId, id) {
      const event = await original.call(this, userId, id);
      if (id === eventId && !stamped) {
        stamped = true;
        await mall.events.update(userId, { ...stamp(structuredClone(event)), modified: timestamp.now() });
      }
      return event;
    };
    try {
      const res = await request();
      assert.ok(stamped, 'the stamp must have been injected');
      return res;
    } finally {
      mall.events.getOne = original;
    }
  }

  async function readBack (eventId) {
    const res = await coreRequest.get(basePath + '/' + eventId).set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.event;
  }

  it('[ESR1] a client update of other fields keeps content stamped since its read', async function () {
    const event = await createNote();
    const res = await withStampAfterRead(event.id, (e) => ({ ...e, content: 'stamped' }),
      () => coreRequest.put(basePath + '/' + event.id).set('Authorization', token)
        .send({ clientData: { k: 'v' }, description: 'edited' }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.event.content, 'stamped');
    assert.strictEqual(res.body.event.description, 'edited');
    assert.deepStrictEqual(res.body.event.clientData, { k: 'v' });
    const stored = await readBack(event.id);
    assert.strictEqual(stored.content, 'stamped');
    assert.strictEqual(stored.description, 'edited');
    assert.strictEqual(stored.integrity, res.body.event.integrity);
  });

  it('[ESR2] a field the client sends wins over the stamp', async function () {
    const event = await createNote();
    const res = await withStampAfterRead(event.id, (e) => ({ ...e, content: 'stamped' }),
      () => coreRequest.put(basePath + '/' + event.id).set('Authorization', token)
        .send({ content: 'mine' }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.event.content, 'mine');
    assert.strictEqual((await readBack(event.id)).content, 'mine');
  });

  it('[ESR3] clientData keys merge onto the stored map, including keys stamped since the read', async function () {
    const event = await createNote();
    const res = await withStampAfterRead(event.id, (e) => ({ ...e, clientData: { server: 1 } }),
      () => coreRequest.put(basePath + '/' + event.id).set('Authorization', token)
        .send({ clientData: { client: 2 } }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.event.clientData, { server: 1, client: 2 });
  });

  it('[ESR4] trashing an event keeps content stamped since its read', async function () {
    const event = await createNote();
    const res = await withStampAfterRead(event.id, (e) => ({ ...e, content: 'stamped' }),
      () => coreRequest.delete(basePath + '/' + event.id).set('Authorization', token));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.event.trashed, true);
    assert.strictEqual(res.body.event.content, 'stamped');
    const stored = await readBack(event.id);
    assert.strictEqual(stored.trashed, true);
    assert.strictEqual(stored.content, 'stamped');
  });

  it('[ESR5] an update keeps a CMC status stamped since its read and refuses a client one', async function () {
    // the CMC server-owned fields are protected on the client path whatever
    // the stream, so a plain stream is enough here (no dispatch on update)
    const created = await mall.events.create(username, {
      streamIds: [streamId],
      type: 'message/chat-cmc',
      content: { content: 'hi' },
      created: timestamp.now(),
      createdBy: 'test',
      modified: timestamp.now(),
      modifiedBy: 'test'
    });
    const res = await withStampAfterRead(created.id, (e) => ({ ...e, content: { ...e.content, status: 'completed' } }),
      () => coreRequest.put(basePath + '/' + created.id).set('Authorization', token)
        .send({ content: { content: 'hi, edited', status: 'forged', failure: { reason: 'forged' } } }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.event.content, { content: 'hi, edited', status: 'completed' });
  });

  // The published CMC type schemas refuse it as well (validation runs right
  // after the cmc update hook); the hook's own refusal is pinned by [APB15].
  it('[ESR8] non-object content on a CMC event is refused and the stored fields stay', async function () {
    const created = await mall.events.create(username, {
      streamIds: [streamId],
      type: 'message/chat-cmc',
      content: { content: 'hi', status: 'completed' },
      created: timestamp.now(),
      createdBy: 'test',
      modified: timestamp.now(),
      modifiedBy: 'test'
    });
    const res = await coreRequest.put(basePath + '/' + created.id).set('Authorization', token)
      .send({ content: 'x' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    assert.deepStrictEqual((await readBack(created.id)).content, { content: 'hi', status: 'completed' });
  });

  it('[ESR7] clientData: null still clears the map', async function () {
    const event = await createNote();
    const set = await coreRequest.put(basePath + '/' + event.id).set('Authorization', token)
      .send({ clientData: { k: 'v' } });
    assert.deepStrictEqual(set.body.event.clientData, { k: 'v' });
    const res = await coreRequest.put(basePath + '/' + event.id).set('Authorization', token)
      .send({ clientData: null });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.event.clientData == null, JSON.stringify(res.body.event.clientData));
    const stored = await readBack(event.id);
    assert.ok(stored.clientData == null, JSON.stringify(stored.clientData));
  });

  describe('[ESR6] mall.events.updateWithMerge on the local store', function () {
    it('[ESR6A] the merge sees the stored event and its result is written, with integrity', async function () {
      const event = await createNote();
      await mall.events.update(username, { ...(await mall.events.getOne(username, event.id)), content: 'stored' });
      let seen;
      const written = await mall.events.updateWithMerge(username, event.id, (stored) => {
        seen = stored.content;
        return { ...stored, description: 'merged' };
      });
      assert.strictEqual(seen, 'stored');
      assert.strictEqual(written.description, 'merged');
      assert.strictEqual(written.content, 'stored');
      const back = await readBack(event.id);
      assert.strictEqual(back.description, 'merged');
      assert.strictEqual(back.integrity, written.integrity);
    });

    it('[ESR6B] a merge returning null writes nothing and returns null', async function () {
      const event = await createNote();
      const res = await mall.events.updateWithMerge(username, event.id, () => null);
      assert.strictEqual(res, null);
      assert.strictEqual((await readBack(event.id)).modified, event.modified);
    });

    it('[ESR6C] an unknown event is refused like update refuses it', async function () {
      await assert.rejects(mall.events.updateWithMerge(username, cuid(), (s) => s),
        (err) => err.id === 'invalid-item-id');
    });
  });
});
