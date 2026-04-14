/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 34 — one-time join-token lifecycle.
 *
 * Tokens are minted by the bootstrap CLI on the issuing core and consumed
 * by that same core's ack endpoint (Phase 4) when the new core calls back
 * to confirm it has joined. Scope is single-core: tokens are stored in a
 * local JSON file on the issuing core's filesystem — the same machine that
 * already holds the cluster CA private key (see ClusterCA.js). No need to
 * put them in PlatformDB: they're never verified anywhere else.
 *
 * Storage file format:
 *   {
 *     "version": 1,
 *     "tokens": {
 *       "<sha256(raw-token), hex>": {
 *         "coreId":     "core-b",
 *         "issuedAt":   1713090000000,
 *         "expiresAt":  1713176400000,
 *         "consumedAt": null | 1713090900000,
 *         "consumerIp": null | "1.2.3.4"
 *       },
 *       ...
 *     }
 *   }
 *
 * Writes are atomic (write to tmp + rename). Callers must not share a
 * TokenStore instance across processes on the same file without external
 * locking — in practice the CLI runs once and exits, and the ack endpoint
 * serializes through a short read-modify-write.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const RAW_TOKEN_BYTES = 32;

class TokenStore {
  /**
   * @param {Object} opts
   * @param {string} opts.path - absolute path to the JSON file backing the store.
   */
  constructor ({ path: filePath }) {
    if (!filePath) throw new Error('TokenStore: path is required');
    this.path = filePath;
  }

  /**
   * Mint a new one-time join token for a specific core.
   *
   * @param {Object} opts
   * @param {string} opts.coreId
   * @param {number} [opts.ttlMs=24h]
   * @param {number} [opts.now=Date.now()] - injectable for testing
   * @returns {{ token: string, coreId: string, issuedAt: number, expiresAt: number }}
   */
  mint ({ coreId, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
    if (!coreId) throw new Error('TokenStore.mint: coreId is required');
    if (!(Number.isInteger(ttlMs) && ttlMs > 0)) {
      throw new Error('TokenStore.mint: ttlMs must be a positive integer');
    }
    const raw = crypto.randomBytes(RAW_TOKEN_BYTES).toString('base64url');
    const hash = sha256(raw);
    const entry = {
      coreId,
      issuedAt: now,
      expiresAt: now + ttlMs,
      consumedAt: null,
      consumerIp: null
    };
    const store = this._load();
    store.tokens[hash] = entry;
    this._save(store);
    return { token: raw, coreId, issuedAt: entry.issuedAt, expiresAt: entry.expiresAt };
  }

  /**
   * Verify a raw token. Does NOT consume it. Useful for dry-run checks or
   * for the ack endpoint's early-reject path.
   *
   * @param {string} rawToken
   * @param {Object} [opts]
   * @param {number} [opts.now=Date.now()]
   * @returns {{ ok: boolean, coreId?: string, reason?: string }}
   */
  verify (rawToken, { now = Date.now() } = {}) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return { ok: false, reason: 'invalid-format' };
    }
    const store = this._load();
    const entry = store.tokens[sha256(rawToken)];
    if (entry == null) return { ok: false, reason: 'unknown' };
    if (entry.consumedAt != null) return { ok: false, reason: 'already-consumed' };
    if (entry.expiresAt <= now) return { ok: false, reason: 'expired' };
    return { ok: true, coreId: entry.coreId };
  }

  /**
   * Atomically consume a raw token. Returns ok:true only if the token was
   * valid AND had not been consumed before. Any second call with the same
   * token returns ok:false.
   *
   * @param {string} rawToken
   * @param {Object} [opts]
   * @param {string|null} [opts.consumerIp=null] - recorded for audit
   * @param {number} [opts.now=Date.now()]
   * @returns {{ ok: boolean, coreId?: string, reason?: string }}
   */
  consume (rawToken, { consumerIp = null, now = Date.now() } = {}) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return { ok: false, reason: 'invalid-format' };
    }
    const store = this._load();
    const hash = sha256(rawToken);
    const entry = store.tokens[hash];
    if (entry == null) return { ok: false, reason: 'unknown' };
    if (entry.consumedAt != null) return { ok: false, reason: 'already-consumed' };
    if (entry.expiresAt <= now) return { ok: false, reason: 'expired' };
    entry.consumedAt = now;
    entry.consumerIp = consumerIp;
    this._save(store);
    return { ok: true, coreId: entry.coreId };
  }

  /**
   * List tokens that have not been consumed and have not expired.
   * Does NOT return raw tokens (we only store hashes) — only metadata.
   *
   * @param {Object} [opts]
   * @param {number} [opts.now=Date.now()]
   * @returns {Array<{ coreId: string, issuedAt: number, expiresAt: number }>}
   */
  listActive ({ now = Date.now() } = {}) {
    const store = this._load();
    return Object.values(store.tokens)
      .filter(e => e.consumedAt == null && e.expiresAt > now)
      .map(({ coreId, issuedAt, expiresAt }) => ({ coreId, issuedAt, expiresAt }));
  }

  /**
   * Revoke all active tokens for a given core. Returns the number of
   * tokens revoked.
   *
   * @param {string} coreId
   * @returns {number}
   */
  revokeByCoreId (coreId) {
    if (!coreId) throw new Error('TokenStore.revokeByCoreId: coreId is required');
    const store = this._load();
    let count = 0;
    for (const hash of Object.keys(store.tokens)) {
      const e = store.tokens[hash];
      if (e.coreId === coreId && e.consumedAt == null) {
        delete store.tokens[hash];
        count++;
      }
    }
    if (count > 0) this._save(store);
    return count;
  }

  /**
   * Drop expired or consumed tokens older than `retainMs` from the store.
   * Returns the number of entries removed. Purely housekeeping; a stale
   * consumed entry is harmless (it stays rejected).
   *
   * @param {Object} [opts]
   * @param {number} [opts.retainMs=7 days] - how long to keep consumed/expired entries for audit
   * @param {number} [opts.now=Date.now()]
   * @returns {number}
   */
  purge ({ retainMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    const store = this._load();
    let count = 0;
    for (const hash of Object.keys(store.tokens)) {
      const e = store.tokens[hash];
      const cutoff = (e.consumedAt ?? e.expiresAt) + retainMs;
      if (cutoff <= now) {
        delete store.tokens[hash];
        count++;
      }
    }
    if (count > 0) this._save(store);
    return count;
  }

  // --- private helpers ---

  _load () {
    if (!fs.existsSync(this.path)) {
      return { version: STORE_VERSION, tokens: {} };
    }
    const raw = fs.readFileSync(this.path, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      throw new Error(`TokenStore: cannot parse ${this.path}: ${err.message}`);
    }
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`TokenStore: unsupported version ${parsed.version} (expected ${STORE_VERSION})`);
    }
    if (parsed.tokens == null || typeof parsed.tokens !== 'object') {
      throw new Error(`TokenStore: malformed tokens field in ${this.path}`);
    }
    return parsed;
  }

  _save (store) {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }
}

function sha256 (s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = TokenStore;
