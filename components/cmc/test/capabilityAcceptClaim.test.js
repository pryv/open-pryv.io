/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The responses-stream write-hook claims a single-use link for the accept it
 * lets through: the link only turns `consumed` once that accept is handled, so
 * without the claim two accepts arriving together both read `open` and both
 * open a relationship.
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

// create-if-absent in the name of an accepter, answered after a turn of the
// event loop like the real store (same rule as cmcAcceptClaim.ts)
function casClaims () {
  const held = new Map();
  const calls = [];
  async function claimAccept (userId, capabilityId, accepter) {
    calls.push([userId, capabilityId, accepter]);
    await new Promise((resolve) => setImmediate(resolve));
    const key = userId + '/' + capabilityId;
    if (!held.has(key)) { held.set(key, accepter); return true; }
    return accepter !== '' && held.get(key) === accepter;
  }
  return { claimAccept, calls };
}

const BOB = { username: 'bob', host: 'b.example' };
const CAROL = { username: 'carol', host: 'c.example' };

function ctxFor ({ type = 'consent/accept-cmc', mode = 'single-use', state = 'open', capabilityId = 'capA', userId = 'alice', from = BOB } = {}) {
  return {
    newEvent: { streamIds: [':_cmc:_internal:responses:' + capabilityId], type, content: { from } },
    user: { id: userId },
    access: { clientData: { cmc: { kind: 'capability', capabilityId, capability: { state, mode } } } },
  };
}

function run (hook, ctx) {
  return new Promise((resolve) => hook(ctx, {}, {}, (err) => resolve(err)));
}

describe('[CMCCLM] single-use accept claim in the responses-stream write-hook', () => {
  it('[CLM01] two accepters at once on a single-use link: one passes, the other is refused as consumed', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    const results = await Promise.all([run(hook, ctxFor({ from: BOB })), run(hook, ctxFor({ from: CAROL }))]);
    const passed = results.filter((err) => err == null);
    const refused = results.filter((err) => err != null);
    assert.equal(passed.length, 1, 'exactly one accept passes');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].id, 'cmc-capability-consumed');
  });

  it('[CLM02] the claim is per capability and per account', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    const results = await Promise.all([
      run(hook, ctxFor({ capabilityId: 'capB' })),
      run(hook, ctxFor({ capabilityId: 'capC' })),
      run(hook, ctxFor({ capabilityId: 'capB', userId: 'carol' }))
    ]);
    assert.deepEqual(results, [undefined, undefined, undefined]);
  });

  it('[CLM03] an open-link accept is not claimed', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    const results = await Promise.all([run(hook, ctxFor({ mode: 'open-link' })), run(hook, ctxFor({ mode: 'open-link' }))]);
    assert.deepEqual(results, [undefined, undefined]);
    assert.equal(claims.calls.length, 0);
  });

  it('[CLM04] a refusal is not claimed and does not block the accept', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    assert.equal(await run(hook, ctxFor({ type: 'consent/refuse-cmc' })), undefined);
    assert.equal(claims.calls.length, 0);
    assert.equal(await run(hook, ctxFor()), undefined);
  });

  it('[CLM05] a link without a mode (minted before modes) is single-use and claimed', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    const results = await Promise.all([run(hook, ctxFor({ mode: undefined })), run(hook, ctxFor({ mode: undefined, from: CAROL }))]);
    assert.equal(results.filter((err) => err == null).length, 1);
  });

  it('[CLM08] the accepter holding the claim passes again (a re-delivery); accepts naming no accepter never share it', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    assert.equal(await run(hook, ctxFor({ from: BOB })), undefined);
    assert.equal(await run(hook, ctxFor({ from: { username: 'BOB', host: 'B.example' } })), undefined, 'same accepter, other case');
    assert.equal((await run(hook, ctxFor({ from: CAROL })))?.id, 'cmc-capability-consumed');
    const anonymous = await Promise.all([run(hook, ctxFor({ capabilityId: 'capN', from: null })), run(hook, ctxFor({ capabilityId: 'capN', from: null }))]);
    assert.equal(anonymous.filter((err) => err == null).length, 1);
    assert.deepEqual(claims.calls.find((c) => c[1] === 'capN').slice(2), ['']);
  });

  it('[CLM06] a claim store that fails lets the accept through', async () => {
    const hook = createCapabilityResponseHook({
      errors: fakeErrors(),
      claimAccept: async () => { throw new Error('store down'); },
      logger: { warn () {} }
    });
    assert.equal(await run(hook, ctxFor()), undefined);
  });

  it('[CLM07] a consumed link is refused before any claim is taken', async () => {
    const claims = casClaims();
    const hook = createCapabilityResponseHook({ errors: fakeErrors(), claimAccept: claims.claimAccept });
    const err = await run(hook, ctxFor({ state: 'consumed' }));
    assert.equal(err.id, 'cmc-capability-consumed');
    assert.equal(claims.calls.length, 0);
  });
});
