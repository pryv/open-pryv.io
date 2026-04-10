/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const timestamp = require('unix-timestamp');
const awaiting = require('awaiting');

const Webhook = require('../../../src/webhooks/Webhook');
const WebhooksRepository = require('business/src/webhooks/repository');

const HttpServer = require('./support/httpServer');
const PORT = 6123;

// const whStorage = require('test-helpers').dependencies.storage.user.webhooks;
const storage = require('test-helpers').dependencies.storage.user.webhooks;
const userStorage = require('test-helpers').dependencies.storage.user.events;

const { getAPIVersion } = require('middleware/src/project_version');

describe('[WHBK] Webhook', () => {
  describe('[WB01] send()', () => {
    const repository = new WebhooksRepository(storage, userStorage);
    let notificationsServer;
    let postPath = '/notifications';
    let url = 'http://127.0.0.1:' + PORT + postPath;
    const user = {
      id: 'doesnotmatter',
      username: 'doesnotmatter'
    };

    after(async () => {
      await repository.deleteForUser(user);
    });

    describe('[WB02] when sending to an existing endpoint', () => {
      describe('[WB03] when the endpoint answers ASAP', () => {
        before(async () => {
          notificationsServer = new HttpServer(postPath, 200);
          await notificationsServer.listen();
        });

        let apiVersion;
        before(async () => {
          apiVersion = await getAPIVersion();
        });

        after(() => {
          notificationsServer.close();
        });

        let webhook, runs, message, requestTimestamp, storedWebhook, serial;

        before(async () => {
          serial = '20190820';
          message = 'hi';
          webhook = new Webhook({
            accessId: 'doesntmatter',
            url,
            webhooksRepository: repository,
            user
          });
          webhook.setApiVersion(apiVersion);
          webhook.setSerial(serial);
          await webhook.save();
          requestTimestamp = timestamp.now();
          await webhook.send(message);
          runs = webhook.runs;
          storedWebhook = await repository.getById(user, webhook.id);
        });

        it('[Q7B2] should send it', () => {
          assert.strictEqual(notificationsServer.getMessages()[0], message, 'Webhook sent wrong message.');
        });
        it('[FICW] should add a log to runs', () => {
          assert.strictEqual(runs.length, 1);
          assert.strictEqual(storedWebhook.runs.length, 1);
        });
        it('[2VRK] should add the correct status to the last run', () => {
          assert.strictEqual(runs[0].status, 200);
          assert.strictEqual(storedWebhook.runs[0].status, 200);
        });
        it('[AOCP] should add the correct timestamp to the last run', () => {
          assert.ok(Math.abs(runs[0].timestamp - requestTimestamp) <= 0.5, 'Timestamp is unsynced.');
          assert.ok(Math.abs(storedWebhook.runs[0].timestamp - requestTimestamp) <= 0.5, 'Timestamp is unsynced.');
        });
        it('[2M6F] should increment runCount', () => {
          assert.strictEqual(webhook.runCount, 1);
          assert.strictEqual(storedWebhook.runCount, 1);
        });
        it('[S1CY] should not increment failCount', () => {
          assert.strictEqual(webhook.failCount, 0);
          assert.strictEqual(storedWebhook.failCount, 0);
        });
        it('[22X1] should send the meta', () => {
          const meta = notificationsServer.getMetas()[0];
          assert.strictEqual(meta.apiVersion, apiVersion);
          assert.strictEqual(meta.serial, serial);
          assert.ok(Math.abs(meta.serverTime - requestTimestamp) <= 0.5);
        });
      });

      describe('[WB04] when the endpoint answers with a long delay', () => {
        postPath = '/delayed';
        url = makeUrl(postPath);
        const minIntervalMs = 50;
        const intraCallsIntervalMs = 100;
        const delay = 500;
        const firstMessage = 'hi1';
        const secondMessage = 'hi2';

        before(async () => {
          notificationsServer = new HttpServer(postPath, 200);
          await notificationsServer.listen();
          notificationsServer.setResponseDelay(delay);
        });

        after(() => {
          notificationsServer.close();
        });

        let webhook;

        before(async () => {
          webhook = new Webhook({
            accessId: 'doesntmatter',
            url,
            minIntervalMs,
            webhooksRepository: repository,
            user
          });
          setTimeout(() => {
            return webhook.send(secondMessage);
          }, intraCallsIntervalMs);
          webhook.send(firstMessage);
          await awaiting.event(notificationsServer, 'received');
          notificationsServer.setResponseDelay(null);
          await awaiting.event(notificationsServer, 'responding');
          await awaiting.event(notificationsServer, 'responding');
        });

        it('[SRDL] should send the second message after the first', async () => {
          const receivedMessages = notificationsServer.getMessages();
          assert.strictEqual(receivedMessages.length, 2);
          assert.strictEqual(receivedMessages[0], firstMessage);
          assert.strictEqual(receivedMessages[1], secondMessage);
        });
      });
    });

    describe('[WB05] when sending to an unexistant endpoint', () => {
      let webhook, requestTimestamp, storedWebhook;

      before(async () => {
        webhook = new Webhook({
          accessId: 'doesnmatter',
          url: 'unexistant',
          webhooksRepository: repository,
          user
        });
        await webhook.save();
        requestTimestamp = timestamp.now();
        await webhook.send('doesntmatter');
        storedWebhook = await repository.getById(user, webhook.id);
      });

      after(() => {
        webhook.stop();
      });

      it('[6UJH] should add a log to runs', () => {
        assert.strictEqual(webhook.runs.length, 1);
        assert.strictEqual(storedWebhook.runs.length, 1);
      });
      it('[VKUA] should add the no status to the last run', () => {
        assert.strictEqual(webhook.runs[0].status, 0);
        assert.strictEqual(storedWebhook.runs[0].status, 0);
      });
      it('[40UZ] should add the correct timestamp to the last run', () => {
        assert.ok(Math.abs(webhook.runs[0].timestamp - requestTimestamp) <= 0.5, 'Timestamp is unsynced.');
        assert.ok(Math.abs(storedWebhook.runs[0].timestamp - requestTimestamp) <= 0.5, 'Timestamp is unsynced.');
      });
      it('[UE17] should increment runCount', () => {
        assert.strictEqual(webhook.runCount, 1, 'runCount should be 1');
        assert.strictEqual(storedWebhook.runCount, 1, 'runCount should be 1');
      });
      it('[UJ2Y] should increment failCount', () => {
        assert.strictEqual(webhook.failCount, 1, 'failCount should be 1');
        assert.strictEqual(storedWebhook.failCount, 1, 'failCount should be 1');
      });
      it('[V5NH] should increment currentRetries', () => {
        assert.strictEqual(webhook.currentRetries, 1, 'in memory currentRetries should be 1');
        assert.strictEqual(storedWebhook.currentRetries, 1, 'stored currentRetries should be 1');
      });
    });

    describe('[WB06] when scheduling for a retry', () => {
      describe('[WB07] when the notifications service is down', () => {
        before(async () => {
          postPath = '/notifs2222';
          url = 'http://127.0.0.1:' + PORT + postPath;
          notificationsServer = new HttpServer(postPath, 503);
          await notificationsServer.listen();
        });

        after(() => {
          webhook.stop();
          notificationsServer.close();
        });

        let webhook, run, storedRun, requestTimestamp, storedWebhook;
        const firstMessage = 'hello';

        before(async () => {
          webhook = new Webhook({
            accessId: 'doesntmatter',
            url,
            minIntervalMs: 100,
            webhooksRepository: repository,
            user
          });
          await webhook.save();
          requestTimestamp = timestamp.now();
          await webhook.send(firstMessage);
          run = webhook.runs[0];
          storedWebhook = await repository.getById(user, webhook.id);
          storedRun = storedWebhook.runs[0];
        });

        it('[E5VQ] should save the run', () => {
          assert.strictEqual(run.status, 503);
          assert.ok(Math.abs(run.timestamp - requestTimestamp) <= 0.1);
          assert.deepEqual(run, webhook.lastRun);
          assert.strictEqual(storedRun.status, 503);
          assert.ok(Math.abs(storedRun.timestamp - requestTimestamp) <= 0.1);
          assert.deepEqual(storedRun, storedWebhook.lastRun);
        });
        it('[XP7G] should increment currentRetries', () => {
          assert.strictEqual(webhook.currentRetries, 1);
          assert.strictEqual(storedWebhook.currentRetries, 1);
        });
        it('[9AL1] should schedule for a retry', () => {
          assert.ok(webhook.timeout);
        });
        it('[OHLY] should send scheduled messages after an interval', async () => {
          notificationsServer.setResponseStatus(201);
          await awaiting.event(notificationsServer, 'received');
          assert.strictEqual(notificationsServer.isMessageReceived(), true);
          // firstMessage is received the first time although it returns a 503.
          assert.deepEqual(notificationsServer.getMessages(),
            [firstMessage, firstMessage]);
        });
        it('[1VIT] should reset error tracking properties', async () => {
          storedWebhook = await repository.getById(user, webhook.id);
          assert.ok(webhook.timeout == null);
          assert.strictEqual(webhook.currentRetries, 0);
          assert.strictEqual(webhook.messageBuffer.size, 0);
          assert.strictEqual(storedWebhook.currentRetries, 0, 'stored currentRetries should be 0');
        });
      });
    });

    describe('[WB08] when throttling frequent calls', () => {
      before(async () => {
        postPath = '/notifs3';
        url = 'http://127.0.0.1:' + PORT + postPath;
        notificationsServer = new HttpServer(postPath, 200);
        await notificationsServer.listen();
      });

      after(() => {
        webhook.stop();
        notificationsServer.close();
      });

      let webhook, runs, storedWebhook;

      const firstMessage = 'hello';
      const secondMessage = 'hello2';
      const thirdMessage = 'hello3';

      before(async () => {
        webhook = new Webhook({
          accessId: 'doesntmatter',
          url,
          minIntervalMs: 100,
          webhooksRepository: repository,
          user
        });
        await webhook.save();
        await webhook.send(firstMessage);
        await webhook.send(firstMessage);
        await webhook.send(secondMessage);
        await webhook.send(thirdMessage);
        runs = webhook.runs;
        storedWebhook = await repository.getById(user, webhook.id);
      });

      it('[73TG] should only send the message once', () => {
        assert.strictEqual(notificationsServer.getMessageCount(), 1, 'server should receive the message once');
        assert.strictEqual(runs.length, 1, 'Webhook should have 1 run');
        assert.strictEqual(storedWebhook.runs.length, 1, 'Webhook should have 1 run');
        assert.deepEqual(notificationsServer.getMessages(), [firstMessage]);
      });
      it('[WPMH] should accumulate messages', () => {
        assert.deepEqual(webhook.getMessageBuffer(),
          [firstMessage, secondMessage, thirdMessage]);
      });
      it('[YLWK] should schedule for a retry after minInterval', () => {
        assert.ok(webhook.timeout);
      });
      it('[OZGP] should send scheduled messages after an interval', async () => {
        notificationsServer.resetMessageReceived();
        await awaiting.event(notificationsServer, 'received');
        assert.strictEqual(notificationsServer.isMessageReceived(), true);
        assert.deepEqual(notificationsServer.getMessages(),
          [firstMessage, firstMessage, secondMessage, thirdMessage]);
      });
      it('[86OP] should remove the timeout afterwards', () => {
        assert.ok(webhook.timeout == null);
      });
    });

    describe('[WB09] when the webhook becomes inactive after failures', () => {
      let webhook, storedWebhook;
      before(async () => {
        postPath = '/notifs5';
        url = 'http://127.0.0.1:' + PORT + postPath;
        notificationsServer = new HttpServer(postPath, 400);
        await notificationsServer.listen();
      });

      after(async () => {
        webhook.stop();
        notificationsServer.close();
      });

      before(async () => {
        webhook = new Webhook({
          accessId: 'doesntmatter',
          url,
          minIntervalMs: 10,
          webhooksRepository: repository,
          user
        });
        await webhook.save();
        await webhook.send('hello');
      });

      it('[768L] should run 5 times', async () => {
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
        await awaiting.event(notificationsServer, 'received');
      });
      it('[PX10] should update the state to inactive', () => {
        assert.strictEqual(webhook.state, 'inactive');
      });
      it('[BLNP] should update the stored version', async () => {
        storedWebhook = await repository.getById(user, webhook.id);
        assert.strictEqual(storedWebhook.state, 'inactive');
      });
      it('[ODNM] should not run anymore', async () => {
        const msgCount = notificationsServer.getMessageCount();
        const runCount = webhook.runCount;
        await webhook.send();
        assert.strictEqual(notificationsServer.getMessageCount(), msgCount);
        assert.strictEqual(webhook.runCount, runCount);
      });
    });

    describe('[WB10] when the runs array gets shifted', () => {
      const message = 'hello';
      let webhook;
      before(async () => {
        postPath = '/notifs4';
        url = 'http://127.0.0.1:' + PORT + postPath;
        notificationsServer = new HttpServer(postPath, 200);
        await notificationsServer.listen();
      });

      after(async () => {
        webhook.stop();
        notificationsServer.close();
      });

      before(async () => {
        webhook = new Webhook({
          accessId: 'doesntmatter',
          url,
          minIntervalMs: 10,
          webhooksRepository: repository,
          user,
          runsSize: 3
        });
        await webhook.save();

        await webhook.send(message);
        await webhook.send(message);
        await webhook.send(message);
        runs1 = structuredClone(webhook.runs);
      });

      let runs1, runs2, runs3;

      function sleep (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

      it('[FYOR] should rotate the runs', async () => {
        await webhook.send(message);
        await sleep(500);
        runs2 = structuredClone(webhook.runs);
        assert.deepEqual(runs2[2], runs1[1]);
        assert.deepEqual(runs2[1], runs1[0]);
        assert.deepEqual(runs2[0], webhook.lastRun);

        // should rotate the runs more'
        await webhook.send(message);
        await sleep(500);
        runs3 = webhook.runs;
        assert.deepEqual(runs3[1], runs2[0]);
        assert.deepEqual(runs3[2], runs2[1]);
        assert.deepEqual(runs3[0], webhook.lastRun);
      });
    });
  });
});

function makeUrl (path) {
  return 'http://127.0.0.1:' + PORT + path;
}
