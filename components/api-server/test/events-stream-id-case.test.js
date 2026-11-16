/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * Stream ids are case-sensitive: `streams.create` keeps the case of an id it
 * slugifies, so `sqcs` and `SQCS` are two streams. An access to one must not
 * read the events of the other, on every storage engine.
 */
describe('[SQCS] stream ids differing only by case are distinct streams', function () {
  this.timeout(30000);
  let fixtures, username, personalToken, appToken;
  const eventIds = {};

  async function get (token, query) {
    const res = await coreRequest.get(`/${username}/events`).set('Authorization', token).query(query);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events.map((e) => e.id).sort();
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    for (const id of ['sqcs', 'SQCS']) {
      const s = await coreRequest.post(`/${username}/streams`).set('Authorization', personalToken).send({ id, name: 'Sqcs ' + id });
      assert.strictEqual(s.status, 201, JSON.stringify(s.body));
      assert.strictEqual(s.body.stream.id, id);
      const e = await coreRequest.post(`/${username}/events`).set('Authorization', personalToken).send({ streamIds: [id], type: 'note/txt', content: id });
      assert.strictEqual(e.status, 201, JSON.stringify(e.body));
      eventIds[id] = e.body.event.id;
    }
    const a = await coreRequest.post(`/${username}/accesses`).set('Authorization', personalToken)
      .send({ name: 'sqcs-app', type: 'app', permissions: [{ streamId: 'sqcs', level: 'read' }] });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    appToken = a.body.access.token;
  });

  after(async function () {
    await fixtures.clean();
  });

  it('[SQCS1] an access to one reads none of the events of the other', async function () {
    assert.deepStrictEqual(await get(appToken, {}), [eventIds.sqcs]);
    assert.deepStrictEqual(await get(appToken, { streams: ['sqcs'] }), [eventIds.sqcs]);
  });

  it('[SQCS2] a stream filter on one id returns only the events of that id', async function () {
    assert.deepStrictEqual(await get(personalToken, { streams: ['sqcs'] }), [eventIds.sqcs]);
    assert.deepStrictEqual(await get(personalToken, { streams: ['SQCS'] }), [eventIds.SQCS]);
    assert.deepStrictEqual(await get(personalToken, { streams: JSON.stringify({ any: ['*'], not: ['sqcs'] }) }).then((ids) => ids.filter((id) => Object.values(eventIds).includes(id))), [eventIds.SQCS]);
  });

  it('[SQCS5] a stream id holding whitespace or a control character, or "..", is refused', async function () {
    for (const id of [':_cmc:apps:sqcs a', ':_cmc:apps:sqcs\ta', ':_cmc:apps:sqcs\u0001', '..']) {
      const s = await coreRequest.post(`/${username}/streams`).set('Authorization', personalToken).send({ id, name: 'Sqcs bad ' + JSON.stringify(id) });
      assert.strictEqual(s.status, 400, JSON.stringify(id) + ' ' + JSON.stringify(s.body));
      assert.strictEqual(s.body.error.id, 'invalid-item-id', JSON.stringify(s.body));
    }
  });

  it('[SQCS3] deleting one stream with its events leaves the events of the other', async function () {
    for (let i = 0; i < 2; i++) {
      const d = await coreRequest.delete(`/${username}/streams/sqcs`).set('Authorization', personalToken).query({ mergeEventsWithParent: false });
      assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    }
    assert.deepStrictEqual(await get(personalToken, { streams: ['SQCS'] }), [eventIds.SQCS]);
  });
});
