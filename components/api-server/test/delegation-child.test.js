/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Accesses a delegate grants on the controlled account — in-process integration.
 *
 * [DCHD] boots the api-server, runs the attach handshake same-core and issues
 * the delegate token, then uses it the way an auth page granting an app "for
 * the controlled account" does:
 *   - the app access it creates carries a server-stamped `delegated-child`
 *     lineage marker (never client-supplied), so access-info and the audit
 *     trail name the delegate;
 *   - accesses that app creates carry the same relationship;
 *   - such accesses are ordinary grants: the account owner, the delegate and
 *     the app itself may update or revoke them, and the marker survives
 *     updates;
 *   - detach revokes every one of them and nothing else.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const base = (id) => String(id).split(':')[0];
const DIARY = { streamId: 'diary', defaultName: 'Diary', level: 'contribute' };

describe('[DCHD] accesses granted through a delegation (in-process integration)', function () {
  this.timeout(60_000);

  let alice, bob;
  let fixtures;
  let patToken, patAccessId;

  before(async function () {
    await initTests();
    await initCore();
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    fixtures = getNewFixture();
    bob = await makeActor('bob-' + cuid().slice(-8)); // controlled account (B)
    alice = await makeActor('alice-' + cuid().slice(-8)); // delegate (A)

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
    const info = await coreRequest.get(bob.accessInfoPath).set('Authorization', patToken);
    patAccessId = base(info.body.id);
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
      accessesPath: '/' + username + '/accesses',
      accessInfoPath: '/' + username + '/access-info',
      eventsPath: '/' + username + '/events',
      delegationsPath: '/' + username + '/delegations',
    };
  }

  async function createAccess (token, body) {
    const res = await coreRequest.post(bob.accessesPath).set('Authorization', token).send(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.access;
  }

  async function bobAccess (id) {
    const res = await coreRequest.get(bob.accessesPath).set('Authorization', bob.token);
    return (res.body.accesses || []).find((a) => base(a.id) === base(id));
  }

  function appFor (name) {
    return { type: 'app', name, permissions: [DIARY], clientData: { app: name } };
  }

  it('[DCH01] an app access created with the delegate token carries the delegated-child marker', async function () {
    const child = await createAccess(patToken, appFor('dch01-app'));
    const stored = await bobAccess(child.id);
    assert.deepStrictEqual(stored.clientData, {
      app: 'dch01-app',
      delegation: {
        kind: 'delegated-child',
        relId: stored.clientData.delegation.relId,
        delegate: stored.clientData.delegation.delegate,
        viaAccessId: patAccessId,
      },
    });
    assert.strictEqual(stored.clientData.delegation.delegate.username, alice.username);
    assert.ok(typeof stored.clientData.delegation.relId === 'string' && stored.clientData.delegation.relId !== '');
  });

  it('[DCH02] access-info on that access says it acts on the controlled account, granted through the delegation', async function () {
    const child = await createAccess(patToken, appFor('dch02-app'));
    const res = await coreRequest.get(bob.accessInfoPath).set('Authorization', child.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.delegation, {
      isDelegatedAccess: true,
      controlledUsername: bob.username,
      delegate: res.body.delegation.delegate,
      grantedVia: 'app',
    });
    assert.strictEqual(res.body.delegation.delegate.username, alice.username);
  });

  it('[DCH03] a client-supplied marker is still refused, for the delegate token and for its child', async function () {
    const child = await createAccess(patToken, appFor('dch03-app'));
    const forged = { kind: 'delegated-child', relId: 'x', delegate: { username: 'someone' } };
    for (const [token, body] of [
      [patToken, { ...appFor('dch03-forged'), clientData: { delegation: forged } }],
      [child.token, { type: 'shared', name: 'dch03-shared', permissions: [{ streamId: 'diary', level: 'read' }], clientData: { delegation: forged } }],
      [bob.token, { ...appFor('dch03-owner'), clientData: { delegation: forged } }],
    ]) {
      const res = await coreRequest.post(bob.accessesPath).set('Authorization', token).send(body);
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.ok(JSON.stringify(res.body).includes('delegation-clientdata-forbidden'), JSON.stringify(res.body));
    }
  });

  it('[DCH04] an access created by that app carries the same relationship, via the app', async function () {
    const child = await createAccess(patToken, appFor('dch04-app'));
    const grandchild = await createAccess(child.token, { type: 'shared', name: 'dch04-shared', permissions: [{ streamId: 'diary', level: 'read' }] });
    const stored = await bobAccess(grandchild.id);
    const childStored = await bobAccess(child.id);
    assert.strictEqual(stored.clientData.delegation.kind, 'delegated-child');
    assert.strictEqual(stored.clientData.delegation.relId, childStored.clientData.delegation.relId);
    assert.deepStrictEqual(stored.clientData.delegation.delegate, childStored.clientData.delegation.delegate);
    assert.strictEqual(stored.clientData.delegation.viaAccessId, base(child.id));
    const info = await coreRequest.get(bob.accessInfoPath).set('Authorization', grandchild.token);
    assert.strictEqual(info.body.delegation.grantedVia, 'app');
  });

  it('[DCH05] actions through that access are audited on the controlled account with the delegate named', async function () {
    const auditStorage = require('storages').auditStorage;
    if (auditStorage == null) { this.skip(); return; }
    const child = await createAccess(patToken, appFor('dch05-app'));
    const created = await coreRequest.post(bob.eventsPath).set('Authorization', child.token)
      .send({ streamIds: ['diary'], type: 'note/txt', content: 'dch05' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const userDb = await auditStorage.forUser(bob.username);
    // audit records are written asynchronously
    let record = null;
    for (let i = 0; i < 30 && record == null; i++) {
      const events = await userDb.getEvents({ query: [] });
      record = events.find((e) => e.content?.action === 'events.create' &&
        (e.streamIds || []).includes('access-' + base(child.id))) ?? null;
      if (record == null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(record != null, 'the child action is audited under its own access stream');
    assert.deepStrictEqual(record.content.delegation, {
      delegateUsername: alice.username,
      delegateHostSlug: record.content.delegation?.delegateHostSlug,
    });
  });

  it('[DCH06] the account owner can update it; no clientData update drops or changes the marker', async function () {
    let child = await createAccess(patToken, appFor('dch06-app'));
    const marker = (await bobAccess(child.id)).clientData.delegation;
    // `delegation: null` passes the forge check (it only refuses a value)
    for (const clientData of [{ x: 1 }, { delegation: null }, null]) {
      const res = await coreRequest.put(bob.accessesPath + '/' + child.id).set('Authorization', bob.token)
        .send({ name: 'dch06-renamed', clientData });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      child = res.body.access; // an update moves the access to its next serial
      const stored = await bobAccess(child.id);
      assert.strictEqual(stored.name, 'dch06-renamed');
      assert.deepStrictEqual(stored.clientData?.delegation, marker, 'after clientData ' + JSON.stringify(clientData));
      if (clientData?.x != null) assert.strictEqual(stored.clientData.x, 1);
    }
    // a null clientData clears the app's own keys, as on any access
    assert.deepStrictEqual((await bobAccess(child.id)).clientData, { delegation: marker });
    // the owner can also narrow what the app may do
    const narrowed = await coreRequest.put(bob.accessesPath + '/' + child.id).set('Authorization', bob.token)
      .send({ permissions: [{ streamId: 'diary', level: 'read' }] });
    assert.strictEqual(narrowed.status, 200, JSON.stringify(narrowed.body));
    const afterNarrow = await bobAccess(narrowed.body.access.id);
    assert.deepStrictEqual(afterNarrow.permissions.filter((p) => p.streamId === 'diary'), [{ streamId: 'diary', level: 'read' }]);
    assert.deepStrictEqual(afterNarrow.clientData.delegation, marker);
    const info = await coreRequest.get(bob.accessInfoPath).set('Authorization', child.token);
    assert.strictEqual(info.body.delegation.grantedVia, 'app');
  });

  it('[DCH07] a client-supplied marker on update is still refused', async function () {
    const child = await createAccess(patToken, appFor('dch07-app'));
    const res = await coreRequest.put(bob.accessesPath + '/' + child.id).set('Authorization', bob.token)
      .send({ clientData: { delegation: { kind: 'control', relId: 'x' } } });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.ok(JSON.stringify(res.body).includes('delegation-clientdata-forbidden'), JSON.stringify(res.body));
  });

  it('[DCH08] the account owner can revoke it, and the revoke cascades to what the app created', async function () {
    const child = await createAccess(patToken, appFor('dch08-app'));
    const grandchild = await createAccess(child.token, { type: 'shared', name: 'dch08-shared', permissions: [{ streamId: 'diary', level: 'read' }] });
    const res = await coreRequest.delete(bob.accessesPath + '/' + child.id).set('Authorization', bob.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual((res.body.relatedDeletions || []).map((d) => base(d.id)), [base(grandchild.id)]);
    assert.strictEqual(await bobAccess(child.id), undefined);
    assert.strictEqual(await bobAccess(grandchild.id), undefined);
  });

  it('[DCH09] the app can revoke itself, and the delegate token can revoke it', async function () {
    const self = await createAccess(patToken, appFor('dch09-self'));
    const bySelf = await coreRequest.delete(bob.accessesPath + '/' + self.id).set('Authorization', self.token);
    assert.strictEqual(bySelf.status, 200, JSON.stringify(bySelf.body));
    const other = await createAccess(patToken, appFor('dch09-pat'));
    const byPat = await coreRequest.delete(bob.accessesPath + '/' + other.id).set('Authorization', patToken);
    assert.strictEqual(byPat.status, 200, JSON.stringify(byPat.body));
  });

  it('[DCH10] check-app matches it like any app access (the lineage marker is not app data)', async function () {
    for (const [name, clientData] of [['dch10-app', { app: 'dch10-app' }], ['dch10-bare', undefined]]) {
      const child = await createAccess(patToken, { type: 'app', name, deviceName: 'dch10-device', permissions: [DIARY], clientData });
      const res = await coreRequest.post(bob.accessesPath + '/check-app').set('Authorization', patToken)
        .send({ requestingAppId: name, deviceName: 'dch10-device', requestedPermissions: [DIARY], clientData });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.matchingAccess != null, JSON.stringify(res.body));
      assert.strictEqual(base(res.body.matchingAccess.id), base(child.id));
    }
  });

  it('[DCH13] an auth page granting for the controlled account: consent-checked ACCEPTED with the hint, then polled', async function () {
    const create = await coreRequest.post('/reg/access').send({
      requestingAppId: 'dch13-app',
      requestedPermissions: [{ streamId: 'diary', level: 'read', defaultName: 'Diary' }, { streamId: 'weight', level: 'read', defaultName: 'Weight' }],
      consent: { allowUserChoice: true, mandatory: ['diary'], optIn: ['weight'] },
      actAs: bob.username
    });
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    const key = create.body.key;
    assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.actAs, bob.username);
    const hint = { isDelegatedAccess: true, controlledUsername: bob.username, delegate: { username: alice.username } };

    // a grant missing the mandatory entry is refused, the request stays open
    const wrong = await createAccess(patToken, { type: 'app', name: 'dch13-wrong', permissions: [{ streamId: 'weight', level: 'read', defaultName: 'Weight' }] });
    const refused = await coreRequest.post('/reg/access/' + key)
      .send({ status: 'ACCEPTED', username: bob.username, token: wrong.token, apiEndpoint: wrong.apiEndpoint, delegation: hint });
    assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.error.id, 'invalid-consent-grant');

    const child = await createAccess(patToken, { type: 'app', name: 'dch13-app', permissions: [{ streamId: 'diary', level: 'read', defaultName: 'Diary' }] });
    const accepted = await coreRequest.post('/reg/access/' + key)
      .send({ status: 'ACCEPTED', username: bob.username, token: child.token, apiEndpoint: child.apiEndpoint, delegation: hint });
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
    const poll = await coreRequest.get('/reg/access/' + key);
    assert.strictEqual(poll.body.username, bob.username);
    assert.strictEqual(poll.body.token, child.token);
    assert.deepStrictEqual(poll.body.delegation, hint);
    const info = await coreRequest.get(bob.accessInfoPath).set('Authorization', poll.body.token);
    assert.strictEqual(info.body.delegation.grantedVia, 'app');
  });

  it('[DCH14] a delegation-derived token cannot write a consent trigger that creates or widens a data grant, nor publish an offer', async function () {
    const child = await createAccess(patToken, appFor('dch14-app'));
    for (const type of ['consent/accept-cmc', 'consent/scope-update-cmc', 'consent/request-cmc']) {
      for (const token of [patToken, child.token]) {
        const res = await coreRequest.post(bob.eventsPath).set('Authorization', token)
          .send({ streamIds: ['diary'], type, content: {} });
        assert.strictEqual(res.status, 400, type + ' ' + JSON.stringify(res.body));
        assert.ok(JSON.stringify(res.body).includes('delegation-grant-requires-owner'), JSON.stringify(res.body));
      }
      // the owner is not refused by this rule (other checks apply as before)
      const own = await coreRequest.post(bob.eventsPath).set('Authorization', bob.token)
        .send({ streamIds: ['diary'], type, content: {} });
      assert.ok(!JSON.stringify(own.body).includes('delegation-grant-requires-owner'), JSON.stringify(own.body));
    }
  });

  it('[DCH11] an access granted through the delegation cannot detach it (genuine-login gate)', async function () {
    const child = await createAccess(patToken, appFor('dch11-app'));
    const res = await coreRequest.delete(bob.delegationsPath + '/delegates/' + alice.username)
      .set('Authorization', child.token);
    assert.ok([401, 403].includes(res.status), res.status + ' ' + JSON.stringify(res.body));
  });

  it('[DCH12] detach revokes every access granted through the delegation, and nothing else', async function () {
    const child = await createAccess(patToken, appFor('dch12-app'));
    const grandchild = await createAccess(child.token, { type: 'shared', name: 'dch12-shared', permissions: [{ streamId: 'diary', level: 'read' }] });
    const own = await createAccess(bob.token, appFor('dch12-own'));
    const ownShared = await createAccess(own.token, { type: 'shared', name: 'dch12-own-shared', permissions: [{ streamId: 'diary', level: 'read' }] });

    const res = await coreRequest.delete(bob.delegationsPath + '/delegates/' + alice.username)
      .set('Authorization', bob.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.strictEqual(await bobAccess(child.id), undefined, 'the app granted by the delegate is revoked');
    assert.strictEqual(await bobAccess(grandchild.id), undefined, 'and what it created');
    assert.ok(await bobAccess(own.id) != null, 'an app the owner granted survives');
    assert.ok(await bobAccess(ownShared.id) != null, 'and what it created');
    const all = (await coreRequest.get(bob.accessesPath).set('Authorization', bob.token)).body.accesses || [];
    assert.deepStrictEqual(all.filter((a) => a.clientData?.delegation != null), [], 'no delegation-marked access remains');
    const dead = await coreRequest.get(bob.eventsPath).set('Authorization', child.token);
    assert.ok([401, 403].includes(dead.status), 'the revoked app token no longer works');
  });
});
