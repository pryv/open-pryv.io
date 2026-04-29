/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 55 Phase 5 — multi-worker test fixture.
 *
 * Spawns N child processes via `child_process.fork`, each running a worker
 * harness that initialises storages and exposes a JSON-RPC over IPC. The
 * fixture exists so cluster-mode bugs (per-worker state vs. cluster-wide
 * state) can be exercised in unit-tier tests instead of waiting for them to
 * surface in production.
 *
 * Worker harnesses are responsible for:
 *   - calling `storages.init(...)` in their `process.on('message')` setup;
 *   - registering the operations the test will dispatch.
 *
 * IPC protocol:
 *   parent → child : { requestId, op, args }
 *   child → parent : { requestId, ok, result?, error? }
 *
 * The fixture sends a `{op:'__ready'}` ping on spawn and waits for the
 * matching reply before resolving — so tests don't race against worker
 * boot.
 */

const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/**
 * @param {Object} opts
 * @param {number} opts.count - number of child workers to spawn
 * @param {string} opts.workerScript - absolute path to the worker harness module
 * @param {Object} [opts.env] - extra env vars passed to children
 * @param {number} [opts.bootTimeoutMs]
 * @param {number} [opts.callTimeoutMs]
 * @returns {Promise<{request: Function, stop: Function, workers: Array}>}
 */
async function spawnWorkers ({
  count = 2,
  workerScript,
  env = {},
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS
} = {}) {
  if (!workerScript) throw new Error('clusterFixture.spawnWorkers: workerScript is required');

  const workers = [];
  for (let i = 0; i < count; i++) {
    const child = childProcess.fork(workerScript, [], {
      env: { ...process.env, ...env, WORKER_INDEX: String(i) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    workers.push({ child, pending: new Map() });
    child.on('message', (msg) => {
      if (!msg || typeof msg.requestId !== 'string') return;
      const entry = workers[i].pending.get(msg.requestId);
      if (!entry) return;
      workers[i].pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'worker error'));
    });
    child.on('exit', (code, sig) => {
      // Settle any pending calls so tests fail loudly instead of hanging.
      for (const entry of workers[i].pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`worker ${i} exited (code=${code} sig=${sig})`));
      }
      workers[i].pending.clear();
    });
  }

  function call (workerIndex, op, args, timeoutMs = callTimeoutMs) {
    const w = workers[workerIndex];
    if (!w) return Promise.reject(new Error(`no worker at index ${workerIndex}`));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(requestId);
        reject(new Error(`worker ${workerIndex} ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      w.pending.set(requestId, { resolve, reject, timer });
      w.child.send({ requestId, op, args });
    });
  }

  // Wait for every child to ack `__ready`.
  await Promise.all(workers.map((_, i) => call(i, '__ready', {}, bootTimeoutMs)));

  async function stop () {
    await Promise.all(workers.map(async (w) => {
      try { w.child.send({ requestId: 'shutdown', op: '__shutdown', args: {} }); } catch (_) {}
      const exited = new Promise(resolve => w.child.once('exit', resolve));
      const killTimer = setTimeout(() => {
        try { w.child.kill('SIGKILL'); } catch (_) {}
      }, 2000);
      await exited;
      clearTimeout(killTimer);
    }));
  }

  return {
    request: call,
    stop,
    workers
  };
}

module.exports = { spawnWorkers };
