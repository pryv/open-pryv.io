/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The core's storage-size job: `account.get` `storageUsed` is written only by
 * this pass, so without it every account reads 0 / 0 (reported from a
 * three-core deployment, 2026-11-12, where nothing scheduled bin/nightly).
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { storageUsedIntervalMs, computeStorageUsedForAllAccounts, startStorageUsedJob, DEFAULT_INTERVAL_HOURS } =
  require('api-server/src/methods/helpers/storageUsedJob.ts');
const { getUsersRepository } = require('business/src/users/index.ts');

const quietLogger = () => {
  const errors = [];
  return { info: () => {}, warn: () => {}, error: (m) => errors.push(m), errors };
};

describe('[STUJ] storage-size job', function () {
  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const stream = await user.stream({ id: cuid(), name: 'stuj' });
    for (let i = 0; i < 3; i++) await stream.event({ type: 'note/txt', content: 'stuj ' + i });
  });

  after(async function () {
    await fixtures.clean();
  });

  const storageUsed = async () => {
    const res = await coreRequest.get('/' + username + '/account').set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.account.storageUsed;
  };

  it('[STUJ1] interval: 24 h by default, the configured hours, 0 (or an unusable value) turns it off', function () {
    const cfg = (v) => ({ get: (k) => (k === 'account:storageUsed:intervalHours' ? v : undefined) });
    assert.strictEqual(DEFAULT_INTERVAL_HOURS, 24);
    assert.strictEqual(storageUsedIntervalMs(cfg(undefined)), 24 * 3600000);
    assert.strictEqual(storageUsedIntervalMs(cfg(6)), 6 * 3600000);
    assert.strictEqual(storageUsedIntervalMs(cfg(0)), 0);
    assert.strictEqual(storageUsedIntervalMs(cfg(-1)), 0);
    assert.strictEqual(startStorageUsedJob(cfg(0)), null, 'off: no timer');
  });

  it('[STUJ2] a pass writes the account\'s real figures (dbDocuments counts its streams and events)', async function () {
    const repository = await getUsersRepository();
    const userId = await repository.getUserIdForUsername(username);
    await repository.updateOne(await repository.getUserById(userId), { storageUsed: { dbDocuments: 0, attachedFiles: 0 } }, 'system');
    assert.strictEqual((await storageUsed()).dbDocuments, 0);
    const logger = quietLogger();
    const r = await computeStorageUsedForAllAccounts(logger);
    assert.ok(r.accounts >= 1 && r.updated >= 1, JSON.stringify(r));
    assert.deepStrictEqual(logger.errors, []);
    const after = await storageUsed();
    assert.ok(after.dbDocuments >= 4, 'one stream and three events at least: ' + JSON.stringify(after));
    assert.strictEqual(typeof after.attachedFiles, 'number');
  });

  it('[STUJ3] an account that fails is logged and skipped; the others are still updated', async function () {
    const repository = await getUsersRepository();
    const userId = await repository.getUserIdForUsername(username);
    const other = cuid();
    await fixtures.user(other);
    const otherId = await repository.getUserIdForUsername(other);
    const original = repository.getUserById;
    repository.getUserById = async function (id, ...rest) {
      if (id === otherId) throw new Error('stuj read failure');
      return original.call(this, id, ...rest);
    };
    try {
      await repository.updateOne(await original.call(repository, userId), { storageUsed: { dbDocuments: 0, attachedFiles: 0 } }, 'system');
      const logger = quietLogger();
      const r = await computeStorageUsedForAllAccounts(logger);
      assert.strictEqual(r.failed, 1, JSON.stringify(r));
      assert.strictEqual(logger.errors.length, 1);
      assert.match(logger.errors[0], new RegExp(`"${other}".*stuj read failure`));
      assert.ok((await storageUsed()).dbDocuments >= 4, 'the healthy account was still updated');
    } finally {
      repository.getUserById = original;
    }
  });

  it('[STUJ4] the started job runs its first pass after the delay, then stops on request', async function () {
    const repository = await getUsersRepository();
    const userId = await repository.getUserIdForUsername(username);
    await repository.updateOne(await repository.getUserById(userId), { storageUsed: { dbDocuments: 0, attachedFiles: 0 } }, 'system');
    const job = startStorageUsedJob({ get: () => undefined }, { firstPassDelayMs: 50 });
    try {
      let figures = await storageUsed();
      for (let i = 0; i < 100 && figures.dbDocuments === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        figures = await storageUsed();
      }
      assert.ok(figures.dbDocuments >= 4, JSON.stringify(figures));
    } finally {
      job.stop();
    }
  });
});
