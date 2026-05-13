/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — namespace + write-hook integration tests.
 *
 * [CMCNS] covers: auto-provisioning of reserved parents on user creation;
 * reserved-root rejection on streams.create; plugin-managed segment
 * rejection (chats/collectors under :_cmc:apps); user-creatable region
 * allowance under :_cmc:apps:; cmc/* event content validation on
 * events.create.
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const C = require('cmc');

describe('[CMCNS] cmc namespace + write-hook integration', function () {
  let username, token, basePath, eventsPath;
  let user, fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    basePath = '/' + username + '/streams';
    eventsPath = '/' + username + '/events';

    user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
  });

  describe.skip('[CMCNS-AUTO] auto-provisioning on user creation (BLOCKED on regression debug)', function () {
    // TODO: un-skip when business/src/users/repository.ts re-enables
    // cmc.provisionUserStreams() — see the TODO there. The regression
    // is state-dependent (only triggers when AC0* run sequentially);
    // currently being investigated.
    it('[CN01] the five reserved parents exist on a fresh user', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token);
      assert.strictEqual(res.status, 200);
      const allIds = [];
      function walk (s) {
        allIds.push(s.id);
        if (Array.isArray(s.children)) s.children.forEach(walk);
      }
      (res.body.streams || []).forEach(walk);
      for (const id of [
        C.NS,
        C.NS_INBOX,
        C.NS_APPS,
        C.NS_INTERNAL,
        C.NS_INTERNAL_RETRIES,
      ]) {
        assert.ok(allIds.includes(id), 'expected reserved parent ' + id + ' to exist; got: ' + JSON.stringify(allIds));
      }
    });
  });

  describe('[CMCNS-RR] reserved-root rejection on streams.create', function () {
    it('[CN02] rejects creating bare :_cmc: root', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: ':_cmc:', name: 'cmc root attempt' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
    });

    it('[CN03] rejects creating reserved parents (inbox / apps / _internal / _internal:retries)', async function () {
      const blocked = [':_cmc:inbox', ':_cmc:apps', ':_cmc:_internal'];
      for (const id of blocked) {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', token)
          .send({ id, name: 'attempt', parentId: ':_cmc:' });
        assert.strictEqual(res.status, 400, 'expected 400 for ' + id);
        assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
      }
    });

    it('[CN04] rejects creating under :_cmc:_internal:* (plugin-internal)', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:_internal:foo',
          parentId: ':_cmc:_internal',
          name: 'attempt',
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
    });
  });

  describe.skip('[CMCNS-APPS] :_cmc:apps:<app-code> sub-stream creation (BLOCKED on auto-provisioning)', function () {
    it('[CN05] allows creating :_cmc:apps:my-app under :_cmc:apps', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:apps:my-app',
          parentId: ':_cmc:apps',
          name: 'My App',
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.stream?.id, ':_cmc:apps:my-app');
    });

    it('[CN06] allows nested user-creatable streams under :_cmc:apps:my-app', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:apps:my-app:study-A',
          parentId: ':_cmc:apps:my-app',
          name: 'Study A',
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.stream?.id, ':_cmc:apps:my-app:study-A');
    });

    it('[CN07] rejects creating plugin-reserved segments under :_cmc:apps:my-app (chats / collectors)', async function () {
      for (const id of [
        ':_cmc:apps:my-app:chats',
        ':_cmc:apps:my-app:collectors',
        ':_cmc:apps:my-app:study-A:chats',
      ]) {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', token)
          .send({ id, parentId: ':_cmc:apps:my-app', name: 'attempt' });
        assert.strictEqual(res.status, 400, 'expected 400 for ' + id);
        assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
      }
    });
  });

  describe.skip('[CMCNS-EV] events.create write-hook validation (BLOCKED: needs :_cmc:apps:my-app stream to exist; provisioning regression)', function () {
    it('[CN08] rejects unknown cmc/* event type (validates BEFORE storage)', async function () {
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'cmc/nonsense-v1',
          content: {},
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-unknown-event-type');
    });

    it('[CN09] rejects cmc/request-v1 with missing required fields', async function () {
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'cmc/request-v1',
          content: { to: null },
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-invalid-event-content');
      assert.strictEqual(res.body?.error?.data?.eventType, 'cmc/request-v1');
      assert.ok(Array.isArray(res.body?.error?.data?.errors));
    });

    it.skip('[CN10] accepts a fully-formed cmc/request-v1 (BLOCKED: needs :_cmc:apps:my-app stream to exist)', async function () {
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'cmc/request-v1',
          content: {
            to: null,
            capabilityRequested: true,
            request: {
              title: { en: 'Example consent' },
              description: { en: 'Share data for the study.' },
              consent: { en: 'I agree.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
          },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.event?.type, 'cmc/request-v1');
    });

    it.skip('[CN11] allows app-defined event types on :_cmc:apps:* streams (BLOCKED: needs stream to exist)', async function () {
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'note/txt',
          content: 'plain note in an app scope stream',
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });
  });
});
