/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [WFTL] Worker-fork .ts loading via NODE_OPTIONS shim — Plan 57 Phase 5a
 * pre-flight characterization test.
 *
 * Pins the CURRENT behavior: a child process spawned via `child_process.fork()`
 * inherits the parent's `NODE_OPTIONS=--require=<shim>` env var (set by
 * `bin/_ts-register.js` the first time it loads), so it can `require()` a
 * `.ts` source file without explicitly loading the shim itself.
 *
 * This is the "defense in depth" mechanism added in Phase 1 to avoid
 * whack-a-mole of adding the shim require to every fork target. After Phase 5
 * (ESM flip + drop the shim), the equivalent must be: forked children can
 * `import()` `.ts` files natively in Node's ESM mode without any env-var
 * trickery. If that mechanism regresses silently, every forked worker
 * (cluster_kv master IPC, accessStateWorker, hfs background workers) breaks.
 *
 * The test launches a minimal child that requires a known .ts module from
 * storages/interfaces/ (no DB, no boiler bootstrap needed) and asserts the
 * require resolves to a non-undefined module.
 */

const assert = require('node:assert');
const path = require('node:path');
const childProcess = require('node:child_process');

const WORKER_SCRIPT = path.join(__dirname, 'fixtures', 'wftl-worker.js');

describe('[WFTL] worker-fork .ts loading (CJS shim contract)', () => {
  it('[WFTL-NODE-OPTIONS] NODE_OPTIONS env var is set by the shim and includes --require', () => {
    // Sanity: the parent process (this mocha run) has been bootstrapped via
    // bin/_ts-register.js (per .mocharc.js). The shim sets NODE_OPTIONS to
    // include --require=<self-path>. Without it, the fork-inheritance
    // mechanism this test exercises would not exist.
    const opts = process.env.NODE_OPTIONS || '';
    assert.ok(
      opts.includes('--require=') && opts.includes('_ts-register'),
      `expected NODE_OPTIONS to include --require=...bin/_ts-register, got: ${opts}`
    );
  });

  it('[WFTL-FORK-INHERITS] forked child inherits NODE_OPTIONS and can require a .ts source file', function (done) {
    this.timeout(15000);
    const child = childProcess.fork(WORKER_SCRIPT, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    let timer = null;
    child.on('message', (msg) => {
      clearTimeout(timer);
      try {
        assert.strictEqual(msg.ok, true,
          `child reported failure: ${msg.error || '(no error)'}\nchild stderr:\n${stderr}`);
        // UserStorage.ts exports { validateUserStorage, REQUIRED_METHODS } — an object.
        // The TYPEOF of an exported object/function/etc is itself always a string;
        // we're checking the value of typeof X here, which should be 'object'.
        assert.strictEqual(msg.tsModuleType, 'object',
          `expected the .ts module's typeof to be 'object' (it exports a record), got '${msg.tsModuleType}'`);
        // Sanity: assert one of the keys is present so we know the require actually
        // resolved a real .ts module (not a fallback to some string).
        assert.ok(msg.exportKeys && msg.exportKeys.includes('validateUserStorage'),
          `expected exported keys to include validateUserStorage, got: ${JSON.stringify(msg.exportKeys)}`);
        done();
      } catch (e) { done(e); } finally {
        child.kill();
      }
    });
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        done(new Error(`child exited (code=${code} sig=${sig})\nstderr:\n${stderr}`));
      }
    });
    timer = setTimeout(() => {
      child.kill();
      done(new Error(`child timed out after 10s\nstderr:\n${stderr}`));
    }, 10000);
  });
});
