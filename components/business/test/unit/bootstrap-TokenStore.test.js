/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 34 Phase 2c — TokenStore.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TokenStore = require('../../src/bootstrap/TokenStore');

describe('[TOKENSTORE] TokenStore', () => {
  let tmpDir;
  let storePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-tokenstore-'));
    storePath = path.join(tmpDir, 'tokens.json');
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('mint()', () => {
    it('returns a token and persists hashed entry', () => {
      const s = new TokenStore({ path: storePath });
      const { token, coreId, issuedAt, expiresAt } = s.mint({ coreId: 'core-b' });
      assert(token.length >= 32, 'token should be non-trivial');
      assert.equal(coreId, 'core-b');
      assert(expiresAt > issuedAt);
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      assert.equal(raw.version, 1);
      // File should NOT contain the raw token string
      const fileStr = JSON.stringify(raw);
      assert(!fileStr.includes(token), 'raw token must not be persisted');
      // File should contain exactly one entry for core-b
      const entries = Object.values(raw.tokens);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].coreId, 'core-b');
    });

    it('uses a 24h TTL by default', () => {
      const s = new TokenStore({ path: storePath });
      const now = 1_700_000_000_000;
      const { expiresAt } = s.mint({ coreId: 'c', now });
      assert.equal(expiresAt - now, 24 * 60 * 60 * 1000);
    });

    it('respects a custom ttlMs', () => {
      const s = new TokenStore({ path: storePath });
      const now = 1_700_000_000_000;
      const { expiresAt } = s.mint({ coreId: 'c', ttlMs: 5000, now });
      assert.equal(expiresAt - now, 5000);
    });

    it('rejects missing coreId', () => {
      const s = new TokenStore({ path: storePath });
      assert.throws(() => s.mint({}), /coreId/);
    });

    it('rejects non-positive ttlMs', () => {
      const s = new TokenStore({ path: storePath });
      assert.throws(() => s.mint({ coreId: 'c', ttlMs: 0 }), /ttlMs/);
      assert.throws(() => s.mint({ coreId: 'c', ttlMs: -1 }), /ttlMs/);
    });

    it('writes with 0600 permissions', () => {
      const s = new TokenStore({ path: storePath });
      s.mint({ coreId: 'c' });
      const mode = fs.statSync(storePath).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  });

  describe('verify()', () => {
    it('returns ok:true for a fresh token', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'core-b' });
      assert.deepEqual(s.verify(token), { ok: true, coreId: 'core-b' });
    });

    it('rejects unknown token', () => {
      const s = new TokenStore({ path: storePath });
      s.mint({ coreId: 'core-b' });
      const res = s.verify('totally-not-a-real-token');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'unknown');
    });

    it('rejects empty or non-string', () => {
      const s = new TokenStore({ path: storePath });
      assert.equal(s.verify('').ok, false);
      assert.equal(s.verify(null).ok, false);
      assert.equal(s.verify(42).ok, false);
    });

    it('rejects expired token', () => {
      const s = new TokenStore({ path: storePath });
      const now = 1_000;
      const { token } = s.mint({ coreId: 'c', ttlMs: 100, now });
      const res = s.verify(token, { now: now + 101 });
      assert.deepEqual(res, { ok: false, reason: 'expired' });
    });

    it('does not consume the token (repeat verify stays ok)', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'c' });
      assert.equal(s.verify(token).ok, true);
      assert.equal(s.verify(token).ok, true);
    });
  });

  describe('consume()', () => {
    it('returns ok:true on first use', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'core-b' });
      assert.deepEqual(s.consume(token, { consumerIp: '1.2.3.4' }), { ok: true, coreId: 'core-b' });
    });

    it('rejects second use of the same token', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'core-b' });
      s.consume(token);
      const res = s.consume(token);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'already-consumed');
    });

    it('verify() also rejects after consume()', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'c' });
      s.consume(token);
      assert.equal(s.verify(token).ok, false);
    });

    it('persists consumedAt and consumerIp', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'c' });
      const now = 123456;
      s.consume(token, { consumerIp: '9.9.9.9', now });
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const entry = Object.values(raw.tokens)[0];
      assert.equal(entry.consumedAt, now);
      assert.equal(entry.consumerIp, '9.9.9.9');
    });

    it('rejects expired token even on first consume', () => {
      const s = new TokenStore({ path: storePath });
      const now = 1000;
      const { token } = s.mint({ coreId: 'c', ttlMs: 100, now });
      const res = s.consume(token, { now: now + 200 });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'expired');
    });
  });

  describe('listActive() and revokeByCoreId()', () => {
    it('listActive excludes consumed and expired tokens', () => {
      const s = new TokenStore({ path: storePath });
      const now = 1000;
      const { token: activeTok } = s.mint({ coreId: 'a', ttlMs: 10_000, now });
      const { token: expiredTok } = s.mint({ coreId: 'b', ttlMs: 100, now });
      const { token: consumedTok } = s.mint({ coreId: 'c', ttlMs: 10_000, now });
      s.consume(consumedTok, { now });
      const active = s.listActive({ now: now + 500 });
      assert.equal(active.length, 1);
      assert.equal(active[0].coreId, 'a');
      // Spot-check that raw tokens are never returned
      const activeSerialized = JSON.stringify(active);
      assert(!activeSerialized.includes(activeTok));
      assert(!activeSerialized.includes(expiredTok));
      assert(!activeSerialized.includes(consumedTok));
    });

    it('revokeByCoreId removes all active tokens for a coreId', () => {
      const s = new TokenStore({ path: storePath });
      s.mint({ coreId: 'a' });
      s.mint({ coreId: 'a' });
      s.mint({ coreId: 'b' });
      const count = s.revokeByCoreId('a');
      assert.equal(count, 2);
      const remaining = s.listActive();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].coreId, 'b');
    });

    it('revokeByCoreId does not remove already-consumed entries', () => {
      const s = new TokenStore({ path: storePath });
      const { token } = s.mint({ coreId: 'a' });
      s.consume(token);
      const count = s.revokeByCoreId('a');
      assert.equal(count, 0);
      // Consumed entry still present in the file (for audit)
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      assert.equal(Object.keys(raw.tokens).length, 1);
    });

    it('revokeByCoreId throws when coreId missing', () => {
      const s = new TokenStore({ path: storePath });
      assert.throws(() => s.revokeByCoreId(), /coreId/);
    });
  });

  describe('purge()', () => {
    it('drops entries older than retainMs past their expiry / consumption', () => {
      const s = new TokenStore({ path: storePath });
      const now = 10_000;
      s.mint({ coreId: 'a', ttlMs: 100, now });
      const { token: oldConsumed } = s.mint({ coreId: 'b', ttlMs: 10_000, now });
      s.consume(oldConsumed, { now });
      s.mint({ coreId: 'c', ttlMs: 1_000_000, now });
      const retainMs = 500;
      const removed = s.purge({ retainMs, now: now + 10_000 });
      assert.equal(removed, 2);
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const entries = Object.values(raw.tokens);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].coreId, 'c');
    });

    it('returns 0 when nothing to remove', () => {
      const s = new TokenStore({ path: storePath });
      s.mint({ coreId: 'a' });
      assert.equal(s.purge(), 0);
    });
  });

  describe('persistence across instances', () => {
    it('two TokenStore instances see the same minted token', () => {
      const s1 = new TokenStore({ path: storePath });
      const { token } = s1.mint({ coreId: 'core-b' });
      const s2 = new TokenStore({ path: storePath });
      assert.equal(s2.verify(token).ok, true);
    });

    it('handles an empty / non-existent storage file', () => {
      const s = new TokenStore({ path: storePath });
      assert.equal(s.verify('anything').ok, false);
      assert.deepEqual(s.listActive(), []);
      assert.equal(s.purge(), 0);
    });

    it('rejects a malformed JSON file', () => {
      fs.writeFileSync(storePath, 'not json');
      const s = new TokenStore({ path: storePath });
      assert.throws(() => s.listActive(), /cannot parse/);
    });

    it('rejects an unsupported version', () => {
      fs.writeFileSync(storePath, JSON.stringify({ version: 99, tokens: {} }));
      const s = new TokenStore({ path: storePath });
      assert.throws(() => s.listActive(), /unsupported version 99/);
    });
  });
});
