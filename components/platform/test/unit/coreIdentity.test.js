/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');

const {
  coreIdProblem, isValidCoreId, peerUrlProblem, peerFetchOptions, PEER_FETCH_TIMEOUT_MS
} = require('../../src/coreIdentity.ts');
const { Platform } = require('../../src/Platform.ts');

/**
 * Core ids and core URLs come from config and from platform rows, and core
 * URLs receive the admin key on core-to-core calls: they are checked on write
 * and again before use.
 */

function makePlatform ({ config = {}, coreInfos = [] } = {}) {
  const rows = new Map(coreInfos.map((c) => [c.id, c]));
  const userCores = new Map();
  const db = {
    rows,
    userCores,
    async getAllCoreInfos () { return [...rows.values()]; },
    async setCoreInfo (id, info) { rows.set(id, info); },
    async setUserCore (user, coreId) { userCores.set(user, coreId); },
    async setUserCoreIfNotExists (user, coreId) { userCores.set(user, coreId); return true; }
  };
  const values = Object.assign({ 'core:id': 'core-a', 'platform:piiMode': 'cleartext', 'dns:domain': 'mc.example.com' }, config);
  const platform = new Platform();
  platform._setDependenciesForTests(db, null, { get: (key) => values[key] });
  return { platform, db };
}

describe('[PCID] core id and core URL rules', () => {
  it('[PCID1] a core id is one lowercase DNS label', () => {
    for (const ok of ['single', 'core-a', 'use1', '0', 'a'.repeat(63)]) assert.equal(isValidCoreId(ok), true, ok);
    for (const bad of ['', 'Core-A', 'core_a', '-core', 'a'.repeat(64), 'a.b', 'evil.example/x', 'a#b', 'a@b', null, 3]) {
      assert.equal(isValidCoreId(bad), false, String(bad));
      assert.match(coreIdProblem(bad), /is invalid/);
    }
  });

  it('[PCID2] a core URL is an https origin; http only with the insecure flag; no credentials, path, query or fragment', () => {
    for (const ok of ['https://core-a.example.com', 'https://core-a.example.com/', 'https://10.0.0.5:8443']) {
      assert.equal(peerUrlProblem(ok), null, ok);
    }
    assert.match(peerUrlProblem('http://core-a.example.com'), /uses http:/);
    assert.equal(peerUrlProblem('http://127.0.0.1:3000/', { allowInsecure: true }), null);
    const refused = {
      'ftp://core-a.example.com': /must use https/,
      'https://user:pw@core-a.example.com': /credentials/,
      'https://core-a.example.com/api': /path/,
      'https://core-a.example.com/?a=1': /query/,
      'https://core-a.example.com/?': /query/,
      'https://core-a.example.com/#x': /fragment/,
      'not a url': /not a valid URL/,
      '': /missing/
    };
    for (const [url, re] of Object.entries(refused)) assert.match(peerUrlProblem(url, { allowInsecure: true }), re, url);
  });

  it('[PCID3] core-to-core fetch options are time-bounded and never follow a redirect', async () => {
    const opts = peerFetchOptions({ method: 'POST', headers: { a: 'b' } });
    assert.equal(opts.redirect, 'error');
    assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(opts.method, 'POST');
    assert.equal(PEER_FETCH_TIMEOUT_MS, 10000);
    const quick = peerFetchOptions({}, 20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(quick.signal.aborted, true, 'the signal aborts after the timeout');
  });

  it('[PCID4] Platform.setUserCore* refuse an invalid core id before writing', async () => {
    const { platform, db } = makePlatform();
    for (const fn of ['setUserCore', 'setUserCoreIfNotExists', 'setUserCoreByPreHashedUsername']) {
      await assert.rejects(() => platform[fn]('alice', 'evil.example.org/x'), (err) => err.id === 'invalid-parameters-format', fn);
    }
    assert.equal(db.userCores.size, 0);
    await platform.setUserCore('alice', 'core-b');
    assert.equal(db.userCores.get('alice'), 'core-b');
  });

  it('[PCID5] coreIdToUrl ignores a peer row with an http or path-carrying URL and refuses an invalid id', async () => {
    const { platform } = makePlatform({
      coreInfos: [
        { id: 'core-a', url: 'http://127.0.0.1:3000' }, // this core: from its own config
        { id: 'core-b', url: 'http://core-b.attacker.example' },
        { id: 'core-c', url: 'https://core-c.example.com/x?y#z' },
        { id: 'core-d', url: 'https://core-d.example.com' }
      ]
    });
    await platform._refreshCoreUrlCache();
    assert.equal(platform.coreIdToUrl('core-a'), 'http://127.0.0.1:3000/');
    assert.equal(platform.coreIdToUrl('core-b'), 'https://core-b.mc.example.com/', 'falls back to derivation');
    assert.equal(platform.coreIdToUrl('core-c'), 'https://core-c.mc.example.com/');
    assert.equal(platform.coreIdToUrl('core-d'), 'https://core-d.example.com/');
    assert.equal(platform.coreIdToUrl('evil.example.org/x'), '', 'no URL for a malformed id');
  });

  it('[PCID6] with cluster.allowInsecurePeerUrl an http peer URL is used', async () => {
    const { platform } = makePlatform({
      config: { 'cluster:allowInsecurePeerUrl': true },
      coreInfos: [{ id: 'core-b', url: 'http://127.0.0.1:3001' }]
    });
    await platform._refreshCoreUrlCache();
    assert.equal(platform.coreIdToUrl('core-b'), 'http://127.0.0.1:3001/');
  });
});
