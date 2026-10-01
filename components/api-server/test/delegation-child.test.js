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

  it('[DCH14] a delegation-derived token cannot widen a data grant nor publish an offer; accepting a consent is no longer refused by this rule', async function () {
    const child = await createAccess(patToken, appFor('dch14-app'));
    for (const type of ['consent/scope-update-cmc', 'consent/request-cmc']) {
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
    // the accept's grant carries the delegation lineage, so the rule lets it
    // through (other checks still apply: this content is not a valid accept)
    for (const token of [patToken, child.token]) {
      const res = await coreRequest.post(bob.eventsPath).set('Authorization', token)
        .send({ streamIds: ['diary'], type: 'consent/accept-cmc', content: {} });
      assert.ok(!JSON.stringify(res.body).includes('delegation-grant-requires-owner'), JSON.stringify(res.body));
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

/**
 * [DCHC] a delegate (a carer managing the account) accepts a consent request
 * for the account it manages, with the delegate token:
 *   - the data grant carries the `delegated-child` lineage of the delegate
 *     token, so access-info names the delegate and detach revokes it;
 *   - the accept event records who approved, server-stamped
 *     (`content.approvedBy`), never taken from the client;
 *   - publishing an offer and widening a grant stay owner-only;
 *   - detach deletes the grant at once and the requester receives
 *     `consent/revoke-cmc`;
 *   - an accept still in progress when the delegation is detached does not
 *     complete and leaves no grant.
 * Three accounts on one core: `kid` (managed), `carer` (delegate), `doctor`
 * (requester). Outbound CMC HTTP goes through the in-process fetch shim.
 */
describe('[DCHC] consent accepted by a delegate for the account it manages (in-process integration)', function () {
  this.timeout(120_000);

  const { buildFetchShim } = require('./cmc-fetch-shim.cjs');
  const POLL_INTERVAL_MS = 100;
  const POLL_TIMEOUT_MS = 40_000;

  let kid, carer, doctor;
  let fixtures;
  let originalFetch;
  // One-shot hold on the next offer read from the doctor's account, to keep
  // an accept in progress while the test detaches the delegation.
  let offerHold = null;
  let rel; // current relationship: { patToken, patAccessId, relId }

  function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  before(async function () {
    await initTests();
    await initCore();
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    originalFetch = globalThis.fetch;
    const shim = buildFetchShim(originalFetch, global.coreServer);
    globalThis.fetch = async (url, init) => {
      const hold = offerHold;
      // the offer is read with the invite's token as the authorization header
      if (hold != null && (init?.method ?? 'GET').toUpperCase() === 'GET' &&
          init?.headers?.authorization === hold.capabilityToken) {
        offerHold = null;
        hold.reached();
        await hold.released;
      }
      return shim(url, init);
    };
    fixtures = getNewFixture();
    kid = await makeActor('kid-' + cuid().slice(-8));
    carer = await makeActor('carer-' + cuid().slice(-8));
    doctor = await makeActor('doctor-' + cuid().slice(-8));
    rel = await attach();
  });

  after(async function () {
    if (originalFetch != null) globalThis.fetch = originalFetch;
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
      accessesPath: '/' + username + '/accesses',
      accessInfoPath: '/' + username + '/access-info',
      eventsPath: '/' + username + '/events',
      delegationsPath: '/' + username + '/delegations',
    };
  }

  async function ensureStream (actor, token, params) {
    const res = await coreRequest.post(actor.streamsPath).set('Authorization', token).send(params);
    if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
      throw new Error('ensureStream(' + params.id + '): ' + res.status + ' ' + JSON.stringify(res.body));
    }
  }

  /** Attach `carer` as delegate of `kid`, issue the delegate token. */
  async function attach () {
    const reqRes = await coreRequest.post(kid.delegationsPath + '/attach-request')
      .set('Authorization', kid.token).send({ delegateUsername: carer.username });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const accRes = await coreRequest.post(carer.delegationsPath + '/controlled/' + kid.username + '/accept')
      .set('Authorization', carer.token).send({});
    assert.strictEqual(accRes.status, 200, JSON.stringify(accRes.body));
    const tokRes = await coreRequest.post(carer.delegationsPath + '/controlled/' + kid.username + '/token')
      .set('Authorization', carer.token).send({});
    assert.strictEqual(tokRes.status, 200, JSON.stringify(tokRes.body));
    const info = await coreRequest.get(kid.accessInfoPath).set('Authorization', tokRes.body.token);
    const list = await coreRequest.get(kid.delegationsPath + '/delegates').set('Authorization', kid.token);
    const record = (list.body.delegates || []).find((d) => d.delegate?.username === carer.username);
    assert.ok(record != null && typeof record.relId === 'string', JSON.stringify(list.body));
    return { patToken: tokRes.body.token, patAccessId: base(info.body.id), relId: record.relId };
  }

  async function detach () {
    const res = await coreRequest.delete(kid.delegationsPath + '/delegates/' + carer.username)
      .set('Authorization', kid.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  /** The doctor publishes a consent request; returns its invite. */
  async function invite (appId) {
    const appRoot = ':_cmc:apps:' + appId;
    const triggerStreamId = appRoot + ':study';
    await ensureStream(doctor, doctor.token, { id: appRoot, parentId: ':_cmc:apps', name: appId });
    await ensureStream(doctor, doctor.token, { id: triggerStreamId, parentId: appRoot, name: 'Study' });
    const res = await coreRequest.post(doctor.eventsPath).set('Authorization', doctor.token)
      .send({ streamIds: [triggerStreamId], type: 'consent/request-cmc', content: requestContent(appId, doctor) });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const capabilityUrl = res.body.event.content.capabilityUrl;
    assert.ok(typeof capabilityUrl === 'string' && capabilityUrl.length > 0);
    return { appId, appRoot, triggerStreamId, capabilityUrl };
  }

  function requestContent (appId, requester) {
    return {
      to: null,
      capabilityRequested: true,
      request: {
        title: { en: appId },
        description: { en: 'consent requested in a delegation test' },
        consent: { en: 'I consent.' },
        permissions: [{ streamId: 'fertility', level: 'read' }],
      },
      requesterMeta: { username: requester.username, appId },
    };
  }

  /** Write the accept on the kid's account with `token`. */
  async function accept (inv, token, extraContent = {}) {
    await ensureStream(kid, kid.token, { id: inv.appRoot, parentId: ':_cmc:apps', name: inv.appId });
    const res = await coreRequest.post(kid.eventsPath).set('Authorization', token)
      .send({
        streamIds: [inv.appRoot],
        type: 'consent/accept-cmc',
        content: { capabilityUrl: inv.capabilityUrl, accessName: 'grant-' + inv.appId, ...extraContent },
      });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }

  async function settledTrigger (eventId) {
    const t0 = Date.now();
    let content;
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const r = await coreRequest.get(kid.eventsPath + '/' + eventId).set('Authorization', kid.token);
      content = r.body?.event?.content;
      if (content?.status === 'completed' || content?.status === 'failed') return content;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('accept trigger did not settle: ' + JSON.stringify(content));
  }

  async function kidAccesses () {
    const res = await coreRequest.get(kid.accessesPath).set('Authorization', kid.token);
    return res.body.accesses || [];
  }

  async function kidAccess (id) {
    return (await kidAccesses()).find((a) => base(a.id) === base(id));
  }

  async function pollDoctorInbox (type, predicate) {
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const res = await coreRequest.get(doctor.eventsPath).set('Authorization', doctor.token)
        .query({ streams: [':_cmc:inbox'], types: [type], limit: 100 });
      const match = (res.body?.events || []).find(predicate);
      if (match != null) return match;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('poll timeout: ' + type + ' on the doctor\'s inbox');
  }

  async function countDoctorInbox (type) {
    const res = await coreRequest.get(doctor.eventsPath).set('Authorization', doctor.token)
      .query({ streams: [':_cmc:inbox'], types: [type], limit: 100 });
    return (res.body?.events || []).length;
  }

  /** The back-channel handshake has reached the kid's grant (the requester's endpoint is known). */
  async function backChannelReached (inv) {
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const match = (await kidAccesses()).find((a) => {
        const rcs = a?.clientData?.cmc?.counterparty?.remoteChatStreamId;
        return typeof rcs === 'string' && rcs.startsWith(inv.triggerStreamId + ':chats:');
      });
      if (match != null) return match;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('back-channel not reached for ' + inv.triggerStreamId);
  }

  const expectedApprovedBy = () => ({
    delegate: rel.delegateHostSlug != null ? { username: carer.username, hostSlug: rel.delegateHostSlug } : { username: carer.username },
    relId: rel.relId,
  });

  /** The token of a grant on the kid's account (the requester holds it). */
  async function grantTokenOf (grantId) {
    const grant = await kidAccess(grantId);
    assert.ok(typeof grant?.token === 'string' && grant.token.length > 0, JSON.stringify(grant));
    return grant.token;
  }

  /** The accept delivered to the doctor for the grant whose token is `grantToken`. */
  function acceptDeliveredFor (grantToken) {
    return pollDoctorInbox('consent/accept-cmc', (e) => {
      const ep = e.content?.grantedAccess?.apiEndpoint;
      if (typeof ep !== 'string') return false;
      try { return decodeURIComponent(new URL(ep).username) === grantToken; } catch (_e) { return false; }
    });
  }

  it('[DCH15] the delegate token accepts: approvedBy recorded, the grant carries the delegation lineage, access-info names the delegate', async function () {
    const inv = await invite('dch15-' + cuid().slice(-6));
    const event = await accept(inv, rel.patToken);
    const approvedBy = event.content.approvedBy;
    assert.strictEqual(approvedBy?.delegate?.username, carer.username, JSON.stringify(event.content));
    assert.strictEqual(approvedBy.relId, rel.relId);
    assert.deepStrictEqual(Object.keys(approvedBy).sort(), ['delegate', 'relId']);
    rel.delegateHostSlug = approvedBy.delegate.hostSlug;

    const settled = await settledTrigger(event.id);
    assert.strictEqual(settled.status, 'completed', JSON.stringify(settled));
    assert.deepStrictEqual(settled.approvedBy, approvedBy, 'the stamp survives the dispatch\'s status writes');

    const grant = await kidAccess(settled.dataGrantAccessId);
    assert.ok(grant != null, 'the data grant exists on the managed account');
    assert.strictEqual(grant.clientData.cmc.role, 'counterparty');
    assert.deepStrictEqual(grant.clientData.delegation, {
      kind: 'delegated-child',
      relId: rel.relId,
      delegate: grant.clientData.delegation.delegate,
      viaAccessId: rel.patAccessId,
    });
    assert.strictEqual(grant.clientData.delegation.delegate.username, carer.username);

    // the requester receives the accept, and its view of the grant says it
    // was granted through the delegation
    const grantToken = await grantTokenOf(settled.dataGrantAccessId);
    const delivered = await acceptDeliveredFor(grantToken);
    assert.strictEqual(delivered.content.from?.username, kid.username);
    const info = await coreRequest.get(kid.accessInfoPath).set('Authorization', grantToken);
    assert.strictEqual(info.status, 200, JSON.stringify(info.body));
    assert.strictEqual(info.body.delegation?.isDelegatedAccess, true, JSON.stringify(info.body));
    assert.strictEqual(info.body.delegation.grantedVia, 'app');
    assert.strictEqual(info.body.delegation.delegate.username, carer.username);
  });

  it('[DCH16] approvedBy cannot be supplied by a client, on create or on update', async function () {
    const forged = { delegate: { username: 'someone-else' }, relId: 'forged-rel' };
    // the owner: no approvedBy, and the grant carries no delegation lineage
    const own = await accept(await invite('dch16a-' + cuid().slice(-6)), kid.token, { approvedBy: forged });
    assert.strictEqual('approvedBy' in own.content, false, JSON.stringify(own.content));
    const ownSettled = await settledTrigger(own.id);
    assert.strictEqual(ownSettled.status, 'completed', JSON.stringify(ownSettled));
    assert.strictEqual('approvedBy' in ownSettled, false);
    const ownGrant = await kidAccess(ownSettled.dataGrantAccessId);
    assert.strictEqual(ownGrant.clientData.delegation, undefined, JSON.stringify(ownGrant.clientData));

    // the delegate: the stamp is the real one, whatever was sent
    const viaPat = await accept(await invite('dch16b-' + cuid().slice(-6)), rel.patToken, { approvedBy: forged });
    assert.deepStrictEqual(viaPat.content.approvedBy, expectedApprovedBy(), JSON.stringify(viaPat.content));
    const patSettled = await settledTrigger(viaPat.id);
    assert.strictEqual((await kidAccess(patSettled.dataGrantAccessId)).clientData.delegation.relId, rel.relId);

    // an update keeps the stamp (owner or delegate), and cannot add one
    for (const [token, content] of [[kid.token, { ...patSettled, approvedBy: forged }], [rel.patToken, { note: 'no approvedBy' }]]) {
      const upd = await coreRequest.put(kid.eventsPath + '/' + viaPat.id).set('Authorization', token).send({ content });
      assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
      assert.deepStrictEqual(upd.body.event.content.approvedBy, expectedApprovedBy(), JSON.stringify(upd.body.event.content));
    }
    const addUpd = await coreRequest.put(kid.eventsPath + '/' + own.id).set('Authorization', kid.token)
      .send({ content: { ...ownSettled, approvedBy: forged } });
    assert.strictEqual(addUpd.status, 200, JSON.stringify(addUpd.body));
    assert.strictEqual('approvedBy' in addUpd.body.event.content, false, JSON.stringify(addUpd.body.event.content));
  });

  it('[DCH17] publishing an offer and widening a grant stay owner-only for the delegate token', async function () {
    const appId = 'dch17-' + cuid().slice(-6);
    const appRoot = ':_cmc:apps:' + appId;
    await ensureStream(kid, kid.token, { id: appRoot, parentId: ':_cmc:apps', name: appId });
    const body = { streamIds: [appRoot], type: 'consent/request-cmc', content: requestContent(appId, kid) };
    const refused = await coreRequest.post(kid.eventsPath).set('Authorization', rel.patToken).send(body);
    assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
    assert.ok(JSON.stringify(refused.body).includes('delegation-grant-requires-owner'), JSON.stringify(refused.body));
    // the same request by the owner is valid: the refusal is the delegation rule
    const own = await coreRequest.post(kid.eventsPath).set('Authorization', kid.token).send(body);
    assert.strictEqual(own.status, 201, JSON.stringify(own.body));

    const widen = await coreRequest.post(kid.eventsPath).set('Authorization', rel.patToken)
      .send({ streamIds: [appRoot], type: 'consent/scope-update-cmc', content: {} });
    assert.strictEqual(widen.status, 400, JSON.stringify(widen.body));
    assert.ok(JSON.stringify(widen.body).includes('delegation-grant-requires-owner'), JSON.stringify(widen.body));
  });

  it('[DCH18] detach deletes a grant the delegate gave, at once, and the requester receives consent/revoke-cmc', async function () {
    const inv = await invite('dch18-' + cuid().slice(-6));
    const event = await accept(inv, rel.patToken);
    const settled = await settledTrigger(event.id);
    assert.strictEqual(settled.status, 'completed', JSON.stringify(settled));
    const grantId = base(settled.dataGrantAccessId);
    await backChannelReached(inv);
    const grantToken = await grantTokenOf(grantId);
    await acceptDeliveredFor(grantToken);

    await detach();

    // gone when detach returns, not eventually
    assert.strictEqual(await kidAccess(grantId), undefined, 'the grant is deleted by the detach itself');
    const dead = await coreRequest.get(kid.accessInfoPath).set('Authorization', grantToken);
    assert.ok([401, 403].includes(dead.status), 'the requester\'s token no longer works: ' + dead.status);
    // and the requester is told
    const revoke = await pollDoctorInbox('consent/revoke-cmc', (e) => base(e.content?.accessId) === grantId);
    assert.strictEqual(revoke.content.appCode, inv.appId);
    assert.strictEqual(revoke.content.from?.username, kid.username);
  });

  it('[DCH19] an accept still in progress when the delegation is detached does not complete and leaves no grant', async function () {
    rel = await attach();
    const inv = await invite('dch19-' + cuid().slice(-6));
    let reached;
    const atOfferRead = new Promise((resolve) => { reached = resolve; });
    let release;
    offerHold = {
      capabilityToken: decodeURIComponent(new URL(inv.capabilityUrl).username),
      reached,
      released: new Promise((resolve) => { release = resolve; }),
    };
    const acceptsBefore = await countDoctorInbox('consent/accept-cmc');

    const event = await accept(inv, rel.patToken);
    assert.strictEqual(event.content.approvedBy?.relId, rel.relId);
    // the dispatch is reading the offer: the accept is in progress
    await Promise.race([atOfferRead, sleep(POLL_TIMEOUT_MS).then(() => { throw new Error('the accept never read the offer'); })]);
    await detach();
    release();

    const settled = await settledTrigger(event.id);
    assert.strictEqual(settled.status, 'failed', JSON.stringify(settled));
    assert.strictEqual(settled.failure?.reason, 'cmc-handler-delegation-ended', JSON.stringify(settled));
    const grants = (await kidAccesses()).filter((a) => a.clientData?.cmc?.acceptEventId === event.id);
    assert.deepStrictEqual(grants, [], 'no grant for this accept');
    await sleep(1000);
    assert.strictEqual(await countDoctorInbox('consent/accept-cmc'), acceptsBefore, 'the requester never received an accept');
  });
});
