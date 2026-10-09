/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const http = require('node:http');
const { ErrorIds } = require('errors/src/index.ts');

const FORBIDDEN = { feature: 'webhooks', setting: 'forbidden' };

describe('[WHFP] permissions webhooks feature', function () {
  let fixtures, receiver, receivedCount, receiverUrl;
  let user, username, personalToken, streamId;
  let restrictedAppId, restrictedAppToken, webhookId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    receivedCount = 0;
    receiver = http.createServer((req, res) => {
      receivedCount++;
      req.resume();
      res.statusCode = 200;
      res.end();
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/whfp`;
  });

  after(async function () {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  });

  beforeEach(async function () {
    username = cuid();
    personalToken = cuid();
    streamId = cuid();
    restrictedAppId = cuid();
    restrictedAppToken = cuid();
    webhookId = cuid();
    user = await fixtures.user(username, {});
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    await user.stream({ id: streamId, name: 'whfp-' + streamId });
    await user.access({
      id: restrictedAppId,
      type: 'app',
      token: restrictedAppToken,
      name: 'restricted-' + username,
      permissions: [{ streamId, level: 'manage' }, FORBIDDEN]
    });
    await user.webhook({ id: webhookId, url: receiverUrl, state: 'inactive' }, restrictedAppId);
    receivedCount = 0;
  });

  afterEach(async function () {
    await fixtures.clean();
  });

  function webhooksPath (suffix = '') {
    return `/${username}/webhooks${suffix}`;
  }
  function accessesPath (suffix = '') {
    return `/${username}/accesses${suffix}`;
  }

  async function addAccess (attrs) {
    return (await user.access(attrs)).attrs;
  }

  async function storedWebhooks () {
    const res = await coreRequest.get(webhooksPath()).set('Authorization', personalToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.webhooks;
  }

  async function storedAccess (accessId) {
    const res = await coreRequest.get(accessesPath('/' + accessId)).set('Authorization', personalToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.access;
  }

  function webhooksEntries (permissions) {
    return (permissions || []).filter((p) => p.feature === 'webhooks');
  }

  function assertWebhooksForbidden (res) {
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
    assert.ok(res.body.error.message.includes('webhooks: forbidden'), res.body.error.message);
  }

  function createWebhook (token) {
    return coreRequest.post(webhooksPath()).set('Authorization', token).send({ url: receiverUrl + '/' + cuid() });
  }

  describe('[WHFC] webhooks.create', function () {
    it('[WHFP1] an app access with "webhooks: forbidden" cannot create a webhook and nothing is stored', async function () {
      const before = (await storedWebhooks()).length;
      const res = await createWebhook(restrictedAppToken);
      assertWebhooksForbidden(res);
      const after = await storedWebhooks();
      assert.strictEqual(after.length, before);
      assert.strictEqual(after.filter((w) => w.id !== webhookId && w.accessId === restrictedAppId).length, 0);
    });

    it('[WHFP2] a shared access with "webhooks: forbidden" cannot create a webhook and nothing is stored', async function () {
      const shared = await addAccess({
        id: cuid(),
        type: 'shared',
        token: cuid(),
        name: 'shared-' + cuid(),
        permissions: [{ streamId, level: 'read' }, FORBIDDEN]
      });
      const res = await createWebhook(shared.token);
      assertWebhooksForbidden(res);
      assert.strictEqual((await storedWebhooks()).filter((w) => w.accessId === shared.id).length, 0);
    });

    it('[WHFP3] an app access without feature entry can create a webhook', async function () {
      const app = await addAccess({
        id: cuid(), type: 'app', token: cuid(), name: 'app-' + cuid(), permissions: [{ streamId, level: 'read' }]
      });
      const res = await createWebhook(app.token);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.webhook.accessId, app.id);
    });

    it('[WHFP4] an app access with "webhooks: allowed" can create a webhook', async function () {
      const app = await addAccess({
        id: cuid(),
        type: 'app',
        token: cuid(),
        name: 'app-' + cuid(),
        permissions: [{ streamId, level: 'read' }, { feature: 'webhooks', setting: 'allowed' }]
      });
      const res = await createWebhook(app.token);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });
  });

  describe('[WHFO] webhooks owned by a restricted access', function () {
    it('[WHFP5] webhooks.test is refused and nothing is sent', async function () {
      const res = await coreRequest.post(webhooksPath(`/${webhookId}/test`)).set('Authorization', restrictedAppToken);
      assertWebhooksForbidden(res);
      assert.strictEqual(receivedCount, 0);
    });

    it('[WHFP6] webhooks.update cannot re-activate it and the stored state is unchanged', async function () {
      const res = await coreRequest
        .put(webhooksPath('/' + webhookId))
        .set('Authorization', restrictedAppToken)
        .send({ state: 'active' });
      assertWebhooksForbidden(res);
      const stored = (await storedWebhooks()).find((w) => w.id === webhookId);
      assert.ok(stored);
      assert.strictEqual(stored.state, 'inactive');
    });

    it('[WHFP7] it can still list, read and delete it', async function () {
      const list = await coreRequest.get(webhooksPath()).set('Authorization', restrictedAppToken);
      assert.strictEqual(list.status, 200, JSON.stringify(list.body));
      assert.deepStrictEqual(list.body.webhooks.map((w) => w.id), [webhookId]);
      const one = await coreRequest.get(webhooksPath('/' + webhookId)).set('Authorization', restrictedAppToken);
      assert.strictEqual(one.status, 200, JSON.stringify(one.body));
      assert.strictEqual(one.body.webhook.id, webhookId);
      const del = await coreRequest.delete(webhooksPath('/' + webhookId)).set('Authorization', restrictedAppToken);
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      const gone = await coreRequest.get(webhooksPath('/' + webhookId)).set('Authorization', personalToken);
      assert.strictEqual(gone.status, 404, JSON.stringify(gone.body));
    });

    it('[WHFP8] the personal token can still update and test it', async function () {
      const upd = await coreRequest
        .put(webhooksPath('/' + webhookId))
        .set('Authorization', personalToken)
        .send({ state: 'active' });
      assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
      assert.strictEqual(upd.body.webhook.state, 'active');
      const test = await coreRequest.post(webhooksPath(`/${webhookId}/test`)).set('Authorization', personalToken);
      assert.strictEqual(test.status, 200, JSON.stringify(test.body));
      assert.strictEqual(receivedCount, 1);
    });
  });

  describe('[WHFI] hand-down to created accesses', function () {
    function createChild (permissions) {
      return coreRequest
        .post(accessesPath())
        .set('Authorization', restrictedAppToken)
        .send({ type: 'shared', name: 'child-' + cuid(), permissions });
    }

    it('[WHFP9] a child created without the entry inherits it and cannot create a webhook', async function () {
      const res = await createChild([{ streamId, level: 'read' }]);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.deepStrictEqual(webhooksEntries(res.body.access.permissions), [FORBIDDEN]);
      const stored = await storedAccess(res.body.access.id);
      assert.deepStrictEqual(webhooksEntries(stored.permissions), [FORBIDDEN]);
      const before = (await storedWebhooks()).length;
      const created = await createWebhook(res.body.access.token);
      assertWebhooksForbidden(created);
      assert.strictEqual((await storedWebhooks()).length, before);
    });

    it('[WHFPA] a child asking for "webhooks: allowed" is refused and not stored', async function () {
      const name = 'child-' + cuid();
      const res = await coreRequest
        .post(accessesPath())
        .set('Authorization', restrictedAppToken)
        .send({ type: 'shared', name, permissions: [{ streamId, level: 'read' }, { feature: 'webhooks', setting: 'allowed' }] });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      const list = await coreRequest.get(accessesPath()).set('Authorization', personalToken);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.accesses.filter((a) => a.name === name).length, 0);
    });

    it('[WHFPB] a child asking for "webhooks: forbidden" explicitly gets a single entry', async function () {
      const res = await createChild([{ streamId, level: 'read' }, FORBIDDEN]);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.deepStrictEqual(webhooksEntries(res.body.access.permissions), [FORBIDDEN]);
    });

    it('[WHFPC] a setting outside the lexicon is refused', async function () {
      const res = await coreRequest
        .post(accessesPath())
        .set('Authorization', personalToken)
        .send({ type: 'app', name: 'app-' + cuid(), permissions: [{ streamId, level: 'read' }, { feature: 'webhooks', setting: 'never' }] });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
    });

    it('[WHFPE] updating a child of a restricted access without the entry keeps it restricted', async function () {
      const childId = cuid();
      const childToken = cuid();
      await addAccess({
        id: childId,
        type: 'shared',
        token: childToken,
        name: 'child-' + childId,
        createdBy: restrictedAppId,
        permissions: [{ streamId, level: 'manage' }]
      });
      const res = await coreRequest
        .put(accessesPath('/' + childId))
        .set('Authorization', personalToken)
        .send({ permissions: [{ streamId, level: 'read' }] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const stored = await storedAccess(childId);
      assert.deepStrictEqual(webhooksEntries(stored.permissions), [FORBIDDEN]);
      const created = await createWebhook(childToken);
      assertWebhooksForbidden(created);
    });
  });

  describe('[WHFL] restriction added later', function () {
    it('[WHFPD] once the owner adds the entry, the access can no longer create or update webhooks', async function () {
      const appId = cuid();
      const appToken = cuid();
      const appPermissions = [{ streamId, level: 'manage' }];
      await addAccess({ id: appId, type: 'app', token: appToken, name: 'app-' + appId, permissions: appPermissions });
      const ownWebhookId = cuid();
      await user.webhook({ id: ownWebhookId, url: receiverUrl, state: 'inactive' }, appId);
      // warm the access cache with the unrestricted access
      const warm = await coreRequest.get(webhooksPath()).set('Authorization', appToken);
      assert.strictEqual(warm.status, 200, JSON.stringify(warm.body));

      const upd = await coreRequest
        .put(accessesPath('/' + appId))
        .set('Authorization', personalToken)
        .send({ permissions: appPermissions.concat([FORBIDDEN]) });
      assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));

      const put = await coreRequest
        .put(webhooksPath('/' + ownWebhookId))
        .set('Authorization', appToken)
        .send({ state: 'active' });
      assertWebhooksForbidden(put);
      const stored = (await storedWebhooks()).find((w) => w.id === ownWebhookId);
      assert.strictEqual(stored.state, 'inactive');
      const before = (await storedWebhooks()).length;
      const created = await createWebhook(appToken);
      assertWebhooksForbidden(created);
      assert.strictEqual((await storedWebhooks()).length, before);
    });
  });
});
