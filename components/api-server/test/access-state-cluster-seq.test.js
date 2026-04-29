/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests */

/**
 * Plan 55 Phase 5 — cross-worker accessState regression test.
 *
 * Spawns two child workers and asserts that an access-request state created
 * on worker 0 is readable on worker 1. Before Plan 55 Phase 2 (PlatformDB
 * backing), this round-trip failed because each worker held its own
 * `new Map()` — exactly the §12 production bug.
 */

const path = require('node:path');
const assert = require('node:assert/strict');

const accessState = require('../src/routes/reg/accessState');
const { spawnWorkers } = require('test-helpers/src/clusterFixture');

const WORKER_SCRIPT = path.join(__dirname, 'clusterWorkers', 'accessStateWorker.js');

describe('[XS12] accessState cross-worker (cluster regression)', function () {
  this.timeout(60_000);

  let cluster;

  before(async function () {
    await initTests();
    cluster = await spawnWorkers({ count: 2, workerScript: WORKER_SCRIPT });
  });

  after(async function () {
    if (cluster) await cluster.stop();
    await accessState.clear();
  });

  afterEach(async function () {
    await accessState.clear();
  });

  it('[XS12A] POST on worker 0 + GET on worker 1 returns the same state', async function () {
    const params = {
      requestingAppId: 'cross-worker-test',
      requestedPermissions: [{ streamId: 'diary', level: 'read' }],
      languageCode: 'en'
    };
    const created = await cluster.request(0, 'buildAndPersist', { params });
    assert.equal(created.state.status, 'NEED_SIGNIN');
    assert.equal(created.state.requestingAppId, 'cross-worker-test');

    const got = await cluster.request(1, 'get', { key: created.key });
    assert.ok(got, 'worker 1 must read the state created by worker 0');
    assert.equal(got.key, created.key);
    assert.equal(got.requestingAppId, 'cross-worker-test');
  });

  it('[XS12B] update on worker 1 is visible on worker 0', async function () {
    const params = {
      requestingAppId: 'update-test',
      requestedPermissions: [{ streamId: 'diary', level: 'read' }]
    };
    const created = await cluster.request(0, 'buildAndPersist', { params });

    const updated = await cluster.request(1, 'update', {
      key: created.key,
      update: { status: 'ACCEPTED', token: 'tok-123', username: 'alice' }
    });
    assert.equal(updated.status, 'ACCEPTED');
    assert.equal(updated.code, 200);

    const refetched = await cluster.request(0, 'get', { key: created.key });
    assert.equal(refetched.status, 'ACCEPTED');
    assert.equal(refetched.token, 'tok-123');
  });

  it('[XS12C] remove on worker 0 makes the state unreadable on worker 1', async function () {
    const created = await cluster.request(0, 'buildAndPersist', {
      params: { requestingAppId: 'rm-test', requestedPermissions: [{ streamId: 'diary', level: 'read' }] }
    });
    await cluster.request(0, 'remove', { key: created.key });
    const got = await cluster.request(1, 'get', { key: created.key });
    assert.equal(got, null);
  });
});
