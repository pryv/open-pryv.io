/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The failed-password budget per client address fails open: when the platform
 * database cannot be read or written, the password check proceeds (the
 * per-account delay still applies) instead of failing every sign-in.
 */

const assert = require('node:assert/strict');
const storages = require('storages');
const { passwordIpRefusal, countPasswordIpFailure } = require('../../src/auth/passwordIpThrottle.ts');

describe('[PIPF] password budget per address, platform database unavailable', function () {
  const cfg = { maxFailures: 3, windowSeconds: 900 };
  let previous;
  let calls;

  before(function () {
    previous = storages.platformDB;
    calls = 0;
    const down = async () => { calls++; throw new Error('platform database unreachable'); };
    storages._setPlatformDBForTest({ getAccessState: down, setAccessStateIfAbsent: down, deleteAccessState: down });
  });

  after(function () {
    storages._setPlatformDBForTest(previous);
  });

  it('[PIPF1] the check proceeds and a failure is not counted, without throwing', async function () {
    assert.equal(await passwordIpRefusal('192.0.2.10', cfg), null);
    await countPasswordIpFailure('192.0.2.10', cfg);
    assert.ok(calls >= 2, 'the store was asked (and failed)');
  });

  it('[PIPF2] an absent platform database is treated the same way', async function () {
    storages._setPlatformDBForTest(undefined);
    assert.equal(await passwordIpRefusal('2001:db8::1', cfg), null);
    await countPasswordIpFailure('2001:db8::1', cfg);
  });
});
