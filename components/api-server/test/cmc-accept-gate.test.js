/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — token-class gate integration tests.
 *
 * [CMCAUTH] verifies the events.create middleware rejects
 * consent/accept-cmc, consent/scope-update-cmc, and consent/revoke-cmc
 * writes from non-personal tokens (app or shared with stream-write
 * permission), and passes through personal-token writes + non-gated
 * trigger types regardless of token class.
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid. The gate
 * fires before content-validation reaches the capability connection, so
 * we can use placeholder content (no real cross-platform handshake is
 * exercised here; that lives in cmc-handshake.test.js).
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

async function ensureStream (path, token, params) {
  const res = await coreRequest.post(path).set('Authorization', token).send(params);
  if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
    throw new Error('ensureStream(' + params.id + ') failed: ' +
      res.status + ' ' + JSON.stringify(res.body));
  }
}

async function createAccess (accessesPath, personalToken, params) {
  const res = await coreRequest.post(accessesPath)
    .set('Authorization', personalToken)
    .send(params);
  assert.strictEqual(res.status, 201,
    'createAccess failed: ' + res.status + ' ' + JSON.stringify(res.body));
  return res.body.access;
}

describe('[CMCAUTH] cmc accept access gate (events.create integration)', function () {
  this.timeout(60_000);

  let alice; // { username, personalToken, streamsPath, eventsPath, accessesPath }
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    const username = 'alice-cmcauth-' + cuid().slice(-8);
    const personalToken = cuid();
    const u = await fixtures.user(username);
    await u.access({ token: personalToken, type: 'personal' });
    await u.session(personalToken);
    alice = {
      username,
      personalToken,
      streamsPath: '/' + username + '/streams',
      eventsPath: '/' + username + '/events',
      accessesPath: '/' + username + '/accesses',
    };
    // Pre-provision the app scope so writes have a place to land.
    await ensureStream(alice.streamsPath, alice.personalToken,
      { id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App' });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  // Each gated trigger is exercised against (a) an app token, (b) a
  // shared token — both with manage permissions on the app scope so the
  // failure cause is the token-class gate, NOT a stream-permission
  // shortfall. Then a sanity check that the same personal token DOES
  // pass the gate (with placeholder content the orchestration may fail
  // downstream, but the 201 response proves the gate let it through).

  describe('[CMCAUTH-ACC] consent/accept-cmc', function () {
    it('[CMCAUTH-ACC-AT] rejects an app token with cmc-accept-requires-personal-token (400)', async function () {
      const app = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-acc-app-' + cuid().slice(-6),
        type: 'app',
        permissions: [{ defaultName: 'cmc app scope', level: 'manage', streamId: ':_cmc:apps:my-app' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', app.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://placeholder@example.com/' },
        });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      // CMC error convention: top-level error.id is the generic category
      // (`invalid-operation`); the CMC-specific id lives under
      // error.data.id (matches inboxWriteHook + forge-prevention hooks).
      assert.strictEqual(res.body?.error?.id, 'invalid-operation');
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-accept-requires-personal-token');
    });

    it('[CMCAUTH-ACC-ST] rejects a shared token with cmc-accept-requires-personal-token (400)', async function () {
      const shared = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-acc-shr-' + cuid().slice(-6),
        type: 'shared',
        permissions: [{ streamId: ':_cmc:apps:my-app', level: 'manage' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', shared.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://placeholder@example.com/' },
        });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      // CMC error convention: top-level error.id is the generic category
      // (`invalid-operation`); the CMC-specific id lives under
      // error.data.id (matches inboxWriteHook + forge-prevention hooks).
      assert.strictEqual(res.body?.error?.id, 'invalid-operation');
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-accept-requires-personal-token');
    });

    it('[CMCAUTH-ACC-PT] passes a personal token through the gate (downstream orchestration may fail, but gate returns 201)', async function () {
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.personalToken)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://placeholder@example.com/' },
        });
      // Gate passes → 201; the orchestration will mark content.status=failed
      // since the placeholder capability URL won't resolve, but that's
      // out of this test's scope (covered by cmc-handshake.test.js).
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.event?.type, 'consent/accept-cmc');
    });
  });

  describe('[CMCAUTH-SU] consent/scope-update-cmc', function () {
    it('[CMCAUTH-SU-AT] rejects an app token with cmc-accept-requires-personal-token (400)', async function () {
      const app = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-su-app-' + cuid().slice(-6),
        type: 'app',
        permissions: [{ defaultName: 'cmc app scope', level: 'manage', streamId: ':_cmc:apps:my-app' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', app.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/scope-update-cmc',
          content: {
            accessId: 'placeholder',
            newPermissions: [{ streamId: 'placeholder', level: 'read' }],
          },
        });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      // CMC error convention: top-level error.id is the generic category
      // (`invalid-operation`); the CMC-specific id lives under
      // error.data.id (matches inboxWriteHook + forge-prevention hooks).
      assert.strictEqual(res.body?.error?.id, 'invalid-operation');
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-accept-requires-personal-token');
    });
  });

  describe('[CMCAUTH-RV] consent/revoke-cmc is NOT in the personal-token gate', function () {
    // Revoke is access-permission-gated INSIDE handleRevoke via
    // AccessLogic.canDeleteAccess (which honours the `selfRevoke`
    // feature permission). At events.create the gate must let any
    // token class through; the handler's per-target check is what
    // ultimately accepts or refuses the operation. End-to-end
    // canDeleteAccess behaviour is exercised by handleRevoke's own
    // tests; here we just confirm the gate is no longer blocking.

    it('[CMCAUTH-RV-AT] app token writes consent/revoke-cmc through the gate (201)', async function () {
      const app = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-rv-app-' + cuid().slice(-6),
        type: 'app',
        permissions: [{ defaultName: 'cmc app scope', level: 'manage', streamId: ':_cmc:apps:my-app' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', app.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/revoke-cmc',
          content: { accessId: 'placeholder' },
        });
      // Gate passes → 201. The handler will run downstream (and may
      // fail to find a matching counterparty since `accessId` is a
      // placeholder — but that's a separate concern from the gate).
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.event?.type, 'consent/revoke-cmc');
    });

    it('[CMCAUTH-RV-ST] shared token writes consent/revoke-cmc through the gate (201)', async function () {
      const shared = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-rv-shr-' + cuid().slice(-6),
        type: 'shared',
        permissions: [{ streamId: ':_cmc:apps:my-app', level: 'manage' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', shared.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/revoke-cmc',
          content: { accessId: 'placeholder' },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });
  });

  describe('[CMCAUTH-UN] un-gated trigger types pass regardless of token class', function () {
    // consent/refuse-cmc, consent/invalidate-link-cmc,
    // consent/scope-request-cmc, message/chat-cmc,
    // notification/alert-cmc, notification/ack-cmc — all out of the
    // Bucket-1 gate. Sample two of them with an app token to prove the
    // gate doesn't over-reach.

    it('[CMCAUTH-UN-RF] app token can write consent/refuse-cmc (un-gated)', async function () {
      const app = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-un-rf-app-' + cuid().slice(-6),
        type: 'app',
        permissions: [{ defaultName: 'cmc app scope', level: 'manage', streamId: ':_cmc:apps:my-app' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', app.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/refuse-cmc',
          content: { capabilityUrl: 'https://placeholder@example.com/' },
        });
      // 201 = gate passed (orchestration outcome is downstream + irrelevant here).
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    it('[CMCAUTH-UN-IL] app token can write consent/invalidate-link-cmc (un-gated)', async function () {
      const app = await createAccess(alice.accessesPath, alice.personalToken, {
        name: 'cmcauth-un-il-app-' + cuid().slice(-6),
        type: 'app',
        permissions: [{ defaultName: 'cmc app scope', level: 'manage', streamId: ':_cmc:apps:my-app' }],
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', app.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/invalidate-link-cmc',
          content: { capabilityId: 'placeholder' },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });
  });
});
