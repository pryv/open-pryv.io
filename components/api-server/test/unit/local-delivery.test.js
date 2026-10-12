/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { accountUrlParts } = require('../../src/methods/helpers/localDelivery.ts');
const { setDeletionTeardownStep, runDeletionTeardownSteps, trackTeardownDelivery } = require('business/src/auth/deletionTeardown.ts');

describe('[LDLV] deliveries to accounts of this core', function () {
  it('[LDL1] finds the account and path in both API URL formats', function () {
    assert.deepStrictEqual(accountUrlParts('https://alice.example.com/events', 'https://{username}.example.com/'),
      { username: 'alice', path: 'events' });
    assert.deepStrictEqual(accountUrlParts('https://core.example.com/alice/events', 'https://core.example.com/{username}/'),
      { username: 'alice', path: 'events' });
    assert.strictEqual(accountUrlParts('https://other.example.org/alice/events', 'https://core.example.com/{username}/'), null);
    assert.strictEqual(accountUrlParts('https://a.b.example.com/events', 'https://{username}.example.com/'), null);
  });

  it('[LDL2] the teardown waits for its deliveries, within a bound', async function () {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    let delivered = false;
    setDeletionTeardownStep('ldl2-test', async () => {
      trackTeardownDelivery(new Promise((resolve) => setTimeout(() => { delivered = true; resolve(); }, 50)));
    });
    try {
      await runDeletionTeardownSteps({ id: 'u1', username: 'u1' }, logger, 1000);
      assert.strictEqual(delivered, true, 'awaited');
      // the steps other modules registered run too and may warn about these fake accounts
      const pending = () => warnings.filter((w) => /still pending/.test(w));
      assert.deepStrictEqual(pending(), []);

      setDeletionTeardownStep('ldl2-test', async () => { trackTeardownDelivery(new Promise(() => {})); });
      const t0 = Date.now();
      await runDeletionTeardownSteps({ id: 'u2', username: 'u2' }, logger, 100);
      assert.ok(Date.now() - t0 < 1000, 'bounded');
      assert.strictEqual(pending().length, 1);
    } finally {
      setDeletionTeardownStep('ldl2-test', async () => {});
    }
  });
});
