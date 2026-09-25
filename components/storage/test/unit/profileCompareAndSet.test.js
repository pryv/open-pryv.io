/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UserStorage.compareAndSetJson on the profile collection, against the engine
 * the run selects (STORAGE_ENGINE). The concurrency case goes through the real
 * storage layer; on PostgreSQL the parallel calls use separate pool
 * connections, which is what makes it a real race.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const cuid = require('cuid');
const { fromCallback } = require('utils');
const storage = require('storage');

describe('[PCAS] UserStorage.compareAndSetJson (profile)', function () {
  let profile;
  let userId;

  const LAST = ['data', 'mfa', 'totp', 'lastUsedStep'];
  const SECRET = ['data', 'mfa', 'totp', 'secret'];
  const cas = (guards, sets, query = { id: 'private' }) =>
    fromCallback((cb) => profile.compareAndSetJson(userId, query, guards, sets, cb));
  const read = async () => (await fromCallback((cb) => profile.findOne(userId, { id: 'private' }, null, cb))).data;

  before(async function () {
    await storage.userLocalDirectory.init();
    profile = (await storage.getStorageLayer()).profile;
  });

  beforeEach(async function () {
    userId = cuid();
    await fromCallback((cb) => profile.insertOne(userId, {
      id: 'private',
      data: { keep: 'me', mfa: { totp: { secret: 'S1', lastUsedStep: 10 } } }
    }, cb));
  });

  afterEach(async function () {
    await fromCallback((cb) => profile.removeAll(userId, cb));
  });

  it('[PCS1] writes when every guard holds, and leaves the rest of the document alone', async function () {
    const ok = await cas([{ path: SECRET, eq: 'S1' }, { path: LAST, lt: 11 }], [{ path: LAST, value: 11 }]);
    assert.strictEqual(ok, true);
    const data = await read();
    assert.strictEqual(data.mfa.totp.lastUsedStep, 11);
    assert.strictEqual(data.mfa.totp.secret, 'S1');
    assert.strictEqual(data.keep, 'me');
  });

  it('[PCS2] refuses when a guard fails: eq mismatch, lt not below, lt on an absent or non-number value', async function () {
    assert.strictEqual(await cas([{ path: SECRET, eq: 'other' }], [{ path: LAST, value: 99 }]), false);
    assert.strictEqual(await cas([{ path: LAST, lt: 10 }], [{ path: LAST, value: 99 }]), false);
    assert.strictEqual(await cas([{ path: ['data', 'mfa', 'totp', 'nope'], lt: 1e9 }], [{ path: LAST, value: 99 }]), false);
    assert.strictEqual(await cas([{ path: SECRET, lt: 1e9 }], [{ path: LAST, value: 99 }]), false);
    assert.strictEqual((await read()).mfa.totp.lastUsedStep, 10);
  });

  it('[PCS3] eq compares as text on every engine, for strings and integers', async function () {
    assert.strictEqual(await cas([{ path: LAST, eq: 10 }], [{ path: ['data', 'keep'], value: 'a' }]), true);
    assert.strictEqual(await cas([{ path: LAST, eq: '10' }], [{ path: ['data', 'keep'], value: 'b' }]), true);
    assert.strictEqual((await read()).keep, 'b');
  });

  it('[PCS4] absent holds for a missing or JSON-null value only, and a whole sub-object can be created', async function () {
    const T = ['data', 'mfaThrottle'];
    assert.strictEqual(await cas([{ path: ['data', 'keep'], absent: true }], [{ path: T, value: 1 }]), false);
    assert.strictEqual(await cas([{ path: T, absent: true }], [{ path: T, value: { failures: 1, notBefore: 0 } }]), true);
    assert.strictEqual(await cas([{ path: T, absent: true }], [{ path: T, value: { failures: 9 } }]), false);
    assert.deepStrictEqual((await read()).mfaThrottle, { failures: 1, notBefore: 0 });
    assert.strictEqual(await cas([{ path: ['data', 'mfaThrottle', 'failures'], eq: 1 }], [{ path: T, value: null }]), true);
    assert.strictEqual(await cas([{ path: T, absent: true }], [{ path: T, value: { failures: 2 } }]), true);
  });

  it('[PCS5] of many concurrent callers racing on the same guard, exactly one wins', async function () {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      cas([{ path: LAST, lt: 11 }], [{ path: LAST, value: 11 }])));
    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.strictEqual((await read()).mfa.totp.lastUsedStep, 11);
  });

  it('[PCS6] a query matching no item writes nothing and answers false', async function () {
    assert.strictEqual(await cas([{ path: LAST, lt: 1e9 }], [{ path: LAST, value: 1 }], { id: 'no-such-id' }), false);
    assert.strictEqual((await read()).mfa.totp.lastUsedStep, 10);
  });

  it('[PCS7] rejects malformed calls before touching the item', async function () {
    const bad = [
      [[{ path: ['data', "x'; --"], eq: 1 }], [{ path: LAST, value: 1 }]],
      [[{ path: ['data'], eq: 1 }], [{ path: LAST, value: 1 }]],
      [[{ path: LAST, eq: 1, lt: 2 }], [{ path: LAST, value: 1 }]],
      [[], [{ path: LAST, value: 1 }]],
      [[{ path: LAST, lt: 1e9 }], []],
      [[{ path: ['id', 'x'], eq: 1 }], [{ path: LAST, value: 1 }]]
    ];
    for (const [guards, sets] of bad) {
      await assert.rejects(cas(guards, sets), /compareAndSetJson/);
    }
    assert.strictEqual((await read()).mfa.totp.lastUsedStep, 10);
  });
});
