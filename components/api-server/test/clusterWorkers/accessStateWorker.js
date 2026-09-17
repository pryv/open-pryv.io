/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Child worker harness for the access-state cross-worker test.
 * Dispatches accessState operations over IPC. Run via `child_process.fork`
 * with the fixture's `kvMaster` on: the state lives in `cluster_kv`, whose
 * worker client talks to the master handler in the parent over this same
 * IPC channel, exactly as a real worker talks to `bin/master.js`.
 *
 * Operations:
 *   __ready              → report ready
 *   buildAndPersist      → accessState.buildState + persist
 *   get                  → accessState.get
 *   update               → accessState.update
 *   remove               → accessState.remove
 *   __shutdown           → exit cleanly
 */

require('test-helpers/src/api-server-tests-config.ts');

const accessState = require('api-server/src/routes/reg/accessState.ts');

const handlers = {
  async __ready () {
    return { workerIndex: process.env.WORKER_INDEX, pid: process.pid };
  },
  async buildAndPersist (args = {}) {
    const { key, state, expiresAt } = accessState.buildState(args.params || {});
    if (args.decorate) Object.assign(state, args.decorate);
    await accessState.persist(key, state, expiresAt);
    return { key, state };
  },
  async get (args = {}) {
    return await accessState.get(args.key);
  },
  async update (args = {}) {
    return await accessState.update(args.key, args.update || {});
  },
  async remove (args = {}) {
    await accessState.remove(args.key);
    return { ok: true };
  },
  async clear () {
    await accessState.clear();
    return { ok: true };
  },
  async __shutdown () {
    setImmediate(() => process.exit(0));
    return { ok: true };
  }
};

process.on('message', async (msg) => {
  if (!msg || typeof msg.op !== 'string') return;
  const reply = (body) => {
    try { process.send({ requestId: msg.requestId, ...body }); } catch (_) {}
  };
  const fn = handlers[msg.op];
  if (!fn) return reply({ ok: false, error: 'unknown op: ' + msg.op });
  try {
    const result = await fn(msg.args || {});
    reply({ ok: true, result });
  } catch (err) {
    reply({ ok: false, error: err.message + (err.stack ? '\n' + err.stack : '') });
  }
});

// Keep the event loop alive
setInterval(() => {}, 60_000).unref();
