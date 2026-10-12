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

// Writing an account field through the events API follows the field's own
// rules (value format, server time) and an account event belongs to its
// account stream only.
describe('[ACEV] account fields written through events', function () {
  this.timeout(60_000);

  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'acev-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'acev', name: 'acev' });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function createEvent (event) {
    return coreRequest.post('/' + username + '/events').set('Authorization', token).send(event);
  }

  async function accountLanguage () {
    const res = await coreRequest.get('/' + username + '/account').set('Authorization', token);
    assert.strictEqual(res.status, 200, res.text);
    return res.body.account.language;
  }

  describe('[ACFT] field value and time', function () {
    it('[ACFT1] the language field takes the value account.update accepts', async function () {
      const tooLong = await createEvent({ streamIds: [':_system:language'], type: 'string/pryv', content: 'abcdefg' });
      assert.strictEqual(tooLong.status, 400, tooLong.text);
      assert.strictEqual(tooLong.body.error.id, 'invalid-parameters-format');
      const empty = await createEvent({ streamIds: [':_system:language'], type: 'string/pryv', content: '' });
      assert.strictEqual(empty.status, 400, empty.text);
      const ok = await createEvent({ streamIds: [':_system:language'], type: 'string/pryv', content: 'de' });
      assert.strictEqual(ok.status, 201, ok.text);
      assert.strictEqual(await accountLanguage(), 'de');
    });

    it('[ACFT2] a field with a configured pattern, or a value over the length cap, is refused', async function () {
      const pattern = await createEvent({ streamIds: [':system:insurancenumber'], type: 'string/pryv', content: 'abc' });
      assert.strictEqual(pattern.status, 400, pattern.text);
      assert.strictEqual(pattern.body.error.id, 'invalid-parameters-format');
      const long = await createEvent({ streamIds: [':system:phoneNumber'], type: 'string/pryv', content: 'x'.repeat(301) });
      assert.strictEqual(long.status, 400, long.text);
      const ok = await createEvent({ streamIds: [':system:insurancenumber'], type: 'string/pryv', content: '123' });
      assert.strictEqual(ok.status, 201, ok.text);
    });

    it('[ACFT3] the field takes the server time, not the client `time`', async function () {
      const before = timestamp.now();
      const res = await createEvent({ streamIds: [':_system:language'], type: 'string/pryv', content: 'it', time: 1000 });
      assert.strictEqual(res.status, 201, res.text);
      assert.ok(res.body.event.time >= before - 1, 'time ' + res.body.event.time);
      const got = await coreRequest.get('/' + username + '/events').set('Authorization', token)
        .query({ streams: [':_system:language'] });
      assert.strictEqual(got.status, 200, got.text);
      assert.ok(got.body.events[0].time >= before - 1, 'stored time ' + got.body.events[0].time);
    });
  });

  describe('[ACMX] account stream ids next to other streams', function () {
    it('[ACMX1] an event naming an account stream and another stream is refused at creation', async function () {
      for (const streamIds of [['acev', ':_system:language'], [':_system:language', 'acev']]) {
        const res = await createEvent({ streamIds, type: 'string/pryv', content: 'fr' });
        assert.strictEqual(res.status, 400, JSON.stringify(streamIds) + ' ' + res.text);
        assert.strictEqual(res.body.error.id, 'invalid-operation');
      }
    });

    it('[ACMX2] an update cannot add an account stream to an event of another stream', async function () {
      const created = await createEvent({ streamIds: ['acev'], type: 'string/pryv', content: 'en' });
      assert.strictEqual(created.status, 201, created.text);
      const res = await coreRequest.put('/' + username + '/events/' + created.body.event.id).set('Authorization', token)
        .send({ streamIds: ['acev', ':_system:language'] });
      assert.strictEqual(res.status, 400, res.text);
      assert.strictEqual(res.body.error.id, 'invalid-operation');
      // the event itself is untouched and still updatable
      const content = await coreRequest.put('/' + username + '/events/' + created.body.event.id).set('Authorization', token)
        .send({ content: 'still mine' });
      assert.strictEqual(content.status, 200, content.text);
    });
  });
});
