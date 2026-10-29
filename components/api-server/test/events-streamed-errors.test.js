/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { Readable } = require('node:stream');
const { getMall } = require('mall');

// A store query can fail only when its rows are read (SQLite raises a query
// error on the first step of its iterator), i.e. after events.get has handed
// its result to the response. Such a failure must still reach the client as an
// error: a JSON error when no byte was sent yet, a cut connection otherwise,
// never a complete-looking 200.
describe('[SMSE] events.get when the store fails while its events are streamed', function () {
  this.timeout(30000);
  let fixtures, username, token, localStore, ownGetStreamed, originalGetStreamed;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'smse-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'smse', name: 'smse' });
    await user.event({ streamIds: ['smse'], type: 'note/txt', content: 'one' });
    const mall = await getMall();
    localStore = mall.events.eventsStores.get('local');
    ownGetStreamed = Object.prototype.hasOwnProperty.call(localStore, 'getStreamed');
    originalGetStreamed = localStore.getStreamed;
  });

  afterEach(function () {
    if (ownGetStreamed) localStore.getStreamed = originalGetStreamed;
    else delete localStore.getStreamed;
  });

  after(async function () {
    await fixtures.clean();
  });

  function failingStore (rowsBeforeFailure) {
    localStore.getStreamed = async function () {
      let sent = 0;
      return new Readable({
        objectMode: true,
        read () {
          if (sent < rowsBeforeFailure) {
            sent++;
            this.push({ id: cuid(), streamIds: ['smse'], type: 'note/txt', content: 'row ' + sent, time: 1, created: 1, createdBy: 'smse', modified: 1, modifiedBy: 'smse' });
            return;
          }
          this.destroy(new Error('forced storage failure'));
        }
      });
    };
  }

  it('[SMSE1] a failure before the first event answers a JSON error', async function () {
    failingStore(0);
    const res = await coreRequest.get(`/${username}/events`).set('Authorization', token).query({ streams: ['smse'] });
    assert.strictEqual(res.status, 500, res.text);
    assert.strictEqual(res.body.error.id, 'unexpected-error', res.text);
    // the connection is still usable afterwards
    if (ownGetStreamed) localStore.getStreamed = originalGetStreamed;
    else delete localStore.getStreamed;
    const ok = await coreRequest.get(`/${username}/events`).set('Authorization', token).query({ streams: ['smse'] });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.events.length, 1);
  });

  it('[SMSE2] a failure after events were sent never looks like a complete answer', async function () {
    failingStore(250); // more than one serialized batch, so bytes are on the wire
    let res = null;
    let err = null;
    try {
      res = await coreRequest.get(`/${username}/events`).set('Authorization', token).query({ streams: ['smse'] });
    } catch (e) {
      err = e;
    }
    if (err == null) {
      // whatever arrived must not parse as a full events.get answer
      assert.ok(res.status !== 200 || res.body?.meta == null, 'complete-looking answer: ' + (res.text || '').slice(-200));
    }
  });
});
