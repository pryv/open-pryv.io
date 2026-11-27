/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADSS] administrator sessions: an end wins over a renewal racing it, in
 * every interleaving of the renewal's consume-then-set with the end. Over an
 * in-memory store with the platform store's semantics whose writes can be
 * held, so each interleaving is played deterministically (the engines are
 * covered by [ADKC]).
 */

import assert from 'node:assert/strict';
import { createAdminSession, renewAdminSession, endAdminSession, readAdminSession, resolveAdminSession, ENDED_SESSION_MARK_MS } from '../../src/admin/sessions.ts';
import { grantRole } from '../../src/admin/roles.ts';
import { KEYS } from '../../src/admin/store.ts';
import { hashToken } from '../../src/admin/codes.ts';

const MIN = 60 * 1000;

/** In-memory store; `hold(op, keyPrefix)` pauses the next matching call until released. */
function memoryStore () {
  const kv = new Map();
  const states = new Map();
  const holds = [];
  const live = (key) => {
    const e = states.get(key);
    if (e == null) return null;
    if (Date.now() > e.expiresAt) { states.delete(key); return null; }
    return e;
  };
  async function gate (op, key) {
    const i = holds.findIndex((h) => h.op === op && key.startsWith(h.prefix));
    if (i < 0) return;
    const [h] = holds.splice(i, 1);
    h.reached();
    await h.released;
  }
  return {
    states,
    hold (op, prefix) {
      let reached, release;
      const reachedP = new Promise((resolve) => { reached = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      holds.push({ op, prefix, reached, released });
      return { reached: reachedP, release };
    },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async setPlatformKvIfAbsent (k, v) { if (kv.has(k)) return false; kv.set(k, v); return true; },
    async replacePlatformKvIfValue (k, expected, next) { if (kv.get(k) !== expected) return false; if (next == null) kv.delete(k); else kv.set(k, next); return true; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvEntries (prefix) { return [...kv].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
    async setAccessState (k, value, expiresAt) { await gate('set', k); states.set(k, JSON.parse(JSON.stringify({ value, expiresAt }))); },
    async getAccessState (k) { await gate('get', k); return live(k); },
    async deleteAccessState (k) { await gate('delete', k); states.delete(k); },
    async consumeAccessState (k) { await gate('consume', k); const e = live(k); states.delete(k); return e; },
    async bumpWindowedCounter () { return null; }
  };
}

describe('[ADSS] administrator sessions: end against renewal', function () {
  let db, token, sessionKey;

  beforeEach(async () => {
    db = memoryStore();
    const now = Date.now();
    await grantRole(db, 'user-a', { role: 'owner', scope: 'platform', grantedBy: 'setup', via: 'setup', now });
    token = (await createAdminSession(db, { userId: 'user-a', homeCore: 'core-a', mfaAt: now, now, ttlMs: 60 * MIN })).token;
    sessionKey = KEYS.adminSessionPrefix + hashToken(token);
  });

  async function assertEnded () {
    assert.equal(await readAdminSession(db, token), null, 'the session reads as gone');
    assert.equal(await resolveAdminSession(db, token, Date.now()), null, 'the session gives no permission');
    assert.equal(db.states.get(sessionKey), undefined, 'no session row is left');
  }

  it('[ADSS1] an end between the consume and the write of a renewal: the renewal fails, the session stays ended', async () => {
    const held = db.hold('set', KEYS.adminSessionPrefix);
    const renewal = renewAdminSession(db, token, { now: Date.now(), ttlMs: 60 * MIN });
    await held.reached; // the row is consumed, its rewrite is pending
    await endAdminSession(db, token);
    held.release();
    assert.equal(await renewal, null, 'the renewal answers that the session is gone');
    await assertEnded();
  });

  it('[ADSS2] an end before the renewal\'s first check: the renewal fails', async () => {
    await endAdminSession(db, token);
    assert.equal(await renewAdminSession(db, token, { now: Date.now(), ttlMs: 60 * MIN }), null);
    await assertEnded();
  });

  it('[ADSS3] an end between the renewal\'s write and its last check: the session stays ended', async () => {
    // The renewal checks the end marker twice: before consuming, after writing.
    const firstCheck = db.hold('get', KEYS.adminSessionEndedPrefix);
    const lastCheck = db.hold('get', KEYS.adminSessionEndedPrefix);
    const renewal = renewAdminSession(db, token, { now: Date.now(), ttlMs: 60 * MIN });
    await firstCheck.reached;
    firstCheck.release();
    await lastCheck.reached; // consumed and rewritten, last check pending
    await endAdminSession(db, token);
    lastCheck.release();
    assert.equal(await renewal, null);
    await assertEnded();
  });

  it('[ADSS6] an end between the renewal\'s first check and its read of the row: the session stays ended', async () => {
    const consume = db.hold('get', KEYS.adminSessionPrefix);
    const renewal = renewAdminSession(db, token, { now: Date.now(), ttlMs: 60 * MIN });
    await consume.reached;
    await endAdminSession(db, token);
    consume.release();
    assert.equal(await renewal, null);
    await assertEnded();
  });

  it('[ADSS4] a row written back after an end (a stale writer) is refused on read', async () => {
    await endAdminSession(db, token);
    await db.setAccessState(sessionKey, { userId: 'user-a', homeCore: 'core-a', mfaAt: Date.now(), createdAt: Date.now() }, Date.now() + 60 * MIN);
    assert.equal(await readAdminSession(db, token), null);
    assert.equal(await resolveAdminSession(db, token, Date.now()), null);
  });

  it('[ADSS5] a renewal without an end extends the session; the end marker outlives the longest session', async () => {
    const before = (await readAdminSession(db, token)).expiresAt;
    const expiresAt = await renewAdminSession(db, token, { now: Date.now() + 1000, ttlMs: 60 * MIN, mfaAt: 123 });
    assert.ok(expiresAt > before);
    const s = await readAdminSession(db, token);
    assert.equal(s.expiresAt, expiresAt);
    assert.equal(s.mfaAt, 123);
    assert.ok(ENDED_SESSION_MARK_MS > 24 * 60 * MIN, 'past admin.session.ttlMinutes at its maximum');
    await endAdminSession(db, token);
    const mark = db.states.get(KEYS.adminSessionEndedPrefix + hashToken(token));
    assert.ok(mark.expiresAt - Date.now() > 24 * 60 * MIN);
    assert.ok(!JSON.stringify([...db.states]).includes(token), 'no plain token in the store');
  });
});
