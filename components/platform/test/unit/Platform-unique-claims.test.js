/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { Platform } = require('../../src/Platform.ts');
const { PiiHasher, PEPPER_BYTES } = require('../../src/PiiHasher.ts');

/**
 * Concurrency of unique-field writes on the update paths (`updateUser`), run
 * against an in-memory PlatformDB whose writes can be held or interleaved, so
 * the race windows are exercised deterministically:
 *  - two accounts updating to the same value at once: exactly one wins, the
 *    loser keeps its previous value's row;
 *  - a registration reserving the value between an update's check and its
 *    write: the registration keeps the row;
 *  - the user insert after a registration reserve: an own row is claimed again
 *    without error.
 */

const PEPPER_B64 = crypto.randomBytes(PEPPER_BYTES).toString('base64');
const SEP = ' ';

/**
 * In-memory PlatformDB with the real engines' row model. `beforeWrite(username,
 * field, value)` runs before every unique-row write (plain or if-absent), which
 * lets a test hold a write or slip another operation in front of it.
 */
function makeFakePlatformDB () {
  const unique = new Map();
  const indexed = new Map();
  const hooks = { beforeWrite: null };
  async function beforeWrite (username, field, value) {
    if (hooks.beforeWrite != null) await hooks.beforeWrite(username, field, value);
  }
  return {
    hooks,
    async setUserUniqueField (username, field, value) {
      await beforeWrite(username, field, value);
      unique.set(field + SEP + value, username);
    },
    async setUserUniqueFieldIfNotExists (username, field, value) {
      await beforeWrite(username, field, value);
      const k = field + SEP + value;
      if (!unique.has(k)) unique.set(k, username);
      return unique.get(k) === username;
    },
    async deleteUserUniqueField (field, value) { unique.delete(field + SEP + value); },
    async getUsersUniqueField (field, value) {
      const k = field + SEP + value;
      return unique.has(k) ? unique.get(k) : null;
    },
    async setUserIndexedField (username, field, value) { indexed.set(username + SEP + field, value); },
    async deleteUserIndexedField (username, field) { indexed.delete(username + SEP + field); },
    async getUserIndexedField (username, field) {
      const k = username + SEP + field;
      return indexed.has(k) ? indexed.get(k) : null;
    }
  };
}

function makePlatform (hashed) {
  const platform = new Platform();
  const db = makeFakePlatformDB();
  platform._setDependenciesForTests(db, hashed ? new PiiHasher(PEPPER_B64) : null);
  return { platform, db };
}

function emailUpdate (value, previousValue) {
  return [{ action: 'update', key: 'email', value, previousValue, isUnique: true, isActive: true }];
}

async function ownerOf (platform, value) {
  return await platform.getUsersUniqueField('email', value);
}

for (const hashed of [false, true]) {
  const mode = hashed ? 'hashed' : 'cleartext';

  describe(`[PLUC] unique-field claims on update paths (${mode})`, () => {
    it('[PLUC1] two concurrent updates to one value: one wins, the loser keeps its previous row', async () => {
      const { platform, db } = makePlatform(hashed);
      const X = 'contested@x.com';
      assert.equal(await platform.reserveUserUniqueValue('alice', 'email', 'alice@x.com'), true);
      assert.equal(await platform.reserveUserUniqueValue('bob', 'email', 'bob@x.com'), true);

      // Hold every write of X until both updates reach it (both have read the
      // value as free by then), then let them go together.
      const xToken = hashed ? platform.hashFor('email', X) : X;
      let held = [];
      db.hooks.beforeWrite = (username, field, value) => {
        if (value !== xToken) return;
        return new Promise((resolve) => {
          held.push(resolve);
          if (held.length >= 2) { held.forEach((r) => r()); held = []; }
          setTimeout(resolve, 200);
        });
      };

      const outcomes = await Promise.allSettled([
        platform.updateUser('alice', emailUpdate(X, 'alice@x.com')),
        platform.updateUser('bob', emailUpdate(X, 'bob@x.com'))
      ]);
      db.hooks.beforeWrite = null;

      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.filter((o) => o.status === 'rejected');
      assert.equal(won.length, 1, 'exactly one update may succeed');
      assert.equal(lost.length, 1, 'exactly one update must be refused');
      assert.equal(lost[0].reason.id, 'item-already-exists');

      const winner = outcomes[0].status === 'fulfilled' ? 'alice' : 'bob';
      const loser = winner === 'alice' ? 'bob' : 'alice';
      assert.equal(await ownerOf(platform, X), platform.hashFor('username', winner));
      assert.equal(await ownerOf(platform, loser + '@x.com'), platform.hashFor('username', loser),
        'the refused account still owns its previous address');
      assert.equal(await ownerOf(platform, winner + '@x.com'), null,
        'the winner released its previous address');
    });

    it('[PLUC2] a registration reserving the value inside an update window keeps the row', async () => {
      const { platform, db } = makePlatform(hashed);
      const X = 'window@x.com';
      assert.equal(await platform.reserveUserUniqueValue('bob', 'email', 'bob@x.com'), true);

      // The registration lands after bob read X as free, right before bob's write.
      const bobToken = platform.hashFor('username', 'bob');
      let registered = null;
      db.hooks.beforeWrite = async (username) => {
        if (username !== bobToken || registered != null) return;
        registered = await platform.reserveUserUniqueValue('reg', 'email', X);
      };

      await assert.rejects(platform.updateUser('bob', emailUpdate(X, 'bob@x.com')),
        (err) => err.id === 'item-already-exists');
      db.hooks.beforeWrite = null;

      assert.equal(registered, true, 'the registration reserved the value');
      assert.equal(await ownerOf(platform, X), platform.hashFor('username', 'reg'),
        'the registration keeps the row, never silently moved to the updater');
      assert.equal(await ownerOf(platform, 'bob@x.com'), bobToken, 'bob keeps his previous address');
    });

    it('[PLUC3] the user insert claims again a value its registration already reserved', async () => {
      const { platform } = makePlatform(hashed);
      const X = 'own@x.com';
      assert.equal(await platform.reserveUserUniqueValue('carol', 'email', X), true);
      await platform.updateUser('carol', [{ action: 'create', key: 'email', value: X, isUnique: true, isActive: true }]);
      assert.equal(await ownerOf(platform, X), platform.hashFor('username', 'carol'));
    });

    it('[PLUC4] a create on a value another account owns is refused and leaves the row', async () => {
      const { platform } = makePlatform(hashed);
      const X = 'other@x.com';
      assert.equal(await platform.reserveUserUniqueValue('dave', 'email', X), true);
      await assert.rejects(
        platform.updateUser('erin', [{ action: 'create', key: 'email', value: X, isUnique: true, isActive: true }]),
        (err) => err.id === 'item-already-exists');
      assert.equal(await ownerOf(platform, X), platform.hashFor('username', 'dave'));
    });

    it('[PLUC5] an update to the current value keeps its row', async () => {
      const { platform } = makePlatform(hashed);
      const X = 'same@x.com';
      assert.equal(await platform.reserveUserUniqueValue('fred', 'email', X), true);
      await platform.updateUser('fred', emailUpdate(X, X));
      assert.equal(await ownerOf(platform, X), platform.hashFor('username', 'fred'));
    });
  });
}
