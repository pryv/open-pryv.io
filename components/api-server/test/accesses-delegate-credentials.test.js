/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [ADCR] A delegated personal access sees the credentials of itself and of
 * the accesses it created only, never the owner's own tokens.
 */
describe('[ADCR] accesses: credentials and a delegated personal access', function () {
  let username, ownerToken, ownerAppId, ownerAppToken, delegateId, delegateToken, delegateShareId, delegateShareToken;

  before(async function () {
    await initTests();
    await initCore();
    username = cuid();
    const user = await getNewFixture().user(username);
    await user.stream({ id: 'adcr-s', name: 'S' });
    ownerToken = cuid();
    await user.access({ type: 'personal', token: ownerToken, name: 'adcr-login' });
    await user.session(ownerToken);
    ownerAppId = cuid();
    ownerAppToken = cuid();
    await user.access({ id: ownerAppId, type: 'app', token: ownerAppToken, name: 'adcr-app', permissions: [{ streamId: 'adcr-s', level: 'read' }] });
    delegateId = cuid();
    delegateToken = 'deleg-' + cuid();
    await user.access({
      id: delegateId,
      type: 'personal',
      token: delegateToken,
      name: 'delegation:adcr-parent@core',
      clientData: { delegation: { kind: 'delegate-pat', relId: 'adcr-rel', delegate: { username: 'adcr-parent', hostSlug: 'core' } } }
    });
    await user.session(delegateToken);
    delegateShareId = cuid();
    delegateShareToken = cuid();
    await user.access({ id: delegateShareId, type: 'shared', token: delegateShareToken, name: 'adcr-share', createdBy: delegateId, permissions: [{ streamId: 'adcr-s', level: 'read' }] });
  });

  function byId (accesses) {
    return Object.fromEntries(accesses.map((a) => [a.id, a]));
  }

  it('[ADCR1] accesses.get hides the owner tokens from the delegate, not its own nor what it created', async function () {
    const res = await coreRequest.get(`/${username}/accesses`).set('Authorization', delegateToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const all = byId(res.body.accesses);
    assert.strictEqual(all[ownerAppId].token, undefined);
    assert.strictEqual(all[ownerAppId].apiEndpoint, undefined);
    const ownerLogin = res.body.accesses.find((a) => a.name === 'adcr-login');
    assert.strictEqual(ownerLogin.token, undefined, 'the owner login token is hidden');
    assert.strictEqual(all[delegateId].token, delegateToken);
    assert.strictEqual(all[delegateShareId].token, delegateShareToken);
  });

  it('[ADCR2] the owner still sees every token', async function () {
    const res = await coreRequest.get(`/${username}/accesses`).set('Authorization', ownerToken);
    const all = byId(res.body.accesses);
    assert.strictEqual(all[ownerAppId].token, ownerAppToken);
    assert.strictEqual(all[delegateId].token, delegateToken);
  });

  it('[ADCR3] accesses.getOne hides an owner token from the delegate', async function () {
    const res = await coreRequest.get(`/${username}/accesses/${ownerAppId}`).set('Authorization', delegateToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.access.token, undefined);
    const own = await coreRequest.get(`/${username}/accesses/${delegateShareId}`).set('Authorization', delegateToken);
    assert.strictEqual(own.body.access.token, delegateShareToken);
  });

  it('[ADCR5] accesses.update does not return an owner token to the delegate', async function () {
    const res = await coreRequest.put(`/${username}/accesses/${ownerAppId}`).set('Authorization', delegateToken)
      .send({ name: 'adcr-app' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.access.token, undefined);
    assert.strictEqual(res.body.access.apiEndpoint, undefined);
  });

  it('[ADCR4] accesses.checkApp never hands an owner app access to the delegate', async function () {
    const res = await coreRequest.post(`/${username}/accesses/check-app`).set('Authorization', delegateToken)
      .send({ requestingAppId: 'adcr-app', requestedPermissions: [{ streamId: 'adcr-s', level: 'read', defaultName: 'S' }] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.matchingAccess, undefined);
    assert.strictEqual(res.body.mismatchingAccess?.token, undefined);
    const asOwner = await coreRequest.post(`/${username}/accesses/check-app`).set('Authorization', ownerToken)
      .send({ requestingAppId: 'adcr-app', requestedPermissions: [{ streamId: 'adcr-s', level: 'read', defaultName: 'S' }] });
    assert.strictEqual(asOwner.body.matchingAccess?.token, ownerAppToken, 'the owner flow is unchanged');
  });
});
