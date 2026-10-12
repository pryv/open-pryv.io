/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The password reset budget per client address counts an IPv6 address toward
 * its /64, like the other per-address budgets: one allocation holds 2^64
 * addresses, each of which would otherwise get a budget of its own.
 */

const assert = require('node:assert/strict');
const storages = require('storages');
const throttle = require('../../src/auth/passwordResetThrottle.ts');

function memoryStore () {
  const rows = new Map();
  return {
    rows,
    async getAccessState (key) { return rows.get(key) ?? null; },
    async setAccessState (key, value, expiresAt) { rows.set(key, { value, expiresAt }); },
    async setAccessStateIfAbsent (key, value, expiresAt) {
      if (rows.has(key)) return false;
      rows.set(key, { value, expiresAt });
      return true;
    },
    async deleteAccessState (key) { rows.delete(key); }
  };
}

describe('[PRTB] password reset budget per address', function () {
  let previous;
  let store;

  before(function () {
    previous = storages.platformDB;
  });

  beforeEach(function () {
    store = memoryStore();
    storages._setPlatformDBForTest(store);
  });

  after(function () {
    storages._setPlatformDBForTest(previous);
  });

  it('[PRTB1] addresses of one IPv6 /64 share a key; IPv4 addresses and other /64s do not', function () {
    assert.equal(throttle.ipKey('2001:db8:1:2::a'), throttle.ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.notEqual(throttle.ipKey('2001:db8:1:2::a'), throttle.ipKey('2001:db8:1:3::a'));
    assert.notEqual(throttle.ipKey('192.0.2.1'), throttle.ipKey('192.0.2.2'));
  });

  it('[PRTB2] an exhausted /64 refuses a request from another address inside it', async function () {
    await store.setAccessState(throttle.ipKey('2001:db8:1:2::1'), { count: throttle.IP_HOURLY_LIMIT }, Date.now() + 60_000);
    const outcome = await throttle.reservePasswordReset('prtb-user', '2001:db8:1:2::9999');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'ip-limit');
  });

  it('[PRTB3] the stored key never carries the client address', async function () {
    const outcome = await throttle.reservePasswordReset('prtb-user', '2001:db8:1:2::1');
    assert.equal(outcome.ok, true);
    for (const key of store.rows.keys()) {
      assert.ok(!key.includes('2001:db8'), key);
    }
  });
});
