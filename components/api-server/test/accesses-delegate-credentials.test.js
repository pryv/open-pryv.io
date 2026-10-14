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
    fixtureUser = user;
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
    // A consent relationship access of the owner: its clientData.cmc holds
    // the counterparty's endpoints, tokens included.
    ownerCmcId = cuid();
    await user.access({
      id: ownerCmcId,
      type: 'shared',
      token: cuid(),
      name: 'adcr-cmc',
      permissions: [{ streamId: 'adcr-s', level: 'read' }],
      clientData: cmcClientData(PEER_TOKEN, PEER_BC_TOKEN)
    });
    deletedCmcId = cuid();
    await user.access({
      id: deletedCmcId,
      type: 'shared',
      token: cuid(),
      name: 'adcr-cmc-deleted',
      deleted: Date.now() / 1000,
      permissions: [{ streamId: 'adcr-s', level: 'read' }],
      clientData: cmcClientData(PEER_DELETED_TOKEN, PEER_DELETED_TOKEN)
    });
  });

  const PEER_TOKEN = 'peertok-' + cuid();
  const PEER_BC_TOKEN = 'peerbc-' + cuid();
  const PEER_DELETED_TOKEN = 'peerdel-' + cuid();
  let ownerCmcId, deletedCmcId, fixtureUser;

  // An owner app access whose app-written clientData carries URL credentials
  // in every form the redaction covers, plus values it leaves alone.
  const FORMS = {
    nested: 'tok-nested-' + cuid(),
    inArray: 'tok-arr-' + cuid(),
    inText: 'tok-text-' + cuid(),
    encoded: 'tok-enc-' + cuid(),
    lenient: 'tok-len-' + cuid(),
  };
  const BARE_SECRET = 'bare-' + cuid();
  const EMAIL = 'contact@example.com';
  let ownerPlainId;
  function plainClientData () {
    return {
      app: {
        endpoint: 'https://' + FORMS.nested + '@peer.example/n/',
        list: ['https://' + FORMS.inArray + '@peer.example/a/', EMAIL],
        note: 'see https://' + FORMS.inText + '@peer.example/t/ for details',
        encoded: 'https://peer.example/cb?next=https%3A%2F%2F' + FORMS.encoded + '%40peer.example%2Fq',
        lenient: 'https:\\\\' + FORMS.lenient + '@peer.example/l',
        bare: BARE_SECRET,
      },
    };
  }
  before(async function () {
    ownerPlainId = cuid();
    await fixtureUser.access({
      id: ownerPlainId,
      type: 'app',
      token: cuid(),
      name: 'adcr-plain',
      permissions: [{ streamId: 'adcr-s', level: 'read' }],
      clientData: plainClientData()
    });
  });
  function assertNoFormToken (body, label) {
    const s = JSON.stringify(body);
    for (const [form, tok] of Object.entries(FORMS)) assert.ok(!s.includes(tok), label + ': the ' + form + ' token leaked: ' + s);
  }

  function cmcClientData (grantToken, backChannelToken) {
    return {
      cmc: {
        role: 'counterparty',
        appCode: 'adcr-app',
        scopeStreamId: ':_cmc:apps:adcr-app:study',
        counterparty: {
          username: 'adcr-peer',
          host: 'peer.example',
          apiEndpoint: 'https://' + grantToken + '@peer.example/adcr-peer/',
          remoteChatStreamId: ':_cmc:apps:adcr-app:study:chats:me'
        },
        backChannelApiEndpoint: 'https://' + backChannelToken + '@peer.example/adcr-peer/'
      }
    };
  }

  function assertPeerTokensRedacted (access, label) {
    const cmc = access.clientData?.cmc;
    assert.ok(cmc != null, label + ': clientData.cmc is still there');
    assert.strictEqual(cmc.counterparty.apiEndpoint, 'https://peer.example/adcr-peer/', label + ': counterparty endpoint kept without its token');
    assert.strictEqual(cmc.backChannelApiEndpoint, 'https://peer.example/adcr-peer/', label + ': back-channel endpoint kept without its token');
    assert.strictEqual(cmc.counterparty.username, 'adcr-peer');
    assert.strictEqual(cmc.counterparty.host, 'peer.example');
    assert.strictEqual(cmc.counterparty.remoteChatStreamId, ':_cmc:apps:adcr-app:study:chats:me');
    assert.strictEqual(cmc.appCode, 'adcr-app');
  }

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

  it('[ADCR6] accesses.get hides the counterparty tokens held in clientData.cmc from the delegate, not from the owner', async function () {
    const res = await coreRequest.get(`/${username}/accesses`).set('Authorization', delegateToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assertPeerTokensRedacted(byId(res.body.accesses)[ownerCmcId], 'ADCR6');
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(PEER_TOKEN) && !body.includes(PEER_BC_TOKEN), 'no peer token anywhere in the response');

    const asOwner = await coreRequest.get(`/${username}/accesses`).set('Authorization', ownerToken);
    const cmc = byId(asOwner.body.accesses)[ownerCmcId].clientData.cmc;
    assert.strictEqual(cmc.counterparty.apiEndpoint, 'https://' + PEER_TOKEN + '@peer.example/adcr-peer/', 'the owner reads the stored value');
    assert.strictEqual(cmc.backChannelApiEndpoint, 'https://' + PEER_BC_TOKEN + '@peer.example/adcr-peer/');
  });

  it('[ADCR7] accesses.getOne hides the counterparty tokens from the delegate', async function () {
    const res = await coreRequest.get(`/${username}/accesses/${ownerCmcId}`).set('Authorization', delegateToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assertPeerTokensRedacted(res.body.access, 'ADCR7');
    assert.strictEqual(res.body.access.token, undefined);
    const asOwner = await coreRequest.get(`/${username}/accesses/${ownerCmcId}`).set('Authorization', ownerToken);
    assert.ok(asOwner.body.access.clientData.cmc.counterparty.apiEndpoint.includes(PEER_TOKEN), 'the owner reads the stored value');
  });

  it('[ADCR8] a deletion record carries no counterparty token, whoever lists it', async function () {
    for (const [who, token] of [['delegate', delegateToken], ['owner', ownerToken]]) {
      const res = await coreRequest.get(`/${username}/accesses`).set('Authorization', token).query({ includeDeletions: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const deletion = (res.body.accessDeletions || []).find((a) => a.id === deletedCmcId);
      assert.ok(deletion != null, who + ': the deletion record is listed: ' + JSON.stringify(res.body.accessDeletions));
      assert.strictEqual(deletion.token, undefined, who + ': no token on a deletion record');
      assert.strictEqual(deletion.clientData.cmc.counterparty.apiEndpoint, 'https://peer.example/adcr-peer/', who);
      assert.strictEqual(deletion.clientData.cmc.backChannelApiEndpoint, 'https://peer.example/adcr-peer/', who);
      assert.ok(!JSON.stringify(res.body.accessDeletions).includes(PEER_DELETED_TOKEN), who + ': no peer token in the deletions');
    }
  });

  it('[ADCR9] every URL user part in clientData is removed for the delegate (nested, in an array, in a text, percent-encoded, lenient spelling); other values stay', async function () {
    const res = await coreRequest.get(`/${username}/accesses/${ownerPlainId}`).set('Authorization', delegateToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assertNoFormToken(res.body, 'ADCR9 getOne');
    const app = res.body.access.clientData.app;
    assert.strictEqual(app.endpoint, 'https://peer.example/n/');
    assert.deepStrictEqual(app.list, ['https://peer.example/a/', EMAIL], 'the e-mail address is unchanged');
    assert.strictEqual(app.note, 'see https://peer.example/t/ for details');
    assert.strictEqual(app.encoded, 'https://peer.example/cb?next=https%3A%2F%2Fpeer.example%2Fq');
    assert.strictEqual(app.lenient, 'https://peer.example/l');
    assert.strictEqual(app.bare, BARE_SECRET, 'a bare value is returned as stored (documented limit)');

    const asOwner = await coreRequest.get(`/${username}/accesses/${ownerPlainId}`).set('Authorization', ownerToken);
    assert.deepStrictEqual(asOwner.body.access.clientData, plainClientData(), 'the owner reads the stored value');
  });

  it('[ADCR10] accesses.update, an older serial, includeHistory and checkApp hand the delegate no clientData credential', async function () {
    // update by the delegate (a non-CMC access: nothing to notify)
    const upd = await coreRequest.put(`/${username}/accesses/${ownerPlainId}`).set('Authorization', delegateToken)
      .send({ name: 'adcr-plain' });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    assertNoFormToken(upd.body, 'ADCR10 update');
    // a second version by the owner, so an older serial and a history exist
    const upd2 = await coreRequest.put(`/${username}/accesses/${upd.body.access.id}`).set('Authorization', ownerToken)
      .send({ name: 'adcr-plain' });
    assert.strictEqual(upd2.status, 200, JSON.stringify(upd2.body));
    const headId = upd2.body.access.id;
    assert.ok(headId.includes(':'), 'the head carries a serial: ' + headId);
    const olderId = ownerPlainId + ':' + (Number(headId.split(':')[1]) - 1);

    const older = await coreRequest.get(`/${username}/accesses/${olderId}`).set('Authorization', delegateToken);
    assert.strictEqual(older.status, 200, JSON.stringify(older.body));
    assert.ok(older.body.current != null, 'an obsolete serial answers with the current id');
    assertNoFormToken(older.body, 'ADCR10 older serial');

    const hist = await coreRequest.get(`/${username}/accesses/${ownerPlainId}`).set('Authorization', delegateToken)
      .query({ includeHistory: true });
    assert.strictEqual(hist.status, 200, JSON.stringify(hist.body));
    assert.ok(Array.isArray(hist.body.history) && hist.body.history.length > 0, 'history returned');
    assertNoFormToken(hist.body, 'ADCR10 history');

    const check = await coreRequest.post(`/${username}/accesses/check-app`).set('Authorization', delegateToken)
      .send({ requestingAppId: 'adcr-plain', requestedPermissions: [{ streamId: 'adcr-s', level: 'contribute', defaultName: 'S' }] });
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    assert.ok(check.body.mismatchingAccess != null, 'the owner app is reported as mismatching: ' + JSON.stringify(check.body));
    assertNoFormToken(check.body, 'ADCR10 checkApp');

    const asOwner = await coreRequest.get(`/${username}/accesses/${ownerPlainId}`).set('Authorization', ownerToken)
      .query({ includeHistory: true });
    assert.ok(JSON.stringify(asOwner.body).includes(FORMS.nested), 'the owner still reads the stored value');
  });

  describe('[ADCR-WH] webhooks of the owner', function () {
    const RECEIVER_SECRET = 'whsecret-' + cuid();
    const OWN_SECRET = 'whown-' + cuid();
    let ownerHookId, ownHookId, delegateAppId;
    before(async function () {
      delegateAppId = cuid();
      await fixtureUser.access({ id: delegateAppId, type: 'app', token: cuid(), name: 'adcr-deleg-app', createdBy: delegateId, permissions: [{ streamId: 'adcr-s', level: 'read' }] });
      ownerHookId = cuid();
      await fixtureUser.webhook({ id: ownerHookId, url: 'https://hook:' + RECEIVER_SECRET + '@hook.example/path?token=' + RECEIVER_SECRET + '#f' }, ownerAppId);
      ownHookId = cuid();
      await fixtureUser.webhook({ id: ownHookId, url: 'https://hook.example/mine?token=' + OWN_SECRET }, delegateAppId);
    });

    it('[ADCR11] webhooks.get and getOne reduce the owner webhooks\' url for the delegate, not the delegate\'s own', async function () {
      const res = await coreRequest.get(`/${username}/webhooks`).set('Authorization', delegateToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const hooks = byId(res.body.webhooks);
      assert.strictEqual(hooks[ownerHookId].url, 'https://hook.example/path');
      assert.strictEqual(hooks[ownHookId].url, 'https://hook.example/mine?token=' + OWN_SECRET, 'the webhook of an access the delegate created is read as stored');
      assert.ok(!JSON.stringify(res.body).includes(RECEIVER_SECRET), 'no receiver secret in the listing');

      const one = await coreRequest.get(`/${username}/webhooks/${ownerHookId}`).set('Authorization', delegateToken);
      assert.strictEqual(one.status, 200, JSON.stringify(one.body));
      assert.strictEqual(one.body.webhook.url, 'https://hook.example/path');

      const asOwner = await coreRequest.get(`/${username}/webhooks/${ownerHookId}`).set('Authorization', ownerToken);
      assert.strictEqual(asOwner.body.webhook.url, 'https://hook:' + RECEIVER_SECRET + '@hook.example/path?token=' + RECEIVER_SECRET + '#f', 'the owner reads the stored url');
    });

    it('[ADCR12] webhooks.update returns the reduced url to the delegate', async function () {
      const res = await coreRequest.put(`/${username}/webhooks/${ownerHookId}`).set('Authorization', delegateToken)
        .send({ state: 'active' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.webhook.url, 'https://hook.example/path');
    });
  });
});
