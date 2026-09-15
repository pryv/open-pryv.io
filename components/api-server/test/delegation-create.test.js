/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Create-from-delegate + the majority-handover lifecycle — in-process integration.
 *
 * [DCRE] boots the api-server against a real backend and drives the whole
 * create-from-delegate lifecycle same-core, culminating in the marquee
 * majority-handover exit through the RATIFIED genuine-login detach gate:
 *
 *   1. Parent A (a normal account) creates kid B with NO email + NO password →
 *      B exists, the delegation is active at birth.
 *   2. A getToken(B) → a delegate PAT that is owner-equivalent (acts as B).
 *   3. B cannot be logged into directly yet (random unguessable password), and a
 *      delegate PAT is REJECTED from detach (genuine-login gate).
 *   4. The owner-equivalent credential path sets B's password (here the same
 *      repository call account.setPassword / account.resetPassword ultimately
 *      make — the password-SET HTTP method is orthogonal pre-existing plumbing;
 *      what this delivers is the create + the genuine-login handover).
 *   5. B logs in GENUINELY (auth.login → a clean personal token, no delegation
 *      marker).
 *   6. B, genuinely logged in, detaches A → SUCCEEDS; the parent's PAT is dead on
 *      the very next request.
 *
 * A second case asserts the username-taken rollback leaves the pre-existing
 * account untouched and no A-side residue.
 *
 * Same-core: identity resolves to self, so create + token issuance + detach all
 * dispatch in-process — no fetch shim needed.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[DCRE] create-from-delegate + majority handover (in-process integration)', function () {
  this.timeout(60_000);

  let parent; // { username, token, ...paths } — the delegate A (normal account)
  let fixtures;
  let usersRepository;

  const kidUsername = 'kid-' + cuid().slice(-8); // controlled account B, created by A
  const takenUsername = 'taken-' + cuid().slice(-8); // a pre-existing account for the conflict case
  const LOGIN_APP_ID = 'pryv-test-no-cors'; // trusted from any origin in the test config

  let patToken; // the delegate PAT A issues for B
  let bootstrapPassword; // the password the owner sets during the handover
  let genuineToken; // B's clean personal token from the genuine login

  before(async function () {
    await initTests();
    await initCore();
    const globalAny = global;
    await require('api-server/src/methods/delegations.ts').default(globalAny.app.api);
    fixtures = getNewFixture();
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    parent = await makeActor('alice-' + cuid().slice(-8));
    // A pre-existing account for the username-taken rollback case.
    await fixtures.user(takenUsername);
  });

  after(async function () {
    // The kid account is created through the API (not a fixture), so it is not
    // swept by fixtures.clean(); remove it explicitly.
    try {
      const kidId = await usersRepository.getUserIdForUsername(kidUsername);
      if (kidId != null) await usersRepository.deleteOne(kidId, kidUsername);
    } catch (_e) { /* best-effort */ }
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
      eventsPath: '/' + username + '/events',
      accessInfoPath: '/' + username + '/access-info',
      delegationsPath: '/' + username + '/delegations',
    };
  }

  it('[DCRE-01] parent creates kid B with NO email and NO password → active at birth', async function () {
    const res = await coreRequest.post(parent.delegationsPath + '/controlled')
      .set('Authorization', parent.token)
      .send({ username: kidUsername });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.delegation != null, 'delegation returned');
    assert.strictEqual(res.body.delegation.status, 'active');
    assert.strictEqual(res.body.delegation.controlled.username, kidUsername);
    // No control endpoint / token leaked to the client.
    assert.strictEqual(JSON.stringify(res.body).includes('controlApiEndpoint'), false);

    // B exists as a real account.
    const kidId = await usersRepository.getUserIdForUsername(kidUsername);
    assert.ok(kidId != null, 'the kid account was created');

    // A mirrors the active relationship.
    const list = await coreRequest.get(parent.delegationsPath + '/controlled').set('Authorization', parent.token);
    assert.ok((list.body.controlled || []).some((c) => c.controlled.username === kidUsername && c.status === 'active'),
      'A lists the controlled account as active');
  });

  it('[DCRE-02] A getToken(B) → an owner-equivalent delegate PAT', async function () {
    const tokRes = await coreRequest.post(parent.delegationsPath + '/controlled/' + kidUsername + '/token')
      .set('Authorization', parent.token).send({});
    assert.strictEqual(tokRes.status, 200, JSON.stringify(tokRes.body));
    assert.ok(tokRes.body.token, 'a PAT token is returned');
    patToken = tokRes.body.token;

    // The PAT acts as B: it can read AND write B's data.
    const kidEventsPath = '/' + kidUsername + '/events';
    const streamId = 'dcre-stream-' + cuid().slice(-6);
    const sRes = await coreRequest.post('/' + kidUsername + '/streams')
      .set('Authorization', patToken).send({ id: streamId, name: 'Kid stream' });
    assert.strictEqual(sRes.status, 201, 'PAT can create a stream on B: ' + JSON.stringify(sRes.body));
    const eRes = await coreRequest.post(kidEventsPath)
      .set('Authorization', patToken).send({ streamIds: [streamId], type: 'note/txt', content: 'from the parent' });
    assert.strictEqual(eRes.status, 201, 'PAT can create an event on B: ' + JSON.stringify(eRes.body));

    // access-info surfaces the delegation field; user stays B.
    const info = await coreRequest.get('/' + kidUsername + '/access-info').set('Authorization', patToken);
    assert.strictEqual(info.status, 200);
    assert.strictEqual(info.body.delegation.isDelegatedAccess, true);
    assert.strictEqual(info.body.user.username, kidUsername);
  });

  it('[DCRE-03] B cannot be logged into directly yet (no usable password)', async function () {
    const res = await coreRequest.post('/' + kidUsername + '/auth/login')
      .send({ username: kidUsername, password: 'not-the-random-one', appId: LOGIN_APP_ID });
    assert.notStrictEqual(res.status, 200, 'login must not succeed against the random password: ' + JSON.stringify(res.body));
  });

  it('[DCRE-04] a delegate PAT is REJECTED from detach (genuine-login gate)', async function () {
    const res = await coreRequest.delete('/' + kidUsername + '/delegations/delegates/' + parent.username)
      .set('Authorization', patToken);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.ok(JSON.stringify(res.body).includes('delegation-genuine-login-required'),
      'the gate names the genuine-login requirement: ' + JSON.stringify(res.body));
  });

  it('[DCRE-05] the owner sets B\'s password, then B logs in GENUINELY (clean personal token)', async function () {
    // The delegate sets B's password via the owner-equivalent credential path. In
    // production that is account.setPassword / the password-reset flow driven by
    // the PAT; here we invoke the same repository call those methods ultimately
    // make, keeping the E2E on the DELEGATION lifecycle rather than re-testing the
    // orthogonal password-set HTTP plumbing.
    bootstrapPassword = 'Handover-' + cuid().slice(-8) + '!';
    const kidId = await usersRepository.getUserIdForUsername(kidUsername);
    await usersRepository.setUserPassword(kidId, bootstrapPassword, 'system');

    // B now logs in genuinely — a clean personal token, no delegation marker.
    const login = await coreRequest.post('/' + kidUsername + '/auth/login')
      .send({ username: kidUsername, password: bootstrapPassword, appId: LOGIN_APP_ID });
    assert.strictEqual(login.status, 200, 'genuine login succeeds after the password is set: ' + JSON.stringify(login.body));
    assert.ok(login.body.token, 'a clean personal token is returned');
    genuineToken = login.body.token;

    // The genuine token carries no delegation marker (unlike the PAT).
    const info = await coreRequest.get('/' + kidUsername + '/access-info').set('Authorization', genuineToken);
    assert.strictEqual(info.status, 200);
    assert.strictEqual(info.body.type, 'personal');
    assert.ok(info.body.delegation == null, 'the genuine login carries NO delegation field');
  });

  it('[DCRE-06] B, genuinely logged in, detaches the parent → SUCCEEDS; the PAT is dead next request', async function () {
    const res = await coreRequest.delete('/' + kidUsername + '/delegations/delegates/' + parent.username)
      .set('Authorization', genuineToken);
    assert.strictEqual(res.status, 200, 'genuine login can detach: ' + JSON.stringify(res.body));

    // The parent's PAT is dead immediately (access deleted + session destroyed).
    const after = await coreRequest.get('/' + kidUsername + '/events').set('Authorization', patToken);
    assert.ok([401, 403].includes(after.status), 'the PAT is rejected post-detach: ' + after.status);
    assert.strictEqual(after.body.error.id, 'invalid-access-token', JSON.stringify(after.body));

    // The relationship is gone on both sides.
    const bList = await coreRequest.get('/' + kidUsername + '/delegations/delegates').set('Authorization', genuineToken);
    assert.strictEqual((bList.body.delegates || []).length, 0, 'B lists no delegates');
    const aList = await coreRequest.get(parent.delegationsPath + '/controlled').set('Authorization', parent.token);
    assert.strictEqual((aList.body.controlled || []).some((c) => c.controlled.username === kidUsername), false,
      'A no longer mirrors the torn-down relationship');
  });

  it('[DCRE-07] creating an account with an already-taken username → 409, no residue', async function () {
    const before = await usersRepository.getUserIdForUsername(takenUsername);
    assert.ok(before != null, 'the pre-existing account exists before the conflicting create');

    const res = await coreRequest.post(parent.delegationsPath + '/controlled')
      .set('Authorization', parent.token)
      .send({ username: takenUsername });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.ok(JSON.stringify(res.body).includes('delegation-username-taken'), JSON.stringify(res.body));

    // The pre-existing account is untouched (same id, still there).
    const afterId = await usersRepository.getUserIdForUsername(takenUsername);
    assert.strictEqual(afterId, before, 'the pre-existing account is untouched by the failed create');

    // No A-side mirror + no leftover notify marker for the failed create.
    const aList = await coreRequest.get(parent.delegationsPath + '/controlled').set('Authorization', parent.token);
    assert.strictEqual((aList.body.controlled || []).some((c) => c.controlled.username === takenUsername), false,
      'no mirror written for the failed create');
  });

  it('[DCRE-08] an unknown target core is rejected up-front', async function () {
    const res = await coreRequest.post(parent.delegationsPath + '/controlled')
      .set('Authorization', parent.token)
      .send({ username: 'never-' + cuid().slice(-6), core: 'no-such-core-id' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.ok(JSON.stringify(res.body).includes('delegation-unknown-core'), JSON.stringify(res.body));
  });
});
