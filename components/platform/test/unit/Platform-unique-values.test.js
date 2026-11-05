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
 * Behavioural coverage for the per-value unique-field operations and the
 * all-values delete / re-own paths, exercised against an in-memory
 * PlatformDB fake so the real Platform code runs without booting storages.
 *
 * Uniqueness rows are keyed (field, value) -> username, so one user can own
 * several values under one field at once (e.g. more than one verified email).
 * These tests pin: reserve one value, release one value guarded by ownership,
 * enumerate all of a user's values, delete-user releasing every value, and
 * rename-user re-owning every value. Each runs in cleartext and hashed mode.
 */

const PEPPER_B64 = crypto.randomBytes(PEPPER_BYTES).toString('base64');
const SEP = '\0';

/**
 * Minimal in-memory PlatformDB matching the row model of the real engines:
 * unique rows keyed by (field, value) hold the owning username; indexed rows
 * keyed by (username, field) hold their value. Stores whatever bytes it is
 * given (plaintext in cleartext mode, HMAC tokens in hashed mode).
 */
function makeFakePlatformDB () {
  const unique = new Map(); // `${field}\0${value}` -> username
  const indexed = new Map(); // `${username}\0${field}` -> value
  return {
    async setUserUniqueField (username, field, value) { unique.set(field + SEP + value, username); },
    async setUserUniqueFieldIfNotExists (username, field, value) {
      const k = field + SEP + value;
      if (!unique.has(k)) unique.set(k, username);
      return unique.get(k) === username;
    },
    async deleteUserUniqueField (field, value) { unique.delete(field + SEP + value); },
    async getUsersUniqueField (field, value) {
      const k = field + SEP + value;
      return unique.has(k) ? unique.get(k) : null;
    },
    async getUsersUniqueFieldAnyCase (field, value) {
      const out = [];
      for (const [k, username] of unique.entries()) {
        const [f, v] = k.split(SEP);
        if (f === field && v.trim().toLowerCase() === value.trim().toLowerCase()) out.push({ value: v, username });
      }
      return out;
    },
    async setUserIndexedField (username, field, value) { indexed.set(username + SEP + field, value); },
    async deleteUserIndexedField (username, field) { indexed.delete(username + SEP + field); },
    async getUserIndexedField (username, field) {
      const k = username + SEP + field;
      return indexed.has(k) ? indexed.get(k) : null;
    },
    async reassignInvitationConsumer () { /* no invitations in this fake */ },
    async getAllWithPrefix (prefix) {
      const out = [];
      if (prefix === 'user' || prefix === 'user-') {
        for (const [k, username] of unique.entries()) {
          const [field, value] = k.split(SEP);
          out.push({ isUnique: true, field, value, username });
        }
        for (const [k, value] of indexed.entries()) {
          const [username, field] = k.split(SEP);
          out.push({ isUnique: false, field, value, username });
        }
      }
      return out;
    },
    async getAllForUser (username) {
      const out = [];
      for (const [k, owner] of unique.entries()) {
        const [field, value] = k.split(SEP);
        if (owner === username) out.push({ isUnique: true, field, value, username });
      }
      for (const [k, value] of indexed.entries()) {
        const [owner, field] = k.split(SEP);
        if (owner === username) out.push({ isUnique: false, field, value, username });
      }
      return out;
    }
  };
}

function makePlatform ({ hashed }) {
  const platform = new Platform();
  const db = makeFakePlatformDB();
  const hasher = hashed ? new PiiHasher(PEPPER_B64) : null;
  platform._setDependenciesForTests(db, hasher);
  return { platform, db, hasher };
}

// Storage-form value for assertions: plaintext in cleartext mode, HMAC token
// in hashed mode (email is normalised + hashed with its field as salt).
function stored (hasher, field, value) {
  return hasher == null ? value : hasher.hashFor(field, value);
}

for (const hashed of [false, true]) {
  const mode = hashed ? 'hashed' : 'cleartext';

  describe(`[PLAT-UV] per-value unique-field operations (${mode})`, () => {
    it('[PLAT-UV-01] one user reserves several values under one field; list returns all', async () => {
      const { platform, hasher } = makePlatform({ hashed });
      const username = 'alice';
      const emails = ['a1@x.com', 'a2@x.com', 'a3@x.com'];
      for (const email of emails) {
        assert.strictEqual(await platform.reserveUserUniqueValue(username, 'email', email), true);
      }
      const listed = (await platform.listUserUniqueValues(username, 'email')).sort();
      const expected = emails.map(e => stored(hasher, 'email', e)).sort();
      assert.deepStrictEqual(listed, expected);
    });

    it('[PLAT-UV-02] reserve conflicts against another user; each keeps its own value', async () => {
      const { platform } = makePlatform({ hashed });
      const owned = 'shared@x.com';
      const free = 'other@x.com';
      assert.strictEqual(await platform.reserveUserUniqueValue('alice', 'email', owned), true);
      assert.strictEqual(await platform.reserveUserUniqueValue('bob', 'email', owned), false);
      assert.strictEqual(await platform.reserveUserUniqueValue('bob', 'email', free), true);
      // re-reserving your own value is idempotent (true).
      assert.strictEqual(await platform.reserveUserUniqueValue('alice', 'email', owned), true);
    });

    it('[PLAT-UV-03] release only removes a value owned by the caller', async () => {
      const { platform, hasher } = makePlatform({ hashed });
      await platform.reserveUserUniqueValue('alice', 'email', 'keep@x.com');
      await platform.reserveUserUniqueValue('alice', 'email', 'drop@x.com');
      // bob cannot release alice's value.
      assert.strictEqual(await platform.releaseUserUniqueValue('bob', 'email', 'drop@x.com'), false);
      assert.deepStrictEqual(
        (await platform.listUserUniqueValues('alice', 'email')).sort(),
        ['keep@x.com', 'drop@x.com'].map(e => stored(hasher, 'email', e)).sort()
      );
      // owner releases exactly that one value.
      assert.strictEqual(await platform.releaseUserUniqueValue('alice', 'email', 'drop@x.com'), true);
      assert.deepStrictEqual(
        await platform.listUserUniqueValues('alice', 'email'),
        [stored(hasher, 'email', 'keep@x.com')]
      );
      // releasing an absent value is a no-op false.
      assert.strictEqual(await platform.releaseUserUniqueValue('alice', 'email', 'never@x.com'), false);
    });

    it('[PLAT-UV-04] list is scoped to the user and field (excludes others + indexed rows)', async () => {
      const { platform, hasher } = makePlatform({ hashed });
      await platform.reserveUserUniqueValue('alice', 'email', 'a@x.com');
      await platform.reserveUserUniqueValue('alice', 'alias', 'r-alice01');
      await platform.reserveUserUniqueValue('bob', 'email', 'b@x.com');
      await platform.setUserIndexedField('alice', 'language', 'en');
      assert.deepStrictEqual(
        await platform.listUserUniqueValues('alice', 'email'),
        [stored(hasher, 'email', 'a@x.com')]
      );
    });

    it('[PLAT-UV-05] deleteUser releases EVERY value the user owns for a field', async () => {
      const { platform, hasher } = makePlatform({ hashed });
      await platform.reserveUserUniqueValue('alice', 'email', 'a1@x.com');
      await platform.reserveUserUniqueValue('alice', 'email', 'a2@x.com');
      await platform.reserveUserUniqueValue('alice', 'email', 'a3@x.com');
      await platform.setUserIndexedField('alice', 'language', 'en');
      // an unrelated user must survive.
      await platform.reserveUserUniqueValue('bob', 'email', 'b@x.com');

      await platform.deleteUser('alice', null);

      assert.deepStrictEqual(await platform.listUserUniqueValues('alice', 'email'), []);
      assert.strictEqual(await platform.getUserIndexedField('alice', 'language'), null);
      assert.deepStrictEqual(await platform.listUserUniqueValues('bob', 'email'), [stored(hasher, 'email', 'b@x.com')]);
    });

    it('[PLAT-UV-06] renameUser re-owns EVERY value to the new username; values unchanged', async () => {
      const { platform, hasher } = makePlatform({ hashed });
      await platform.reserveUserUniqueValue('alice', 'username', 'alice');
      await platform.reserveUserUniqueValue('alice', 'email', 'a1@x.com');
      await platform.reserveUserUniqueValue('alice', 'email', 'a2@x.com');
      await platform.setUserIndexedField('alice', 'language', 'en');

      await platform.renameUser('alice', 'alice2');

      // old owner holds nothing.
      assert.deepStrictEqual(await platform.listUserUniqueValues('alice', 'email'), []);
      assert.strictEqual(await platform.getUserIndexedField('alice', 'language'), null);
      // new owner holds both email values (unchanged), the moved index, and
      // the username self-row now carries the new username value.
      assert.deepStrictEqual(
        (await platform.listUserUniqueValues('alice2', 'email')).sort(),
        ['a1@x.com', 'a2@x.com'].map(e => stored(hasher, 'email', e)).sort()
      );
      assert.strictEqual(await platform.getUserIndexedField('alice2', 'language'), 'en');
      assert.strictEqual(await platform.getUsersUniqueField('username', 'alice2'), stored(hasher, 'username', 'alice2'));
    });

    it('[PLAT-UV-07] renameUser, deleteUser and listUserUniqueValues read only the rows of the user, never the whole platform', async () => {
      const { platform, db } = makePlatform({ hashed });
      await platform.reserveUserUniqueValue('alice', 'email', 'a1@x.com');
      await platform.setUserIndexedField('alice', 'language', 'en');
      db.getAllWithPrefix = async () => { throw new Error('whole-platform scan'); };
      assert.strictEqual((await platform.listUserUniqueValues('alice', 'email')).length, 1);
      await platform.renameUser('alice', 'alice2');
      await platform.deleteUser('alice2', null);
    });

    it('[PLAT-UV-08] getUniqueValueOwner finds the holder of an email in any case; a binding is compared as written', async () => {
      const { platform, db, hasher } = makePlatform({ hashed });
      await platform.reserveUserUniqueValue('alice', 'email', 'alice@x.com');
      await platform.reserveUserUniqueValue('alice', 'sso-idp', 'Sub-1');
      const alice = stored(hasher, 'username', 'alice');
      for (const spelling of ['alice@x.com', 'Alice@X.com', 'ALICE@X.COM', ' alice@x.com ']) {
        assert.strictEqual(await platform.getUniqueValueOwner('email', spelling), alice, JSON.stringify(spelling));
      }
      assert.strictEqual(await platform.getUniqueValueOwner('email', 'bob@x.com'), null);
      assert.strictEqual(await platform.getUniqueValueOwner('sso-idp', 'Sub-1'), alice);
      assert.strictEqual(await platform.getUniqueValueOwner('sso-idp', 'sub-1'), null);
      if (hashed) {
        // One row per normalised value: the exact read, never the any-case query.
        db.getUsersUniqueFieldAnyCase = async () => { throw new Error('any-case query in hashed mode'); };
        assert.strictEqual(await platform.getUniqueValueOwner('email', 'ALICE@x.com'), alice);
      }
    });

    if (!hashed) {
      it('[PLAT-UV-09] getUniqueValueOwner, several accounts holding one address in several spellings: the exact spelling, else none', async () => {
        const { platform, db } = makePlatform({ hashed });
        await db.setUserUniqueField('alice', 'email', 'User@x.com');
        await db.setUserUniqueField('bob', 'email', 'user@x.com');
        assert.strictEqual(await platform.getUniqueValueOwner('email', 'User@x.com'), 'alice');
        assert.strictEqual(await platform.getUniqueValueOwner('email', 'user@x.com'), 'bob');
        assert.strictEqual(await platform.getUniqueValueOwner('email', 'USER@x.com'), null);
        // One account holding two spellings is still one owner.
        await db.setUserUniqueField('carol', 'email', 'Carol@x.com');
        await db.setUserUniqueField('carol', 'email', 'carol@x.com');
        assert.strictEqual(await platform.getUniqueValueOwner('email', 'CAROL@x.com'), 'carol');
      });
    }
  });
}
