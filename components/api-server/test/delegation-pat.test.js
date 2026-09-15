/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Delegate PAT (personal access token) — in-process integration.
 *
 * [DPAT] boots the api-server against a real backend, runs the full attach
 * handshake same-core (request → accept), issues a delegate PAT via getToken,
 * and asserts:
 *   - the PAT is a FULL owner-equivalent personal token (streams/events/accesses
 *     on the controlled account behave exactly as its own personal token);
 *   - re-issue is idempotent (same token, no second access);
 *   - access-info surfaces the additive `delegation` field for the PAT;
 *   - the controlled account's audit trail attributes the PAT's actions to the
 *     named delegate (content.delegation) under the PAT's own audit stream.
 *
 * Same-core: identity resolves to self, so the whole handshake + token issuance
 * dispatch in-process — no fetch shim needed.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[DPAT] delegate PAT (in-process integration)', function () {
  this.timeout(60_000);

  let alice, bob; // { username, token, ...paths }
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    // The shared in-process core registers a fixed method-family list whose
    // first-booting caller decides the set; ensure the delegations family is
    // present regardless of boot order (api.register overwrites idempotently).
    const globalAny = global;
    await require('api-server/src/methods/delegations.ts').default(globalAny.app.api);
    fixtures = getNewFixture();
    bob = await makeActor('bob-' + cuid().slice(-8)); // controlled account (B)
    alice = await makeActor('alice-' + cuid().slice(-8)); // delegate (A)
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
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
      accessInfoPath: '/' + username + '/access-info',
      delegationsPath: '/' + username + '/delegations',
    };
  }

  let patToken;
  let patApiEndpoint;
  let patAccessId;

  it('[DPAT-01] full handshake same-core: request → accept → getToken issues a PAT', async function () {
    // B requests to be controlled by A.
    const reqRes = await coreRequest.post(bob.delegationsPath + '/attach-request')
      .set('Authorization', bob.token)
      .send({ delegateUsername: alice.username });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    assert.strictEqual(reqRes.body.delegation.status, 'invite');

    // A accepts.
    const accRes = await coreRequest.post(alice.delegationsPath + '/controlled/' + bob.username + '/accept')
      .set('Authorization', alice.token)
      .send({});
    assert.strictEqual(accRes.status, 200, JSON.stringify(accRes.body));
    assert.strictEqual(accRes.body.delegation.status, 'active');

    // A issues a delegate PAT for B.
    const tokRes = await coreRequest.post(alice.delegationsPath + '/controlled/' + bob.username + '/token')
      .set('Authorization', alice.token)
      .send({});
    assert.strictEqual(tokRes.status, 200, JSON.stringify(tokRes.body));
    assert.ok(tokRes.body.token, 'a PAT token is returned to A');
    assert.ok(typeof tokRes.body.apiEndpoint === 'string', 'B apiEndpoint returned');
    assert.ok(tokRes.body.apiEndpoint.includes(bob.username), 'apiEndpoint targets the controlled account');
    patToken = tokRes.body.token;
    patApiEndpoint = tokRes.body.apiEndpoint;
    assert.ok(patApiEndpoint.includes(patToken), 'apiEndpoint carries the PAT token');
  });

  it('[DPAT-02] the PAT is an owner-equivalent personal token on B', async function () {
    // streams.create on B via the PAT.
    const streamId = 'dpat-stream-' + cuid().slice(-6);
    const sRes = await coreRequest.post(bob.streamsPath)
      .set('Authorization', patToken)
      .send({ id: streamId, name: 'Delegated Stream' });
    assert.strictEqual(sRes.status, 201, 'PAT can create a stream: ' + JSON.stringify(sRes.body));

    // events.create on B via the PAT.
    const eRes = await coreRequest.post(bob.eventsPath)
      .set('Authorization', patToken)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'hello from the delegate' });
    assert.strictEqual(eRes.status, 201, 'PAT can create an event: ' + JSON.stringify(eRes.body));

    // events.get / streams.get / accesses.get on B via the PAT.
    const egRes = await coreRequest.get(bob.eventsPath).set('Authorization', patToken).query({ streams: [streamId] });
    assert.strictEqual(egRes.status, 200, 'PAT can read events');
    assert.ok((egRes.body.events || []).some((e) => e.content === 'hello from the delegate'));

    const sgRes = await coreRequest.get(bob.streamsPath).set('Authorization', patToken);
    assert.strictEqual(sgRes.status, 200, 'PAT can read streams');

    const agRes = await coreRequest.get(bob.accessesPath).set('Authorization', patToken);
    assert.strictEqual(agRes.status, 200, 'PAT can read accesses (account management)');
  });

  it('[DPAT-03] access-info surfaces the additive delegation field for the PAT', async function () {
    const res = await coreRequest.get(bob.accessInfoPath).set('Authorization', patToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.type, 'personal', 'the PAT is a personal-class token');
    assert.ok(res.body.delegation != null, 'delegation field present');
    assert.strictEqual(res.body.delegation.isDelegatedAccess, true);
    assert.strictEqual(res.body.delegation.controlledUsername, bob.username);
    assert.strictEqual(res.body.delegation.delegate.username, alice.username);
    // The token acts AS the controlled account.
    assert.strictEqual(res.body.user.username, bob.username, 'user.username stays the controlled account');
    patAccessId = res.body.id;
  });

  it('[DPAT-04] getToken is idempotent — re-issue returns the same PAT, no second access', async function () {
    const before = await coreRequest.get(bob.accessesPath).set('Authorization', patToken);
    const patCountBefore = (before.body.accesses || []).filter(isDelegatePat).length;

    const tokRes = await coreRequest.post(alice.delegationsPath + '/controlled/' + bob.username + '/token')
      .set('Authorization', alice.token)
      .send({});
    assert.strictEqual(tokRes.status, 200, JSON.stringify(tokRes.body));
    assert.strictEqual(tokRes.body.token, patToken, 're-issue returns the SAME live PAT token');

    const after = await coreRequest.get(bob.accessesPath).set('Authorization', patToken);
    const patCountAfter = (after.body.accesses || []).filter(isDelegatePat).length;
    assert.strictEqual(patCountAfter, patCountBefore, 'no second PAT access minted');
    assert.strictEqual(patCountAfter, 1, 'exactly one delegate PAT on B');

    function isDelegatePat (a) {
      return a.clientData?.delegation?.kind === 'delegate-pat';
    }
  });

  it('[DPAT-05] the PAT actions are audited on B with delegate attribution under the PAT stream', async function () {
    const auditStorage = require('storages').auditStorage;
    if (auditStorage == null) { this.skip(); return; }
    const userDb = await auditStorage.forUser(bob.username);
    const events = await userDb.getEvents({ query: [] });
    assert.ok(Array.isArray(events) && events.length >= 1, 'audit events recorded on B');
    const stamped = events.find((e) => e.content?.action === 'events.create' && e.content?.delegation != null);
    assert.ok(stamped != null, 'at least one events.create carries content.delegation');
    assert.strictEqual(stamped.content.delegation.delegateUsername, alice.username,
      'audit attributes the action to the named delegate');
    assert.ok((stamped.streamIds || []).includes('access-' + patAccessId),
      'the audited action lands under the PAT access audit stream (per-delegate attribution)');
  });
});
