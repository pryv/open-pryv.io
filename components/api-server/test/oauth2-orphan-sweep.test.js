/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OSWM] The master's sweep of expired, never-exchanged authorization codes
 * removes the session pre-minted at /accept as the code exchange removes it:
 * the breach-scope index keeps the access as deleted, its alias is released
 * when the session was its last holder, the account's clients are told.
 */

/* global initTests, initCore, getNewFixture, assert, cuid */

describe('[OSWM] expired-code orphan sweep: the session removal of the master', function () {
  this.timeout(30_000);

  let fixtures, user, username, userId, storageLayer, platform;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'oswm-' + cuid().slice(-8);
    user = await fixtures.user(username);
    userId = user.attrs.id;
    storageLayer = await require('storage').getStorageLayer();
    platform = await require('platform').getPlatform();
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  it('[OSWM1] the sweep tombstones the index row, releases the alias and notifies', async function () {
    const { createSessions } = require('api-server/src/routes/oauth2/sessions.ts');
    const { revokeOAuthSessionLocal } = require('api-server/src/methods/helpers/oauthSessionRemoval.ts');
    const { revokeExpiredCodeOrphans } = require('oauth2/src/orphanSweep.ts');
    const { getUsersRepository } = require('business/src/users/index.ts');
    const accessIndex = require('platform/src/accessIndex.ts');
    const { pubsub, USERNAME_BASED_ACCESSES_CHANGED } = require('messages');
    const usersRepository = await getUsersRepository();
    const env = { config: { get: () => undefined }, storageLayer, logger: { warn: () => {}, debug: () => {}, info: () => {} } };

    // A session pre-minted at /accept, carrying an alias no other access holds.
    const clientId = 'oswm-' + cuid().slice(-8);
    const alias = await usersRepository.mintAlias(username, userId);
    const minted = await createSessions(env).mintAccessDirect({
      userId, username, clientId, permissions: [{ streamId: '*', level: 'read' }], expiresAt: Date.now() + 600_000, alias,
    });
    assert.ok((await accessIndex.getAccessIndex(platform, minted.accessId))?.deleted == null, 'indexed live by the mint');

    // Its authorization code expired unexchanged; the sweep runs with the
    // master's removal (bin/master.js).
    const coreId = 'oswm-core';
    const expired = {
      async listExpiredAccessStates (prefix) {
        return prefix === 'oauth-ac/' ? [{ key: 'oauth-ac/x', value: { coreId, clientId, userId, accessId: minted.accessId } }] : [];
      },
    };
    const notified = [];
    const remove = pubsub.notifications.onAndGetRemovable(username, (payload) => { notified.push(payload); });
    let revoked;
    try {
      revoked = await revokeExpiredCodeOrphans({
        platform: expired,
        coreId,
        resolveUsername: async () => username,
        revokeLocal: (params) => revokeOAuthSessionLocal(storageLayer, params),
      });
    } finally {
      remove();
    }
    assert.strictEqual(revoked, 1);

    const row = await new Promise((resolve, reject) => storageLayer.accesses.findOne({ id: userId, username }, { id: minted.accessId }, null,
      (err, a) => (err != null ? reject(err) : resolve(a))));
    assert.strictEqual(row, null, 'the session is deleted');
    const entry = await accessIndex.getAccessIndex(platform, minted.accessId);
    assert.ok(entry != null && typeof entry.deleted === 'number', 'the index row is kept, marked deleted: ' + JSON.stringify(entry));
    assert.strictEqual(await usersRepository.getUserIdForUsername(alias), undefined, 'the alias no longer routes');
    assert.strictEqual(await usersRepository.platform.getUsersUniqueField('alias', alias), null, 'its reservation is released');
    assert.ok(notified.includes(USERNAME_BASED_ACCESSES_CHANGED), JSON.stringify(notified));
  });

  it('[OSWM3] a failed alias release does not undo nor fail the removal', async function () {
    const { createSessions } = require('api-server/src/routes/oauth2/sessions.ts');
    const { revokeOAuthSessionLocal } = require('api-server/src/methods/helpers/oauthSessionRemoval.ts');
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    const env = { config: { get: () => undefined }, storageLayer, logger: { warn: () => {}, debug: () => {}, info: () => {} } };
    const clientId = 'oswm-' + cuid().slice(-8);
    const alias = await usersRepository.mintAlias(username, userId);
    const minted = await createSessions(env).mintAccessDirect({
      userId, username, clientId, permissions: [{ streamId: '*', level: 'read' }], expiresAt: Date.now() + 600_000, alias,
    });
    const original = usersRepository.releaseAlias;
    usersRepository.releaseAlias = async () => { throw new Error('platform down'); };
    let done;
    try {
      done = await revokeOAuthSessionLocal(storageLayer, { userId, username, accessId: minted.accessId, clientId });
    } finally {
      usersRepository.releaseAlias = original;
    }
    assert.strictEqual(done, true);
    const row = await new Promise((resolve, reject) => storageLayer.accesses.findOne({ id: userId, username }, { id: minted.accessId }, null,
      (err, a) => (err != null ? reject(err) : resolve(a))));
    assert.strictEqual(row, null, 'the session is deleted');
    await usersRepository.releaseAlias(alias, userId);
  });

  it('[OSWM2] an access that is not the client\'s OAuth session is left alone', async function () {
    const { revokeOAuthSessionLocal } = require('api-server/src/methods/helpers/oauthSessionRemoval.ts');
    const other = await user.access({ token: cuid(), type: 'app', name: 'not-oauth-' + cuid(), permissions: [{ streamId: '*', level: 'read' }] });
    const done = await revokeOAuthSessionLocal(storageLayer, { userId, username, accessId: other.attrs.id, clientId: 'any' });
    assert.strictEqual(done, false);
    const row = await new Promise((resolve, reject) => storageLayer.accesses.findOne({ id: userId, username }, { id: other.attrs.id }, null,
      (err, a) => (err != null ? reject(err) : resolve(a))));
    assert.ok(row != null, 'still there');
  });
});
