/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [WHLM] Bounds on webhooks: webhooks.maxPerAccess, webhooks.maxPerUser,
 * webhooks.maxScopes. A cap refuses the new webhook or scope set; webhooks
 * already stored keep working.
 */

const { withInjectedConfig } = require('test-helpers');
const { ErrorIds } = require('errors/src/index.ts');
const { readWebhookLimits, WEBHOOK_LIMIT_DEFAULTS } = require('../src/methods/helpers/webhookLimits.ts');

describe('[WHLM] webhook limits', function () {
  let fixtures, username, appToken, otherAppToken, thirdAppToken, streamId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  beforeEach(async function () {
    username = cuid();
    appToken = cuid();
    otherAppToken = cuid();
    thirdAppToken = cuid();
    streamId = 'whlm-' + cuid();
    const user = await fixtures.user(username, {});
    await user.stream({ id: streamId, name: 'whlm ' + streamId });
    await user.access({ type: 'app', token: appToken, name: 'whlm-a', permissions: [{ streamId, level: 'read' }] });
    await user.access({ type: 'app', token: otherAppToken, name: 'whlm-b', permissions: [{ streamId, level: 'read' }] });
    await user.access({ type: 'app', token: thirdAppToken, name: 'whlm-c', permissions: [{ streamId, level: 'read' }] });
  });

  afterEach(async function () {
    await fixtures.clean();
  });

  function create (token, extra = {}) {
    return coreRequest.post('/' + username + '/webhooks').set('Authorization', token)
      .send({ url: `https://whlm-${cuid()}.example.com/hook`, ...extra });
  }

  function scopesOf (n) {
    const scopes = {};
    for (let i = 0; i < n; i++) scopes['s' + i] = { kind: 'events', query: { streams: [streamId] } };
    return scopes;
  }

  it('[WHLM1] past webhooks.maxPerAccess an access cannot create one more; another access still can; 0 disables it', async function () {
    await withInjectedConfig({ webhooks: { maxPerAccess: 2 } }, async () => {
      assert.strictEqual((await create(appToken)).status, 201);
      assert.strictEqual((await create(appToken)).status, 201);
      const refused = await create(appToken);
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error.id, ErrorIds.InvalidOperation);
      assert.match(refused.body.error.message, /webhooks\.maxPerAccess/);
      assert.strictEqual((await create(otherAppToken)).status, 201, 'another access');
      const list = await coreRequest.get('/' + username + '/webhooks').set('Authorization', appToken);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.webhooks.length, 2, 'the stored webhooks keep working');
    });
    await withInjectedConfig({ webhooks: { maxPerAccess: 0 } }, async () => {
      assert.strictEqual((await create(appToken)).status, 201);
    });
  });

  it('[WHLM2] past webhooks.maxPerUser no access of the account can create one more', async function () {
    await withInjectedConfig({ webhooks: { maxPerUser: 3, maxPerAccess: 0 } }, async () => {
      assert.strictEqual((await create(appToken)).status, 201);
      assert.strictEqual((await create(otherAppToken)).status, 201);
      assert.strictEqual((await create(thirdAppToken)).status, 201);
      const refused = await create(otherAppToken);
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error.id, ErrorIds.InvalidOperation);
      assert.match(refused.body.error.message, /webhooks\.maxPerUser/);
    });
  });

  it('[WHLM3] more than webhooks.maxScopes scopes are refused on create and on update', async function () {
    await withInjectedConfig({ webhooks: { maxScopes: 2 } }, async () => {
      const refused = await create(appToken, { scopes: scopesOf(3) });
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error.id, ErrorIds.InvalidParametersFormat);
      assert.match(refused.body.error.message, /webhooks\.maxScopes/);
      const created = await create(appToken, { scopes: scopesOf(2) });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const update = await coreRequest.put('/' + username + '/webhooks/' + created.body.webhook.id)
        .set('Authorization', appToken).send({ scopes: scopesOf(3) });
      assert.strictEqual(update.status, 400, JSON.stringify(update.body));
      assert.strictEqual(update.body.error.id, ErrorIds.InvalidParametersFormat);
    });
  });

  it('[WHLM4] defaults: 10 per access, 100 per account, 20 scopes', function () {
    assert.deepStrictEqual(readWebhookLimits(() => undefined), { ...WEBHOOK_LIMIT_DEFAULTS });
    assert.deepStrictEqual({ ...WEBHOOK_LIMIT_DEFAULTS }, { maxPerAccess: 10, maxPerUser: 100, maxScopes: 20 });
    assert.deepStrictEqual(readWebhookLimits(() => 0), { maxPerAccess: 0, maxPerUser: 0, maxScopes: 0 });
  });
});
