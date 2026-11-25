/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC accept: an offer that requires a verified email.
 *
 * [CMCVE] covers: an offer with `request.requireVerifiedEmail: true` cannot be
 * accepted while the accepting account's primary address is not proved
 * (trigger `failed`, reason `cmc-verified-email-required`, nothing granted and
 * nothing sent to the requester), the link stays usable and a new accept
 * completes once the address is proved, and the address that counts is the one
 * of the account the accept is written on.
 *
 * The verification token is mailed and the mail transport is disabled in the
 * test config, so the plaintext token comes from the business layer
 * (`operations.addEmails`, as in the email verification tests).
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { buildFetchShim } = require('./cmc-fetch-shim.cjs');
const operations = require('business/src/emails/operations.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const errors = require('errors').factory;

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;
const TRUSTED_APP = 'pryv-test-no-cors';
const EMAIL = ':system:email';
const SCOPE = ':_cmc:apps:my-app';
const PERMISSIONS = [{ streamId: 'fertility', level: 'read' }, { streamId: EMAIL, level: 'read' }];

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe('[CMCVE] cmc accept: offer requiring a verified email', function () {
  this.timeout(90_000);

  let alice, originalFetch, fixtures;

  before(async function () {
    await initTests();
    await initCore();
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.coreServer);
    fixtures = getNewFixture();
    alice = await makeActor('a');
  });

  after(async function () {
    if (originalFetch != null) globalThis.fetch = originalFetch;
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function makeActor (label) {
    const username = 'cmcve' + label + cuid().toLowerCase().slice(-8);
    const token = cuid();
    const email = cuid() + '@cmcve.example.com';
    const u = await fixtures.user(username, { email });
    await u.access({ token, type: 'personal' });
    await u.session(token);
    const userId = await (await getUsersRepository()).getUserIdForUsername(username);
    const path = '/' + username;
    const res = await coreRequest.post(path + '/streams').set('Authorization', token)
      .send({ id: SCOPE, parentId: ':_cmc:apps', name: 'My App' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { username, token, email, userId, path };
  }

  // Add an address, follow the mailed link, make it the primary.
  async function proveNewPrimary (actor) {
    const ctx = { userId: actor.userId, username: actor.username, user: null, accessId: 'system', legacyEmail: actor.email };
    const address = cuid() + '@cmcve-proved.example.com';
    const [minted] = await operations.addEmails({ errors, usersRepository: await getUsersRepository() }, ctx, [address]);
    const verify = await coreRequest.post(actor.path + '/account/verify-email')
      .set('Origin', 'http://test.pryv.local').send({ appId: TRUSTED_APP, token: minted.token });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
    await setPrimary(actor, address);
    return address;
  }

  async function setPrimary (actor, address) {
    const res = await coreRequest.put(actor.path + '/account').set('Authorization', actor.token)
      .send({ emails: { setPrimary: address } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  async function postOffer (request = {}) {
    const scope = SCOPE + ':cmcve-' + cuid().slice(-8);
    const str = await coreRequest.post(alice.path + '/streams').set('Authorization', alice.token)
      .send({ id: scope, parentId: SCOPE, name: scope });
    assert.strictEqual(str.status, 201, JSON.stringify(str.body));
    return await coreRequest.post(alice.path + '/events').set('Authorization', alice.token).send({
      streamIds: [scope],
      type: 'consent/request-cmc',
      content: {
        to: null,
        capabilityRequested: true,
        request: {
          title: { en: 'CMCVE' },
          description: { en: 'd' },
          consent: { en: 'I consent.' },
          permissions: PERMISSIONS,
          requireVerifiedEmail: true,
          ...request,
        },
        requesterMeta: { username: alice.username, appId: 'my-app' },
      },
    });
  }

  async function offer (request) {
    const res = await postOffer(request);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }

  // Accept on `actor`'s account; returns the settled trigger.
  async function accept (actor, capabilityUrl, token = actor.token) {
    const res = await coreRequest.post(actor.path + '/events').set('Authorization', token).send({
      streamIds: [SCOPE],
      type: 'consent/accept-cmc',
      content: { capabilityUrl, accessName: 'cmcve-grant-' + cuid().slice(-8) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const got = await coreRequest.get(actor.path + '/events/' + res.body.event.id).set('Authorization', actor.token);
      const content = got.body?.event?.content ?? {};
      if (content.status === 'completed' || content.status === 'failed') return got.body.event;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('accept did not settle: ' + res.body.event.id);
  }

  async function grantsOf (actor, trigger) {
    const res = await coreRequest.get(actor.path + '/accesses').set('Authorization', actor.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return (res.body.accesses || []).filter((a) => a.clientData?.cmc?.acceptEventId === trigger.id);
  }

  async function inboxCount () {
    const res = await coreRequest.get(alice.path + '/events').set('Authorization', alice.token)
      .query({ streams: JSON.stringify([':_cmc:inbox']), limit: 1000 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events.length;
  }

  function assertRefused (trigger) {
    assert.strictEqual(trigger.content.status, 'failed', JSON.stringify(trigger.content));
    assert.strictEqual(trigger.content.failure?.reason, 'cmc-verified-email-required', JSON.stringify(trigger.content));
    assert.ok(trigger.content.failure.detail == null, 'no detail: ' + JSON.stringify(trigger.content.failure));
  }

  function assertCompleted (trigger) {
    assert.strictEqual(trigger.content.status, 'completed', JSON.stringify(trigger.content));
  }

  it('[RVED] an unproved account is refused and the requester learns nothing; proved, a new accept on the same link completes', async function () {
    const bob = await makeActor('b');
    const event = await offer();
    assert.strictEqual(event.content.request.requireVerifiedEmail, true, 'the field is stored as sent');
    const before = await inboxCount();

    const refused = await accept(bob, event.content.capabilityUrl);
    assertRefused(refused);
    assert.deepStrictEqual(await grantsOf(bob, refused), []);
    assert.strictEqual(await inboxCount(), before);

    await proveNewPrimary(bob);
    const accepted = await accept(bob, event.content.capabilityUrl);
    assertCompleted(accepted);
    assert.strictEqual((await grantsOf(bob, accepted)).length, 1);
    // the first trigger stays a record of the refusal: nothing completes it later
    assertRefused((await coreRequest.get(bob.path + '/events/' + refused.id).set('Authorization', bob.token)).body.event);
  });

  it('[RVEE] a primary changed back to an unproved address: the next accept is refused', async function () {
    const bob = await makeActor('b');
    await proveNewPrimary(bob);
    assertCompleted(await accept(bob, (await offer()).content.capabilityUrl));
    // the founding address: usable as primary, never proved
    await setPrimary(bob, bob.email);
    assertRefused(await accept(bob, (await offer()).content.capabilityUrl));
  });

  it('[RVEJ] after the accept, the grant reads the address and its proof', async function () {
    const bob = await makeActor('b');
    const address = await proveNewPrimary(bob);
    const trigger = await accept(bob, (await offer()).content.capabilityUrl);
    assertCompleted(trigger);
    const [grant] = await grantsOf(bob, trigger);
    const res = await coreRequest.get(bob.path + '/events').set('Authorization', grant.token)
      .query({ streams: JSON.stringify([EMAIL]), types: ['email/string', 'verification/email'] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const byType = Object.fromEntries(res.body.events.map((e) => [e.type, e.content]));
    assert.strictEqual(byType['email/string'], address);
    assert.strictEqual(byType['verification/email'].verified, true, JSON.stringify(byType));
  });

  it('[RVEH] updating the request event does not change the offer the link carries', async function () {
    const bob = await makeActor('b');
    const event = await offer();
    const { requireVerifiedEmail, ...request } = event.content.request;
    assert.strictEqual(requireVerifiedEmail, true);
    const upd = await coreRequest.put(alice.path + '/events/' + event.id).set('Authorization', alice.token)
      .send({ content: { ...event.content, request } });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    assert.strictEqual(upd.body.event.content.request.requireVerifiedEmail, undefined);
    assertRefused(await accept(bob, event.content.capabilityUrl));
  });

  it('[RVEQ] an offer that breaks the rule is refused when written; false is an ordinary offer', async function () {
    const bad = await postOffer({ permissions: [{ streamId: 'fertility', level: 'read' }] });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.ok(JSON.stringify(bad.body).includes('requireVerifiedEmail'), JSON.stringify(bad.body));

    const bob = await makeActor('b');
    const plain = await offer({ requireVerifiedEmail: false });
    assertCompleted(await accept(bob, plain.content.capabilityUrl));
  });

  it('[RVEF] accepting with a delegate token: the managed account\'s address counts, and the delegate may prove it', async function () {
    const child = await makeActor('c');
    const parent = await makeActor('p');
    await proveNewPrimary(parent);
    const req = await coreRequest.post(child.path + '/delegations/attach-request')
      .set('Authorization', child.token).send({ delegateUsername: parent.username });
    assert.strictEqual(req.status, 201, JSON.stringify(req.body));
    const acc = await coreRequest.post(parent.path + '/delegations/controlled/' + child.username + '/accept')
      .set('Authorization', parent.token).send({});
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
    const tok = await coreRequest.post(parent.path + '/delegations/controlled/' + child.username + '/token')
      .set('Authorization', parent.token).send({});
    assert.strictEqual(tok.status, 200, JSON.stringify(tok.body));
    const delegateToken = tok.body.token;

    // on the managed account: the delegate's own proved address does not help
    const event = await offer();
    assertRefused(await accept(child, event.content.capabilityUrl, delegateToken));
    // on the delegate's own account (an invite answered "for self"): it counts
    assertCompleted(await accept(parent, (await offer()).content.capabilityUrl));

    // the delegate adds an address to the managed account and asks for its mail
    const address = cuid() + '@cmcve-child.example.com';
    const add = await coreRequest.put(child.path + '/account').set('Authorization', delegateToken)
      .send({ emails: { add: [address] } });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const entry = add.body.account.emails.find((e) => e.value === address);
    assert.strictEqual(entry.status, 'pending', JSON.stringify(entry));

    await proveNewPrimary(child);
    assertCompleted(await accept(child, event.content.capabilityUrl, delegateToken));
  });
});
