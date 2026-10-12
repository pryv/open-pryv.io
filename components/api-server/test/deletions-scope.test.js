/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');
const { Readable } = require('node:stream');
const { ReadableDeletionsStream } = require('../src/methods/streams/ReadableDeletionsStream.ts');

// Deletion records keep no streams: they are returned only to an access that
// reads the whole store, and in the same order / limit / skip on both engines.
describe('[DLSC] event and stream deletion records', function () {
  this.timeout(30000);
  let fixtures, username, personalToken;
  const deletedIds = [];

  async function app (permissions) {
    const res = await coreRequest.post(`/${username}/accesses`).set('Authorization', personalToken)
      .send({ name: 'dlsc-' + cuid(), type: 'app', permissions });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.access.token;
  }

  function deletions (token, extra = {}) {
    return coreRequest.get(`/${username}/events`).set('Authorization', token)
      .query(Object.assign({ state: 'all', modifiedSince: timestamp.now('-1h'), includeDeletions: true }, extra));
  }

  function streamDeletions (token) {
    return coreRequest.get(`/${username}/streams`).set('Authorization', token)
      .query({ includeDeletionsSince: timestamp.now('-1h') });
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    await user.stream({ id: 'dlsc-a', name: 'A' });
    await user.stream({ id: 'dlsc-b', name: 'B' });
    await user.stream({ id: 'dlsc-gone', name: 'Gone' });
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    for (let i = 0; i < 3; i++) {
      const created = await coreRequest.post(`/${username}/events`).set('Authorization', personalToken)
        .send({ streamIds: ['dlsc-a'], type: 'note/txt', content: 'gone ' + i });
      const id = created.body.event.id;
      await coreRequest.del(`/${username}/events/${id}`).set('Authorization', personalToken);
      await coreRequest.del(`/${username}/events/${id}`).set('Authorization', personalToken);
      deletedIds.push(id);
      await new Promise((resolve) => setTimeout(resolve, 20)); // distinct deletion times
    }
    await coreRequest.del(`/${username}/streams/dlsc-gone`).set('Authorization', personalToken);
    await coreRequest.del(`/${username}/streams/dlsc-gone`).set('Authorization', personalToken).query({ mergeEventsWithParent: false });
  });

  after(async function () {
    await fixtures.clean();
  });

  it('[DLS1] the personal access and a `*` read app get the records', async function () {
    for (const token of [personalToken, await app([{ streamId: '*', level: 'read' }])]) {
      const res = await deletions(token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      for (const id of deletedIds) assert.ok(res.body.eventDeletions.some((d) => d.id === id), id);
      const streams = await streamDeletions(token);
      assert.ok(streams.body.streamDeletions.some((d) => d.id === 'dlsc-gone'), JSON.stringify(streams.body));
    }
  });

  it('[DLS2] an access reading part of the store gets none', async function () {
    const scoped = [
      [{ streamId: 'dlsc-a', level: 'read' }],
      [{ streamId: '*', level: 'read' }, { streamId: 'dlsc-b', level: 'none' }],
      [{ streamId: '*', level: 'read' }, { streamId: 'dlsc-b', level: 'create-only' }]
    ];
    for (const permissions of scoped) {
      const token = await app(permissions);
      const res = await deletions(token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.eventDeletions, [], JSON.stringify(permissions));
      const streams = await streamDeletions(token);
      assert.deepStrictEqual(streams.body.streamDeletions, [], JSON.stringify(permissions));
    }
  });

  it('[DLS3] limit, skip and sortAscending apply to the records', async function () {
    const all = (await deletions(personalToken, { sortAscending: true })).body.eventDeletions
      .filter((d) => deletedIds.includes(d.id)).map((d) => d.id);
    assert.deepStrictEqual(all, deletedIds, 'oldest deletion first');
    const desc = (await deletions(personalToken)).body.eventDeletions.map((d) => d.id).filter((id) => deletedIds.includes(id));
    assert.deepStrictEqual(desc, [...deletedIds].reverse(), 'newest deletion first by default');
    const limited = (await deletions(personalToken, { limit: 2, sortAscending: false })).body.eventDeletions;
    assert.strictEqual(limited.length, 2);
    const skipped = (await deletions(personalToken, { limit: 1, skip: 1, sortAscending: false })).body.eventDeletions;
    assert.deepStrictEqual(skipped.map((d) => d.id), [desc[1]]);
  });

  it('[DLS4] with streams kept on the record, only the readable ones pass', async function () {
    const access = { canGetEventsOnStream: async (streamId) => streamId === 'a' };
    const records = [{ id: '1', streamIds: ['a'] }, { id: '2', streamIds: ['b'] }, { id: '3' }, { id: '4', streamIds: ['b', 'a'] }];
    const out = [];
    for await (const r of Readable.from(records).pipe(new ReadableDeletionsStream(access))) out.push(r.id);
    assert.deepStrictEqual(out, ['1', '4']);
  });
});
