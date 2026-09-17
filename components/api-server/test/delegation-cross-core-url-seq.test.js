/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Cross-core peer-URL resolution for delegations — in-process integration.
 *
 * [DXCU] pins how `resolveTarget()` finds the peer core's endpoint when the
 * delegate account lives on another core. The registry row a peer writes only
 * carries a `url` when that peer was configured with an explicit `core.url`,
 * which neither the config wizard nor the bootstrap bundle sets — so reading
 * the row was not a resolution strategy at all on a normal dns-active
 * platform, and every cross-core delegation call answered 400
 * `delegation-unknown-core`. Resolution goes through `Platform.coreIdToUrl()`,
 * which knows the advertised url AND the `core.id + dns.domain` derivation.
 *
 * The three cases are the three outcomes that matter:
 *   -01 no `url` in the row + a domain  → derived, and the invite really is
 *       POSTed to the derived endpoint (the case that was broken);
 *   -02 an explicit `url` in the row    → still wins over the derivation (the
 *       operator workaround must keep working);
 *   -03 no `url` and no domain          → still refused. `coreIdToUrl()` falls
 *       back to THIS core's own URL, and delivering a cross-core invite to
 *       ourselves would be worse than refusing it.
 *
 * Sequential: it injects multi-core config, which is shared state. Config and
 * the platform core registry are saved and restored around the whole file.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { getConfig } = require('@pryv/boiler');
const { injectTestConfigSnapshot } = require('test-helpers');
const { platform } = require('platform');

const DOMAIN = 'test-delegation-xcore.pryv.li';
const CORE_A = 'dxcu-core-a'; // this core
const CORE_B = 'dxcu-core-b'; // the peer the delegate lives on
const EXPLICIT_B_URL = 'https://explicit-b.example.org/';

describe('[DXCU] cross-core delegation peer-URL resolution', function () {
  this.timeout(60_000);

  let config;
  let fixtures;
  let bob; // the controlled account (B), local to this core
  let remoteDelegate; // the delegate (A) username, mapped to CORE_B
  let savedConfig; // core:* only — see the note on restoreDomain
  // `dns:domain` goes through the test-scope snapshot helper, NOT config.set().
  // config.set() is the highest nconf priority, so restoring the domain that
  // way would MASK the value a later file injects into the test scope — which
  // is how this file first broke [OB03] three files down the alphabet. The
  // core:* keys have no such choice: the core-identity plugin claims them with
  // config.set() at boot, so only config.set() can move them.
  let restoreDomain;
  let realFetch;
  let inviteCalls; // every POST to a /system/delegation/invite endpoint
  let savedPlatformData; // user-unique/indexed entries, preserved across the reset

  function platformDB () {
    return require('storages').platformDB;
  }

  /**
   * PlatformDB has no per-row core-info delete, so the only way to leave the
   * registry as we found it is export → clearAll → re-import. Only the user
   * entries are re-imported: core-info and user-core rows are what we are
   * clearing, and `exportAll()` returns the latter with `username == null`.
   */
  async function resetPlatformRegistry () {
    const all = await platformDB().exportAll();
    savedPlatformData = all.filter(e => e.username != null);
    await platformDB().clearAll();
    if (savedPlatformData.length > 0) await platformDB().importAll(savedPlatformData);
  }

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();

    savedConfig = {
      isSingleCore: config.get('core:isSingleCore'),
      coreUrl: config.get('core:url'),
      coreId: config.get('core:id'),
    };

    await resetPlatformRegistry(); // drop core rows left by an earlier run

    // Multi-core, dns-active, and deliberately NO explicit `core.url` on this
    // core: that is the deployment the config wizard produces.
    config.set('core:isSingleCore', false);
    config.set('core:id', CORE_A);
    config.set('core:url', null);
    restoreDomain = injectTestConfigSnapshot({ dns: { domain: DOMAIN } });
    await platform.registerSelf();

    const globalAny = global;
    // Registered AFTER the config injection: the method closure captures
    // `core:id` once, at registration.
    await require('api-server/src/methods/delegations.ts').default(globalAny.app.api);

    fixtures = getNewFixture();
    const bobUsername = 'dxcub-' + cuid().slice(-8);
    const token = cuid();
    const u = await fixtures.user(bobUsername);
    await u.access({ token, type: 'personal' });
    await u.session(token);
    bob = { username: bobUsername, token, delegationsPath: '/' + bobUsername + '/delegations' };

    remoteDelegate = 'dxcua-' + cuid().slice(-8);
    await platform.setUserCore(remoteDelegate, CORE_B);

    realFetch = global.fetch;
    global.fetch = async function (url, options) {
      const asString = String(url);
      if (asString.endsWith('/system/delegation/invite')) {
        inviteCalls.push({ url: asString, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }
      return realFetch(url, options);
    };
  });

  after(async function () {
    if (realFetch != null) global.fetch = realFetch;
    config.set('core:isSingleCore', savedConfig.isSingleCore);
    config.set('core:id', savedConfig.coreId);
    config.set('core:url', savedConfig.coreUrl);
    if (restoreDomain != null) restoreDomain();
    try { await resetPlatformRegistry(); } catch (_e) { /* best-effort */ }
    try { await platform.registerSelf(); } catch (_e) { /* best-effort */ }
    try { await platform._refreshCoreUrlCache(); } catch (_e) { /* best-effort */ }
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  beforeEach(function () {
    inviteCalls = [];
  });

  /** Seed the peer core's registry row; `url` absent unless passed. */
  async function seedPeerCore (info) {
    await platformDB().setCoreInfo(CORE_B, Object.assign({
      id: CORE_B,
      ip: null,
      ipv6: null,
      cname: null,
      hosting: null,
      available: true,
    }, info));
    await platform._refreshCoreUrlCache();
  }

  /** One attach-request from the local account B to the remote delegate A. */
  async function attachRequest () {
    return await coreRequest.post(bob.delegationsPath + '/attach-request')
      .set('Authorization', bob.token)
      .send({ delegateUsername: remoteDelegate });
  }

  /** Drop the invite B just created, so the next case is not a duplicate. */
  async function cancelInvite () {
    try {
      await coreRequest.post(bob.delegationsPath + '/delegates/' + remoteDelegate + '/cancel')
        .set('Authorization', bob.token).send({});
    } catch (_e) { /* best-effort */ }
  }

  it('[DXCU-01] a registry row with no url resolves by derivation from core.id + dns.domain', async function () {
    await seedPeerCore({}); // exactly what registerSelf() writes with no core.url
    const res = await attachRequest();
    assert.strictEqual(res.status, 201,
      'the invite is delivered, not refused: ' + JSON.stringify(res.body));
    assert.strictEqual(inviteCalls.length, 1,
      'exactly one cross-core invite POST: ' + JSON.stringify(inviteCalls.map(c => c.url)));
    assert.strictEqual(inviteCalls[0].url,
      'https://' + CORE_B + '.' + DOMAIN + '/system/delegation/invite',
      'the derived peer endpoint is the one used');
    await cancelInvite();
  });

  it('[DXCU-02] an explicit url in the registry row still wins over the derivation', async function () {
    await seedPeerCore({ url: EXPLICIT_B_URL });
    const res = await attachRequest();
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(inviteCalls.length, 1, JSON.stringify(inviteCalls.map(c => c.url)));
    assert.strictEqual(inviteCalls[0].url,
      'https://explicit-b.example.org/system/delegation/invite',
      'the advertised url is preferred — the operator workaround keeps working');
    await cancelInvite();
  });

  it('[DXCU-03] no url and no domain is refused, NOT delivered to this core itself', async function () {
    const selfUrl = 'https://' + CORE_A + '.' + DOMAIN + '/';
    const restoreNoDomain = injectTestConfigSnapshot({ dns: { domain: null } });
    config.set('core:url', selfUrl);
    await platform.registerSelf(); // advertises this core's own url
    await seedPeerCore({}); // peer still has none → coreIdToUrl() falls back to self
    try {
      const res = await attachRequest();
      assert.strictEqual(res.status, 400,
        'an unresolvable peer is refused: ' + JSON.stringify(res.body));
      assert.ok(JSON.stringify(res.body).includes('delegation-unknown-core'),
        'refused with the unknown-core id: ' + JSON.stringify(res.body));
      assert.strictEqual(inviteCalls.length, 0,
        'nothing was delivered — least of all to ourselves: ' +
        JSON.stringify(inviteCalls.map(c => c.url)));
    } finally {
      restoreNoDomain();
      config.set('core:url', null);
      await platform.registerSelf();
      await platform._refreshCoreUrlCache();
    }
  });
});
