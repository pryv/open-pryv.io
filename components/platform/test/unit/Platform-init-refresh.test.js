/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Platform.init is shared: every getPlatform() call lands in it, so concurrent
 * and later callers must get the one initialisation (never a half-initialised
 * platform) and a failed one must be retryable. A multi-core core re-reads the
 * other cores' URLs periodically, so it learns a core that joined or moved
 * after it booted. The api-server re-reads the platform names the same way
 * (its username-rewriter skips them).
 */

const assert = require('node:assert/strict');
const { Platform } = require('../../src/Platform.ts');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until (condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met within ' + timeoutMs + 'ms');
    await wait(5);
  }
}

describe('[PINI] Platform.init is shared and retryable', () => {
  // init() needs the storages (PlatformDB singleton) to be up.
  before(async () => {
    const { getConfig } = require('@pryv/boiler');
    await require('storages').init(await getConfig());
  });

  it('[PINI-01] concurrent and later calls run the initialisation once and get the same platform', async () => {
    const p = new Platform();
    let runs = 0;
    p.registerSelf = async () => { runs++; await wait(30); };
    p._refreshCoreUrlCache = async () => {};
    const results = await Promise.all([p.init(), p.init(), p.init()]);
    assert.strictEqual(runs, 1);
    for (const r of results) assert.strictEqual(r, p);
    assert.strictEqual(await p.init(), p);
    assert.strictEqual(runs, 1);
    p.stopCoreUrlRefresh();
  });

  it('[PINI-02] a failed initialisation is retried on the next call', async () => {
    const p = new Platform();
    let runs = 0;
    p.registerSelf = async () => { runs++; if (runs === 1) throw new Error('platform DB down'); };
    p._refreshCoreUrlCache = async () => {};
    await assert.rejects(() => p.init(), /platform DB down/);
    assert.strictEqual(await p.init(), p);
    assert.strictEqual(runs, 2);
    p.stopCoreUrlRefresh();
  });
});

describe('[PCUR] core URL cache and platform names refresh', () => {
  it('[PCUR-01] the periodic refresh learns a core that joined, and a core that moved', async () => {
    const rows = [{ id: 'core-a', url: 'https://core-a.example.com/' }];
    const db = { async getAllCoreInfos () { return rows.map((r) => ({ ...r })); } };
    const values = { 'core:id': 'core-a', 'dns:domain': 'example.com', 'cluster:allowInsecurePeerUrl': false };
    const p = new Platform();
    p._setDependenciesForTests(db, null, { get: (key) => values[key] });
    await p._refreshCoreUrlCache();
    // Not known yet: derived from the domain.
    assert.strictEqual(p.coreIdToUrl('core-b'), 'https://core-b.example.com/');

    p.startCoreUrlRefresh(15);
    try {
      rows.push({ id: 'core-b', url: 'https://api-b.other.example/' });
      await wait(60);
      assert.strictEqual(p.coreIdToUrl('core-b'), 'https://api-b.other.example/');
      rows[1].url = 'https://api-b2.other.example/';
      await wait(60);
      assert.strictEqual(p.coreIdToUrl('core-b'), 'https://api-b2.other.example/');
    } finally {
      p.stopCoreUrlRefresh();
    }
  });

  it('[PNRF-01] the platform names refresh learns a runtime record, keeps the previous names on a failed read, and stops', async () => {
    const records = [];
    let fail = false;
    let reads = 0;
    const db = {
      async getAllCoreInfos () { return [{ id: 'core-a' }]; },
      async getAllDnsRecords () {
        reads++;
        if (fail) throw new Error('rqlite unavailable');
        return records.map((r) => ({ ...r }));
      }
    };
    const values = { 'core:id': 'core-a', 'dns:domain': 'example.com' };
    const p = new Platform();
    p._setDependenciesForTests(db, null, { get: (key) => values[key] });
    await p.refreshPlatformNames();
    assert.strictEqual(p.isUsernameRoutingReserved('vanity'), false);
    p.startPlatformNamesRefresh(10);
    try {
      records.push({ subdomain: 'vanity', records: { a: ['10.0.0.1'] } });
      await until(() => p.isUsernameRoutingReserved('vanity'));
      // A registration-only rule is not a name the DNS answers itself.
      assert.strictEqual(p.isNameRoutedByPlatform('vanity'), true);
      assert.strictEqual(p.isUsernameRoutingReserved('pryvfan'), true);
      assert.strictEqual(p.isNameRoutedByPlatform('pryvfan'), false);
      assert.strictEqual(p.isNameRoutedByPlatform('users'), false);
      fail = true;
      const readsAtFail = reads;
      await until(() => reads >= readsAtFail + 2);
      assert.strictEqual(p.isUsernameRoutingReserved('vanity'), true, 'previous names kept');
    } finally {
      p.stopPlatformNamesRefresh();
    }
    const readsAtStop = reads;
    await wait(40);
    assert.strictEqual(reads, readsAtStop, 'no read after stop');
  });

  it('[PCUR-02] a failed refresh keeps the previous URLs', async () => {
    let fail = false;
    const db = {
      async getAllCoreInfos () {
        if (fail) throw new Error('rqlite unavailable');
        return [{ id: 'core-b', url: 'https://api-b.other.example/' }];
      }
    };
    const values = { 'core:id': 'core-a', 'dns:domain': 'example.com' };
    const p = new Platform();
    p._setDependenciesForTests(db, null, { get: (key) => values[key] });
    await p._refreshCoreUrlCache();
    fail = true;
    p.startCoreUrlRefresh(10);
    try {
      await wait(40);
      assert.strictEqual(p.coreIdToUrl('core-b'), 'https://api-b.other.example/');
    } finally {
      p.stopCoreUrlRefresh();
    }
  });
});
