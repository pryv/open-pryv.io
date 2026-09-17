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
 * The consent check's REMOTE arm: the one taken when the platform says the
 * user lives on another core. Driven through the injected platform and
 * fetch seams, because what matters here is WHICH url is called and how
 * each answer is classified, not that a second core is running.
 *
 * The local arm is covered end to end by [RA70]-[RA76] in reg-access.
 */

const { checkAcceptedGrant } = require('../src/routes/reg/consentCheck.ts');

describe('[RCCK] auth-request consent check (remote arm)', () => {
  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
  });

  const CONSENT_FORM = {
    allowUserChoice: true,
    permissions: [
      { streamId: 'diary', level: 'read', mandatory: true },
      { streamId: 'weight', level: 'read', optIn: true }
    ]
  };

  /** A platform that hosts the user on another core. */
  function remotePlatform (coreUrl) {
    return {
      isSingleCore: false,
      coreId: 'core-a',
      getUserCore: async () => 'core-b',
      coreIdToUrl: () => coreUrl
    };
  }

  function accessInfoFetch (status, body) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body
      };
    };
    fn.calls = calls;
    return fn;
  }

  const APP = { storageLayer: {}, getCustomAuthFunction: () => null };

  it('[RC01] must read access-info on the core the PLATFORM names, never a caller-supplied host', async () => {
    const fetchFn = accessInfoFetch(200, {
      id: 'acc-1',
      type: 'app',
      permissions: [
        { streamId: ':_system:account', level: 'none' },
        { streamId: 'diary', level: 'read' },
        { streamId: ':_audit:access-acc-1', level: 'read' }
      ]
    });
    const outcome = await checkAcceptedGrant(
      { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
      { platform: remotePlatform('https://core-b.example.com/'), fetch: fetchFn }
    );
    assert.deepStrictEqual(outcome, { ok: true });
    assert.strictEqual(fetchFn.calls.length, 1);
    // The host is the platform's, and the token travels as the credential.
    assert.strictEqual(fetchFn.calls[0].url, 'https://core-b.example.com/alice/access-info');
    assert.strictEqual(fetchFn.calls[0].init.headers.Authorization, 'tok-1');
    // The injected entries came back in the response and were subtracted,
    // otherwise this grant would have read as wider than the offer.
  });

  it('[RC02] must not call out at all when the core has no usable url', async () => {
    // `coreIdToUrl` answers "null/" when it has no cached row, no dns
    // domain and no configured core url. That string must never reach fetch.
    for (const unusable of ['null/', '', 'not a url', 'file:///etc/passwd']) {
      const fetchFn = accessInfoFetch(200, {});
      const outcome = await checkAcceptedGrant(
        { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
        { platform: remotePlatform(unusable), fetch: fetchFn }
      );
      assert.strictEqual(outcome.ok, false, unusable);
      assert.strictEqual(outcome.kind, 'unavailable', unusable);
      assert.strictEqual(outcome.reason, 'core-unresolvable', unusable);
      assert.strictEqual(fetchFn.calls.length, 0, 'must not fetch ' + unusable);
    }
  });

  it('[RC03] must tell a rejected token apart from a core it could not reach', async () => {
    // The page's fault: the token is no good. 400 territory.
    for (const status of [401, 403, 404]) {
      const outcome = await checkAcceptedGrant(
        { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
        { platform: remotePlatform('https://core-b.example.com/'), fetch: accessInfoFetch(status, {}) }
      );
      assert.strictEqual(outcome.kind, 'grant', 'status ' + status);
      assert.strictEqual(outcome.reason, 'token-invalid', 'status ' + status);
    }
    // The operator's or the network's fault: no verdict was obtained. 503
    // territory, and crucially NOT a signal for the page to delete the
    // access it just minted.
    for (const status of [421, 500, 502]) {
      const outcome = await checkAcceptedGrant(
        { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
        { platform: remotePlatform('https://core-b.example.com/'), fetch: accessInfoFetch(status, {}) }
      );
      assert.strictEqual(outcome.kind, 'unavailable', 'status ' + status);
      assert.strictEqual(outcome.reason, 'core-unreachable', 'status ' + status);
    }
  });

  it('[RC04] must treat a throwing or timing-out fetch as unavailable, never as a pass', async () => {
    const throwing = async () => { throw new Error('connect ETIMEDOUT'); };
    const outcome = await checkAcceptedGrant(
      { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
      { platform: remotePlatform('https://core-b.example.com/'), fetch: throwing }
    );
    assert.strictEqual(outcome.kind, 'unavailable');
    assert.strictEqual(outcome.reason, 'core-unreachable');
  });

  it('[RC05] must apply the same grant rule to a remote access as to a local one', async () => {
    const missingMandatory = accessInfoFetch(200, {
      id: 'acc-2',
      type: 'app',
      permissions: [{ streamId: 'weight', level: 'read' }]
    });
    const refused = await checkAcceptedGrant(
      { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
      { platform: remotePlatform('https://core-b.example.com/'), fetch: missingMandatory }
    );
    assert.strictEqual(refused.kind, 'grant');
    assert.strictEqual(refused.reason, 'mandatory-refused');

    const personal = accessInfoFetch(200, { id: 'acc-3', type: 'personal' });
    const wrongType = await checkAcceptedGrant(
      { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
      { platform: remotePlatform('https://core-b.example.com/'), fetch: personal }
    );
    assert.strictEqual(wrongType.kind, 'grant');
    assert.strictEqual(wrongType.reason, 'not-app-access');
  });

  it('[RC06] a single-core platform never takes the remote arm', async () => {
    const fetchFn = accessInfoFetch(200, {});
    const outcome = await checkAcceptedGrant(
      { app: APP, username: 'alice', token: 'tok-1', consentForm: CONSENT_FORM },
      {
        platform: {
          isSingleCore: true,
          coreId: 'core-a',
          getUserCore: async () => { throw new Error('must not be asked on a single core'); },
          coreIdToUrl: () => { throw new Error('must not be asked on a single core'); }
        },
        fetch: fetchFn
      }
    );
    // It went local, where this fake app has no real storage layer, so the
    // outcome is a storage error. What matters is that nothing was fetched.
    assert.strictEqual(fetchFn.calls.length, 0);
    assert.strictEqual(outcome.ok, false);
  });
});
