/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { lastActivityOf, activityOf, getActivity, getLastActivity, ACTIVITY_CLOCK_SKEW_SECONDS } = require('../../src/accesses/accountActivity.ts');

// The operator setting that also counts app accesses as use.
const APPS = { countApps: true };

describe('[ACAC] account activity', function () {
  it('[ACAC1] is the latest lastUsed among personal accesses; app accesses count only when asked', function () {
    const accesses = [
      { type: 'personal', lastUsed: 100 },
      { type: 'app', lastUsed: 300 },
      { type: 'personal', lastUsed: 200 }
    ];
    assert.equal(lastActivityOf(accesses), 200, 'an app is not the holder using the account');
    assert.equal(lastActivityOf(accesses, undefined, APPS), 300);
  });

  it('[ACAC2] ignores shared accesses, however recent, apps counted or not', function () {
    const accesses = [
      { type: 'personal', lastUsed: 100 },
      { type: 'shared', lastUsed: 900 }
    ];
    assert.equal(lastActivityOf(accesses), 100);
    assert.equal(lastActivityOf(accesses, undefined, APPS), 100);
  });

  it('[ACAC3] is null when no counted access was ever used', function () {
    assert.equal(lastActivityOf([]), null);
    assert.equal(lastActivityOf([{ type: 'shared', lastUsed: 900 }]), null);
    assert.equal(lastActivityOf([{ type: 'app' }, { type: 'personal', lastUsed: null }]), null);
    assert.equal(lastActivityOf([{ type: 'app', lastUsed: 900 }]), null, 'only an app was used');
  });

  it('[ACAC4] skips malformed values and rows', function () {
    assert.equal(lastActivityOf([null, { type: 'personal', lastUsed: NaN }, { type: 'personal', lastUsed: '500' }, { type: 'personal', lastUsed: 50 }]), 50);
    assert.equal(lastActivityOf([null, { type: 'app', lastUsed: NaN }, { type: 'app', lastUsed: '500' }, { type: 'app', lastUsed: 50 }], undefined, APPS), 50);
  });

  it('[ACAC5] reads the user\'s accesses through the repository', async function () {
    const seen = [];
    const repo = {
      find (user, query, options, cb) {
        seen.push(user.id);
        cb(null, [{ type: 'personal', lastUsed: 42 }, { type: 'app', lastUsed: 70 }, { type: 'shared', lastUsed: 99 }]);
      }
    };
    assert.equal(await getLastActivity(repo, { id: 'u1' }), 42);
    assert.equal(await getLastActivity(repo, { id: 'u1' }, undefined, APPS), 70);
    assert.deepEqual(seen, ['u1', 'u1']);
  });

  it('[ACAC6] rejects with the repository error', async function () {
    const repo = { find (user, query, options, cb) { cb(new Error('boom')); } };
    await assert.rejects(getLastActivity(repo, { id: 'u1' }), /boom/);
  });

  it('[ACAC7] counts a delegate\'s own token and reports it as by delegate; an app a delegate granted is app use', function () {
    const accesses = [
      { type: 'personal', lastUsed: 100 },
      { type: 'app', lastUsed: 150 },
      { type: 'personal', lastUsed: 400, clientData: { delegation: { kind: 'delegate-pat' } } },
      { type: 'app', lastUsed: 500, clientData: { delegation: { kind: 'delegated-child' } } }
    ];
    assert.deepEqual(activityOf(accesses), { at: 400, by: 'delegate', personal: 100, app: 500, delegate: 400 });
    assert.deepEqual(activityOf(accesses, undefined, APPS), { at: 500, by: 'delegate', personal: 100, app: 500, delegate: 400 },
      'counted, the delegate-granted app is the delegate using the account');
  });

  it('[ACAC8] reports by owner when the holder used the account last', function () {
    assert.deepEqual(activityOf([
      { type: 'personal', lastUsed: 500 },
      { type: 'personal', lastUsed: 400, clientData: { delegation: { kind: 'delegate-pat' } } }
    ]), { at: 500, by: 'owner', personal: 500, app: null, delegate: 400 });
  });

  it('[ACAC9] ignores delegation marker accesses (shared); an app with another marker kind is the holder\'s app', function () {
    const accesses = [
      { type: 'shared', lastUsed: 900, clientData: { delegation: { kind: 'control' } } },
      { type: 'shared', lastUsed: 800, clientData: { delegation: { kind: 'delegated-child' } } },
      { type: 'app', lastUsed: 200, clientData: { delegation: { kind: 'notify' } } }
    ];
    assert.deepEqual(activityOf(accesses), { at: null, by: null, personal: null, app: 200, delegate: null });
    assert.deepEqual(activityOf(accesses, undefined, APPS), { at: 200, by: 'owner', personal: null, app: 200, delegate: null });
    assert.deepEqual(activityOf([]), { at: null, by: null, personal: null, app: null, delegate: null });
  });

  it('[ACAC10] getActivity returns the breakdown, app use reported even when not counted', async function () {
    const repo = { find (user, query, options, cb) { cb(null, [{ type: 'app', lastUsed: 42 }]); } };
    assert.deepEqual(await getActivity(repo, { id: 'u1' }), { at: null, by: null, personal: null, app: 42, delegate: null });
    assert.deepEqual(await getActivity(repo, { id: 'u1' }, undefined, APPS), { at: 42, by: 'owner', personal: null, app: 42, delegate: null });
  });

  it('[ACAC11] a use time later than now, past the clock-skew allowance, is not use', function () {
    const now = 1_000_000;
    const skew = ACTIVITY_CLOCK_SKEW_SECONDS;
    assert.deepEqual(activityOf([
      { type: 'personal', lastUsed: now - 10 },
      { type: 'app', lastUsed: now + skew + 1 },
      { type: 'personal', lastUsed: now + skew + 1, clientData: { delegation: { kind: 'delegate-pat' } } }
    ], now, APPS), { at: now - 10, by: 'owner', personal: now - 10, app: null, delegate: null });
    assert.equal(lastActivityOf([{ type: 'personal', lastUsed: now + skew }], now), now + skew, 'within the allowance it counts');
    assert.equal(lastActivityOf([{ type: 'personal', lastUsed: 4102444800 }]), null, 'against the real clock by default');
    const repo = { find (user, query, options, cb) { cb(null, [{ type: 'personal', lastUsed: now + 2 * skew }]); } };
    return Promise.all([
      getLastActivity(repo, { id: 'u1' }, now).then((at) => assert.equal(at, null)),
      getLastActivity(repo, { id: 'u1' }, now + skew).then((at) => assert.equal(at, now + 2 * skew))
    ]);
  });
});
