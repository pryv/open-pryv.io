/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cuid = require('cuid');
const assert = require('node:assert');
const awaiting = require('awaiting');
const timestamp = require('unix-timestamp');
const _ = require('lodash');

const { getWebhooksStorage } = require('../test-helpers');

const { databaseFixture } = require('test-helpers');

require('api-server/test/test-helpers');
const { produceStorageConnection, context } = require('api-server/test/test-helpers');

const { Application: WebhooksApp } = require('../../src/application.ts');

const { Webhook, Repository } = require('business').webhooks;
let repository;
const HttpServer = require('business/test/acceptance/webhooks/support/httpServer').default;

const BOOT_MESSAGE = require('../../src/messages.ts').BOOT_MESSAGE;

describe('[WSV01] webhooks', function () {
  let user, username,
    streamId, appAccessId, appAccessToken,
    webhook, webhook2, webhookId,
    url, url2,
    notificationsServer;

  let fixtures;
  before(async function () {
    fixtures = databaseFixture(await produceStorageConnection());
    const webhooksStorage = await getWebhooksStorage();
    repository = new Repository(webhooksStorage);
  });

  // The mock notification servers take the register URL's port and the next
  // one, so checkouts running their suites side by side can each set their
  // own in their test config.
  let port, port2;
  const postPath = '/notifications';
  const mockServerHostname = 'http://127.0.0.1:';

  before(async function () {
    const config = await require('@pryv/boiler').getConfig();
    port = Number(new URL(config.get('services:register:url')).port);
    port2 = port + 1;
    url = mockServerHostname + port + postPath;
    url2 = mockServerHostname + port2 + postPath;
  });

  let apiServer, webhooksApp, webhooksService;
  before(async function () {
    this.timeout(5000);
    apiServer = await context.spawn({
      webhooks: {
        minIntervalMs: 10,
        inProcess: false
      }
    });
  });
  after(async function () {
    await fixtures.clean();
    await apiServer.stop();
    webhooksApp.stop();
  });

  describe('[WSV02] when loading Webhooks on startup', function () {
    describe('[WSV03] when booting the webhooks application', function () {
      before(function () {
        username = cuid();
        streamId = cuid();
        appAccessToken = cuid();
        appAccessId = cuid();
      });

      before(async function () {
        user = await fixtures.user(username, {});
        await user.stream({
          id: streamId
        });
        await user.access({
          id: appAccessId,
          type: 'app',
          token: appAccessToken,
          permissions: [{
            streamId: '*',
            level: 'manage'
          }]
        });
        webhook = await user.webhook({ url }, appAccessId);
        webhook = webhook.attrs;
        webhook2 = await user.webhook({
          url: url2,
          state: 'inactive'
        }, appAccessId);
        webhook2 = webhook2.attrs;
      });

      before(async function () {
        notificationsServer = new HttpServer(postPath, 200);
        notificationsServer.listen(port);
      });
      after(async function () {
        await notificationsServer.close();
      });

      before(async function () {
        webhooksApp = new WebhooksApp();
        await webhooksApp.setup();
        await webhooksApp.run();
        webhooksService = webhooksApp.webhooksService;
      });
      after(async function () {
        webhooksApp.stop();
      });

      it('[YD6N] should send a boot message to all active webhooks', async function () {
        assert.strictEqual(notificationsServer.getMessageCount(), 1);
        const activeWebhook = await repository.getById(user.context.user, webhook.id);
        assert.strictEqual(activeWebhook.runCount, 1);
        const messages = notificationsServer.getMessages();
        assert.strictEqual(messages[0], BOOT_MESSAGE);
        const metas = notificationsServer.getMetas();
        assert.strictEqual(metas[0].apiVersion, webhooksService.apiVersion);
        assert.strictEqual(metas[0].serial, webhooksService.serial);
        assert.ok(Math.abs(metas[0].serverTime - timestamp.now()) <= 100);
      });
      it('[UM4T] should send nothing to inactive webhooks', async function () {
        const inactiveWebhook = await repository.getById(user.context.user, webhook2.id);
        assert.strictEqual(inactiveWebhook.runCount, 0);
      });
    });

    describe('[WSV04] when creating an event in a Webhook scope', function () {
      describe('[WSV05] when the notifications server is running', function () {
        before(async function () {
          notificationsServer = new HttpServer(postPath, 200);
          await notificationsServer.listen(port);
        });
        after(async function () {
          await notificationsServer.close();
        });

        before(function () {
          username = cuid();
          appAccessId = cuid();
          appAccessToken = cuid();
          streamId = cuid();
        });

        before(async function () {
          webhooksApp = new WebhooksApp();
          await webhooksApp.setup();
          await webhooksApp.run();
          webhooksService = webhooksApp.webhooksService;
        });

        before(async function () {
          user = await fixtures.user(username);
          await user.access({
            id: appAccessId,
            token: appAccessToken,
            type: 'app',
            permissions: [{
              streamId: '*',
              level: 'manage'
            }]
          });
          await user.stream({ id: streamId });
          webhook = await user.webhook({
            accessId: appAccessId,
            url
          });
          webhook = new Webhook(_.merge(webhook.attrs, { webhooksRepository: repository, user: user.context.user }));
          await webhooksService.addWebhook(username, webhook);
        });

        let requestTimestamp;
        before(async function () {
          requestTimestamp = timestamp.now();
          await apiServer.request()
            .post(`/${username}/events`)
            .set('Authorization', appAccessToken)
            .send({
              streamIds: [streamId],
              type: 'note/txt',
              content: 'salut'
            });
        });

        it('[3TMH] should send API call to the notifications server', async function () {
          await awaiting.event(notificationsServer, 'received');
          assert.strictEqual(notificationsServer.isMessageReceived(), true);
        });

        it('[7N4L] should update the Webhook\'s data to the storage', async function () {
          await new Promise(resolve => { setTimeout(resolve, 1000); });
          const updatedWebhook = await repository.getById(user.context.user, webhook.id);
          assert.strictEqual(updatedWebhook.runCount, 1, 'wrong runCount');
          const runs = updatedWebhook.runs;
          assert.strictEqual(runs.length, 1, 'wrong amount of runs');
          const run = runs[0];
          assert.strictEqual(run.status, 200);
          assert.ok(Math.abs(run.timestamp - requestTimestamp) <= 0.5);
        });
      });
    });
  });

  describe('[BBB] when creating a Webhook through api-server', function () {
    describe('[WSV06] when the notifications server is running returning 400', function () {
      before(async function () {
        webhooksApp = new WebhooksApp();
        await webhooksApp.setup();
        await webhooksApp.run();
        webhooksService = webhooksApp.webhooksService;
      });
      after(async function () {
        webhooksApp.stop();
      });

      before(async function () {
        notificationsServer = new HttpServer(postPath, 400);
        await notificationsServer.listen(port);
      });
      after(async function () {
        await notificationsServer.close();
      });
      before(function () {
        username = cuid();
        streamId = cuid();
        appAccessToken = cuid();
        appAccessId = cuid();
      });

      before(async function () {
        user = await fixtures.user(username, {});
        await user.stream({
          id: streamId
        });
        await user.access({
          id: appAccessId,
          type: 'app',
          token: appAccessToken,
          permissions: [{
            streamId: '*',
            level: 'manage'
          }]
        });
      });

      before(async function () {
        const res = await apiServer.request()
          .get(`/${username}/webhooks`)
          .set('Authorization', appAccessToken);
        const webhooks = res.body.webhooks;
        const webhooksDeletes = [];
        webhooks.forEach(w => {
          webhooksDeletes.push(
            apiServer.request()
              .delete(`/${username}/webhooks/${w.id}`)
              .set('Authorization', appAccessToken)
          );
        });
        await Promise.all(webhooksDeletes);
      });
      before(async function () {
        const res = await apiServer.request()
          .post(`/${username}/webhooks`)
          .set('Authorization', appAccessToken)
          .send({
            url
          });
        webhookId = res.body.webhook.id;
      });

      it('[EXQD] should register a new webhook in the service through pubsub', async function () {
        let isWebhookActive = false;
        while (!isWebhookActive) {
          const [, webhook] = webhooksService.getWebhook(username, webhookId);
          if (webhook != null) {
            isWebhookActive = true;
          }
          await awaiting.delay(10);
        }
        assert.strictEqual(isWebhookActive, true);
      });

      it('[8Q4E] should deactivate after failures', async function () {
        let res = await apiServer.request()
          .post(`/${username}/streams`)
          .set('Authorization', appAccessToken)
          .send({
            id: cuid(),
            name: cuid()
          });
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        /**
         * The webhook running for this test is activated by other actions and might be run more than 6 times.
         */
        await awaiting.delay(300);
        res = await apiServer.request()
          .get(`/${username}/webhooks`)
          .set('Authorization', appAccessToken);
        const webhook = res.body.webhooks[0];
        assert.strictEqual(webhook.state, 'inactive');
      });

      it('[PY61] should be run again when updating its state', async function () {
        let res = await apiServer.request()
          .put(`/${username}/webhooks/${webhookId}`)
          .set('Authorization', appAccessToken)
          .send({ state: 'active' });
        const webhook = res.body.webhook;
        assert.strictEqual(webhook.state, 'active');
        res = await apiServer.request()
          .post(`/${username}/streams`)
          .set('Authorization', appAccessToken)
          .send({
            id: cuid(),
            name: cuid()
          });
        assert.ok(res.body.stream);
        await awaiting.event(notificationsServer, 'received');
        assert.strictEqual(notificationsServer.getMessageCount() > 6, true);
      });
    });
  });

  describe('[WSV07] when there are running webhooks', function () {
    before(function () {
      username = cuid();
      appAccessId = cuid();
      appAccessToken = cuid();
      webhookId = cuid();
      streamId = cuid();
    });

    before(async function () {
      webhooksApp = new WebhooksApp();
      await webhooksApp.setup();
      await webhooksApp.run();
      webhooksService = webhooksApp.webhooksService;
    });

    before(async function () {
      const user = await fixtures.user(username, {});
      await user.stream({
        id: streamId,
        name: 'doesntmatter'
      });
      await user.access({
        id: appAccessId,
        type: 'app',
        token: appAccessToken,
        permissions: [{
          streamId,
          level: 'manage'
        }]
      });
      await user.webhook({
        url: 'doesntmatter',
        id: webhookId
      }, appAccessId);
    });

    before(async function () {
      await webhooksApp.webhooksService.addWebhook(username, new Webhook({
        id: webhookId
      }));
    });

    describe('[WSV08] when deleting a webhook through API server', function () {
      before(async function () {
        await apiServer.request()
          .delete(`/${username}/webhooks/${webhookId}`)
          .set('Authorization', appAccessToken);
      });

      it('[904D] should deactivate the current running webhook through pubsub', async function () {
        let isWebhookActive = true;
        while (isWebhookActive) {
          const webhooks = webhooksApp.webhooksService.webhooks.get(username);
          isWebhookActive = false;
          webhooks.forEach(w => {
            if (w.id === webhookId) {
              isWebhookActive = true;
            }
          });
          await awaiting.delay(10);
        }
        assert.strictEqual(isWebhookActive, false);
      });
    });
  });

  describe('[WHSV] signed deliveries', function () {
    const http = require('node:http');
    const { createHmac } = require('node:crypto');
    let signedApp, sUsername, sAppToken, sStreamId, receiver, hookId, firstSecret, secondSecret;
    const deliveries = [];

    function verifies (header, secret, raw) {
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
      return m != null && m[2] === createHmac('sha256', secret).update(m[1] + '.').update(raw).digest('hex');
    }
    async function until (check, label) {
      const deadline = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out: ' + label);
        await awaiting.delay(20);
      }
    }
    function runningCopy () {
      const [, webhook] = signedApp.webhooksService.getWebhook(sUsername, hookId);
      return webhook;
    }
    async function createEvent () {
      const res = await apiServer.request()
        .post(`/${sUsername}/events`)
        .set('Authorization', sAppToken)
        .send({ streamIds: [sStreamId], type: 'note/txt', content: 'signed' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    }

    before(async function () {
      receiver = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          deliveries.push({ header: req.headers['pryv-signature'], raw: Buffer.concat(chunks) });
          res.end();
        });
      });
      await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
      signedApp = new WebhooksApp();
      await signedApp.setup();
      await signedApp.run();
      sUsername = cuid();
      sAppToken = cuid();
      sStreamId = cuid();
      const sUser = await fixtures.user(sUsername, {});
      await sUser.stream({ id: sStreamId });
      await sUser.access({ id: cuid(), type: 'app', token: sAppToken, permissions: [{ streamId: '*', level: 'manage' }] });
      const res = await apiServer.request()
        .post(`/${sUsername}/webhooks`)
        .set('Authorization', sAppToken)
        .send({ url: `http://127.0.0.1:${receiver.address().port}/signed` });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      hookId = res.body.webhook.id;
      firstSecret = res.body.webhook.secret;
    });
    after(async function () {
      signedApp.stop();
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    });

    it('[WHSG2] a delivery carries a signature that verifies on the raw bytes received', async function () {
      // loaded from storage on the pubsub message, which carries the id only
      await until(() => runningCopy() != null, 'webhook loaded');
      assert.strictEqual(runningCopy().secret, firstSecret);
      await createEvent();
      await until(() => deliveries.length > 0, 'a delivery');
      for (const d of deliveries) assert.ok(verifies(d.header, firstSecret, d.raw), 'verifies: ' + d.header);
    });

    it('[WHSR7] after rotateSecret the running webhook is reloaded and signs with the new secret only', async function () {
      const res = await apiServer.request()
        .post(`/${sUsername}/webhooks/${hookId}/rotate-secret`)
        .set('Authorization', sAppToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      secondSecret = res.body.webhook.secret;
      assert.notStrictEqual(secondSecret, firstSecret);
      await until(() => runningCopy()?.secret === secondSecret, 'running copy reloaded');
      // let the deliveries already under way land
      await awaiting.delay(300);
      const from = deliveries.length;
      await createEvent();
      await until(() => deliveries.length > from, 'a delivery after the rotation');
      for (const d of deliveries.slice(from)) {
        assert.ok(verifies(d.header, secondSecret, d.raw), 'verifies with the new secret: ' + d.header);
        assert.ok(!verifies(d.header, firstSecret, d.raw), 'not with the old one');
        // a webhook loaded after boot carries the service's meta too
        const { meta } = JSON.parse(d.raw.toString());
        assert.strictEqual(meta.apiVersion, signedApp.webhooksService.apiVersion);
        assert.strictEqual(meta.serial, signedApp.webhooksService.serial);
      }
      assert.ok(runningCopy().logger != null, 'the reloaded copy logs');
    });

    it('[WHSP1] two reloads close together leave one running copy', async function () {
      const service = signedApp.webhooksService;
      const previous = runningCopy();
      await Promise.all([
        service.onCreate({ username: sUsername, webhook: { id: hookId } }),
        service.onCreate({ username: sUsername, webhook: { id: hookId } })
      ]);
      const copies = service.webhooks.get(sUsername).filter((w) => w.id === hookId);
      assert.strictEqual(copies.length, 1);
      assert.strictEqual(previous.stopped, true, 'the replaced copy is stopped');
      assert.strictEqual(copies[0].stopped, false);
    });

    it('[WHSM1] a load message for a webhook not in storage runs nothing, whatever the message carries', async function () {
      const service = signedApp.webhooksService;
      const ghostId = cuid();
      await service.onCreate({ username: sUsername, webhook: { id: ghostId, url: `http://127.0.0.1:${receiver.address().port}/ghost` } });
      const [, ghost] = service.getWebhook(sUsername, ghostId);
      assert.strictEqual(ghost, null);
    });
  });
});
