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

/**
 * Invitation tokens must never be stored as a usable key: PlatformDB is
 * replicated to every core (rqlite) and backed up, so the row KEY is the
 * token's SHA-256, and the admin listing exposes only description + creation
 * info. These tests run the real Platform code against an in-memory PlatformDB
 * fake that models the engines' `invitation/<key>` keyValue store.
 */

function sha256 (token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** In-memory PlatformDB fake: invitation rows keyed verbatim by the given key. */
function makeFakePlatformDB () {
  const invitations = new Map(); // key -> info
  return {
    invitations,
    async createInvitationToken (key, info) { invitations.set(key, JSON.parse(JSON.stringify(info))); },
    async getInvitationToken (key) { return invitations.has(key) ? JSON.parse(JSON.stringify(invitations.get(key))) : null; },
    async getAllInvitationTokens () {
      return [...invitations.entries()].map(([key, info]) => ({ id: key, ...info }));
    },
    async updateInvitationToken (key, info) { invitations.set(key, JSON.parse(JSON.stringify(info))); },
    async deleteInvitationToken (key) { invitations.delete(key); }
  };
}

function makePlatform () {
  const platform = new Platform();
  const db = makeFakePlatformDB();
  platform._setDependenciesForTests(db, null);
  return { platform, db };
}

describe('[INVT] invitation tokens stored hashed at rest', () => {
  it('[INVT1] generated tokens are keyed by their hash, never by the raw token', async () => {
    const { platform, db } = makePlatform();
    const created = await platform.generateInvitationTokens(1, 'admin', 'a-marker');
    const raw = created[0].id;

    assert.ok(!db.invitations.has(raw), 'raw token must not be a storage key');
    assert.ok(db.invitations.has(sha256(raw)), 'token must be stored under its hash');
    // the raw token still validates (it hashes to the stored key)
    assert.strictEqual(await platform.isInvitationTokenValid(raw), true);
  });

  it('[INVT2] the admin listing exposes the hash + metadata, not the raw token or the marker', async () => {
    const { platform } = makePlatform();
    const raw = (await platform.generateInvitationTokens(1, 'admin', 'listed'))[0].id;

    const list = await platform.getAllInvitationTokens();
    assert.strictEqual(list.length, 1);
    assert.notStrictEqual(list[0].id, raw, 'raw token must not appear as an id');
    assert.strictEqual(list[0].id, sha256(raw));
    assert.strictEqual(list[0].description, 'listed');
    assert.strictEqual(list[0].keyHashed, undefined, 'internal marker must be stripped');
  });

  it('[INVT3] consuming a token invalidates it', async () => {
    const { platform } = makePlatform();
    const raw = (await platform.generateInvitationTokens(1, 'admin', ''))[0].id;
    assert.strictEqual(await platform.isInvitationTokenValid(raw), true);
    await platform.consumeInvitationToken(raw, 'someuser');
    assert.strictEqual(await platform.isInvitationTokenValid(raw), false);
  });

  it('[INVT4] boot migration re-keys a legacy raw-keyed token to its hash', async () => {
    const { platform, db } = makePlatform();
    // Simulate a row written by a previous core version: keyed by the raw token,
    // no keyHashed marker.
    db.invitations.set('legacy-raw-token', { createdAt: 1, createdBy: 'old', description: 'legacy' });

    await platform._migrateInvitationTokensForTests();

    assert.ok(!db.invitations.has('legacy-raw-token'), 'legacy raw key must be removed');
    const hashedKey = sha256('legacy-raw-token');
    assert.ok(db.invitations.has(hashedKey), 'token must be re-keyed under its hash');
    assert.strictEqual(db.invitations.get(hashedKey).keyHashed, true);
    assert.strictEqual(db.invitations.get(hashedKey).description, 'legacy');
    // the token still validates through the normal (hashing) lookup
    assert.strictEqual(await platform.isInvitationTokenValid('legacy-raw-token'), true);
  });

  it('[INVT5] the migration is idempotent: a hashed row is not re-hashed on a second boot', async () => {
    const { platform, db } = makePlatform();
    db.invitations.set('legacy-raw-token', { createdAt: 1, createdBy: 'old', description: 'legacy' });

    await platform._migrateInvitationTokensForTests();
    const afterFirst = new Map(db.invitations);
    await platform._migrateInvitationTokensForTests();

    assert.strictEqual(db.invitations.size, afterFirst.size, 'second migration must not add rows');
    for (const [k, v] of afterFirst.entries()) {
      assert.deepStrictEqual(db.invitations.get(k), v, 'rows must be unchanged by the second migration');
    }
  });
});
