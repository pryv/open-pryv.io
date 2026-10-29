/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC accept: account-stream permissions in the granted set.
 *
 * [CMCAS] covers: accepting an offer mints the data-grant with the same
 * account-stream rules as accesses.create. A granted set naming a hidden or
 * unknown account stream, the account root above read, or a visible account
 * field above read is refused (trigger `failed`, reason
 * `cmc-offer-invalid-permissions`) and no data-grant is stored; read on a
 * visible account field is granted.
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid, with the shared
 * in-process fetch shim for the cross-account delivery.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { buildFetchShim } = require('./cmc-fetch-shim.cjs');

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function ensureStream (path, token, params) {
  const res = await coreRequest.post(path).set('Authorization', token).send(params);
  if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
    throw new Error('ensureStream(' + params.id + ') failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
}

describe('[CMCAS] cmc accept: account-stream permissions in the granted set', function () {
  this.timeout(90_000);

  let alice, bob, originalFetch, fixtures;

  before(async function () {
    await initTests();
    await initCore();
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.coreServer);
    fixtures = getNewFixture();
    alice = await makeActor('cmcas-a-' + cuid().slice(-8));
    bob = await makeActor('cmcas-b-' + cuid().slice(-8));
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
    const actor = { username, token, streamsPath: '/' + username + '/streams', eventsPath: '/' + username + '/events', accessesPath: '/' + username + '/accesses' };
    await ensureStream(actor.streamsPath, token, { id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App' });
    return actor;
  }

  // Alice offers `permissions`, Bob accepts; returns Bob's settled trigger.
  async function offerAndAccept (permissions) {
    const scope = ':_cmc:apps:my-app:cmcas-' + cuid().slice(-8);
    await ensureStream(alice.streamsPath, alice.token, { id: scope, parentId: ':_cmc:apps:my-app', name: scope });
    const reqRes = await coreRequest.post(alice.eventsPath).set('Authorization', alice.token).send({
      streamIds: [scope],
      type: 'consent/request-cmc',
      content: {
        to: null,
        capabilityRequested: true,
        request: { title: { en: 'CMCAS' }, description: { en: 'd' }, consent: { en: 'I consent.' }, permissions },
        requesterMeta: { username: alice.username, appId: 'my-app' },
      },
    });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const capabilityUrl = reqRes.body.event.content.capabilityUrl;
    const accRes = await coreRequest.post(bob.eventsPath).set('Authorization', bob.token).send({
      streamIds: [':_cmc:apps:my-app'],
      type: 'consent/accept-cmc',
      content: { capabilityUrl, accessName: 'cmcas-grant-' + cuid().slice(-8) },
    });
    assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const res = await coreRequest.get(bob.eventsPath + '/' + accRes.body.event.id).set('Authorization', bob.token);
      const content = res.body?.event?.content ?? {};
      if (content.status === 'completed' || content.status === 'failed') return { trigger: res.body.event };
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('accept did not settle: ' + accRes.body.event.id);
  }

  async function grantsOf (trigger) {
    const res = await coreRequest.get(bob.accessesPath).set('Authorization', bob.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return (res.body.accesses || []).filter((a) => a.clientData?.cmc?.acceptEventId === trigger.id);
  }

  for (const [label, permission] of [
    ['a hidden account stream at read', { streamId: ':_system:invitationToken', level: 'read' }],
    ['an unknown account stream at read', { streamId: ':_system:cmcasunknown', level: 'read' }],
    ['the account root above read', { streamId: ':_system:account', level: 'contribute' }],
    ['a visible account field above read', { streamId: ':_system:language', level: 'contribute' }],
    ['a visible account field above read, store-prefixed', { streamId: ':account::_system:language', level: 'manage' }],
  ]) {
    it('[CMCAS1] ' + label + ' is refused and no data-grant is stored (' + permission.streamId + ')', async function () {
      const { trigger } = await offerAndAccept([{ streamId: 'fertility', level: 'read' }, permission]);
      assert.strictEqual(trigger.content.status, 'failed', JSON.stringify(trigger.content));
      assert.strictEqual(trigger.content.failure?.reason, 'cmc-offer-invalid-permissions', JSON.stringify(trigger.content));
      assert.deepStrictEqual(await grantsOf(trigger), []);
    });
  }

  it('[CMCAS2] read on a visible account field is granted', async function () {
    const { trigger } = await offerAndAccept([{ streamId: ':_system:language', level: 'read' }]);
    assert.strictEqual(trigger.content.status, 'completed', JSON.stringify(trigger.content));
    const grants = await grantsOf(trigger);
    assert.strictEqual(grants.length, 1);
    assert.ok(grants[0].permissions.some((p) => p.streamId === ':_system:language' && p.level === 'read'), JSON.stringify(grants[0].permissions));
  });
});
