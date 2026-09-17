/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — capabilityResponseHook tests.
 *
 * [CMCCRH] covers the gate on writes to :_cmc:_internal:responses:<capId>.
 * The hook rejects events.create when the capability access's
 * clientData.cmc.capability.state is 'consumed' or 'invalidated'.
 * Open state and absence of the capability marker (legacy) pass through.
 * On an open-link capability, a subject who still holds a live relationship
 * through it is refused (cmc-capability-already-accepted-by-you).
 */

const assert = require('node:assert/strict');
const { createCapabilityResponseHook } = require('../src/capabilityResponseHook.ts');

function fakeErrors () {
  return {
    invalidOperation (message, details) {
      const err = new Error(message);
      err.id = details?.id;
      err.data = details;
      return err;
    },
  };
}

function makeCtx (opts) {
  const access = opts.access || {};
  return {
    newEvent: opts.event || null,
    access,
  };
}

describe('[CMCCRH] cmcCapabilityResponseHook', () => {
  const hook = createCapabilityResponseHook({ errors: fakeErrors() });

  it('[CRH01] passes through writes that are not on a :_cmc:_internal:responses:* stream', (done) => {
    const ctx = makeCtx({
      event: { streamIds: [':_cmc:apps:my-app'], type: 'consent/accept-cmc' },
      access: { clientData: { cmc: { capability: { state: 'consumed' } } } },
    });
    hook(ctx, {}, {}, (err) => {
      assert.equal(err, undefined);
      done();
    });
  });

  it('[CRH02] passes through when the access has no capability marker (legacy mint, pre-lifecycle)', (done) => {
    const ctx = makeCtx({
      event: { streamIds: [':_cmc:_internal:responses:cap1'], type: 'consent/accept-cmc' },
      access: { clientData: { cmc: { kind: 'capability', capabilityId: 'cap1', singleUse: true } } },
    });
    hook(ctx, {}, {}, (err) => {
      assert.equal(err, undefined);
      done();
    });
  });

  it('[CRH03] passes through when state is "open"', (done) => {
    const ctx = makeCtx({
      event: { streamIds: [':_cmc:_internal:responses:cap2'], type: 'consent/accept-cmc' },
      access: { clientData: { cmc: { capability: { state: 'open', mode: 'single-use' } } } },
    });
    hook(ctx, {}, {}, (err) => {
      assert.equal(err, undefined);
      done();
    });
  });

  it('[CRH04] rejects with cmc-capability-consumed when state is "consumed"', (done) => {
    const ctx = makeCtx({
      event: { streamIds: [':_cmc:_internal:responses:cap3'], type: 'consent/accept-cmc' },
      access: { clientData: { cmc: { capability: { state: 'consumed', stateChangedAt: 9000 } } } },
    });
    hook(ctx, {}, {}, (err) => {
      assert.ok(err != null);
      assert.equal(err.id, 'cmc-capability-consumed');
      assert.equal(err.data.stateChangedAt, 9000);
      done();
    });
  });

  it('[CRH05] rejects with cmc-capability-invalidated when state is "invalidated"', (done) => {
    const ctx = makeCtx({
      event: { streamIds: [':_cmc:_internal:responses:cap4'], type: 'consent/accept-cmc' },
      access: { clientData: { cmc: { capability: { state: 'invalidated', stateChangedAt: 9000 } } } },
    });
    hook(ctx, {}, {}, (err) => {
      assert.ok(err != null);
      assert.equal(err.id, 'cmc-capability-invalidated');
      assert.equal(err.data.stateChangedAt, 9000);
      done();
    });
  });

  it('[CRH06] passes through when no newEvent on context (defensive — hook ordering)', (done) => {
    const ctx = makeCtx({});
    hook(ctx, {}, {}, (err) => {
      assert.equal(err, undefined);
      done();
    });
  });

  // ---- open-link re-click: decided from the live relationship accesses ----
  function openLinkCtx (from, extraCmc = {}) {
    return {
      newEvent: {
        streamIds: [':_cmc:_internal:responses:cap-ol'],
        type: 'consent/accept-cmc',
        content: { from },
      },
      user: { id: 'u1' },
      access: {
        clientData: {
          cmc: { kind: 'capability', capabilityId: 'cap-ol', capability: { state: 'open', mode: 'open-link' }, ...extraCmc },
        },
      },
    };
  }
  function mallWith (accesses) {
    return { accesses: { async get () { return accesses; } } };
  }
  function relationship (capabilityId, counterparty, created) {
    return { id: 'rel-' + counterparty.username, created, clientData: { cmc: { role: 'counterparty', capabilityId, counterparty } } };
  }

  it('[CRH07] open-link with no live relationship for the subject proceeds', async () => {
    const hookWithMall = createCapabilityResponseHook({
      errors: fakeErrors(),
      mall: mallWith([relationship('cap-ol', { username: 'bob', host: 'example.com' }, 1234)]),
    });
    const err = await new Promise((resolve) => hookWithMall(openLinkCtx({ username: 'alice', host: 'pryv.me' }), {}, {}, resolve));
    assert.equal(err, undefined);
  });

  it('[CRH08] open-link with a live relationship (other spelling) rejects already-accepted-by-you with its created time', async () => {
    const hookWithMall = createCapabilityResponseHook({
      errors: fakeErrors(),
      mall: mallWith([relationship('cap-ol', { username: 'alice', host: 'pryv.me' }, 5555)]),
    });
    const err = await new Promise((resolve) => hookWithMall(openLinkCtx({ username: 'Alice', host: 'PRYV.me' }), {}, {}, resolve));
    assert.ok(err != null);
    assert.equal(err.id, 'cmc-capability-already-accepted-by-you');
    assert.equal(err.data.acceptedAt, 5555);
  });

  it('[CRH09] a legacy acceptedBy array naming the subject, without a live relationship, is ignored', async () => {
    const hookWithMall = createCapabilityResponseHook({ errors: fakeErrors(), mall: mallWith([]) });
    const ctx = openLinkCtx({ username: 'alice', host: 'pryv.me' });
    ctx.access.clientData.cmc.capability.acceptedBy = [{ username: 'alice', host: 'pryv.me', acceptedAt: 1 }];
    const err = await new Promise((resolve) => hookWithMall(ctx, {}, {}, resolve));
    assert.equal(err, undefined);
  });

  it('[CRH10] without a mall dep the open-link check is skipped', async () => {
    const err = await new Promise((resolve) => hook(openLinkCtx({ username: 'alice', host: 'pryv.me' }), {}, {}, resolve));
    assert.equal(err, undefined);
  });

  it('[CRH11] a live relationship through ANOTHER capability does not block', async () => {
    const hookWithMall = createCapabilityResponseHook({
      errors: fakeErrors(),
      mall: mallWith([relationship('cap-other', { username: 'alice', host: 'pryv.me' }, 5555)]),
    });
    const err = await new Promise((resolve) => hookWithMall(openLinkCtx({ username: 'alice', host: 'pryv.me' }), {}, {}, resolve));
    assert.equal(err, undefined);
  });

  it('[CRH12] a failing lookup lets the accept through', async () => {
    const hookWithMall = createCapabilityResponseHook({
      errors: fakeErrors(),
      mall: { accesses: { async get () { throw new Error('storage down'); } } },
    });
    const err = await new Promise((resolve) => hookWithMall(openLinkCtx({ username: 'alice', host: 'pryv.me' }), {}, {}, resolve));
    assert.equal(err, undefined);
  });
});
