/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('test-helpers/src/api-server-tests-config.ts');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const assert = require('node:assert');
const { DynamicInstanceManager } = require('test-helpers/src/DynamicInstanceManager.ts');
const portAllocator = require('test-helpers/src/portAllocator.ts');

const FAKE_SERVER = path.resolve(import.meta.dirname, 'dim-fixtures/fake-server.cjs');
const READY_DELAY_MS = 400; // see dim-fixtures/fake-server.cjs

describe('[DIMR] DynamicInstanceManager readiness', function () {
  this.timeout(10000);
  let dim;

  afterEach(async () => {
    if (dim != null) await dim.stopAsync();
    dim = null;
  });

  // Observed: how long ensureStarted() waits for the NEW child. The fake child
  // only announces readiness after READY_DELAY_MS, so a restart that returns
  // sooner trusted a readiness flag left over from the dead child, which is
  // how a caller got ECONNREFUSED from a server that was not listening yet.
  it('[DIM1] after the child died unexpectedly, the next start waits for the new child to be ready', async () => {
    dim = new DynamicInstanceManager({ serverFilePath: FAKE_SERVER });
    await dim.ensureStartedAsync({});
    const child = dim.serverProcess;
    const exited = once(child, 'exit');
    // Not through stop(): an unexpected exit. This logs an expected
    // "exited unexpectedly after ready" error line in test-sync.log.
    child.kill('SIGKILL');
    await exited;

    const t0 = Date.now();
    await dim.ensureStartedAsync({});
    const waited = Date.now() - t0;
    assert.ok(waited >= READY_DELAY_MS - 50, `restart returned after ${waited} ms, before the new child was ready`);
  });

  it('[DIM3] a child that exits 0 before announcing readiness fails the start', async () => {
    dim = new DynamicInstanceManager({ serverFilePath: FAKE_SERVER });
    process.env.DIM_FAKE_EXIT_EARLY = '1';
    try {
      await assert.rejects(dim.ensureStartedAsync({}), /Server failed: exited before ready/);
    } finally {
      delete process.env.DIM_FAKE_EXIT_EARLY;
    }
  });

  it('[DIM4] creating managers does not add process listeners per instance', async () => {
    new DynamicInstanceManager({ serverFilePath: FAKE_SERVER }); // eslint-disable-line no-new
    const before = ['exit', 'SIGINT', 'SIGTERM'].map((e) => process.listenerCount(e));
    for (let i = 0; i < 5; i++) new DynamicInstanceManager({ serverFilePath: FAKE_SERVER }); // eslint-disable-line no-new
    const after = ['exit', 'SIGINT', 'SIGTERM'].map((e) => process.listenerCount(e));
    assert.deepEqual(after, before);
  });

  it('[DIM5] the temp config file is removed once the child has stopped', async () => {
    dim = new DynamicInstanceManager({ serverFilePath: FAKE_SERVER });
    await dim.ensureStartedAsync({});
    assert.ok(fs.existsSync(dim.tempConfigPath), 'config written for the child');
    await dim.stopAsync();
    assert.ok(!fs.existsSync(dim.tempConfigPath), 'config left behind: ' + dim.tempConfigPath);
  });

  it('[DIM6] stop() completes when the kill is reported as an error event', async () => {
    dim = new DynamicInstanceManager({ serverFilePath: FAKE_SERVER });
    await dim.ensureStartedAsync({});
    const child = dim.serverProcess;
    const realKill = child.kill.bind(child);
    // Node reports a signal it could not send as an 'error' event, not a throw.
    child.kill = () => { setImmediate(() => child.emit('error', new Error('kill failed'))); return false; };
    try {
      await Promise.race([
        dim.stopAsync(),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('stop() never called back')), 2000)),
      ]);
    } finally {
      // Restore first: stop()'s 5 s fallback must not hit the fake kill later.
      child.kill = realKill;
      realKill('SIGKILL');
    }
  });

  it('[DIM7] stop() force-kills a child that ignores SIGTERM', async () => {
    dim = new DynamicInstanceManager({ serverFilePath: FAKE_SERVER });
    process.env.DIM_FAKE_IGNORE_SIGTERM = '1';
    try {
      await dim.ensureStartedAsync({});
    } finally {
      delete process.env.DIM_FAKE_IGNORE_SIGTERM;
    }
    const child = dim.serverProcess;
    await Promise.race([
      dim.stopAsync(),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('child ignoring SIGTERM was never killed')), 7000)),
    ]);
    assert.equal(child.signalCode, 'SIGKILL');
  });

  it('[DIM2] the port probe binds the address the server will bind, below the ephemeral range', async () => {
    const port = await portAllocator.allocatePort('127.0.0.1');
    assert.ok(port >= 10000 && port <= 49151, 'port ' + port + ' outside 10000-49151');
    // A port held on 127.0.0.1 is reported unavailable for 127.0.0.1.
    const net = require('node:net');
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      assert.equal(await portAllocator.isPortAvailable(port, '127.0.0.1'), false);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
