/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// TODO: enable linting again once implementation finished

/* global assert, initTests, initCore, getNewFixture, charlatan, cuid, coreRequest  */

require('test-helpers/src/api-server-tests-config');

describe('[KVDB] Per-store key-value DB', () => {
  let user, username, password, access;
  let personalToken;
  let mongoFixtures;
  let streamsPath, eventsPath;

  before(async () => {
    await initTests();
    await initCore();
    mongoFixtures = getNewFixture();
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      password
    });

    username = user.attrs.username;
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    personalToken = access.attrs.token;
    await user.session(personalToken);
    user = user.attrs;
    streamsPath = '/' + username + '/streams/';
    eventsPath = '/' + username + '/events/';
  });

  after(async () => {
    await mongoFixtures.clean();
  });

  it('[2Z7L] Must set and get key-value data', async () => {
    // requesting stream will update "lastStreamCall" event
    const resStream = await coreRequest
      .get(streamsPath)
      .set('Authorization', personalToken)
      .query({ parentId: ':dummy:myself' });
    const streams = resStream.body?.streams;
    assert.ok(streams);
    assert.strictEqual(streams.length, 2);

    const resEvent = await coreRequest
      .get(eventsPath)
      .set('Authorization', personalToken)
      .query({ streams: [':dummy:antonia'] });
    const events = resEvent.body?.events;
    assert.ok(events);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].content?.id, 'antonia');
  });
});
