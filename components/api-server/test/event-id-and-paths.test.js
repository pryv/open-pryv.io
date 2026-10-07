/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { createId: cuid2 } = require('@paralleldrive/cuid2');

/**
 * [EIDP] A client-supplied event id is exactly one of the accepted shapes,
 * nothing appended; attachment paths never leave the user's directory.
 */
describe('[EIDP] event ids and attachment paths', function () {
  this.timeout(60_000);
  let fixtures, username, token, streamId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'eidp-' + cuid().slice(-8);
    token = cuid();
    streamId = 'eidp-' + cuid().slice(-6);
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: streamId, name: 'eidp' });
  });

  after(async function () {
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function create (id) {
    return coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .send({ id, streamIds: [streamId], type: 'note/txt', content: 'eidp' });
  }

  it('[EIDP1] refuses a store-prefixed id that carries anything beyond the allowed characters', async function () {
    for (const id of [':local:ab/cd', ':local:ab/../cd', ':store:ab"cd', ':store:ab cd', ':store:ab\\cd']) {
      const res = await create(id);
      assert.strictEqual(res.status, 400, id + ' -> ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format', id);
    }
  });

  it('[EIDP2] still accepts a cuid2 id and a legacy cuid id', async function () {
    for (const id of [cuid2(), 'c' + cuid2().slice(0, 24)]) {
      const res = await create(id);
      assert.strictEqual(res.status, 201, id + ' -> ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.event.id, id);
    }
  });

  it('[EIDP3] the filesystem attachment store refuses path segments that leave the user directory', async function () {
    const { getEventFiles } = require('storage/src/eventFiles/getEventFiles.ts');
    const ef = await getEventFiles();
    const userId = 'eidp-user-' + cuid().slice(-8);
    for (const eventId of ['../escape', 'a/b', '..', '']) {
      await assert.rejects(() => ef.removeAllForEvent(userId, eventId), /Invalid attachment path segment/, JSON.stringify(eventId));
    }
    await assert.rejects(() => ef.getAttachmentStream(userId, 'event-1', '../../other'), /Invalid attachment path segment/);
    await assert.rejects(() => ef.removeAttachment(userId, 'event-1', 'a/b'), /Invalid attachment path segment/);
  });
});
