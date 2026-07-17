/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [AUST] access-usage-stats tracking middleware.
 *
 * The middleware runs after EVERY API method and bumps per-access usage
 * counters. It keyed the update on `context.user.id` while only checking
 * that `context.access` was set — but the two do not always come
 * together: public / pre-authentication methods (`auth.cores`,
 * password-reset, …) are given a SYNTHETIC `access.id` by
 * `setAuditAccessId` purely to label the audit trail, and run before any
 * user is resolved. Those calls dereferenced an undefined user id deep in
 * the storage layer.
 *
 * The failure was invisible from the outside: the middleware calls
 * `next()` before doing its work and swallows its own errors, so the
 * request still succeeded and only a log line recorded the throw.
 * These tests pin the contract at the middleware boundary instead.
 */

const assert = require('node:assert/strict');
const getUpdateAccessUsageStats = require('api-server/src/methods/helpers/updateAccessUsageStats.ts').default;
const { getStorageLayer } = require('storage');

/* global initTests, initCore */

describe('[AUST] access-usage-stats tracking', function () {
  this.timeout(20000);

  let middleware, storageLayer, savedUpdateOne, calls;

  before(async function () {
    await initTests();
    await initCore();
    middleware = await getUpdateAccessUsageStats();
    storageLayer = await getStorageLayer();
  });

  beforeEach(function () {
    // The middleware captured `storageLayer.accesses` at build time, so
    // stubbing the method on that same object is what it will call.
    calls = [];
    savedUpdateOne = storageLayer.accesses.updateOne;
    storageLayer.accesses.updateOne = function (user, query, update, cb) {
      calls.push({ user, query, update });
      cb(null);
    };
  });

  afterEach(function () {
    storageLayer.accesses.updateOne = savedUpdateOne;
  });

  function run (context) {
    return new Promise((resolve, reject) => {
      middleware(context, {}, {}, (err) => (err ? reject(err) : resolve()));
    });
  }

  it('[AU01] skips the update when the context has an access but NO resolved user', async function () {
    // Shape produced by a public method: setAuditAccessId stamped a
    // synthetic access id, no user was ever resolved.
    await run({ access: { id: 'public' }, user: { username: 'someone' }, methodId: 'auth.cores' });
    assert.equal(calls.length, 0, 'must not touch storage without a user id');
  });

  it('[AU02] skips the update when there is no user object at all', async function () {
    await run({ access: { id: 'valid-password' }, methodId: 'auth.login' });
    assert.equal(calls.length, 0, 'must not touch storage without a user');
  });

  it('[AU03] still records usage for a real authenticated access', async function () {
    await run({
      access: { id: 'a-real-access' },
      user: { id: 'u-123', username: 'someone' },
      methodId: 'events.get',
    });
    assert.equal(calls.length, 1, 'authenticated calls must still be tracked');
    assert.equal(calls[0].user.id, 'u-123');
    assert.equal(calls[0].query.id, 'a-real-access');
    // sanitizeFieldKey maps `.` to `:` in the counter key.
    assert.equal(calls[0].update.$inc['calls.events:get'], 1);
  });

  it('[AU04] calls next() before doing its work (callers never wait on stats)', async function () {
    let nextCalled = false;
    middleware({ access: { id: 'x' }, user: { id: 'u-1' }, methodId: 'events.get' }, {}, {}, () => {
      nextCalled = true;
    });
    assert.ok(nextCalled, 'next() must have been called synchronously');
  });
});
