/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 55 Phase 5 — child worker harness for the access-state cross-worker
 * test. Initialises storages on first request and dispatches accessState
 * operations over IPC. Run via `child_process.fork`.
 *
 * Operations:
 *   __ready              → init storages + accessState; report ready
 *   buildAndPersist      → accessState.buildState + persist
 *   get                  → accessState.get
 *   update               → accessState.update
 *   remove               → accessState.remove
 *   __shutdown           → exit cleanly
 */

require('test-helpers/src/api-server-tests-config');

const { getConfig } = require('@pryv/boiler');
const accessState = require('api-server/src/routes/reg/accessState');

let initialized = false;

/**
 * Plan 55 Phase 5 — initialize ONLY the rqlite PlatformDB. Avoid the full
 * `storages.init()` so the worker doesn't open a PG/Mongo baseStorage pool
 * (each child × test would otherwise eat PG connection slots and starve the
 * parent's [EVST]/[ROOT] suites). accessState's lazy `require('storages').
 * platformDB` lookup goes through the property defined below.
 */
async function ensureInit () {
  if (initialized) return;
  initialized = true;
  const config = await getConfig();

  const rqliteEngine = require('storages/engines/rqlite/src');
  const engineCfg = config.get('storages:engines:rqlite') || { url: 'http://localhost:4001' };
  rqliteEngine.init(engineCfg);
  const platformDB = rqliteEngine.createPlatformDB();
  await platformDB.init();

  const storages = require('storages');
  Object.defineProperty(storages, 'platformDB', {
    get: () => platformDB,
    configurable: true
  });
}

const handlers = {
  async __ready () {
    await ensureInit();
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
