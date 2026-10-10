/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Account deletion ends the delegation relationships of the deleted account
 * (in-process integration, same core).
 *
 * [DADL] boots the api-server, runs full attach handshakes, deletes accounts
 * through DELETE /users/:username and asserts what is left on the OTHER
 * accounts:
 *   - a deleted delegate's personal token on the controlled account is dead,
 *     its control access (the credential that issues that token) is gone and
 *     cannot issue another one, the anchor is gone, and the name can be
 *     invited again once someone registers it;
 *   - a deleted delegate's pending invite is withdrawn on the requesting
 *     account;
 *   - a deleted controlled account is dropped from its delegate's list;
 *   - a control access kept past a delegate account erased without the
 *     teardown (another core, a lost delivery) issues nothing, and the
 *     relationship turns stale.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { ErrorIds } = require('errors/src/index.ts');

describe('[DADL] account deletion ends its delegation relationships (in-process integration)', function () {
  this.timeout(60_000);

  let fixtures;
  let adminKey;

  before(async function () {
    await initTests();
    await initCore();
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    await require('api-server/src/methods/auth/delete.ts').default(global.app.api);
    adminKey = (await require('@pryv/boiler').getConfig()).get('auth:adminAccessKey');
    fixtures = getNewFixture();
  });

  after(async function () {
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function makeActor (prefix) {
    const username = prefix + '-' + cuid().slice(-8);
    const token = cuid();
    const u = await fixtures.user(username);
    await u.access({ token, type: 'personal' });
    await u.session(token);
    return {
      username,
      token,
      eventsPath: '/' + username + '/events',
      accessesPath: '/' + username + '/accesses',
      delegationsPath: '/' + username + '/delegations',
    };
  }

  async function invite (controlled, delegate) {
    const res = await coreRequest.post(controlled.delegationsPath + '/attach-request')
      .set('Authorization', controlled.token).send({ delegateUsername: delegate.username });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  }

  async function attachActive (controlled, delegate) {
    await invite(controlled, delegate);
    const acc = await coreRequest.post(delegate.delegationsPath + '/controlled/' + controlled.username + '/accept')
      .set('Authorization', delegate.token).send({});
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
  }

  async function issueToken (controlled, delegate) {
    const res = await coreRequest.post(delegate.delegationsPath + '/controlled/' + controlled.username + '/token')
      .set('Authorization', delegate.token).send({});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.token;
  }

  async function markerAccesses (actor) {
    const res = await coreRequest.get(actor.accessesPath).set('Authorization', actor.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return (res.body.accesses || []).filter((a) => a.clientData?.delegation != null);
  }

  async function listDelegates (actor) {
    const res = await coreRequest.get(actor.delegationsPath + '/delegates').set('Authorization', actor.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.delegates || [];
  }

  async function deleteAccount (actor) {
    const res = await coreRequest.delete('/users/' + actor.username).set('Authorization', adminKey);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  describe('[DADL-D] the deleted account is a delegate with an active relationship', function () {
    let bob, alice, patToken, controlToken;

    before(async function () {
      bob = await makeActor('bob'); // controlled
      alice = await makeActor('alice'); // delegate, deleted below
      await attachActive(bob, alice);
      patToken = await issueToken(bob, alice);
      const used = await coreRequest.get(bob.eventsPath).set('Authorization', patToken);
      assert.strictEqual(used.status, 200, 'the token works before the deletion: ' + JSON.stringify(used.body));
      const control = (await markerAccesses(bob)).find((a) => a.clientData.delegation.kind === 'control');
      assert.ok(control?.token, 'the control access and its token are on the controlled account');
      controlToken = control.token;

      await deleteAccount(alice);
    });

    it('[DADL01] the delegate\'s personal token is refused on the controlled account', async function () {
      const res = await coreRequest.get(bob.eventsPath).set('Authorization', patToken);
      assert.ok([401, 403].includes(res.status), res.status + ' ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error?.id, 'invalid-access-token', JSON.stringify(res.body));
    });

    it('[DADL02] the control access is gone and a saved control token issues no new token', async function () {
      assert.deepStrictEqual(await markerAccesses(bob), [], 'no delegation access remains on the controlled account');
      const res = await coreRequest.post(bob.delegationsPath + '/controlled-side/token')
        .set('Authorization', controlToken).send({});
      assert.ok([401, 403].includes(res.status), res.status + ' ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error?.id, ErrorIds.InvalidAccessToken, JSON.stringify(res.body));
      assert.strictEqual(res.body.token, undefined);
    });

    it('[DADL03] the relationship is gone, and the name can be invited again once registered', async function () {
      assert.deepStrictEqual(await listDelegates(bob), []);
      const again = await fixtures.user(alice.username);
      const token = cuid();
      await again.access({ token, type: 'personal' });
      await again.session(token);
      await invite(bob, alice);
      const delegates = await listDelegates(bob);
      assert.deepStrictEqual(delegates.map((d) => [d.delegate.username, d.status]), [[alice.username, 'invite']]);
    });
  });

  describe('[DADL-I] the deleted account is a delegate with a pending invite', function () {
    it('[DADL04] the invite is withdrawn on the requesting account', async function () {
      const bob = await makeActor('bob');
      const frank = await makeActor('frank');
      await invite(bob, frank);
      assert.strictEqual((await listDelegates(bob)).length, 1);
      await deleteAccount(frank);
      assert.deepStrictEqual(await listDelegates(bob), []);
      assert.deepStrictEqual(await markerAccesses(bob), [], 'the invite capability is gone too');
    });
  });

  describe('[DADL-C] the deleted account is a controlled account', function () {
    it('[DADL05] the delegate no longer lists it', async function () {
      const carol = await makeActor('carol'); // controlled, deleted below
      const erin = await makeActor('erin'); // delegate
      await attachActive(carol, erin);
      const before = await coreRequest.get(erin.delegationsPath + '/controlled').set('Authorization', erin.token);
      assert.strictEqual((before.body.controlled || []).length, 1, JSON.stringify(before.body));

      await deleteAccount(carol);

      const after = await coreRequest.get(erin.delegationsPath + '/controlled').set('Authorization', erin.token);
      assert.strictEqual(after.status, 200, JSON.stringify(after.body));
      assert.deepStrictEqual(after.body.controlled, []);
      assert.deepStrictEqual(await markerAccesses(erin), [], 'the delegate\'s notify access is gone');
    });
  });

  describe('[DADL-R] the release a delegate\'s core sends from another core', function () {
    it('[DADL07] only the control token releases, and it ends that relationship on the controlled account', async function () {
      const bob = await makeActor('bob');
      const gina = await makeActor('gina');
      await attachActive(bob, gina);
      const pat = await issueToken(bob, gina);
      const control = (await markerAccesses(bob)).find((a) => a.clientData.delegation.kind === 'control');

      const byPat = await coreRequest.post(bob.delegationsPath + '/controlled-side/release')
        .set('Authorization', pat).send({});
      assert.strictEqual(byPat.status, 403, 'the personal token cannot release: ' + JSON.stringify(byPat.body));
      assert.strictEqual((await listDelegates(bob)).length, 1);

      const res = await coreRequest.post(bob.delegationsPath + '/controlled-side/release')
        .set('Authorization', control.token).send({});
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.released, true);
      assert.deepStrictEqual(await listDelegates(bob), []);
      assert.deepStrictEqual(await markerAccesses(bob), []);
      const used = await coreRequest.get(bob.eventsPath).set('Authorization', pat);
      assert.strictEqual(used.body.error?.id, 'invalid-access-token', JSON.stringify(used.body));
      const mirror = await coreRequest.get(gina.delegationsPath + '/controlled').set('Authorization', gina.token);
      assert.deepStrictEqual(mirror.body.controlled, [], 'the delegate is told, as at detach');
    });
  });

  describe('[DADL-S] a delegate account erased without the teardown', function () {
    it('[DADL06] its kept control token issues nothing and the relationship turns stale', async function () {
      const bob = await makeActor('bob');
      const dave = await makeActor('dave');
      await attachActive(bob, dave);
      const control = (await markerAccesses(bob)).find((a) => a.clientData.delegation.kind === 'control');

      // The account leaves the users index the way the deletion does, without
      // the steps that reach the controlled account (as when the delegate's
      // core cannot deliver the release).
      const usersRepository = await require('business/src/users/index.ts').getUsersRepository();
      await usersRepository.deleteOne(dave.username, dave.username);

      const res = await coreRequest.post(bob.delegationsPath + '/controlled-side/token')
        .set('Authorization', control.token).send({});
      assert.strictEqual(res.status, 410, JSON.stringify(res.body));
      assert.strictEqual(res.body.error?.id, 'delegation-not-active');
      assert.strictEqual(res.body.token, undefined);
      assert.strictEqual((await markerAccesses(bob)).filter((a) => a.clientData.delegation.kind === 'delegate-pat').length, 0,
        'no personal token was minted');
      assert.deepStrictEqual((await listDelegates(bob)).map((d) => d.status), ['stale']);
    });
  });
});
