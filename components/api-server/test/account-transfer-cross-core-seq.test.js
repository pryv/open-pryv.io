/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ACTX] account transfer claimed by an account on another core, on the
 * owner's core: the claim delivers the delegation invite to the claimant's
 * core (intercepted here), binds the transfer to that remote account, and
 * completes once the claimant's core has accepted (the accept reaches the
 * owner's core through the invite capability; run here as that call does).
 *
 * Sequential: it injects multi-core config, which is shared state. Config and
 * the platform core registry are saved and restored around the whole file
 * (the same isolation as [DXCU]).
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');
const { getConfig } = require('@pryv/boiler');
const { injectTestConfigSnapshot } = require('test-helpers');
const { platform } = require('platform');
const delegation = require('delegation');
const { createAutoDeletionState } = require('business/src/autoDeletion/state.ts');
const { deriveLinkToken } = require('business/src/autoDeletion/transfer.ts');
const { createAccountAutoDeletionSweep } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
const { transferLinkKey } = require('api-server/src/methods/helpers/autoDeletionPolicy.ts');
const { buildMallForCmc } = require('api-server/src/methods/helpers/cmcMall.ts');

const DAY = 24 * 60 * 60;
const DOMAIN = 'test-transfer-xcore.pryv.li';
const CORE_A = 'actx-core-a'; // this core: the owner's
const CORE_B = 'actx-core-b'; // the claimant's
const APP_ID = 'pryv-test-no-cors';

describe('[ACTX] account transfer claimed from another core', function () {
  this.timeout(60_000);

  let config, state, fixtures, owner, remoteClaimant, savedConfig, restoreDomain, restoreTransfer, realFetch, inviteCalls, savedPlatformData;

  function platformDB () {
    return require('storages').platformDB;
  }

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
    state = createAutoDeletionState(require('storages').userAccountStorage);
    savedConfig = { isSingleCore: config.get('core:isSingleCore'), coreUrl: config.get('core:url'), coreId: config.get('core:id') };
    await resetPlatformRegistry();
    config.set('core:isSingleCore', false);
    config.set('core:id', CORE_A);
    config.set('core:url', null);
    restoreDomain = injectTestConfigSnapshot({ dns: { domain: DOMAIN } });
    restoreTransfer = injectTestConfigSnapshot({
      'user-account': { delete: ['adminToken', 'personalToken'] },
      service: { account: 'https://account.actx.example.com/' },
      services: { email: { enabled: { accountDeletionReminder: false, accountTransferStarted: false, accountTransferCompleted: false } } }
    });
    await platform.registerSelf();
    await platformDB().setCoreInfo(CORE_B, { id: CORE_B, ip: null, ipv6: null, cname: null, hosting: null, available: true });
    await platform._refreshCoreUrlCache();
    // Registered after the config injection: the closures capture core:id.
    await require('api-server/src/methods/delegations.ts').default(global.app.api);

    fixtures = getNewFixture();
    const username = 'actxo' + cuid().slice(-8).toLowerCase();
    const token = cuid();
    const fu = await fixtures.user(username, { email: username + '@actx.example.com', language: 'en' });
    await fu.access({ token, type: 'personal' });
    await fu.session(token);
    owner = { id: fu.attrs.id, username, token };
    remoteClaimant = 'actxb' + cuid().slice(-8).toLowerCase();
    await platform.setUserCore(remoteClaimant, CORE_B);

    realFetch = global.fetch;
    global.fetch = async function (url, options) {
      if (String(url).endsWith('/system/delegation/invite')) {
        inviteCalls.push({ url: String(url), body: JSON.parse(options.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return realFetch(url, options);
    };
  });

  after(async function () {
    if (realFetch != null) global.fetch = realFetch;
    config.set('core:isSingleCore', savedConfig.isSingleCore);
    config.set('core:id', savedConfig.coreId);
    config.set('core:url', savedConfig.coreUrl);
    if (restoreTransfer != null) restoreTransfer();
    if (restoreDomain != null) restoreDomain();
    try { await resetPlatformRegistry(); } catch (_e) { /* best-effort */ }
    try { await platform.registerSelf(); } catch (_e) { /* best-effort */ }
    try { await platform._refreshCoreUrlCache(); } catch (_e) { /* best-effort */ }
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  beforeEach(function () {
    inviteCalls = [];
  });

  it('[ACTX1] the invite goes to the claimant\'s core, the transfer is bound to that account, the accept completes it', async function () {
    const T0 = Math.floor(timestamp.now());
    await state.setSetting(owner.id, { mode: 'date', date: T0 + 20 * DAY, action: 'transfer', transfer: { email: 'b@actx.example.com', notifyBeneficiary: 'atTrigger', fallback: 'keep' }, updatedAt: T0 }, 'test');
    const clock = { t: T0 };
    const quiet = { info () {}, warn () {}, error () {} };
    const sweep = await createAccountAutoDeletionSweep(config, {
      listAccounts: async () => [{ id: owner.id, username: owner.username }],
      listPendingErasures: async () => [],
      now: () => clock.t,
      logger: quiet,
      sendReminder: async () => 'sent',
      sendTransferMail: async () => 'sent'
    });
    for (const d of [0, 13, 19, 21]) { clock.t = T0 + d * DAY; await sweep.runPass(); }
    const record = await state.getTransfer(owner.id);
    assert.equal(record.status, 'open');
    const token = deriveLinkToken(transferLinkKey(config), 'claim', owner.id, record.claimSalt);

    const claim = () => coreRequest.post(`/${owner.username}/account/auto-deletion/transfer-claim`)
      .set('Origin', 'http://test.pryv.local').send({ appId: APP_ID, token, claimant: remoteClaimant });
    const res = await claim();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transfer.status, 'invited');
    assert.equal(inviteCalls.length, 1);
    assert.equal(inviteCalls[0].url, 'https://' + CORE_B + '.' + DOMAIN + '/system/delegation/invite');
    assert.equal(inviteCalls[0].body.delegateUsername, remoteClaimant);
    assert.equal(inviteCalls[0].body.controlled.username, owner.username);
    const bound = await state.getTransfer(owner.id);
    assert.equal(bound.claimedBy.username, remoteClaimant);
    assert.equal(bound.claimedBy.relId, inviteCalls[0].body.relId);
    assert.ok(typeof bound.claimedBy.hostSlug === 'string' && bound.claimedBy.hostSlug.includes(CORE_B), 'the claimant\'s core: ' + bound.claimedBy.hostSlug);

    // The claimant's core accepts through the invite capability (what its
    // `delegations.acceptAttach` calls on this core).
    const mall = await buildMallForCmc();
    await delegation.handleAcceptResponse({ mall, now: () => Math.floor(Date.now() / 1000) }, {
      bUserId: owner.id,
      relId: bound.claimedBy.relId,
      delegate: { username: remoteClaimant, hostSlug: bound.claimedBy.hostSlug }
    });
    const done = await claim();
    assert.equal(done.body.transfer?.status, 'completed', JSON.stringify(done.body));
    assert.equal((await state.getTransfer(owner.id)).status, 'completed');
    assert.equal(await state.getSetting(owner.id), null);
    assert.equal(inviteCalls.length, 1, 'no second invite');
  });
});
