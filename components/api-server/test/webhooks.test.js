/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan */

const { promisify } = require('util');
const timestamp = require('unix-timestamp');

const helpers = require('./helpers');
const validation = helpers.validation;
const methodsSchema = require('../src/schema/webhooksMethods.ts');
const HttpServer = require('business/test/acceptance/webhooks/support/httpServer').default;

const { ErrorIds } = require('errors/src/index.ts');
const dependencies = require('test-helpers').dependencies;
// Use a getter to access webhooks storage after dependencies.init() runs
const getWebhooksStorage = () => dependencies.storage.user.webhooks;
const { Webhook } = require('business').webhooks;

describe('[WH01] webhooks', () => {
  let fixtures;
  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });
  after(async () => {
    await fixtures.clean();
  });

  let username, personalAccessToken,
    appAccessToken1, appAccessToken2,
    appAccessId1, appAccessId2,
    sharedAccessToken,
    sharedAccessId,
    webhookId1, webhookId2, webhookId3, webhookId4;
  before(() => {
    username = cuid();
    personalAccessToken = cuid();
    appAccessToken1 = cuid();
    appAccessToken2 = cuid();
    appAccessId1 = cuid();
    appAccessId2 = cuid();
    sharedAccessToken = cuid();
  });

  describe('[WH02] GET /', () => {
    before(() => {
      username = cuid();
      return fixtures.user(username, {}, (user) => {
        user.access({
          type: 'personal', token: personalAccessToken
        });
        user.access({
          id: appAccessId1,
          type: 'app',
          token: appAccessToken1
        });
        user.access({
          id: appAccessId2,
          type: 'app',
          token: appAccessToken2
        });
        user.access({
          type: 'shared', token: sharedAccessToken
        });

        user.session(personalAccessToken);
        user.webhook({}, appAccessId1);
        user.webhook({}, appAccessId2);
      });
    });

    after(async () => {
      await fixtures.clean();
    });

    describe('[WH08] when using an app token', () => {
      let webhooks, response;
      before(async () => {
        const res = await coreRequest
          .get(`/${username}/webhooks`)
          .set('Authorization', appAccessToken1);
        response = res;
        webhooks = res.body.webhooks;
      });

      it('[R5KD] should return a status 200 with a webhooks object which is an array', () => {
        validation.check(response, {
          schema: methodsSchema.get.result,
          status: 200
        });
      });
      it('[67CX] should fetch all webhooks reachable by an app token', () => {
        webhooks.forEach(w => {
          assert.strictEqual(w.accessId, appAccessId1);
        });
      });
      it('[WSJG] should not fetch any Webhook outside its scope', () => {
        webhooks.forEach(w => {
          assert.notStrictEqual(w.accessId, appAccessId2);
        });
      });
    });

    describe('[WH09] when using a personal token', () => {
      let webhooks, response;
      before(async () => {
        const res = await coreRequest
          .get(`/${username}/webhooks`)
          .set('Authorization', personalAccessToken);
        response = res;
        webhooks = res.body.webhooks;
      });

      it('[6MNC] should return a status 200 with a webhooks object which is an array', () => {
        validation.check(response, {
          schema: methodsSchema.get.result,
          status: 200
        });
      });

      it('[4YFQ] should fetch all webhooks for the user', () => {
        let found1 = false;
        let found2 = false;
        webhooks.forEach(w => {
          if (w.accessId === appAccessId1) {
            found1 = true;
          }
          if (w.accessId === appAccessId2) {
            found2 = true;
          }
        });
        assert.strictEqual(found1, true, 'did not find webhook1');
        assert.strictEqual(found2, true, 'did not find webhook2');
      });
    });

    describe('[WH10] when using a shared token', () => {
      let response;
      before(async () => {
        const res = await coreRequest
          .get(`/${username}/webhooks`)
          .set('Authorization', sharedAccessToken);
        response = res;
      });

      it('[RIZV] should return a status 200 with a webhooks object which is an array', () => {
        validation.check(response, {
          schema: methodsSchema.get.result,
          status: 200
        });
      });
    });
  });

  describe('[WH03] GET /:webhookId', () => {
    const url = 'yololo';
    const minIntervalMs = 10000;
    const maxRetries = 5;

    before(() => {
      personalAccessToken = cuid();
      appAccessId1 = cuid();
      appAccessToken1 = cuid();
      appAccessId2 = cuid();
      appAccessToken2 = cuid();
      sharedAccessToken = cuid();
      sharedAccessId = cuid();
      webhookId1 = cuid();
      webhookId2 = cuid();
      webhookId3 = cuid();
    });

    before(() => {
      username = cuid();
      return fixtures.user(username, {}, async (user) => {
        user.access({
          type: 'personal', token: personalAccessToken
        });
        user.access({
          id: appAccessId1,
          type: 'app',
          token: appAccessToken1
        });
        // The second app access is what makes [WH13] meaningful: without it,
        // webhook2 below hangs off an id left over from an earlier block —
        // an access this user never had — so [WH13]'s 403 proved only that
        // the access did not exist, not that the scope check rejects a
        // sibling app access.
        user.access({
          id: appAccessId2,
          type: 'app',
          token: appAccessToken2
        });
        user.access({
          id: sharedAccessId,
          type: 'shared',
          token: sharedAccessToken
        });
        user.session(personalAccessToken);
        user.webhook({
          id: webhookId1,
          url,
          minIntervalMs,
          maxRetries
        }, appAccessId1);
        user.webhook({
          id: webhookId2
        }, appAccessId2);
        user.webhook({
          id: webhookId3
        }, sharedAccessId);
      });
    });

    after(async () => {
      await fixtures.clean();
    });

    describe('[WH11] when using an app token', () => {
      describe('[WH12] when fetching an existing webhook inside its scope', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .get(`/${username}/webhooks/${webhookId1}`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[XMB7] should return a status 200 with a webhook object', () => {
          validation.check(response, {
            schema: methodsSchema.getOne.result,
            status: 200
          });
        });
      });

      describe('[WH13] when fetching an existing webhook outside of its scope', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .get(`/${username}/webhooks/${webhookId2}`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[BDC2] should return a status 403 with a forbidden error', () => {
          validation.checkErrorForbidden(response);
        });

        // Positive control for [BDC2]: the access that owns webhook2 must be
        // able to read it. Without this, a 403 above could equally mean the
        // webhook is unreachable by anyone, and the scope check would look
        // correct even if it rejected every app access.
        it('[W2SC] the owning app access can read the same webhook', async () => {
          const res = await coreRequest
            .get(`/${username}/webhooks/${webhookId2}`)
            .set('Authorization', appAccessToken2);
          validation.check(res, {
            schema: methodsSchema.getOne.result,
            status: 200
          });
        });
      });

      describe('[WH14] when fetching an unexistant webhook', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .get(`/${username}/webhooks/doesnotexist`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[O6MM] should return a status 404 with a unknown resource error', () => {
          validation.checkErrorUnknown(response);
        });
      });
    });

    describe('[WH15] when using a personal token', () => {
      let response;
      before(async () => {
        const res = await coreRequest
          .get(`/${username}/webhooks/${webhookId2}`)
          .set('Authorization', personalAccessToken);
        response = res;
      });

      it('[D8YQ] should return a status 200 with a webhook object', () => {
        validation.check(response, {
          schema: methodsSchema.getOne.result,
          status: 200
        });
      });
    });

    describe('[WH16] when using a shared token', () => {
      let response;
      before(async () => {
        const res = await coreRequest
          .get(`/${username}/webhooks/${webhookId3}`)
          .set('Authorization', sharedAccessToken);
        response = res;
      });

      it('[604H] should return a status 200 with a webhook object', () => {
        validation.check(response, {
          schema: methodsSchema.getOne.result,
          status: 200
        });
      });
    });
  });

  describe('[WH04] POST /', () => {
    const usedUrl = 'https://existing.com/notifications';

    before(async () => {
      await fixtures.clean();
      username = cuid();
      personalAccessToken = cuid();
      appAccessId1 = cuid();
      appAccessToken1 = cuid();
      sharedAccessId = cuid();
      sharedAccessToken = cuid();
    });

    before(() => {
      return fixtures.user(username, {}, async (user) => {
        user.access({
          type: 'personal', token: personalAccessToken
        });
        user.session(personalAccessToken);
        user.access({
          id: appAccessId1,
          type: 'app',
          token: appAccessToken1,
          permissions: [{ streamId: charlatan.Lorem.word(), level: 'read' }]
        });
        user.access({
          id: sharedAccessId,
          type: 'shared',
          token: sharedAccessToken
        });
        user.webhook({
          url: usedUrl
        }, appAccessId1);
      });
    });

    describe('[WH17] when using an app token', () => {
      describe('[WH18] when providing a valid webhook', () => {
        const url = 'https://somecompany.com/notifications';
        let webhook, response;
        before(async () => {
          const res = await coreRequest
            .post(`/${username}/webhooks`)
            .set('Authorization', appAccessToken1)
            .send({ url });
          response = res;
          webhook = new Webhook({
            accessId: appAccessId1,
            url,
            id: res.body.webhook.id
          }).forApi();
        });

        it('[Z1XD] should return a status 201 with the created webhook', () => {
          validation.check(response, {
            status: 201,
            schema: methodsSchema.create.result,
            data: webhook,
            sanitizeFn: validation.removeTrackingPropertiesForOne,
            sanitizeTarget: 'webhook'
          });
        });
        it('[XKLU] should save it to the storage', async () => {
          const findOneAsync = promisify((u, q, o, cb) => getWebhooksStorage().findOne(u, q, o, cb));
          const storedWebhook = await findOneAsync({ id: username }, { id: { $eq: webhook.id } }, {});
          assert.deepEqual(validation.removeTrackingPropertiesForOne(storedWebhook),
            validation.removeTrackingPropertiesForOne(webhook));
        });
      });

      describe('[WH19] when providing an existing url', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .post(`/${username}/webhooks`)
            .set('Authorization', appAccessToken1)
            .send({ url: usedUrl });
          response = res;
        });

        it('[60OQ] should return a status 409 with a collision error', () => {
          validation.checkError(response, {
            status: 409,
            id: ErrorIds.ItemAlreadyExists
          });
        });
      });

      describe('[WH20] when providing invalid parameters', () => {
        describe('[WH21] when url is not a string', () => {
          const url = 123;

          let response;
          before(async () => {
            const res = await coreRequest
              .post(`/${username}/webhooks`)
              .set('Authorization', appAccessToken1)
              .send({ url });
            response = res;
          });

          it('[3VIU] should return a status 400 with a invalid parameters error', () => {
            validation.checkErrorInvalidParams(response);
          });
        });
      });
    });

    describe('[WH22] when using a shared token', () => {
      describe('[WH23] when providing a valid webhook', () => {
        const url = `https://${charlatan.Internet.domainName()}/something`;
        let webhook, response;
        before(async () => {
          response = await coreRequest
            .post(`/${username}/webhooks`)
            .set('Authorization', sharedAccessToken)
            .send({ url });
          webhook = new Webhook({
            accessId: sharedAccessId,
            url,
            id: response.body.webhook.id
          }).forApi();
        });

        it('[YTLW] should return a status 201 with the created webhook', () => {
          validation.check(response, {
            status: 201,
            schema: methodsSchema.create.result,
            data: webhook,
            sanitizeFn: validation.removeTrackingPropertiesForOne,
            sanitizeTarget: 'webhook'
          });
        });
        it('[UC6J] should save it to the storage', async () => {
          const findOneAsync = promisify((u, q, o, cb) => getWebhooksStorage().findOne(u, q, o, cb));
          const storedWebhook = await findOneAsync({ id: username }, { id: { $eq: webhook.id } }, {});
          assert.deepEqual(validation.removeTrackingPropertiesForOne(storedWebhook),
            validation.removeTrackingPropertiesForOne(webhook));
        });
      });
    });

    describe('[WH24] when using a personal token', () => {
      describe('[WH25] when providing a valid webhook', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .post(`/${username}/webhooks`)
            .set('Authorization', personalAccessToken)
            .send({ url: 'doesntmatter' });
          response = res;
        });

        it('[3AZO] should return a status 403 with a forbidden error', () => {
          validation.checkErrorForbidden(response);
        });
      });
    });
  });

  describe('[WH05] PUT /:webhookId', () => {
    const url = 'yololo';
    const minIntervalMs = 10000;
    const maxRetries = 5;

    before(() => {
      personalAccessToken = cuid();
      appAccessId1 = cuid();
      appAccessToken1 = cuid();
      appAccessId2 = cuid();
      appAccessToken2 = cuid();
      sharedAccessId = cuid();
      sharedAccessToken = cuid();
      webhookId1 = cuid();
      webhookId2 = cuid();
      webhookId3 = cuid();
    });

    before(() => {
      username = cuid();
      return fixtures.user(username, {}, async (user) => {
        user.access({
          type: 'personal', token: personalAccessToken
        });
        user.session(personalAccessToken);
        user.access({
          id: appAccessId1,
          type: 'app',
          token: appAccessToken1
        });
        user.access({
          id: appAccessId2,
          type: 'app',
          token: appAccessToken2
        });
        user.access({
          id: sharedAccessId,
          type: 'shared',
          token: sharedAccessToken
        });
        user.webhook({
          id: webhookId1,
          url,
          minIntervalMs,
          maxRetries,
          currentRetries: 5,
          state: 'inactive'
        }, appAccessId1);
        user.webhook({
          id: webhookId2
        }, appAccessId2);
        user.webhook({
          id: webhookId3
        }, sharedAccessId);
      });
    });

    after(async () => {
      await fixtures.clean();
    });

    describe('[WH26] when using an app token', () => {
      describe('[WH27] when updating an existing webhook', () => {
        describe('[WH28] when changing a valid parameter', () => {
          let response, webhook;
          before(async () => {
            const res = await coreRequest
              .put(`/${username}/webhooks/${webhookId1}`)
              .set('Authorization', appAccessToken1)
              .send({
                state: 'active'
              });
            response = res;
            webhook = new Webhook({
              accessId: appAccessId1,
              url,
              id: webhookId1,
              minIntervalMs,
              maxRetries,
              state: 'active',
              currentRetries: 0
            }).forApi();
          });

          it('[C9FU] should return a status 200 with the updated webhook', () => {
            validation.check(response, {
              status: 200,
              schema: methodsSchema.update.result,
              data: webhook,
              sanitizeFn: validation.removeTrackingPropertiesForOne,
              sanitizeTarget: 'webhook'
            });
          });
          it('[JSOH] should apply the changes to the storage', async () => {
            const findOneAsync = promisify((u, q, o, cb) => getWebhooksStorage().findOne(u, q, o, cb));
            const storedWebhook = await findOneAsync({ id: username }, { id: { $eq: webhookId1 } }, {});
            assert.deepEqual(validation.removeTrackingPropertiesForOne(storedWebhook),
              validation.removeTrackingPropertiesForOne(webhook));
          });
        });

        describe('[WH29] when changing a readonly parameter', () => {
          let response;
          before(async () => {
            const res = await coreRequest
              .put(`/${username}/webhooks/${webhookId1}`)
              .set('Authorization', appAccessToken1)
              .send({
                lastRun: {
                  status: 201,
                  timestamp: timestamp.now()
                }
              });
            response = res;
          });

          it('[PW4I] should return a status 403 with an invalid parameter error', () => {
            validation.checkErrorForbidden(response);
          });
        });
      });

      describe('[WH30] when updating a webhook outside its scope', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .put(`/${username}/webhooks/${webhookId2}`)
            .set('Authorization', appAccessToken1)
            .send({
              state: 'inactive'
            });
          response = res;
        });

        it('[8T2G] should return a status 403 with a forbidden error', () => {
          validation.checkErrorForbidden(response);
        });
      });

      describe('[WH31] when updating an unexistant webhook', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .put(`/${username}/webhooks/doesnotexist`)
            .set('Authorization', appAccessToken1)
            .send({
              state: 'active'
            });
          response = res;
        });

        it('[AR5R] should return a status 404 with an unknown resource error', () => {
          validation.checkErrorUnknown(response);
        });
      });
    });

    describe('[WH32] when using a personal token', () => {
      describe('[WH33] when providing valid parameters', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .put(`/${username}/webhooks/${webhookId1}`)
            .set('Authorization', personalAccessToken)
            .send({
              state: 'inactive'
            });
          response = res;
        });

        it('[LCKN] should return a status 200 with the updated webhook', () => {
          validation.check(response, {
            status: 200,
            schema: methodsSchema.update.result
          });
        });
      });
    });

    describe('[WH34] when using a shared token', () => {
      describe('[WH35] when providing valid parameters', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .put(`/${username}/webhooks/${webhookId3}`)
            .set('Authorization', sharedAccessToken)
            .send({
              state: 'inactive'
            });
          response = res;
        });

        it('[TMIZ] should return a status 200 with the updated webhook', () => {
          validation.check(response, {
            status: 200,
            schema: methodsSchema.update.result
          });
        });
      });
    });
  });

  describe('[WH06] DELETE /:webhookId', () => {
    before(() => {
      personalAccessToken = cuid();
      appAccessId1 = cuid();
      appAccessToken1 = cuid();
      appAccessId2 = cuid();
      appAccessToken2 = cuid();
      sharedAccessToken = cuid();
      sharedAccessId = cuid();
      webhookId1 = cuid();
      webhookId2 = cuid();
      webhookId3 = cuid();
      webhookId4 = cuid();
    });

    before(() => {
      username = cuid();
      return fixtures.user(username, {}, async (user) => {
        user.access({
          type: 'personal', token: personalAccessToken
        });
        user.session(personalAccessToken);
        user.access({
          id: appAccessId1,
          type: 'app',
          token: appAccessToken1
        });
        user.access({
          id: appAccessId2,
          type: 'app',
          token: appAccessToken2
        });
        user.access({
          id: sharedAccessId,
          type: 'shared',
          token: sharedAccessToken
        });
        user.webhook({
          id: webhookId1
        }, appAccessId1);
        user.webhook({
          id: webhookId2
        }, appAccessId2);
        user.webhook({
          id: webhookId3
        }, appAccessId1);
        user.webhook({
          id: webhookId4
        }, sharedAccessId);
      });
    });

    after(async () => {
      await fixtures.clean();
    });

    describe('[WH36] when using an app token', () => {
      describe('[WH37] when deleting an existing webhook', () => {
        let response, deletion;
        before(async () => {
          const res = await coreRequest
            .delete(`/${username}/webhooks/${webhookId1}`)
            .set('Authorization', appAccessToken1);
          response = res;
          deletion = {
            id: response.body.id,
            timestamp: response.body.timestamp
          };
        });

        it('[A0CG] should return a status 200 with the webhook deletion', () => {
          validation.check(response, {
            status: 200,
            schema: methodsSchema.del.result,
            data: deletion
          });
        });

        it('[KA98] should delete it in the storage', async () => {
          const findOneAsync = promisify((u, q, o, cb) => getWebhooksStorage().findOne(u, q, o, cb));
          const deletedWebhook = await findOneAsync({ id: username }, { id: { $eq: webhookId1 } }, {});
          assert.ok(deletedWebhook == null);
        });
      });

      describe('[WH38] when deleting an unexistant webhook', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .delete(`/${username}/webhooks/doesnotexist`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[ZPRT] should return a status 404 with an unknown resource error', () => {
          validation.checkErrorUnknown(response);
        });
      });

      describe('[WH39] when deleting an already deleted webhook', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .delete(`/${username}/webhooks/${webhookId1}`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[5UX7] should return a status 404 with an unknown resource error', () => {
          validation.checkErrorUnknown(response);
        });
      });

      describe('[WH40] when deleting a webhook outside of its scope', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .delete(`/${username}/webhooks/${webhookId2}`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[7O0F] should return a status 403 with a forbidden error', () => {
          validation.checkErrorForbidden(response);
        });
      });
    });

    describe('[WH41] when using a personal token', () => {
      describe('[WH42] when deleting an existing webhook', () => {
        let response, deletion;
        before(async () => {
          const res = await coreRequest
            .delete(`/${username}/webhooks/${webhookId3}`)
            .set('Authorization', personalAccessToken);
          response = res;
          deletion = {
            id: response.body.id,
            timestamp: response.body.timestamp
          };
        });

        it('[P6X4] should return a status 200 with the webhook deletion', () => {
          validation.check(response, {
            status: 200,
            schema: methodsSchema.del.result,
            data: deletion
          });
        });
      });
    });

    describe('[WH43] when using a shared token', () => {
      describe('[WH44] when deleting an existing webhook', () => {
        let response, deletion;
        before(async () => {
          const res = await coreRequest
            .delete(`/${username}/webhooks/${webhookId4}`)
            .set('Authorization', sharedAccessToken);
          response = res;
          deletion = {
            id: response.body.id,
            timestamp: response.body.timestamp
          };
        });

        it('[OZZB] should return a status 200 with the webhook deletion', () => {
          validation.check(response, {
            status: 200,
            schema: methodsSchema.del.result,
            data: deletion
          });
        });
      });
    });
  });

  describe('[SNWA] scoped webhooks', () => {
    let scUsername, appToken;
    const streamId = 'snwa-stream';
    const scopes = { s: { kind: 'events', query: { streams: [streamId] } } };
    before(async () => {
      await fixtures.clean();
      scUsername = cuid();
      appToken = cuid();
      await fixtures.user(scUsername, {}, async (user) => {
        user.stream({ id: streamId, name: 'SNWA' });
        user.access({ id: cuid(), type: 'app', token: appToken, permissions: [{ streamId, level: 'read' }] });
      });
    });
    after(async () => { await fixtures.clean(); });

    it('[SNWA1] creates a webhook with scopes and echoes them without the internal prepared form', async () => {
      const res = await coreRequest
        .post(`/${scUsername}/webhooks`)
        .set('Authorization', appToken)
        .send({ url: 'https://sc1.example/hook', scopes });
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(res.body.webhook.scopes, scopes);
      assert.strictEqual(res.body.webhook.scopes.s.prepared, undefined, 'prepared must not be exposed via the API');
    });

    it('[SNWA2] getOne returns the scopes', async () => {
      const createRes = await coreRequest
        .post(`/${scUsername}/webhooks`)
        .set('Authorization', appToken)
        .send({ url: 'https://sc2.example/hook', scopes });
      const id = createRes.body.webhook.id;
      const res = await coreRequest
        .get(`/${scUsername}/webhooks/${id}`)
        .set('Authorization', appToken);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.webhook.scopes, scopes);
    });
  });

  describe('[WH07] POST /:webhookId/test', () => {
    const port = 5553;
    const postPath = '/notifications';

    let notificationsServer;
    before(async () => {
      notificationsServer = new HttpServer(postPath, 200);
      await notificationsServer.listen(port);
    });

    before(() => {
      personalAccessToken = cuid();
      appAccessId1 = cuid();
      appAccessToken1 = cuid();
      appAccessId2 = cuid();
      appAccessToken2 = cuid();
      sharedAccessId = cuid();
      sharedAccessToken = cuid();
      webhookId1 = cuid();
      webhookId2 = cuid();
      webhookId3 = cuid();
    });

    before(() => {
      username = cuid();
      return fixtures.user(username, {}, async (user) => {
        user.access({
          type: 'personal', token: personalAccessToken
        });
        user.session(personalAccessToken);
        user.access({
          id: appAccessId1,
          type: 'app',
          token: appAccessToken1
        });
        user.access({
          id: appAccessId2,
          type: 'app',
          token: appAccessToken2
        });
        user.access({
          id: sharedAccessId,
          type: 'shared',
          token: sharedAccessToken
        });
        user.webhook({
          url: 'http://127.0.0.1:' + port + postPath,
          id: webhookId1
        }, appAccessId1);
        user.webhook({
          id: webhookId2
        }, appAccessId2);
        user.webhook({
          url: 'http://127.0.0.1:' + port + postPath,
          id: webhookId3
        }, sharedAccessId);
      });
    });

    after(async () => {
      await fixtures.clean();
      await notificationsServer.close();
    });

    describe('[WH45] when using an app token', () => {
      describe('[WH46] when the webhook exists', () => {
        describe('[WH47] when the URL is valid', () => {
          let response;
          before(async () => {
            response = await coreRequest
              .post(`/${username}/webhooks/${webhookId1}/test`)
              .set('Authorization', appAccessToken1);
          });

          it('[ZM2B] should return a status 200 with a webhook object', () => {
            validation.check(response, {
              schema: methodsSchema.test.result,
              status: 200
            });
          });

          it('[Q7KL] should send a POST request to the URL', async () => {
            assert.strictEqual(notificationsServer.isMessageReceived(), true);
          }).timeout(1000);
        });

        describe('[WH48] when the URL is invalid', () => {
          let response;
          before(async () => {
            notificationsServer.setResponseStatus(404);
            response = await coreRequest
              .post(`/${username}/webhooks/${webhookId1}/test`)
              .set('Authorization', appAccessToken1);
          });

          it('[KLRO] should return a status 400 with an error object', () => {
            validation.check(response, {
              status: 400,
              id: ErrorIds.UnknownReferencedResource
            });
          });
        });
      });

      describe('[WH49] when the webhook does not exist', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .post(`/${username}/webhooks/doesnotexist/test`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[KXA8] should return a status 404 with a unknown resource error', () => {
          validation.checkErrorUnknown(response);
        });
      });

      describe('[WH50] when the webhook is outside of its scope', () => {
        let response;
        before(async () => {
          const res = await coreRequest
            .post(`/${username}/webhooks/${webhookId2}/test`)
            .set('Authorization', appAccessToken1);
          response = res;
        });

        it('[KZJD] should return a status 403 with a forbidden error', () => {
          validation.checkErrorForbidden(response);
        });
      });
    });

    describe('[WH51] when using a personal token', () => {
      describe('[WH52] when the webhook exists', () => {
        let response;
        before(async () => {
          notificationsServer.resetMessageReceived();
          notificationsServer.setResponseStatus(200);
          const res = await coreRequest
            .post(`/${username}/webhooks/${webhookId1}/test`)
            .set('Authorization', personalAccessToken);
          response = res;
        });

        it('[HYZZ] should return a status 200 with a webhook object', () => {
          validation.check(response, {
            schema: methodsSchema.test.result,
            status: 200
          });
        });

        it('[SBI7] should send a POST request to the URL', async () => {
          assert.strictEqual(notificationsServer.isMessageReceived(), true);
        }).timeout(1000);
      });
    });

    describe('[WH53] when using a shared token', () => {
      describe('[WH54] when the webhook exists', () => {
        let response;
        before(async () => {
          notificationsServer.resetMessageReceived();
          notificationsServer.setResponseStatus(200);
          const res = await coreRequest
            .post(`/${username}/webhooks/${webhookId3}/test`)
            .set('Authorization', sharedAccessToken);
          response = res;
        });

        it('[O8PB] should return a status 200 with a webhook object', () => {
          validation.check(response, {
            schema: methodsSchema.test.result,
            status: 200
          });
        });

        it('[C62I] should send a POST request to the URL', async () => {
          assert.strictEqual(notificationsServer.isMessageReceived(), true);
        }).timeout(1000);
      });
    });
  });

  describe('[WV00] create input and destination rules', () => {
    const http = require('node:http');
    let vUsername, vAppToken, vAppId, vOtherAppId, config, savedAllowList;
    let receiver, receivedCount, receiverStatus;

    function setAllowList (list) {
      config.set('webhooks:allowedPrivateHosts', list);
    }
    function create (body) {
      return coreRequest
        .post(`/${vUsername}/webhooks`)
        .set('Authorization', vAppToken)
        .send(body);
    }
    async function storedWebhooksCount () {
      const findAsync = promisify((u, q, o, cb) => getWebhooksStorage().find(u, q, o, cb));
      return (await findAsync({ id: vUsername }, {}, {})).length;
    }

    before(async () => {
      await fixtures.clean();
      config = require('@pryv/boiler').getConfigSync();
      savedAllowList = config.get('webhooks:allowedPrivateHosts');
      vUsername = cuid();
      vAppToken = cuid();
      vAppId = cuid();
      vOtherAppId = cuid();
      await fixtures.user(vUsername, {}, async (user) => {
        user.access({ id: vAppId, type: 'app', token: vAppToken });
        user.access({ id: vOtherAppId, type: 'app', token: cuid() });
      });
      receivedCount = 0;
      receiverStatus = 200;
      receiver = http.createServer((req, res) => {
        receivedCount++;
        req.resume();
        res.statusCode = receiverStatus;
        res.end();
      });
      // default host: listens on both loopback families, as `localhost` may resolve to either
      await new Promise((resolve) => receiver.listen(0, resolve));
    });
    after(async () => {
      setAllowList(savedAllowList);
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
      await fixtures.clean();
    });

    describe('[WV01] without allowed private hosts', () => {
      before(() => setAllowList([]));
      after(() => setAllowList(savedAllowList));

      it('[WVA1] refuses a URL with a loopback, private, link-local or metadata IP address', async () => {
        for (const url of [
          'http://127.0.0.1:5553/notifications', 'http://2130706433/', 'http://10.0.0.1/hook', 'http://172.16.5.4/hook',
          'http://192.168.1.10/hook', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/hook',
          'http://[::1]/hook', 'http://[::ffff:127.0.0.1]/hook', 'http://[fd00::1]/hook', 'http://[fe80::1]/hook', 'http://0.0.0.0/hook'
        ]) {
          const res = await create({ url });
          assert.strictEqual(res.status, 400, url);
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat, url);
        }
        assert.strictEqual(await storedWebhooksCount(), 0);
      });

      it('[WVA2] refuses other schemes, credentials and over-long URLs', async () => {
        for (const url of [
          'ftp://hooks.example.com/', 'file:///etc/passwd', 'https://user:secret@hooks.example.com/',
          'hooks.example.com/no-scheme', 'https://hooks.example.com/' + 'a'.repeat(2048)
        ]) {
          const res = await create({ url });
          assert.strictEqual(res.status, 400, url.slice(0, 60));
        }
        assert.strictEqual(await storedWebhooksCount(), 0);
      });

      it('[WVA3] webhooks.test of a host name resolving to loopback: same error as a failed call, nothing reaches the receiver', async () => {
        const port = receiver.address().port;
        const created = await create({ url: `http://localhost:${port}/wva3?k=v` });
        assert.strictEqual(created.status, 201);
        const id = created.body.webhook.id;

        // reference: an allowed receiver answering 404
        setAllowList(['localhost']);
        receiverStatus = 404;
        const reference = await coreRequest.post(`/${vUsername}/webhooks/${id}/test`).set('Authorization', vAppToken);
        assert.strictEqual(reference.status, 400);
        assert.strictEqual(receivedCount, 1);

        setAllowList([]);
        receiverStatus = 200;
        const refused = await coreRequest.post(`/${vUsername}/webhooks/${id}/test`).set('Authorization', vAppToken);
        assert.strictEqual(refused.status, 400);
        assert.strictEqual(refused.body.error.id, ErrorIds.UnknownReferencedResource);
        assert.deepStrictEqual(refused.body.error, reference.body.error);
        assert.strictEqual(receivedCount, 1, 'the refused call must not reach the receiver');
      });
    });

    describe('[WV02] with allowed private hosts', () => {
      it('[WVA4] lets an allowed private host through', async () => {
        setAllowList(['localhost']);
        receiverStatus = 200;
        const before = receivedCount;
        const created = await create({ url: `http://localhost:${receiver.address().port}/wva4` });
        assert.strictEqual(created.status, 201);
        const res = await coreRequest.post(`/${vUsername}/webhooks/${created.body.webhook.id}/test`).set('Authorization', vAppToken);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(receivedCount, before + 1);
        setAllowList(savedAllowList);
      });

      it('[WVA5] accepts an allowed private IP literal at creation', async () => {
        setAllowList(['10.20.0.0/16']);
        const res = await create({ url: 'http://10.20.1.2/wva5' });
        assert.strictEqual(res.status, 201);
        const other = await create({ url: 'http://10.21.1.2/wva5' });
        assert.strictEqual(other.status, 400);
        setAllowList(savedAllowList);
      });
    });

    describe('[WV03] server-managed fields', () => {
      it('[WVB1] refuses an accessId, even of another access of the user', async () => {
        const res = await create({ url: 'https://wvb1.example.com/hook', accessId: vOtherAppId });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
      });

      it('[WVB2] refuses id, maxRetries, minIntervalMs, state, counters and tracking properties', async () => {
        for (const extra of [
          { id: cuid() }, { maxRetries: 1000 }, { minIntervalMs: 1 }, { state: 'inactive' }, { runCount: 3 },
          { failCount: 2 }, { currentRetries: 1 }, { runs: [] }, { lastRun: { status: 200, timestamp: 1 } },
          { created: 1 }, { createdBy: 'someone' }, { unknownField: true }
        ]) {
          const res = await create(Object.assign({ url: `https://wvb2-${cuid()}.example.com/hook` }, extra));
          assert.strictEqual(res.status, 400, JSON.stringify(extra));
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat, JSON.stringify(extra));
        }
      });

      it('[WVB3] creates from url (and scopes) with server-assigned values', async () => {
        const res = await create({ url: 'https://wvb3.example.com/hook' });
        assert.strictEqual(res.status, 201);
        const w = res.body.webhook;
        assert.strictEqual(w.accessId, vAppId);
        assert.strictEqual(w.state, 'active');
        assert.strictEqual(w.maxRetries, config.get('webhooks:maxRetries'));
        assert.strictEqual(w.minIntervalMs, config.get('webhooks:minIntervalMs'));
        assert.strictEqual(w.runCount, 0);
        assert.strictEqual(w.failCount, 0);
        assert.strictEqual(w.currentRetries, 0);
        assert.deepStrictEqual(w.runs, []);
        assert.strictEqual(w.createdBy, vAppId);
      });

      it('[WVB4] update refuses accessId and an unknown state', async () => {
        const created = await create({ url: 'https://wvb4.example.com/hook' });
        const id = created.body.webhook.id;
        const res = await coreRequest.put(`/${vUsername}/webhooks/${id}`).set('Authorization', vAppToken).send({ accessId: vOtherAppId });
        assert.strictEqual(res.status, 403);
        const bad = await coreRequest.put(`/${vUsername}/webhooks/${id}`).set('Authorization', vAppToken).send({ state: 'paused' });
        assert.strictEqual(bad.status, 400);
        const after = await coreRequest.get(`/${vUsername}/webhooks/${id}`).set('Authorization', vAppToken);
        assert.strictEqual(after.body.webhook.accessId, vAppId);
        assert.strictEqual(after.body.webhook.state, 'active');
      });
    });
  });
});
