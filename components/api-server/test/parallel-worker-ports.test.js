/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PWP] Parallel-mode worker ports: each checkout gets its own band, clear of
 * the host services checkouts run for sequential tests.
 */

const assert = require('node:assert/strict');
const setup = require('test-helpers/src/parallelWorkerSetup.ts');

const WORKERS = 14;
const CHECKOUTS = 3;

function portsOf (o) {
  return [o.httpPort, o.previewsPort, o.hfsPort, o.tcpBrokerPort, Number(new URL(o.rqliteUrl).port), o.rqliteRaftPort];
}

function withCheckoutIndex (index, fn) {
  const saved = process.env.PRYV_TEST_CHECKOUT_INDEX;
  process.env.PRYV_TEST_CHECKOUT_INDEX = String(index);
  try { return fn(); } finally {
    if (saved == null) delete process.env.PRYV_TEST_CHECKOUT_INDEX; else process.env.PRYV_TEST_CHECKOUT_INDEX = saved;
  }
}

describe('[PWP] parallel worker ports', () => {
  it('[PWP1] no two workers of any checkout share a port, and none hits a host service port', () => {
    // Host services of checkout N (0-based): PG 5432+N, rqlite 4001/4002 +100N,
    // tcpBroker 4222 +100N, InfluxDB 8086/8088 +100N, api http 3000/3001, hfs 4000.
    const host = new Set();
    for (let n = 0; n < CHECKOUTS; n++) {
      for (const p of [5432 + n, 4001 + 100 * n, 4002 + 100 * n, 4222 + 100 * n, 8086 + 100 * n, 8088 + 100 * n]) host.add(p);
    }
    for (const p of [3000, 3001, 4000]) host.add(p);
    const seen = new Map();
    for (let n = 0; n < CHECKOUTS; n++) {
      withCheckoutIndex(n, () => {
        for (let w = 0; w < WORKERS; w++) {
          for (const p of portsOf(setup.getPerWorkerOverrides(w))) {
            assert.ok(!host.has(p), `checkout ${n} worker ${w} uses host port ${p}`);
            assert.ok(!seen.has(p), `port ${p} used by ${seen.get(p)} and checkout ${n} worker ${w}`);
            seen.set(p, `checkout ${n} worker ${w}`);
          }
        }
      });
    }
  });

  it('[PWP2] the checkout index is derived from the rqlite port in test-config', () => {
    const cfg = (port) => 'storages:\n  engines:\n    postgresql:\n      port: 5433\n    rqlite:\n      url: http://localhost:' + port + '\n      raftPort: 4102\n';
    assert.equal(setup.checkoutIndexFromConfigText(cfg(4001)), 0);
    assert.equal(setup.checkoutIndexFromConfigText(cfg(4101)), 1);
    assert.equal(setup.checkoutIndexFromConfigText(cfg(4201)), 2);
    assert.equal(setup.checkoutIndexFromConfigText(cfg(4150)), 0, 'not on the 100 grid: first band');
    assert.equal(setup.checkoutIndexFromConfigText('storages: {}\n'), 0);
  });

  it('[PWP3] PRYV_TEST_CHECKOUT_INDEX wins over the config file', () => {
    withCheckoutIndex(7, () => assert.equal(setup.getCheckoutIndex(), 7));
  });
});
