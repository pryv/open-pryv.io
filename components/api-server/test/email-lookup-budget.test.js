/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The public email lookups share one per-address budget: an address that
 * looked up too many emails, through any of the routes, is refused on all of
 * them until its window ends; another address is not. A signed-in account
 * asking the same through `account.update` has a budget of its own.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { LOOKUPS_PER_WINDOW, ACCOUNT_LOOKUPS_PER_WINDOW, clear } = require('../src/routes/reg/emailLookupBudget.ts');

const LOOKUPS = [
  (email) => coreRequest.get('/reg/' + encodeURIComponent(email) + '/check_email'),
  (email) => coreRequest.get('/reg/' + encodeURIComponent(email) + '/username'),
  (email) => coreRequest.get('/reg/' + encodeURIComponent(email) + '/uid'),
  (email) => coreRequest.get('/reg/cores').query({ email })
];

function lookupFrom (address, route, i) {
  return LOOKUPS[route](`emlb-${i}@example.test`).set('X-Forwarded-For', address);
}

describe('[EMLB] public email lookups share a per-address budget', function () {
  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
  });

  afterEach(async function () { await clear(); });

  it('[EMLB1] past the budget, spread over the four routes, every route answers 429; another address is not refused', async function () {
    const address = '203.0.113.70';
    for (let i = 0; i < LOOKUPS_PER_WINDOW; i++) {
      const res = await lookupFrom(address, i % LOOKUPS.length, i);
      assert.notStrictEqual(res.status, 429, 'lookup ' + i + ' is within the budget: ' + res.text);
    }
    for (let route = 0; route < LOOKUPS.length; route++) {
      const refused = await lookupFrom(address, route, 1000 + route);
      assert.strictEqual(refused.status, 429, 'route ' + route + ': ' + refused.text);
      assert.strictEqual(refused.body.error.id, 'too-many-attempts');
      assert.ok(Number(refused.headers['retry-after']) >= 1, 'a Retry-After header is set');
      assert.ok(refused.body.error.data.retryAfterSeconds >= 1, 'data.retryAfterSeconds is set');
    }
    for (let route = 0; route < LOOKUPS.length; route++) {
      assert.notStrictEqual((await lookupFrom('203.0.113.71', route, 2000 + route)).status, 429);
    }
  });

  it('[EMLB2] a core lookup by username does not count', async function () {
    const address = '203.0.113.72';
    for (let i = 0; i < LOOKUPS_PER_WINDOW + 5; i++) {
      const res = await coreRequest.get('/reg/cores').query({ username: 'emlb-nobody-' + i }).set('X-Forwarded-For', address);
      assert.notStrictEqual(res.status, 429, 'username lookup ' + i + ': ' + res.text);
    }
    assert.notStrictEqual((await lookupFrom(address, 0, 0)).status, 429, 'the email budget of the address is untouched');
  });

  it('[EMLB3] a refused lookup answers nothing about the address', async function () {
    const address = '203.0.113.73';
    for (let i = 0; i < LOOKUPS_PER_WINDOW; i++) await lookupFrom(address, 1, i);
    const refused = await lookupFrom(address, 1, 0);
    assert.strictEqual(refused.status, 429);
    assert.strictEqual(refused.body.username, undefined);
    assert.strictEqual(refused.headers.location, undefined);
  });

  it('[EMLB4] the lookup methods are refused inside a batch call, where the budget would not apply', async function () {
    const fixtures = getNewFixture();
    try {
      const username = ('emlb' + cuid.slug()).toLowerCase();
      const token = cuid();
      const user = await fixtures.user(username);
      await user.access({ type: 'personal', token, name: 'pryv-test' });
      await user.session(token);
      const res = await coreRequest.post('/' + username).set('Authorization', token).send([
        { method: 'auth.emailCheck', params: { email: 'emlb-batch@example.test' } },
        { method: 'auth.cores', params: { email: 'emlb-batch@example.test' } }
      ]);
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(res.body.results.length, 2);
      for (const result of res.body.results) {
        assert.strictEqual(result.error?.id, 'invalid-operation', JSON.stringify(result));
      }
    } finally {
      await fixtures.clean();
    }
  });

  it('[EMLB5] a signed-in account asking whether other accounts hold addresses has a budget of its own, whatever the form of the call', async function () {
    this.timeout(30000);
    const fixtures = getNewFixture();
    try {
      const makeUser = async () => {
        const username = ('emlb' + cuid.slug()).toLowerCase();
        const token = cuid();
        const email = username + '@emlb-account.example.test';
        const user = await fixtures.user(username, { email });
        await user.access({ type: 'personal', token, name: 'pryv-test' });
        await user.session(token);
        const put = (update) => coreRequest.put('/' + username + '/account').set('Authorization', token).send(update);
        return { username, token, email, put };
      };
      const [holder, asker, other] = [await makeUser(), await makeUser(), await makeUser()];
      const ask = [
        (u) => u.put({ emails: { add: [holder.email] } }),
        (u) => u.put({ email: holder.email })
      ];
      for (let i = 0; i < ACCOUNT_LOOKUPS_PER_WINDOW; i++) {
        const res = await ask[i % ask.length](asker);
        assert.strictEqual(res.body.error?.id, 'item-already-exists', 'ask ' + i + ': ' + res.text);
      }
      for (const form of ask) {
        const refused = await form(asker);
        assert.strictEqual(refused.status, 429, refused.text);
        assert.strictEqual(refused.body.error.id, 'too-many-attempts');
        assert.strictEqual(refused.body.error.data.reason, 'account-email-lookups');
        assert.ok(refused.body.error.data.retryAfterSeconds >= 1);
      }
      const batch = await coreRequest.post('/' + asker.username).set('Authorization', asker.token).send([
        { method: 'account.update', params: { update: { emails: { add: [holder.email] } } } }
      ]);
      assert.strictEqual(batch.body.results[0].error?.id, 'too-many-attempts', batch.text);

      // what asks nothing about another account still works, and other accounts are not refused
      assert.strictEqual((await asker.put({ email: asker.email, language: 'fr' })).status, 200);
      assert.strictEqual((await ask[0](other)).body.error?.id, 'item-already-exists');
    } finally {
      await fixtures.clean();
    }
  });

  it('[EMLB6] several addresses in one call count each', async function () {
    const fixtures = getNewFixture();
    try {
      const username = ('emlb' + cuid.slug()).toLowerCase();
      const token = cuid();
      const user = await fixtures.user(username);
      await user.access({ type: 'personal', token, name: 'pryv-test' });
      await user.session(token);
      const PER_CALL = 5;
      const call = (n) => coreRequest.put('/' + username + '/account').set('Authorization', token)
        .send({ emails: { add: Array.from({ length: PER_CALL }, (_, i) => `emlb6-${n}-${i}-${username}@example.test`) } });
      const calls = Math.floor(ACCOUNT_LOOKUPS_PER_WINDOW / PER_CALL);
      for (let n = 0; n < calls; n++) assert.notStrictEqual((await call(n)).status, 429, 'call ' + n);
      assert.strictEqual((await call(calls)).status, 429);
    } finally {
      await fixtures.clean();
    }
  });
});
