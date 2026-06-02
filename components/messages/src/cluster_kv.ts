/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * cluster_kv: master-held key/value store with TTL, accessed by
 * workers over the existing cluster IPC channel.
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

type StoreEntry = { value: unknown; expiresAt: number | null };
type KvMessage = {
  type: string;
  requestId?: string;
  key?: string;
  value?: unknown;
  ttlMs?: number;
  ok?: boolean;
  error?: string;
};
type WorkerLike = { send: (msg: unknown) => void };
type ProcessLike = {
  send?: (msg: unknown) => void;
  on (event: string, listener: (msg: unknown) => void): unknown;
  removeListener (event: string, listener: (msg: unknown) => void): unknown;
};
type ClusterLike = {
  on: (event: string, handler: (worker: WorkerLike, msg: KvMessage) => void) => void;
  removeListener: (event: string, handler: (worker: WorkerLike, msg: KvMessage) => void) => void;
};

let _masterRunning = false;
let _store: Map<string, StoreEntry> | null = null;
let _sweepTimer: NodeJS.Timeout | null = null;
let _ipcHandler: ((worker: WorkerLike, msg: KvMessage) => void) | null = null;
let _log: (msg: string) => void = () => {};

let _cluster: ClusterLike | null = null;

/**
 * Initialise the master-side handler. Call once from `bin/master.js` after
 * `cluster.setupPrimary()`. Idempotent — second call is a no-op.
 *
 * @param [opts.log] - logger; called with (msg)
 * @param [opts.cluster] - injectable for tests; defaults to `require('node:cluster')`
 */
function masterStart (opts: { log?: (msg: string) => void; cluster?: ClusterLike } = {}) {
  if (_masterRunning) return;
  _masterRunning = true;
  _log = typeof opts.log === 'function' ? opts.log : () => {};
  _store = new Map();

  _cluster = opts.cluster || require('node:cluster');
  _ipcHandler = (worker: WorkerLike, msg: KvMessage) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('kv:')) return;
    if (msg.type === 'kv:reply') return; // master never receives replies
    const reply = (body: Partial<KvMessage>) => {
      try { worker.send({ type: 'kv:reply', requestId: msg.requestId, ...body }); } catch (_) {
        // worker died between request + reply; not fatal
      }
    };
    try {
      switch (msg.type) {
        case 'kv:get': {
          // _store set before _ipcHandler is registered in masterStart
          const entry = _store!.get(msg.key!);
          if (!entry) return reply({ ok: true, value: null });
          if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
            _store!.delete(msg.key!);
            return reply({ ok: true, value: null });
          }
          return reply({ ok: true, value: entry.value });
        }
        case 'kv:set': {
          const expiresAt = (typeof msg.ttlMs === 'number' && msg.ttlMs > 0)
            ? Date.now() + msg.ttlMs
            : null;
          _store!.set(msg.key!, { value: msg.value, expiresAt });
          return reply({ ok: true });
        }
        case 'kv:delete':
          _store!.delete(msg.key!);
          return reply({ ok: true });
        case 'kv:clear':
          _store!.clear();
          return reply({ ok: true });
        default:
          return reply({ ok: false, error: 'cluster_kv: unknown op ' + msg.type });
      }
    } catch (err: unknown) {
      reply({ ok: false, error: 'cluster_kv master error: ' + (err as Error).message });
    }
  };
  _cluster!.on('message', _ipcHandler);

  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of _store!) {
      if (entry.expiresAt != null && now > entry.expiresAt) _store!.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  _sweepTimer!.unref();
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

function _request (payload: Partial<KvMessage>, processHandle: ProcessLike, timeoutMs: number) {
  if (typeof processHandle.send !== 'function') {
    return { _noChannel: true };
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMsg = (raw: unknown) => {
      if (settled) return;
      const msg = raw as KvMessage | null;
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
      processHandle.send!({ ...payload, requestId });
    } catch (err: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.removeListener('message', onMsg);
      reject(new Error('cluster_kv send failed: ' + (err as Error).message));
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
  store: Map<string, StoreEntry>;
  constructor () { this.store = new Map(); }
  _get (key: string): unknown {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get (key: string): Promise<unknown> { return this._get(key); }
  async set (key: string, value: unknown, { ttlMs }: { ttlMs?: number } = {}): Promise<void> {
    const expiresAt = (typeof ttlMs === 'number' && ttlMs > 0) ? Date.now() + ttlMs : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete (key: string): Promise<void> { this.store.delete(key); }
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
 * @param [opts]
 * @param [opts.processHandle=process]
 * @param [opts.timeoutMs=5000]
 * @param [opts.fallback=true] - when false, raise instead of using the in-process store.
 */
function clientFor (opts: { processHandle?: ProcessLike; timeoutMs?: number; fallback?: boolean } = {}) {
  const { processHandle = process as unknown as ProcessLike, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fallback = true } = opts;
  // Mocha-parallel workers have `process.send` wired to the mocha runner —
  // not to a Pryv cluster master. Any IPC the client would send goes
  // unanswered and times out after 5s, surfacing as 500s in tests like
  // [MFAA]. Force the in-process fallback so single-process test scenarios
  // (Pattern C / supertest, which is how mfa.test.js drives the API) get
  // correct semantics. Production deployments never set MOCHA_PARALLEL.
  //
  // Apply ONLY to the pure-default invocation (no explicit opts) — MFA's
  // `SessionStore.constructor` calls `clientFor()` with no args. Callers
  // that pass `processHandle` or `fallback` are explicit-IPC tests
  // (`messages/test/cluster_kv.test.js`) and must get the literal IPC
  // semantics, including the strict "no IPC channel + fallback:false" =
  // hard-fail branch.
  if (process.env.MOCHA_PARALLEL === '1' &&
      opts.processHandle === undefined &&
      opts.fallback === undefined) {
    return _SHARED_FALLBACK;
  }
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
    async get (key: string) {
      const reply = await _request({ type: 'kv:get', key }, processHandle, timeoutMs) as { value?: unknown };
      return reply.value ?? null;
    },
    async set (key: string, value: unknown, { ttlMs }: { ttlMs?: number } = {}) {
      await _request({ type: 'kv:set', key, value, ttlMs }, processHandle, timeoutMs);
    },
    async delete (key: string) {
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

export { masterStart, masterStop, clientFor, _masterStoreForTests, _resetInProcessFallbackForTests };
