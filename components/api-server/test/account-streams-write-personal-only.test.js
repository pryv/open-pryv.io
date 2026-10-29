/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account fields are written by the account owner only.
 *
 * [ACSW] covers: no access other than the personal one can be granted more
 * than `read` on a visible account stream (accesses create / update, also
 * from an app access creating a shared one), and an access already stored
 * with a write level on an account stream cannot create or update account
 * events any more; it keeps reading them. The personal access still writes.
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ErrorIds } = require('errors');
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');

describe('[ACSW] account streams: write access for the personal access only', function () {
  let fixtures, username, token, user;
  const eventsPath = () => '/' + username + '/events';
  const accessesPath = () => '/' + username + '/accesses';

  const LANGUAGE = ':_system:language';
  const PHONE = ':system:phoneNumber';
  const WRITE_LEVELS = ['contribute', 'manage', 'create-only'];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    user = await fixtures.user(username, { phoneNumber: '123' });
    await user.access({ token, type: 'personal' });
    await user.session(token);
  });

  after(async function () {
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function accountEvent (streamId) {
    const res = await coreRequest.get(eventsPath()).set('Authorization', token).query({ streams: [streamId] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const event = (res.body.events || []).find((e) => e.streamIds.includes(streamId));
    assert.ok(event != null, streamId + ' event is readable: ' + JSON.stringify(res.body.events));
    return event;
  }

  function assertTooHigh (res, streamId, label) {
    assert.strictEqual(res.status, 400, label + ': ' + JSON.stringify(res.body));
    assert.strictEqual(res.body?.error?.id, ErrorIds.InvalidOperation, label);
    assert.strictEqual(res.body?.error?.message, ErrorMessages[ErrorIds.TooHighAccessForSystemStreams], label);
    assert.deepStrictEqual(res.body?.error?.data, { param: streamId }, label);
  }

  it('[ACSW1] accesses.create refuses any level above read on a visible account stream, for app and shared accesses', async function () {
    for (const type of ['app', 'shared']) {
      for (const streamId of [LANGUAGE, PHONE]) {
        for (const level of WRITE_LEVELS) {
          const res = await coreRequest.post(accessesPath()).set('Authorization', token)
            .send({ type, name: 'acsw1-' + cuid().slice(-8), token: cuid(), permissions: [{ streamId, level }] });
          assertTooHigh(res, streamId, type + ' ' + streamId + ' at ' + level);
        }
        const ok = await coreRequest.post(accessesPath()).set('Authorization', token)
          .send({ type, name: 'acsw1-r-' + cuid().slice(-8), token: cuid(), permissions: [{ streamId, level: 'read' }] });
        assert.strictEqual(ok.status, 201, type + ' ' + streamId + ' at read: ' + JSON.stringify(ok.body));
      }
    }
  });

  it('[ACSW2] accesses.update refuses raising an account-stream permission above read, and keeps the stored one', async function () {
    const created = await coreRequest.post(accessesPath()).set('Authorization', token)
      .send({ type: 'app', name: 'acsw2-' + cuid().slice(-8), token: cuid(), permissions: [{ streamId: LANGUAGE, level: 'read' }] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    for (const level of WRITE_LEVELS) {
      const res = await coreRequest.put(accessesPath() + '/' + created.body.access.id).set('Authorization', token)
        .send({ permissions: [{ streamId: LANGUAGE, level }] });
      assertTooHigh(res, LANGUAGE, 'update to ' + level);
    }
    const list = await coreRequest.get(accessesPath()).set('Authorization', token);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const stored = list.body.accesses.find((a) => a.id === created.body.access.id);
    assert.deepStrictEqual(stored.permissions.filter((p) => p.streamId === LANGUAGE), [{ streamId: LANGUAGE, level: 'read' }]);
  });

  describe('[ACSWS] an access stored with a write level on account streams (granted before this rule)', function () {
    let appToken, sharedToken, initialLanguage, initialPhone;

    before(async function () {
      initialLanguage = (await accountEvent(LANGUAGE)).content;
      initialPhone = (await accountEvent(PHONE)).content;
      assert.notStrictEqual(initialLanguage, 'it', 'premise: the writes below change the language');
      appToken = cuid();
      sharedToken = cuid();
      // Inserted directly: the API no longer grants these levels.
      await user.access({
        type: 'app',
        name: 'acsw-legacy-app-' + cuid().slice(-8),
        token: appToken,
        permissions: [{ streamId: LANGUAGE, level: 'contribute' }, { streamId: PHONE, level: 'manage' }]
      });
      await user.access({
        type: 'shared',
        name: 'acsw-legacy-shared-' + cuid().slice(-8),
        token: sharedToken,
        permissions: [{ streamId: LANGUAGE, level: 'contribute' }, { streamId: PHONE, level: 'contribute' }]
      });
    });

    it('[ACSW3] cannot create an account event (403), through any spelling of the stream id', async function () {
      for (const accessToken of [appToken, sharedToken]) {
        for (const [streamId, type, content] of [
          [LANGUAGE, 'language/iso-639-1', 'it'],
          [':account::_system:language', 'language/iso-639-1', 'de'],
          [PHONE, 'string/pryv', '999'],
          [':local::system:phoneNumber', 'string/pryv', '998']
        ]) {
          const res = await coreRequest.post(eventsPath()).set('Authorization', accessToken)
            .send({ streamIds: [streamId], type, content });
          assert.strictEqual(res.status, 403, streamId + ': ' + JSON.stringify(res.body));
          assert.strictEqual(res.body?.error?.id, ErrorIds.Forbidden, streamId);
        }
      }
      assert.strictEqual((await accountEvent(LANGUAGE)).content, initialLanguage);
      assert.strictEqual((await accountEvent(PHONE)).content, initialPhone);
    });

    it('[ACSW4] cannot update an account event (403)', async function () {
      for (const accessToken of [appToken, sharedToken]) {
        for (const [streamId, content] of [[LANGUAGE, 'it'], [PHONE, '999']]) {
          const event = await accountEvent(streamId);
          const res = await coreRequest.put(eventsPath() + '/' + encodeURIComponent(event.id)).set('Authorization', accessToken)
            .send({ content });
          assert.strictEqual(res.status, 403, streamId + ': ' + JSON.stringify(res.body));
          assert.strictEqual(res.body?.error?.id, ErrorIds.Forbidden, streamId);
        }
      }
      assert.strictEqual((await accountEvent(LANGUAGE)).content, initialLanguage);
      assert.strictEqual((await accountEvent(PHONE)).content, initialPhone);
    });

    it('[ACSW5] still reads the account fields it was granted', async function () {
      for (const accessToken of [appToken, sharedToken]) {
        const res = await coreRequest.get(eventsPath()).set('Authorization', accessToken).query({ streams: [LANGUAGE] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.events.map((e) => e.content), [initialLanguage]);
      }
    });

    it('[ACSW6] an app access holding such a level cannot pass a write level on to a shared access', async function () {
      const res = await coreRequest.post(accessesPath()).set('Authorization', appToken)
        .send({ type: 'shared', name: 'acsw6-' + cuid().slice(-8), token: cuid(), permissions: [{ streamId: LANGUAGE, level: 'contribute' }] });
      assertTooHigh(res, LANGUAGE, 'shared child at contribute');
      const ok = await coreRequest.post(accessesPath()).set('Authorization', appToken)
        .send({ type: 'shared', name: 'acsw6-r-' + cuid().slice(-8), token: cuid(), permissions: [{ streamId: LANGUAGE, level: 'read' }] });
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    });

    it('[ACSW7] the personal access still writes the account fields', async function () {
      const event = await accountEvent(LANGUAGE);
      const res = await coreRequest.put(eventsPath() + '/' + encodeURIComponent(event.id)).set('Authorization', token)
        .send({ content: 'it' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual((await accountEvent(LANGUAGE)).content, 'it');
    });
  });
});
