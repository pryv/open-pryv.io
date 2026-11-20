/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { default: checkUserCore } = require('../../src/checkUserCore.ts');
const { RoutingMissBudget, readUnknownNamesPerMinute, UNKNOWN_NAMES_PER_CLIENT_PER_MINUTE_DEFAULT } = require('../../src/routingMissBudget.ts');

/**
 * [CUCB] Wrong-core check (multi-core): routing answers come from the
 * per-process routing cache, and a client whose lookups keep finding no
 * account is refused uncached lookups for the rest of the minute.
 */

function makePlatform (cores) {
  const cache = new Map();
  const platform = {
    isSingleCore: false,
    coreId: 'core-a',
    reads: 0,
    coreIdToUrl: (id) => 'https://' + id + '.example',
    async getUserCore () { throw new Error('the routing check must use the routing read'); },
    async getUserCoreForRouting (name) {
      platform.reads++;
      const core = cores[name] ?? null;
      cache.set(name, core);
      return core;
    },
    peekUserCoreForRouting (name) { return cache.has(name) ? cache.get(name) : undefined; }
  };
  return platform;
}

function request (username, ip = '198.51.100.7') {
  return { params: { username }, socket: { remoteAddress: ip }, headers: {} };
}

function response () {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function run (req) {
  const res = response();
  let nextArg = 'not called';
  await checkUserCore(req, res, (arg) => { nextArg = arg; });
  return { res, nextArg };
}

describe('[CUCB] wrong-core check: routing cache and per-client miss budget', function () {
  afterEach(() => checkUserCore._resetPlatformCache());

  it('[CUCB1] uses the routing read and the cache; another core answers 421, this core or an unknown name passes on', async function () {
    const platform = makePlatform({ alice: 'core-b', bob: 'core-a' });
    checkUserCore._setPlatformForTests(platform);
    const wrong = await run(request('alice'));
    assert.equal(wrong.res.statusCode, 421);
    assert.equal(wrong.res.body.error.coreUrl, 'https://core-b.example');
    assert.equal((await run(request('bob'))).nextArg, undefined);
    assert.equal((await run(request('nobody'))).nextArg, undefined);
    assert.equal((await run(request('alice'))).res.statusCode, 421);
    assert.equal(platform.reads, 3, 'the second alice came from the cache');
  });

  it('[CUCB2] past the budget of unknown names a client gets 429 for uncached names; cached names and other clients go on', async function () {
    const platform = makePlatform({ alice: 'core-b', bob: 'core-a' });
    checkUserCore._setPlatformForTests(platform);
    await run(request('alice'));
    for (let i = 0; i < UNKNOWN_NAMES_PER_CLIENT_PER_MINUTE_DEFAULT; i++) {
      assert.equal((await run(request('random' + i))).nextArg, undefined);
    }
    const readsBefore = platform.reads;
    const refused = await run(request('random-next'));
    assert.equal(refused.nextArg?.id, 'too-many-requests', String(refused.nextArg));
    assert.equal(platform.reads, readsBefore, 'a refused lookup costs no read');
    assert.equal((await run(request('alice'))).res.statusCode, 421, 'a cached name still answers');
    assert.equal((await run(request('random0'))).nextArg, undefined, 'a cached miss still passes on');
    assert.equal((await run(request('bob', '203.0.113.9'))).nextArg, undefined, 'another client is not affected');
  });

  it('[CUCB3] an IPv6 client counts by its /64', async function () {
    const platform = makePlatform({});
    checkUserCore._setPlatformForTests(platform);
    for (let i = 0; i < UNKNOWN_NAMES_PER_CLIENT_PER_MINUTE_DEFAULT; i++) {
      await run(request('v6-' + i, '2001:db8:1:2::' + (i + 1).toString(16)));
    }
    const refused = await run(request('v6-next', '2001:db8:1:2:ffff::1'));
    assert.equal(refused.nextArg?.id, 'too-many-requests');
    assert.equal((await run(request('v6-other', '2001:db8:1:3::1'))).nextArg, undefined);
  });

  it('[CUCB4] the budget window, its bound and its defaults; 0 turns it off', function () {
    const budget = new RoutingMissBudget({ maxClients: 10 });
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) budget.countMiss('c', t);
    assert.equal(budget.retryAfter('c', 3, t + 1000), 59);
    assert.equal(budget.retryAfter('c', 4, t + 1000), null);
    assert.equal(budget.retryAfter('c', 0, t + 1000), null);
    assert.equal(budget.retryAfter('c', 3, t + 60_000), null, 'the window ended');
    for (let i = 0; i < 100; i++) budget.countMiss('client-' + i, t + i * 61_000);
    assert.ok(budget.size <= 10, String(budget.size));
    assert.equal(readUnknownNamesPerMinute(() => undefined), 60);
    assert.equal(readUnknownNamesPerMinute(() => 0), 0);
    assert.equal(readUnknownNamesPerMinute(() => -5), 60);
  });
});
