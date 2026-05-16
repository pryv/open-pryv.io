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
});
