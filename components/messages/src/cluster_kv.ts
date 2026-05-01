/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

/**
 * Plan 55 Phase 3 — cluster_kv: master-held key/value store with TTL,
 * accessed by workers over the existing cluster IPC channel.
 *
 * Single-core scope. For cross-core state use PlatformDB.
 *
 * Wire protocol:
 *   worker → master : { type: 'kv:get'|'kv:set'|'kv:delete'|'kv:clear',
 *                       requestId, key?, value?, ttlMs? }
 *   master → worker : { type: 'kv:reply', requestId, ok, value?, error? }
 *
 * Failure semantics: workers fast-fail. `get` returns null when no IPC
 * channel is available (single-process tests, run-from-CLI). `set` /
 * `delete` / `clear` throw in that case so callers learn early.
 */

const { randomUUID } = require('node:crypto');

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const SWEEP_INTERVAL_MS = 60_000;

let _masterRunning = false;
let _store: Map<any, any> | null = null;
let _sweepTimer: any = null;
let _ipcHandler: any = null;
let _log: (...args: any[]) => void = () => {};

let _cluster: any = null;

/**
 * Initialise the master-side handler. Call once from `bin/master.js` after
 * `cluster.setupPrimary()`. Idempotent — second call is a no-op.
 *
 * @param {Object} opts
 * @param {Function} [opts.log] - logger; called with (msg)
 * @param {Object} [opts.cluster] - injectable for tests; defaults to `require('node:cluster')`
 */
function masterStart (opts: any = {}) {
  if (_masterRunning) return;
  _masterRunning = true;
  _log = typeof opts.log === 'function' ? opts.log : () => {};
  _store = new Map();

  _cluster = opts.cluster || require('node:cluster');
  _ipcHandler = (worker, msg) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('kv:')) return;
    if (msg.type === 'kv:reply') return; // master never receives replies
    const reply = (body) => {
      try { worker.send({ type: 'kv:reply', requestId: msg.requestId, ...body }); } catch (_) {
        // worker died between request + reply; not fatal
      }
    };
    try {
      switch (msg.type) {
        case 'kv:get': {
          const entry = _store.get(msg.key);
          if (!entry) return reply({ ok: true, value: null });
          if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
            _store.delete(msg.key);
            return reply({ ok: true, value: null });
          }
          return reply({ ok: true, value: entry.value });
        }
        case 'kv:set': {
          const expiresAt = (typeof msg.ttlMs === 'number' && msg.ttlMs > 0)
            ? Date.now() + msg.ttlMs
            : null;
          _store.set(msg.key, { value: msg.value, expiresAt });
          return reply({ ok: true });
        }
        case 'kv:delete':
          _store.delete(msg.key);
          return reply({ ok: true });
        case 'kv:clear':
          _store.clear();
          return reply({ ok: true });
        default:
          return reply({ ok: false, error: 'cluster_kv: unknown op ' + msg.type });
      }
    } catch (err) {
      reply({ ok: false, error: 'cluster_kv master error: ' + err.message });
    }
  };
  _cluster.on('message', _ipcHandler);

  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of _store) {
      if (entry.expiresAt != null && now > entry.expiresAt) _store.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  _sweepTimer.unref();
  _log('cluster_kv master started');
}

/**
 * Stop the master-side handler + clear the store. Mainly for tests.
 */
function masterStop () {
  if (!_masterRunning) return;
  if (_cluster && _ipcHandler) _cluster.removeListener('message', _ipcHandler);
  _ipcHandler = null;
  _cluster = null;
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = null;
  if (_store) _store.clear();
  _store = null;
  _masterRunning = false;
}

/**
 * Read access to master's store — used by the in-process test path that
 * wants to introspect without going through IPC.
 */
function _masterStoreForTests () {
  return _store;
}

// ---------- Worker-side client ----------

function _request (payload, processHandle, timeoutMs) {
  if (typeof processHandle.send !== 'function') {
    return { _noChannel: true };
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMsg = (msg) => {
      if (settled) return;
      if (!msg || msg.type !== 'kv:reply' || msg.requestId !== requestId) return;
      settled = true;
      clearTimeout(timer);
      processHandle.removeListener('message', onMsg);
      if (msg.ok) {
        resolve({ value: msg.value });
      } else {
        reject(new Error(msg.error || 'cluster_kv error'));
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      processHandle.removeListener('message', onMsg);
      reject(new Error(`cluster_kv timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    processHandle.on('message', onMsg);
    try {
      processHandle.send({ ...payload, requestId });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.removeListener('message', onMsg);
      reject(new Error('cluster_kv send failed: ' + err.message));
    }
  });
}

/**
 * In-process fallback used when `process.send` is unavailable — i.e. the
 * caller isn't running under `cluster.fork()`. Single-process api-server
 * tests, single-worker deployments, and CLI tools all hit this path. The
 * fallback is just a local Map with the same TTL semantics as master.
 */
class _InProcessStore {
  store: Map<any, any>;
  constructor () { this.store = new Map(); }
  _get (key: any): any {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get (key: any): Promise<any> { return this._get(key); }
  async set (key: any, value: any, { ttlMs }: { ttlMs?: number } = {}): Promise<void> {
    const expiresAt = (typeof ttlMs === 'number' && ttlMs > 0) ? Date.now() + ttlMs : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete (key: any): Promise<void> { this.store.delete(key); }
  async clear (): Promise<void> { this.store.clear(); }
}

const _SHARED_FALLBACK = new _InProcessStore();

/**
 * Build a client handle. The default uses the live `process` IPC channel
 * when one is available, falling back to a per-process in-memory store
 * otherwise (so single-process scenarios still get correct semantics
 * within their one process). Tests inject `processHandle` to drive a
 * specific channel.
 *
 * @param {Object} [opts]
 * @param {NodeJS.Process|EventEmitter} [opts.processHandle=process]
 * @param {number} [opts.timeoutMs=5000]
 * @param {boolean} [opts.fallback=true] - when false, raise instead of using the in-process store.
 */
function clientFor ({ processHandle = process, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fallback = true } = {}) {
  // Detect "no IPC channel" up-front so we can pick the fallback once and
  // share it across this client's lifetime (consistent semantics within a
  // single process).
  if (typeof processHandle.send !== 'function') {
    if (!fallback) {
      return {
        async get () { return null; },
        async set () { throw new Error('cluster_kv.set: not running under cluster (no IPC channel)'); },
        async delete () { throw new Error('cluster_kv.delete: not running under cluster (no IPC channel)'); },
        async clear () { throw new Error('cluster_kv.clear: not running under cluster (no IPC channel)'); }
      };
    }
    return _SHARED_FALLBACK;
  }
  return {
    async get (key: any) {
      const reply: any = await _request({ type: 'kv:get', key }, processHandle, timeoutMs);
      return reply.value ?? null;
    },
    async set (key: any, value: any, { ttlMs }: { ttlMs?: number } = {}) {
      await _request({ type: 'kv:set', key, value, ttlMs }, processHandle, timeoutMs);
    },
    async delete (key: any) {
      await _request({ type: 'kv:delete', key }, processHandle, timeoutMs);
    },
    async clear () {
      await _request({ type: 'kv:clear' }, processHandle, timeoutMs);
    }
  };
}

/**
 * Reset the shared in-process fallback store — for tests that need a
 * clean slate when running outside cluster.
 */
function _resetInProcessFallbackForTests () {
  _SHARED_FALLBACK.store.clear();
}

module.exports = {
  masterStart,
  masterStop,
  clientFor,
  _masterStoreForTests,
  _resetInProcessFallbackForTests
};
