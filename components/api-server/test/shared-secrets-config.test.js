/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Shared secrets — behaviour under non-default configuration.
 *
 * Separate from the main suite because these need the platform configured
 * differently from the defaults everything else runs on. The feature reads its
 * settings per request rather than capturing them at boot, so an operator
 * toggle takes effect without a restart — and so these tests can exercise it.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { withInjectedConfig } = require('test-helpers');

describe('[SHSCFG] shared secrets — configuration', function () {
  let username, personalToken, secretsPath;

  function validBody (over = {}) {
    return Object.assign({
      ttl: 300,
      title: 'config test',
      onConsumed: { message: 'used' },
      secret: { token: 'abc' }
    }, over);
  }

  before(async function () {
    await initTests();
    await initCore();
    const fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    secretsPath = '/' + username + '/shared-secrets';
    const user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
  });

  it('[SHS61] enabled by default — the feature is inert, not absent', async function () {
    const res = await coreRequest.post(secretsPath)
      .set('Authorization', personalToken).send(validBody());
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('[SHS62] sharedSecrets.enabled:false refuses both creation and redemption', async function () {
    // Mint a live secret first, so we can prove an ALREADY-ISSUED key stops
    // working too — disabling the feature must not leave redeemable keys behind.
    const created = await coreRequest.post(secretsPath)
      .set('Authorization', personalToken).send(validBody());
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const key = created.body.sharedSecret.key;

    await withInjectedConfig({ sharedSecrets: { enabled: false } }, async () => {
      const create = await coreRequest.post(secretsPath)
        .set('Authorization', personalToken).send(validBody());
      assert.notStrictEqual(create.status, 201,
        'creation must be refused while the feature is off');

      const redeem = await coreRequest.post(secretsPath + '/retrieve').send({ key });
      assert.notStrictEqual(redeem.status, 200,
        'an already-issued key must not redeem while the feature is off');
      assert.strictEqual(redeem.body?.secret, undefined);
    });

    // …and turning it back on restores the untouched secret.
    const after = await coreRequest.post(secretsPath + '/retrieve').send({ key });
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
    assert.deepStrictEqual(after.body.secret, { token: 'abc' });
  });

  it('[SHS63] limits are read per request, so an operator can tighten them live', async function () {
    await withInjectedConfig({ sharedSecrets: { maxTtl: 60 } }, async () => {
      const tooLong = await coreRequest.post(secretsPath)
        .set('Authorization', personalToken).send(validBody({ ttl: 300 }));
      assert.strictEqual(tooLong.status, 400,
        'the tightened maxTtl must apply without a restart: ' + JSON.stringify(tooLong.body));

      const ok = await coreRequest.post(secretsPath)
        .set('Authorization', personalToken).send(validBody({ ttl: 60 }));
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    });

    // Back to the default ceiling once the override is gone.
    const restored = await coreRequest.post(secretsPath)
      .set('Authorization', personalToken).send(validBody({ ttl: 300 }));
    assert.strictEqual(restored.status, 201, JSON.stringify(restored.body));
  });

  it('[SHS64] a tightened maxSizeBytes applies live too', async function () {
    await withInjectedConfig({ sharedSecrets: { maxSizeBytes: 64 } }, async () => {
      const tooBig = await coreRequest.post(secretsPath)
        .set('Authorization', personalToken)
        .send(validBody({ secret: { blob: 'x'.repeat(200) } }));
      assert.strictEqual(tooBig.status, 400, JSON.stringify(tooBig.body));
    });
  });
});
