/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Unit tests for IntegrityCheck.checkUser coverage reporting.
 *
 * A verification that ran zero checks (integrity inactive, or a store that
 * cannot be read) must be reported as NOT verified, distinct from a run that
 * verified everything clean. The seam: construct IntegrityCheck WITHOUT init()
 * and inject the `integrity` / `storageLayer` fields directly (both are plain
 * public fields; checkUser never touches the logger). No config, no real DB.
 */

const assert = require('node:assert/strict');

const IntegrityCheck = require('../../src/integrity/IntegrityCheck.ts').default;

const GOOD = 'sha256-good';
const BAD = 'sha256-bad';

/** integrity singleton stub. compute() always returns GOOD, so a stored item
 *  with integrity === GOOD is "clean" and one with BAD is a "mismatch". */
function makeIntegrity (eventsActive, accessesActive) {
  return {
    events: { isActive: eventsActive, compute: () => ({ integrity: GOOD }) },
    accesses: { isActive: accessesActive, compute: () => ({ integrity: GOOD }) }
  };
}

/** callback-style export store, or the sentinel to model an absent store. */
const ABSENT = Symbol('absent-store');
function makeStorage (events, accesses) {
  const layer = {};
  if (events !== ABSENT) {
    layer.events = { exportAll: (user, cb) => cb(null, events) };
  }
  // accesses is not optional in StorageLayer; always present.
  layer.accesses = { exportAll: (user, cb) => cb(null, accesses) };
  return layer;
}

function makeChecker (integrity, storageLayer) {
  const checker = new IntegrityCheck();
  checker.integrity = integrity;
  checker.storageLayer = storageLayer;
  return checker;
}

describe('IntegrityCheck.checkUser — coverage reporting', function () {
  it('[IVR1] integrity inactive is NOT verified, even with data present', async function () {
    // pins the false-positive: nothing checked must not read as verified/OK-earning.
    const checker = makeChecker(
      makeIntegrity(false, false),
      makeStorage([{ id: 'e1', integrity: GOOD }], [{ id: 'a1', integrity: GOOD }])
    );
    const r = await checker.checkUser('u1');
    assert.equal(r.events.status, 'inactive');
    assert.equal(r.accesses.status, 'inactive');
    assert.equal(r.events.checked, 0);
    assert.equal(r.accesses.checked, 0);
    assert.equal(r.ok, true); // no errors were found...
    assert.equal(r.verified, false); // ...but nothing was actually verified.
  });

  it('[IVR2] a store that cannot be read is "unavailable", not verified', async function () {
    // events store absent entirely
    const absent = makeChecker(
      makeIntegrity(true, false),
      makeStorage(ABSENT, [])
    );
    const ra = await absent.checkUser('u1');
    assert.equal(ra.events.status, 'unavailable');
    assert.equal(ra.verified, false);

    // events store present but exportAll yields null
    const nullExport = makeChecker(
      makeIntegrity(true, false),
      makeStorage(null, [])
    );
    const rn = await nullExport.checkUser('u1');
    assert.equal(rn.events.status, 'unavailable');
    assert.equal(rn.verified, false);

    // events store present but exportAll is not callable
    const notFn = makeChecker(
      makeIntegrity(true, false),
      { events: { exportAll: null }, accesses: { exportAll: (u, cb) => cb(null, []) } }
    );
    const rf = await notFn.checkUser('u1');
    assert.equal(rf.events.status, 'unavailable');
    assert.equal(rf.verified, false);

    // accesses side: active but export yields null
    const accNull = makeChecker(
      makeIntegrity(false, true),
      makeStorage(ABSENT, null)
    );
    const rac = await accNull.checkUser('u1');
    assert.equal(rac.accesses.status, 'unavailable');
    assert.equal(rac.verified, false);
  });

  it('[IVR3] both stores active and clean is verified and OK', async function () {
    const checker = makeChecker(
      makeIntegrity(true, true),
      makeStorage(
        [{ id: 'e1', integrity: GOOD }, { id: 'e2', integrity: GOOD }],
        [{ id: 'a1', integrity: GOOD }]
      )
    );
    const r = await checker.checkUser('u1');
    assert.equal(r.events.status, 'checked');
    assert.equal(r.accesses.status, 'checked');
    assert.equal(r.events.checked, 2);
    assert.equal(r.accesses.checked, 1);
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
  });

  it('[IVR4] a mismatch is verified-but-failed (verified and ok are orthogonal)', async function () {
    const checker = makeChecker(
      makeIntegrity(true, true),
      makeStorage([], [{ id: 'a1', integrity: BAD }])
    );
    const r = await checker.checkUser('u1');
    assert.equal(r.accesses.status, 'checked');
    assert.equal(r.accesses.errors.length, 1);
    assert.equal(r.accesses.errors[0].error, 'integrity mismatch');
    assert.equal(r.ok, false);
    assert.equal(r.verified, true);
  });

  it('[IVR5] mixed (events checked clean, accesses inactive) is NOT verified', async function () {
    const checker = makeChecker(
      makeIntegrity(true, false),
      makeStorage([{ id: 'e1', integrity: GOOD }], [])
    );
    const r = await checker.checkUser('u1');
    assert.equal(r.events.status, 'checked');
    assert.equal(r.accesses.status, 'inactive');
    assert.equal(r.ok, true);
    assert.equal(r.verified, false);
  });

  it('[IVR6] zero items is still "checked" (nothing to check is not "not verified")', async function () {
    const checker = makeChecker(
      makeIntegrity(true, true),
      makeStorage([], [])
    );
    const r = await checker.checkUser('u1');
    assert.equal(r.events.status, 'checked');
    assert.equal(r.accesses.status, 'checked');
    assert.equal(r.events.checked, 0);
    assert.equal(r.accesses.checked, 0);
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
  });
});
