/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The OAuth2 consent poll must key on the trigger's TERMINAL status, never on
 * the transient data-grant that handleAccept creates before delivering the
 * accept and rolls back on a peer refusal. These tests drive the extracted
 * poll directly with an injected clock, so the ordering is proven without any
 * wall-clock timing or CPU-load dependency.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { awaitConsentOutcome, buildConsentRejectionError } = require('../../../src/routes/consentPoll.ts');

// A clock whose only advance is each awaited sleep; keeps the loop deterministic.
function fakeClock (stepMs) {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => { t += stepMs; },
  };
}

describe('[CPOLL] OAuth2 consent poll is outcome-driven', function () {
  it('[CPOLL1] never returns a transient data-grant when the trigger then FAILS', async function () {
    // The race scenario: the data-grant IS resolvable (handleAccept created it
    // before delivery), but the trigger goes to `failed` (peer refused). The
    // pre-fix logic checked the grant first and would return it; the fixed poll
    // must throw the typed rejection and never even resolve the grant.
    const triggers = [
      { /* in-flight: no status */ },
      { status: 'failed', failure: { reason: 'cmc-handler-delivery-rejected', detail: { body: { error: { data: { id: 'cmc-capability-invalidated' } } } } } },
    ];
    let resolveCalls = 0;
    const clock = fakeClock(100);
    let thrown = null;
    try {
      await awaitConsentOutcome({
        getTrigger: async () => triggers.shift() ?? {},
        resolveDataGrant: async () => { resolveCalls++; return { id: 'transient-grant' }; },
        deadlineMs: 10_000,
        sleepMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'must throw when the trigger fails');
    assert.strictEqual(thrown.code, 'cmc-accept-rejected');
    assert.strictEqual(thrown.cmcErrorId, 'cmc-capability-invalidated');
    assert.strictEqual(resolveCalls, 0, 'the data-grant must never be resolved on a failed trigger');
  });

  it('[CPOLL2] resolves the data-grant only once the trigger is COMPLETED', async function () {
    const triggers = [
      { /* in-flight */ },
      { status: 'completed', dataGrantAccessId: 'dg-1' },
    ];
    const clock = fakeClock(100);
    const grant = await awaitConsentOutcome({
      getTrigger: async () => triggers.shift() ?? {},
      resolveDataGrant: async (t) => {
        assert.strictEqual(t.status, 'completed', 'resolve only on completed');
        return t.dataGrantAccessId === 'dg-1' ? { id: 'dg-1' } : null;
      },
      deadlineMs: 10_000,
      sleepMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.deepStrictEqual(grant, { id: 'dg-1' });
  });

  it('[CPOLL3] throws a descriptive timeout when the trigger never reaches a terminal status', async function () {
    const clock = fakeClock(100);
    let thrown = null;
    try {
      await awaitConsentOutcome({
        getTrigger: async () => ({ /* forever in-flight */ }),
        resolveDataGrant: async () => { throw new Error('must not resolve while non-terminal'); },
        deadlineMs: 100,
        sleepMs: 100,
        now: clock.now,
        sleep: clock.sleep,
        describe: 'acceptEventId=evt-1',
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'must throw on deadline');
    assert.match(thrown.message, /timed out waiting for the consent outcome/);
    assert.match(thrown.message, /acceptEventId=evt-1/);
  });

  it('[CPOLL4] throws when the trigger is COMPLETED but the grant cannot be found (inconsistency, not a wait)', async function () {
    const clock = fakeClock(100);
    let thrown = null;
    try {
      await awaitConsentOutcome({
        getTrigger: async () => ({ status: 'completed', dataGrantAccessId: 'dg-x' }),
        resolveDataGrant: async () => null,
        deadlineMs: 10_000,
        sleepMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'must throw on completed-but-missing grant');
    assert.match(thrown.message, /completed but no data-grant was found/);
  });

  it('[CPOLL6] a capability refusal reported as the reason maps to cmc-accept-rejected with that id', function () {
    const e = buildConsentRejectionError({
      reason: 'cmc-capability-invalidated',
      detail: { body: { error: { id: 'invalid-operation', data: { id: 'cmc-capability-invalidated' } } } },
    });
    assert.strictEqual(e.code, 'cmc-accept-rejected');
    assert.strictEqual(e.cmcErrorId, 'cmc-capability-invalidated');
  });

  it('[CPOLL5] a non-delivery-rejected failure stays a generic error (maps to 500, not 400)', function () {
    const generic = buildConsentRejectionError({ reason: 'cmc-delivery-timeout' });
    assert.strictEqual(generic.code, undefined, 'generic failures carry no cmc-accept-rejected code');
    assert.match(generic.message, /consent accept failed: cmc-delivery-timeout/);
  });
});
