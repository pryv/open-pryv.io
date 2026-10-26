/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

/**
 * The forced external-id accept check, remote arm: the account lives on
 * another core, so the token is bound through that core's access-info and the
 * holder answer comes from its admin-key `POST /system/ext-id/holds`. Both
 * URLs come from the platform mapping, never from the caller.
 */

const { checkForcedAcceptance } = require('../src/routes/reg/externalIdCheck.ts');
const { extIdLookupBudget } = require('../src/routes/reg/extIdLookupBudget.ts');

describe('[XIDFC] forced external-id accept check (remote arm)', () => {
  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
  });

  afterEach(async () => {
    await extIdLookupBudget.clear();
  });

  const CORE_B = 'https://core-b.example.com/';
  const EXTERNAL_ID = { namespace: 'ehr-x', blindedValue: 'v'.repeat(43) };

  function remotePlatform () {
    return { isSingleCore: false, coreId: 'core-a', getUserCore: async () => 'core-b', coreIdToUrl: () => CORE_B };
  }

  /** access-info answers `accessStatus`; holds answers `holdsAnswer` (status, body) or throws. */
  function coreFetch (accessStatus, holdsAnswer) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/access-info')) {
        return { status: accessStatus, ok: accessStatus < 300, json: async () => (accessStatus < 300 ? { id: 'acc-1', type: 'app', permissions: [] } : { error: { id: 'invalid-access-token' } }) };
      }
      if (holdsAnswer instanceof Error) throw holdsAnswer;
      return { status: holdsAnswer.status, ok: holdsAnswer.status < 300, json: async () => holdsAnswer.body };
    };
    fn.calls = calls;
    return fn;
  }

  const APP = {
    storageLayer: {},
    getCustomAuthFunction: () => null,
    config: { get: (key) => (key === 'auth:adminAccessKey' ? 'admin-key-for-tests' : undefined) }
  };

  function run (fetchFn) {
    return checkForcedAcceptance(
      { app: APP, username: 'alice', token: 'tok-1', externalId: EXTERNAL_ID, ip: '203.0.113.9' },
      { platform: remotePlatform(), fetch: fetchFn }
    );
  }

  it('[XIDFC1] binds the token on the platform\'s core, then asks that core with the admin key', async () => {
    const fetchFn = coreFetch(200, { status: 200, body: { holds: true } });
    assert.deepStrictEqual(await run(fetchFn), { ok: true });
    assert.strictEqual(fetchFn.calls.length, 2);
    assert.strictEqual(fetchFn.calls[0].url, CORE_B + 'alice/access-info');
    assert.strictEqual(fetchFn.calls[1].url, 'https://core-b.example.com/system/ext-id/holds');
    assert.strictEqual(fetchFn.calls[1].init.headers.authorization, 'admin-key-for-tests');
    assert.strictEqual(fetchFn.calls[1].init.redirect, 'error', 'never follows a redirect');
    assert.deepStrictEqual(JSON.parse(fetchFn.calls[1].init.body), { username: 'alice', ...EXTERNAL_ID });
  });

  it('[XIDFC2] a token that does not resolve there is token-invalid, and the holder is not asked', async () => {
    const fetchFn = coreFetch(403, { status: 200, body: { holds: true } });
    assert.deepStrictEqual(await run(fetchFn), { ok: false, kind: 'mismatch', reason: 'token-invalid' });
    assert.strictEqual(fetchFn.calls.length, 1);
  });

  it('[XIDFC3] holds: false is not-holder', async () => {
    assert.deepStrictEqual(await run(coreFetch(200, { status: 200, body: { holds: false } })), { ok: false, kind: 'mismatch', reason: 'not-holder' });
  });

  it('[XIDFF9] a home core that cannot answer is unavailable, never a pass nor a refusal', async () => {
    for (const answer of [new Error('ECONNREFUSED'), { status: 404, body: { error: { id: 'unknown-resource' } } },
      { status: 500, body: {} }, { status: 200, body: { holds: 'yes' } }]) {
      const outcome = await run(coreFetch(200, answer));
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.kind, 'unavailable', JSON.stringify(outcome));
      assert.strictEqual(outcome.reason, 'core-unreachable');
    }
  });

  it('[XIDFC4] a home core URL that is not a usable core URL receives no admin key', async () => {
    const fetchFn = coreFetch(200, { status: 200, body: { holds: true } });
    const outcome = await checkForcedAcceptance(
      { app: APP, username: 'alice', token: 'tok-1', externalId: EXTERNAL_ID, ip: null },
      { platform: { ...remotePlatform(), coreIdToUrl: () => 'http://core-b.example.com/' }, fetch: fetchFn }
    );
    assert.strictEqual(outcome.kind === 'unavailable' || outcome.kind === 'mismatch', true, JSON.stringify(outcome));
    assert.ok(!fetchFn.calls.some((c) => c.url.endsWith('/system/ext-id/holds')), 'no holds call to an http: URL');
  });
});
