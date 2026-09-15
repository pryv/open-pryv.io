/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Authoritative detach — in-process integration.
 *
 * [DDET] boots the api-server against a real backend, runs the full attach
 * handshake same-core (request → accept → getToken issues a PAT), then asserts
 * the genuine-login gate BOTH ways and the authoritative teardown:
 *   - a delegate PAT (delegation-stamped personal token) is REJECTED from detach
 *     with delegation-genuine-login-required;
 *   - the PAT cannot side-door the gate by deleting the control access or anchor
 *     through the generic accesses/events APIs (delegation-managed-resource);
 *   - a genuine personal login on the controlled account IS accepted;
 *   - after detach the PAT is DEAD on the very next request (401 — session
 *     destroyed AND access deleted), the control access + anchor + capability are
 *     gone, and the delegate's mirror is dropped (same-core notify);
 *   - re-detaching the now-absent relationship is a clean 404, not a crash.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[DDET] authoritative detach (in-process integration)', function () {
  this.timeout(60_000);

  let alice, bob;
  let fixtures;
  let patToken, controlAccessId;

  before(async function () {
    await initTests();
    await initCore();
    const globalAny = global;
    await require('api-server/src/methods/delegations.ts').default(globalAny.app.api);
    fixtures = getNewFixture();
    bob = await makeActor('bob-' + cuid().slice(-8)); // controlled account (B)
    alice = await makeActor('alice-' + cuid().slice(-8)); // delegate (A)

    // Full handshake + PAT issuance (same-core).
    const reqRes = await coreRequest.post(bob.delegationsPath + '/attach-request')
      .set('Authorization', bob.token).send({ delegateUsername: alice.username });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const accRes = await coreRequest.post(alice.delegationsPath + '/controlled/' + bob.username + '/accept')
      .set('Authorization', alice.token).send({});
    assert.strictEqual(accRes.status, 200, JSON.stringify(accRes.body));
    const tokRes = await coreRequest.post(alice.delegationsPath + '/controlled/' + bob.username + '/token')
      .set('Authorization', alice.token).send({});
    assert.strictEqual(tokRes.status, 200, JSON.stringify(tokRes.body));
    patToken = tokRes.body.token;

    // Discover the control access id (B-side marker) for the side-door test.
    const acc = await coreRequest.get(bob.accessesPath).set('Authorization', bob.token);
    const control = (acc.body.accesses || []).find((a) => a.clientData?.delegation?.kind === 'control');
    assert.ok(control != null, 'a control access exists on B after activation');
    controlAccessId = control.id;
  });

  after(async function () {
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function makeActor (username) {
    const token = cuid();
    const u = await fixtures.user(username);
    await u.access({ token, type: 'personal' });
    await u.session(token);
    return {
      username,
      token,
      streamsPath: '/' + username + '/streams',
      eventsPath: '/' + username + '/events',
      accessesPath: '/' + username + '/accesses',
      delegationsPath: '/' + username + '/delegations',
    };
  }

  it('[DDET-01] the freshly-issued PAT works on B (baseline before detach)', async function () {
    const res = await coreRequest.get(bob.eventsPath).set('Authorization', patToken);
    assert.strictEqual(res.status, 200, 'PAT can read B events: ' + JSON.stringify(res.body));
  });

  it('[DDET-02] a delegate PAT is REJECTED from detach (genuine-login gate)', async function () {
    const res = await coreRequest.delete(bob.delegationsPath + '/delegates/' + alice.username)
      .set('Authorization', patToken);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.ok(JSON.stringify(res.body).includes('delegation-genuine-login-required'),
      'the gate names the genuine-login requirement: ' + JSON.stringify(res.body));
  });

  it('[DDET-03] the PAT cannot side-door the gate via generic accesses/events APIs', async function () {
    // Delete the control access directly → blocked by the lifecycle guard.
    const delAcc = await coreRequest.delete(bob.accessesPath + '/' + controlAccessId)
      .set('Authorization', patToken);
    assert.notStrictEqual(delAcc.status, 200, 'generic delete of the control access must not succeed');
    assert.ok(JSON.stringify(delAcc.body).includes('delegation-managed-resource'),
      'lifecycle guard rejects the delete: ' + JSON.stringify(delAcc.body));

    // The relationship still stands after the blocked side-door.
    const list = await coreRequest.get(bob.delegationsPath + '/delegates').set('Authorization', bob.token);
    assert.ok((list.body.delegates || []).some((d) => d.delegate.username === alice.username && d.status === 'active'),
      'the delegation is still active after the blocked side-door');
  });

  it('[DDET-04] a genuine personal login on B detaches; the PAT is DEAD on the very next request', async function () {
    const res = await coreRequest.delete(bob.delegationsPath + '/delegates/' + alice.username)
      .set('Authorization', bob.token);
    assert.strictEqual(res.status, 200, 'genuine login accepted: ' + JSON.stringify(res.body));

    // The PAT is DEAD immediately — the access is deleted AND its session
    // destroyed. Access resolution fails first ("Cannot find access from
    // token."), which this server maps to invalid-access-token / 403; the point
    // is that the token no longer authenticates (a dead-token 401/403, never a
    // live 200).
    const after = await coreRequest.get(bob.eventsPath).set('Authorization', patToken);
    assert.ok([401, 403].includes(after.status),
      'the PAT is rejected on the next request post-detach: ' + after.status + ' ' + JSON.stringify(after.body));
    assert.strictEqual(after.body.error.id, 'invalid-access-token',
      'the PAT no longer resolves to any access: ' + JSON.stringify(after.body));
  });

  it('[DDET-05] control access + anchor + PAT are gone on B', async function () {
    const acc = await coreRequest.get(bob.accessesPath).set('Authorization', bob.token);
    const markers = (acc.body.accesses || []).filter((a) => a.clientData?.delegation != null);
    assert.strictEqual(markers.length, 0, 'no delegation-marker accesses remain on B: ' + JSON.stringify(markers));

    const list = await coreRequest.get(bob.delegationsPath + '/delegates').set('Authorization', bob.token);
    assert.strictEqual((list.body.delegates || []).length, 0, 'no anchors remain (B lists no delegates)');
  });

  it('[DDET-06] the delegate mirror is dropped on A (same-core notify)', async function () {
    const list = await coreRequest.get(alice.delegationsPath + '/controlled').set('Authorization', alice.token);
    assert.strictEqual((list.body.controlled || []).length, 0, 'A no longer mirrors the torn-down relationship');
  });

  it('[DDET-07] re-detaching the now-absent relationship is a clean 404', async function () {
    const res = await coreRequest.delete(bob.delegationsPath + '/delegates/' + alice.username)
      .set('Authorization', bob.token);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.ok(JSON.stringify(res.body).includes('delegation-not-found'));
  });
});
