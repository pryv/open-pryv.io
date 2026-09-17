/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);


/**
 * Multi-worker test fixture.
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
 * @param opts.count - number of child workers to spawn
 * @param opts.workerScript - absolute path to the worker harness module
 * @param [opts.env] - extra env vars passed to children
 * @param [opts.bootTimeoutMs]
 * @param [opts.callTimeoutMs]
 * @param [opts.kvMaster] - run the `cluster_kv` master handler in this
 *   (parent) process for the children, as `bin/master.js` does for real
 *   workers, so state kept in cluster_kv is shared between them.
 */
async function spawnWorkers ({
  count = 2,
  workerScript,
  env = {},
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  kvMaster = false
}: any = {}) {
  if (!workerScript) throw new Error('clusterFixture.spawnWorkers: workerScript is required');

  const workers: any[] = [];
  // The master handler listens on a `cluster`-shaped emitter: `message`
  // events carry (worker, msg). Children are forked processes here, so
  // relay each child's messages onto that shape.
  const kvHandlers: any[] = [];
  const clusterKv = kvMaster ? require('messages/src/cluster_kv.ts') : null;
  if (clusterKv) {
    clusterKv.masterStart({
      cluster: {
        on: (event: string, handler: any) => { if (event === 'message') kvHandlers.push(handler); },
        removeListener: (event: string, handler: any) => {
          const i = kvHandlers.indexOf(handler);
          if (i >= 0) kvHandlers.splice(i, 1);
        }
      }
    });
  }
  for (let i = 0; i < count; i++) {
    const child = childProcess.fork(workerScript, [], {
      env: { ...process.env, ...env, WORKER_INDEX: String(i) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    workers.push({ child, pending: new Map() });
    child.on('message', (msg: any) => {
      if (clusterKv && typeof msg?.type === 'string' && msg.type.startsWith('kv:')) {
        const worker = { send: (m: unknown) => child.send(m) };
        for (const handler of kvHandlers) handler(worker, msg);
        return;
      }
      if (!msg || typeof msg.requestId !== 'string') return;
      const entry = workers[i].pending.get(msg.requestId);
      if (!entry) return;
      workers[i].pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'worker error'));
    });
    child.on('exit', (code: any, sig: any) => {
      // Settle any pending calls so tests fail loudly instead of hanging.
      for (const entry of workers[i].pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`worker ${i} exited (code=${code} sig=${sig})`));
      }
      workers[i].pending.clear();
    });
  }

  function call (workerIndex: any, op: any, args: any, timeoutMs = callTimeoutMs) {
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
    if (clusterKv) clusterKv.masterStop();
  }

  return {
    request: call,
    stop,
    workers
  };
}

export { spawnWorkers };
