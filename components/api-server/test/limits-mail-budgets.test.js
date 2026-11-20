/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, assert */

/**
 * [MLBG] Budgets on mail a caller can make the platform send: registration
 * codes per client address, distinct verification addresses per account and
 * day, and the per-core hourly breaker on caller-triggered mails.
 */

const { withInjectedConfig } = require('test-helpers');
const { ErrorIds } = require('errors/src/index.ts');
const mailBudgets = require('../src/methods/helpers/mailBudgets.ts');
const mailing = require('../src/methods/helpers/mailing.ts');

describe('[MLBG] mail budgets', function () {
  before(async function () {
    await initTests();
  });

  beforeEach(async function () {
    await mailBudgets.clear();
  });

  after(async function () {
    await mailBudgets.clear();
  });

  it('[MLBG1] registration codes are counted per client address; past the budget the address gets 429; 0 disables it', async function () {
    await withInjectedConfig({ account: { emailVerification: { registrationCodesPerIpPerHour: 2 } } }, async () => {
      assert.strictEqual(await mailBudgets.reserveChallengeFromIp('192.0.2.10'), null);
      assert.strictEqual(await mailBudgets.reserveChallengeFromIp('192.0.2.10'), null);
      const refused = await mailBudgets.reserveChallengeFromIp('192.0.2.10');
      assert.strictEqual(refused?.id, ErrorIds.TooManyAttempts);
      assert.strictEqual(refused.httpStatus, 429);
      assert.strictEqual(refused.data.reason, 'ip-limit');
      assert.strictEqual(await mailBudgets.reserveChallengeFromIp('192.0.2.11'), null, 'another address has its own budget');
    });
    await withInjectedConfig({ account: { emailVerification: { registrationCodesPerIpPerHour: 0 } } }, async () => {
      assert.strictEqual(await mailBudgets.reserveChallengeFromIp('192.0.2.10'), null);
    });
  });

  it('[MLBG2] an account gets verification mails sent to a bounded number of distinct addresses a day; an address already counted is free', async function () {
    await withInjectedConfig({ account: { emailVerification: { addressesPerAccountPerDay: 2 } } }, async () => {
      assert.strictEqual(await mailBudgets.reserveVerificationAddress('user-a', 'one@example.com'), null);
      assert.strictEqual(await mailBudgets.reserveVerificationAddress('user-a', 'two@example.com'), null);
      assert.strictEqual(await mailBudgets.reserveVerificationAddress('user-a', 'ONE@example.com'), null, 'same address, any case');
      const retry = await mailBudgets.reserveVerificationAddress('user-a', 'three@example.com');
      assert.ok(typeof retry === 'number' && retry > 0, 'a third distinct address is refused');
      // The refused address was not marked: still refused, not free.
      assert.ok(await mailBudgets.reserveVerificationAddress('user-a', 'three@example.com') != null);
      assert.strictEqual(await mailBudgets.reserveVerificationAddress('user-b', 'three@example.com'), null, 'per account');
    });
  });

  it('[MLBG3] past services.email.maxPerHour the caller-triggered sends of the core are refused with 429, already logged, before any delivery', async function () {
    await withInjectedConfig({ services: { email: { maxPerHour: 2 } } }, async () => {
      assert.strictEqual(await mailBudgets.meterCallerMail(), null);
      assert.strictEqual(await mailBudgets.meterCallerMail(), null);
      const refused = await mailBudgets.meterCallerMail();
      assert.strictEqual(refused?.id, ErrorIds.TooManyRequests);
      const err = await new Promise((resolve) => {
        // An invalid method would fail delivery with an unexpected error: the
        // breaker answers first.
        mailing.sendmailMetered({ method: 'none' }, 'tpl', { email: 'x@example.com', type: 'to' }, {}, 'en', resolve);
      });
      assert.strictEqual(err?.id, ErrorIds.TooManyRequests, String(err));
      assert.strictEqual(mailing.isLoggedMailFailure(err), true);
    });
    await withInjectedConfig({ services: { email: { maxPerHour: 0 } } }, async () => {
      assert.strictEqual(await mailBudgets.meterCallerMail(), null);
    });
  });

  it('[MLBG4] defaults', function () {
    assert.deepStrictEqual({ ...mailBudgets.MAIL_BUDGET_DEFAULTS }, { registrationCodesPerIpPerHour: 10, addressesPerAccountPerDay: 10, maxPerHour: 500 });
  });
});
