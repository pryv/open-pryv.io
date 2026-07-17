/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the consent effective-permission guard (hierarchical
 * consent-masking class). The AccessLogic/mall resolution is injected as a
 * fake tree so the DECISION logic is tested in isolation; the real
 * AccessLogic wiring is exercised by the accept-path integration tests.
 */

const assert = require('node:assert/strict');
const guard = require('../../src/accesses/consentEffectiveGuard.ts');

/**
 * Build a LevelResolver that mimics AccessLogic resolution over a fake
 * tree: for a stream, walk child→parent (via `parents`) and return the
 * first permission-set entry found; fall back to the set's '*' entry; else
 * undefined. `perms` is [{streamId, level}].
 */
function fakeResolver (perms, parents) {
  const byStream = new Map(perms.map((p) => [p.streamId, p.level]));
  return async (streamId) => {
    let cur = streamId;
    while (cur != null) {
      if (byStream.has(cur)) return byStream.get(cur);
      cur = parents[cur] ?? null;
    }
    return byStream.has('*') ? byStream.get('*') : undefined;
  };
}

function assertWithin (granted, offered, parents) {
  return guard.assertGrantedWithinOffer({
    userId: 'u',
    granted,
    offered,
    resolvers: {
      granted: fakeResolver(granted, parents),
      offered: fakeResolver(offered, parents),
    },
  });
}

describe('[CEG] consent effective-permission guard', () => {
  it('[CEG1] {*,manage}+{secret,read}, drop secret → WIDENS (manage inherited)', async () => {
    const offered = [{ streamId: '*', level: 'manage' }, { streamId: 'secret', level: 'read' }];
    const granted = [{ streamId: '*', level: 'manage' }]; // secret dropped
    const res = await assertWithin(granted, offered, {});
    assert.equal(res.ok, false);
    const v = res.violations.find((x) => x.streamId === 'secret');
    assert.ok(v, 'secret must be flagged');
    assert.deepEqual(v.excess.sort(), ['create', 'manage', 'update']);
  });

  it('[CEG2] {*,read}+{X,create-only}, drop X → WIDENS (gains read create-only masked)', async () => {
    const offered = [{ streamId: '*', level: 'read' }, { streamId: 'X', level: 'create-only' }];
    const granted = [{ streamId: '*', level: 'read' }]; // X dropped
    const res = await assertWithin(granted, offered, {});
    assert.equal(res.ok, false);
    assert.deepEqual(res.violations.find((x) => x.streamId === 'X').excess, ['read']);
  });

  it('[CEG3] specific ancestor (no *): {A,read}+{B,create-only}, B child of A, drop B → WIDENS', async () => {
    const offered = [{ streamId: 'A', level: 'read' }, { streamId: 'B', level: 'create-only' }];
    const granted = [{ streamId: 'A', level: 'read' }]; // B dropped; B is under A
    const res = await assertWithin(granted, offered, { B: 'A' });
    assert.equal(res.ok, false);
    assert.deepEqual(res.violations.find((x) => x.streamId === 'B').excess, ['read']);
  });

  it('[CEG4] legitimate narrowing: {*,read}+{secret,manage}, drop secret → OK (read ⊆ manage)', async () => {
    const offered = [{ streamId: '*', level: 'read' }, { streamId: 'secret', level: 'manage' }];
    const granted = [{ streamId: '*', level: 'read' }]; // secret narrows to inherited read
    const res = await assertWithin(granted, offered, {});
    assert.equal(res.ok, true);
  });

  it('[CEG5] all-or-nothing kept whole → OK (granted == offered)', async () => {
    const offered = [{ streamId: '*', level: 'manage' }, { streamId: 'secret', level: 'read' }];
    const res = await assertWithin(offered.slice(), offered, {});
    assert.equal(res.ok, true);
  });

  it('[CEG6] dropping a leaf with no broader ancestor → OK (resolves to nothing)', async () => {
    // No '*', no ancestor: dropping {b,read} leaves b with no grant at all.
    const offered = [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }];
    const granted = [{ streamId: 'a', level: 'read' }];
    const res = await assertWithin(granted, offered, {});
    assert.equal(res.ok, true);
  });

  it('[CEG7] feature-only / empty offer → trivially OK (no stream entries)', async () => {
    const res = await guard.assertGrantedWithinOffer({
      userId: 'u',
      granted: [{ feature: 'selfRevoke', setting: 'forbidden' }],
      offered: [{ feature: 'selfRevoke', setting: 'forbidden' }],
    });
    assert.equal(res.ok, true);
  });

  it('[CEG8] evaluateExcess de-duplicates repeated offered streamIds', async () => {
    const calls = [];
    const resolveGranted = async (s) => { calls.push(s); return 'manage'; };
    const resolveOffered = async () => 'read';
    const v = await guard.evaluateExcess({
      offeredStreamIds: ['s', 's', 's'],
      resolveGranted,
      resolveOffered,
    });
    assert.equal(calls.length, 1, 'resolver called once per distinct streamId');
    assert.equal(v.length, 1);
  });
});
